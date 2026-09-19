"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Bell, Crosshair, Maximize, Projector, Siren, Terminal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LayerBar } from "@/components/map/LayerBar";
import { MapStyle } from "@/components/map/MapStyle";
import type { CamMode, Layers, MapTrack, RouteLine, Selection } from "@/components/map/MapView";
import { AlertsPanel } from "@/components/panels/AlertsPanel";
import { FlightDetail } from "@/components/panels/FlightDetail";
import { HistoryPanel } from "@/components/panels/HistoryPanel";
import { ALT_MAX, LivePanel } from "@/components/panels/LivePanel";
import { ReceiverPanel } from "@/components/panels/ReceiverPanel";
import { StatsPanel } from "@/components/panels/StatsPanel";
import {
  getAlerts, getConfig, getHeatmap, getTrack, liveSocketUrl,
  type AppConfig, type Alert, type Flight, type FlightTrack, type Heat, type LiveAircraft, type Route, type TrackPoint,
} from "@/lib/api";
import { ALIGN_EPOCH, PALETTE } from "@/lib/format";
import { liveryFor } from "@/lib/livery";
import { askNotificationPermission, beep, showNotification } from "@/lib/notify";
import { getPref, usePref } from "@/lib/prefs";
import { setUnits, useUnits } from "@/lib/units";

const MapView = dynamic(() => import("@/components/map/MapView"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">Loading 3D map…</div>,
});

type Tab = "live" | "history" | "stats" | "rx" | "alerts";
const TABS: Tab[] = ["live", "history", "stats", "rx", "alerts"];
const CAM_CYCLE: CamMode[] = ["free", "orbit", "chase", "cockpit", "side", "top"];

function nearestPoint(track: FlightTrack, ms: number, align: boolean): TrackPoint | null {
  const pts = track.points;
  if (!pts.length) return null;
  const t0 = Date.parse(pts[0].ts);
  const target = align ? t0 + (ms - ALIGN_EPOCH) : ms;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Date.parse(pts[mid].ts) < target) lo = mid + 1;
    else hi = mid;
  }
  return pts[lo];
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("live");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [live, setLive] = useState<LiveAircraft[]>([]);
  const [homeView, setHomeView] = useState<{ lat: number; lon: number } | null>(null);
  const [connected, setConnected] = useState(false);
  const [overlay, setOverlay] = useState<{ flight: Flight; color: string }[]>([]);
  const [trackMap, setTrackMap] = useState<Record<number, FlightTrack>>({});
  const [selection, setSelection] = useState<Selection>(null);
  const [camMode, setCamMode] = useState<CamMode>("free");
  const [align, setAlign] = useState(false);
  const [homeSignal, setHomeSignal] = useState(0);
  const [clockMs, setClockMs] = useState(0);
  const [liveAtt, setLiveAtt] = useState<{ icao24: string; pitch: number; roll: number } | null>(null);
  const [altRange, setAltRange] = useState<[number, number]>([0, ALT_MAX]);
  const [layers, setLayers] = useState<Layers>({ trails: true, drops: true, labels: true, rings: true, routes: true, weather: false, heatmap: false, tags: false, dim: true, outlines: false, airports: false });
  const [routeOf, setRouteOf] = useState<{ flightId: number; route: Route | null } | null>(null);
  const [heat, setHeat] = useState<Heat | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [toasts, setToasts] = useState<Alert[]>([]);
  const [seenAlertId, setSeenAlertId] = useState(0);
  const [notify, setNotifyPref] = usePref("notify");
  const [sound, setSoundPref] = usePref("sound");
  const units = useUnits();
  const [projector, setProjector] = useState(false);
  const [frameSignal, setFrameSignal] = useState(0);
  const [hud, setHud] = useState(true);
  const [clock, setClock] = useState("");
  const [tagsFull, setTagsFull] = usePref("tagsFull", true);
  const projectorRef = useRef(false);
  const framedOnce = useRef(false);

  const mode = tab === "history" ? "history" : "live"; // the map keeps showing live traffic behind Stats and Alerts
  const receiver = config && (config.receiver.lat || config.receiver.lon) ? config.receiver : null;
  const enrichOnline = config?.enrich_online ?? false;

  // ------------------------------------------------------------------------------------ data feeds
  const urlReady = useRef(false);
  const openFlightRef = useRef<(id: number) => Promise<void>>(async () => {});

  useEffect(() => {
    getConfig()
      .then((c) => {
        setConfig(c);
        // apply a shared link (?tab=…&flight=…&aircraft=…) once the backend is known to be reachable
        const sp = new URLSearchParams(window.location.search);
        const t = sp.get("tab") as Tab | null;
        if (t && TABS.includes(t)) setTab(t);
        if (sp.get("projector") === "1") setProjector(true);
        const f = Number(sp.get("flight"));
        const ac = sp.get("aircraft");
        if (f) void openFlightRef.current(f);
        else if (ac) {
          setTab("live");
          setSelection({ flightId: null, icao24: ac.toLowerCase() });
        }
      })
      .catch(() => {})
      .finally(() => {
        urlReady.current = true;
      });
  }, []);

  // live feed over WebSocket, kept open on every tab (it also drives the connection status)
  useEffect(() => {
    let closed = false;
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      ws = new WebSocket(liveSocketUrl());
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        const list: LiveAircraft[] = JSON.parse(e.data);
        setLive(list);
        if (list.length && projectorRef.current && !framedOnce.current) {
          framedOnce.current = true;
          setFrameSignal((n) => n + 1); // a projector opened from a link frames the first traffic it sees
        }
        if (list.length) {
          const lat = list.reduce((s, a) => s + a.lat, 0) / list.length;
          const lon = list.reduce((s, a) => s + a.lon, 0) / list.length;
          setHomeView((v) => v ?? { lat, lon }); // first traffic seen, used when no receiver position is set
        }
      };
      ws.onerror = () => ws?.close();
      ws.onclose = () => {
        setConnected(false);
        if (!closed) timer = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  // alerts: the first poll only sets a baseline; later ones raise a toast, notification and sound
  const lastAlertId = useRef<number | null>(null);
  const tabRef = useRef<Tab>(tab);
  useEffect(() => {
    tabRef.current = tab;
  });
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const list = await getAlerts(lastAlertId.current ?? 0);
        if (cancelled) return;
        const baseline = lastAlertId.current === null;
        if (list.length) lastAlertId.current = list[0].id;
        else if (baseline) lastAlertId.current = 0;
        if (!list.length) return;
        setAlerts((a) => [...list, ...a].slice(0, 100));
        if (baseline) {
          setSeenAlertId(list[0].id); // history from before this page opened is not "new"
          return;
        }
        if (tabRef.current === "alerts") setSeenAlertId(list[0].id);
        setToasts((t) => [...list, ...t].slice(0, 4));
        for (const a of list) setTimeout(() => setToasts((t) => t.filter((x) => x.id !== a.id)), 14_000);
        if (getPref("notify", false)) list.forEach(showNotification);
        if (getPref("sound", false)) beep(list.some((a) => a.kind === "emergency"));
      } catch {
        /* backend unreachable: try again on the next tick */
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // reception heatmap, only fetched while its layer is on
  useEffect(() => {
    if (!layers.heatmap) return;
    let cancelled = false;
    const load = () => getHeatmap(30, 0.02).then((h) => !cancelled && setHeat(h)).catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [layers.heatmap]);

  // fetch tracks for overlaid flights that are not loaded yet
  useEffect(() => {
    for (const { flight } of overlay) {
      if (trackMap[flight.id]) continue;
      getTrack(flight.id)
        .then((t) => setTrackMap((m) => ({ ...m, [flight.id]: t })))
        .catch(() => {});
    }
  }, [overlay, trackMap]);

  // ------------------------------------------------------------------------------------ actions
  const switchTab = useCallback((t: Tab) => {
    setTab(t);
    setSelection(null);
    setCamMode("free");
    if (t === "alerts") setSeenAlertId((id) => Math.max(id, lastAlertId.current ?? 0));
  }, []);

  const addOverlay = useCallback((f: Flight) => {
    setOverlay((o) => {
      if (o.some((x) => x.flight.id === f.id)) return o;
      const used = new Set(o.map((x) => x.color));
      return [...o, { flight: f, color: PALETTE.find((c) => !used.has(c)) ?? PALETTE[o.length % PALETTE.length] }];
    });
  }, []);

  const toggleOverlay = useCallback(
    (f: Flight) => {
      if (overlay.some((x) => x.flight.id === f.id)) setOverlay((o) => o.filter((x) => x.flight.id !== f.id));
      else addOverlay(f);
    },
    [overlay, addOverlay],
  );

  const overlayFromDetail = useCallback(
    (f: Flight) => {
      addOverlay(f);
      setTab("history");
    },
    [addOverlay],
  );

  // open one flight in History (from Stats records, alerts, airport movements, shared links)
  const openFlight = useCallback(
    async (flightId: number) => {
      try {
        const t = await getTrack(flightId);
        const { points, ...flight } = t;
        void points;
        setTrackMap((m) => ({ ...m, [flightId]: t }));
        addOverlay(flight);
        setTab("history");
        setSelection({ flightId, icao24: "" });
      } catch {
        /* backend unreachable: leave the UI as it is */
      }
    },
    [addOverlay],
  );
  useEffect(() => {
    openFlightRef.current = openFlight;
  }, [openFlight]);

  // replay everything that flew in a window: each aircraft in its airline's colour
  const replayAll = useCallback((flights: FlightTrack[]) => {
    setTrackMap((m) => {
      const next = { ...m };
      for (const f of flights) next[f.id] = f;
      return next;
    });
    setOverlay(
      flights.map((f) => {
        const { points, ...flight } = f;
        void points;
        return { flight, color: liveryFor(f.airline?.icao).tail };
      }),
    );
    setAlign(false);
    setSelection(null);
    setCamMode("free");
  }, []);

  const openAlert = useCallback(
    (a: Alert) => {
      const inView = live.find((x) => x.icao24 === a.icao24);
      if (inView) {
        setTab("live");
        setSelection({ flightId: null, icao24: a.icao24 });
      } else if (a.flight_id) void openFlight(a.flight_id);
    },
    [live, openFlight],
  );

  const setNotify = async (on: boolean) => {
    if (on && !(await askNotificationPermission())) return; // blocked by the browser: stay off
    setNotifyPref(on);
  };
  const setSound = (on: boolean) => {
    setSoundPref(on);
    if (on) beep(false); // also unlocks audio, which browsers only allow after a click
  };

  // ------------------------------------------------------------------------------------ derived
  const tracks: MapTrack[] = useMemo(
    () => overlay.filter((o) => trackMap[o.flight.id]).map((o) => ({ flight: trackMap[o.flight.id], color: o.color })),
    [overlay, trackMap],
  );
  const overlayIds = useMemo(() => new Set(overlay.map((o) => o.flight.id)), [overlay]);

  const visibleLive = useMemo(() => {
    if (altRange[0] === 0 && altRange[1] === ALT_MAX) return live;
    return live.filter((a) => a.alt != null && a.alt >= altRange[0] && a.alt <= altRange[1]);
  }, [live, altRange]);

  const selLive = mode === "live" && selection ? (visibleLive.find((a) => a.icao24 === selection.icao24) ?? null) : null;
  const selFlight =
    mode === "history" && selection?.flightId != null
      ? (overlay.find((o) => o.flight.id === selection.flightId)?.flight ?? null)
      : null;
  const selTrack = selFlight ? (trackMap[selFlight.id] ?? null) : null;
  const selPoint = selTrack ? nearestPoint(selTrack, clockMs, align) : null;
  const attitude = selPoint
    ? { pitch: selPoint.pitch, roll: selPoint.roll }
    : selLive && liveAtt?.icao24 === selLive.icao24
      ? { pitch: liveAtt.pitch, roll: liveAtt.roll }
      : null;
  const showDetail = !!(selLive || selFlight);

  const selFlightId = selFlight?.id ?? selLive?.flight_id ?? null;
  const routeSrc = selLive?.route ?? (routeOf && routeOf.flightId === selFlightId ? routeOf.route : null);
  const routeLine: RouteLine | null = useMemo(() => {
    if (!routeSrc) return null;
    const { origin: o, destination: d } = routeSrc;
    if (o.lat == null || o.lon == null || d.lat == null || d.lon == null) return null;
    return {
      origin: { lat: o.lat, lon: o.lon, label: o.iata ?? o.icao ?? "" },
      destination: { lat: d.lat, lon: d.lon, label: d.iata ?? d.icao ?? "" },
    };
  }, [routeSrc]);

  const emergencies = live.filter((a) => a.emergency);
  const unread = alerts.filter((a) => a.id > seenAlertId).length;

  const deselect = useCallback(() => {
    setSelection(null);
    setCamMode("free");
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);
  const enterProjector = useCallback(() => {
    setProjector(true);
    setTab("live");
    deselect();
    setFrameSignal((n) => n + 1);
    framedOnce.current = true;
    if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {});
  }, [deselect]);
  const exitProjector = useCallback(() => {
    setProjector(false);
    if (document.fullscreenElement) void document.exitFullscreen();
  }, []);

  useEffect(() => {
    projectorRef.current = projector;
  }, [projector]);

  // projector HUD: visible while the mouse moves, gone after a few quiet seconds; also a small clock
  useEffect(() => {
    if (!projector) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      setHud(true);
      clearTimeout(timer);
      timer = setTimeout(() => setHud(false), 3500);
    };
    wake();
    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", wake);
    const tick = () => setClock(new Date().toLocaleTimeString());
    tick();
    const clockTimer = setInterval(tick, 1000);
    return () => {
      clearTimeout(timer);
      clearInterval(clockTimer);
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", wake);
    };
  }, [projector]);

  // keep the address bar shareable: ?tab=…&flight=… / ?aircraft=…
  useEffect(() => {
    if (!urlReady.current) return;
    const sp = new URLSearchParams(window.location.search);
    for (const k of ["tab", "flight", "aircraft", "projector"]) sp.delete(k);
    if (tab !== "live") sp.set("tab", tab);
    if (mode === "history" && selection?.flightId != null) sp.set("flight", String(selection.flightId));
    if (mode === "live" && selection?.icao24) sp.set("aircraft", selection.icao24);
    if (projector) sp.set("projector", "1");
    const q = sp.toString();
    window.history.replaceState(null, "", q ? `?${q}` : window.location.pathname);
  }, [tab, mode, selection, projector]);

  // keyboard: Esc closes the card (or leaves projector mode), H = home view, C cycles the camera view of the
  // selected aircraft, P = projector mode (then D = tag detail, A = frame all traffic, F = fullscreen)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (e.key === "Escape") {
        if (projector) exitProjector();
        else deselect();
      } else if (k === "p") {
        if (projector) exitProjector();
        else enterProjector();
      } else if (projector && k === "d") setTagsFull(!tagsFull);
      else if (projector && k === "a") setFrameSignal((n) => n + 1);
      else if (projector && k === "f") toggleFullscreen();
      else if (k === "h") setHomeSignal((n) => n + 1);
      else if (k === "c" && showDetail) setCamMode((m) => CAM_CYCLE[(CAM_CYCLE.indexOf(m) + 1) % CAM_CYCLE.length]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deselect, showDetail, projector, tagsFull, setTagsFull, enterProjector, exitProjector, toggleFullscreen]);

  // ------------------------------------------------------------------------------------ view
  return (
    <main data-projector={projector} className={`dark relative h-screen w-screen overflow-clip bg-background text-foreground [color-scheme:dark] ${projector && !hud ? "cursor-none" : ""}`}>
      <MapView
        mode={mode}
        live={visibleLive}
        tracks={tracks}
        align={align}
        selection={selection}
        onSelect={setSelection}
        receiver={receiver}
        homeView={homeView}
        camMode={camMode}
        layers={layers}
        route={showDetail ? routeLine : null}
        heat={heat}
        airport={config?.airport ?? null}
        projector={projector}
        tagDetail={tagsFull ? "full" : "compact"}
        frameSignal={frameSignal}
        homeSignal={homeSignal}
        onClock={setClockMs}
        onLiveAttitude={(icao24, a) => setLiveAtt({ icao24, ...a })}
      />

      <div className={`pointer-events-none absolute right-16 top-3 z-10 hidden md:block ${projector ? "!hidden" : ""}`}>
        <MapStyle dim={layers.dim} onDim={(dim) => setLayers((l) => ({ ...l, dim }))} onProjector={enterProjector} />
      </div>
      <div className={`pointer-events-none absolute inset-x-0 top-[7.6rem] flex justify-center md:top-4 ${projector ? "hidden" : ""}`}>
        <LayerBar layers={layers} onChange={setLayers} />
      </div>

      {/* emergencies stay on screen until they clear; new alerts appear briefly */}
      <div className={`pointer-events-none absolute left-1/2 top-[11rem] z-30 flex w-[min(92vw,26rem)] -translate-x-1/2 flex-col gap-2 md:top-16 ${projector ? "hidden" : ""}`}>
        {emergencies.map((a) => (
          <button
            key={a.icao24}
            type="button"
            onClick={() => {
              setTab("live");
              setSelection({ flightId: null, icao24: a.icao24 });
            }}
            className="pointer-events-auto flex items-center gap-2 rounded-xl border border-destructive/60 bg-destructive/90 px-3 py-2 text-left text-sm text-white shadow-lg backdrop-blur"
          >
            <Siren className="size-4 shrink-0" />
            <span className="num font-semibold">{a.callsign ?? a.icao24.toUpperCase()}</span>
            <span className="truncate">squawk {a.squawk}: {a.emergency}</span>
          </button>
        ))}
        {toasts.map((a) => (
          <div key={a.id} className="panel pointer-events-auto flex items-start gap-2 rounded-xl px-3 py-2 text-sm">
            <Bell className={`mt-0.5 size-4 shrink-0 ${a.kind === "emergency" ? "text-destructive" : "text-primary"}`} />
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openAlert(a)}>
              <span className="num block font-semibold">{a.callsign ?? a.icao24.toUpperCase()}</span>
              <span className="block truncate text-xs text-muted-foreground">{a.detail}</span>
            </button>
            <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={() => setToasts((t) => t.filter((x) => x.id !== a.id))}><X /></Button>
          </div>
        ))}
      </div>

      <div
        className={`pointer-events-none absolute inset-x-2 top-2 flex flex-col justify-between gap-3 md:inset-x-auto md:left-4 md:top-4 md:w-[21rem] md:justify-start ${
          mode === "history" ? "bottom-40 md:bottom-48" : "bottom-2 md:bottom-8"
        } ${projector ? "hidden" : ""}`}
      >
        <header className="panel pointer-events-auto rounded-2xl p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="grid size-9 place-items-center rounded border border-climb/40 bg-climb/10 text-climb">
                <Terminal className="size-[18px]" />
              </span>
              <div className="leading-tight">
                <h1 className="text-[15px] font-bold tracking-tight">flightlog<span className="text-climb">_</span></h1>
                <p className="num text-[10px] text-muted-foreground">adsb://sdr</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className={`num flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] ${connected ? "border-climb/30 text-climb" : "border-destructive/40 text-destructive"}`}
                title={connected ? "Receiving live data" : "Not connected to the backend"}
              >
                <span className="relative flex size-1.5">
                  {connected && <span className="ping-soft absolute inset-0 rounded-full bg-climb" />}
                  <span className={`relative size-1.5 rounded-full ${connected ? "bg-climb" : "bg-destructive"}`} />
                </span>
                {connected ? `${live.length} live` : "offline"}
              </span>
              <Button size="xs" variant="outline" className="num" title="Switch between aviation (ft, kt, NM) and metric units" onClick={() => setUnits(units === "metric" ? "aviation" : "metric")}>
                {units === "metric" ? "m·km/h" : "ft·kt"}
              </Button>
              <Button size="icon-sm" variant="outline" aria-label="Projector mode (P)" title="Projector mode (P): black map, only aircraft and floating tags" onClick={enterProjector}>
                <Projector />
              </Button>
              <Button size="icon-sm" variant="outline" aria-label="Home view (H)" title="Home view (H)" onClick={() => setHomeSignal((n) => n + 1)}>
                <Crosshair />
              </Button>
            </div>
          </div>
          <Tabs value={tab} onValueChange={(v) => switchTab(v as Tab)} className="mt-3">
            <TabsList className="w-full">
              <TabsTrigger value="live">Live</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
              <TabsTrigger value="stats">Stats</TabsTrigger>
              <TabsTrigger value="rx" title="Receiver gain and signal">Rx</TabsTrigger>
              <TabsTrigger value="alerts" className="relative">
                Alerts
                {unread > 0 && <span className="num absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-destructive px-1 text-[9px] font-semibold text-white">{unread > 9 ? "9+" : unread}</span>}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </header>

        <section className={`panel pointer-events-auto flex h-[42vh] min-h-0 flex-col rounded-2xl p-3 md:h-auto md:flex-1 ${showDetail ? "hidden md:flex" : ""}`}>
          {tab === "live" && (
            <LivePanel
              aircraft={visibleLive}
              total={live.length}
              selectedIcao={selection?.icao24 ?? null}
              receiver={receiver}
              altRange={altRange}
              onAltRange={setAltRange}
              onPick={(a) => setSelection({ flightId: null, icao24: a.icao24 })}
            />
          )}
          {tab === "history" && (
            <HistoryPanel
              overlay={overlay}
              selectedId={selection?.flightId ?? null}
              align={align}
              onAlign={setAlign}
              onToggle={toggleOverlay}
              onSelect={(f) => {
                addOverlay(f);
                setSelection({ flightId: f.id, icao24: "" });
              }}
              onClear={() => {
                setOverlay([]);
                deselect();
              }}
              onReplay={replayAll}
            />
          )}
          {tab === "stats" && <StatsPanel onOpenFlight={openFlight} />}
          {tab === "rx" && <ReceiverPanel live={live} />}
          {tab === "alerts" && <AlertsPanel alerts={alerts} notify={notify} onNotify={setNotify} sound={sound} onSound={setSound} onOpen={openAlert} />}
        </section>
      </div>

      {showDetail && !projector && (
        <div className="pointer-events-none absolute inset-x-2 bottom-2 top-[7.4rem] flex min-h-0 items-start md:inset-x-auto md:bottom-8 md:right-4 md:top-14">
          <FlightDetail
            flight={selFlight}
            live={selLive}
            track={selTrack}
            attitude={attitude}
            point={selPoint}
            camMode={camMode}
            onCamMode={setCamMode}
            onClose={deselect}
            onOverlay={overlayFromDetail}
            overlayIds={overlayIds}
            enrichOnline={enrichOnline}
            signalAvailable={config?.signal_available ?? false}
            onRoute={(flightId, route) => setRouteOf({ flightId, route })}
          />
        </div>
      )}

      {projector && (
        <div className={`pointer-events-none absolute inset-0 z-40 transition-opacity duration-300 ${hud ? "opacity-100" : "opacity-0"}`}>
          <div className="pointer-events-auto absolute right-3 top-3 flex items-center gap-1 rounded border border-border bg-card p-1">
            <Button size="xs" variant="ghost" onClick={() => setFrameSignal((n) => n + 1)}>[A] frame all</Button>
            <Button size="xs" variant="ghost" onClick={() => setTagsFull(!tagsFull)}>[D] tags: {tagsFull ? "full" : "compact"}</Button>
            <Button size="xs" variant="ghost" onClick={toggleFullscreen}><Maximize /> [F]</Button>
            <Button size="xs" variant="outline" onClick={exitProjector}>[Esc] exit</Button>
          </div>
          <div className="num absolute bottom-3 left-4 text-sm text-muted-foreground">
            {clock} · {live.length} aircraft{connected ? "" : " · OFFLINE"}
          </div>
        </div>
      )}
    </main>
  );
}
