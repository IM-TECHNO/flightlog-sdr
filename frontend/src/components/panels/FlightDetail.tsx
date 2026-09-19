"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, Copy, Download, Eye, History, Minus, Plane, Video, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CamMode } from "@/components/map/MapView";
import {
  addWatch, exportUrl, getHistory, getInfo, getPhoto, getTrack,
  type Airport, type Photo, type Flight, type FlightInfo, type FlightTrack, type LiveAircraft, type Route, type TrackPoint,
} from "@/lib/api";
import { altUnit, altValue, fmtAlt, fmtDist, fmtDuration, fmtTs, speedUnit, speedValue, vrateUnit, vrateValue } from "@/lib/format";
import { haversineKm } from "@/lib/geo";
import { liveryFor } from "@/lib/livery";
import { signalLevel } from "@/lib/signal";
import { AirlineBadge } from "./AirlineBadge";
import { AltitudeProfile } from "./AltitudeProfile";
import { AttitudeIndicator } from "./AttitudeIndicator";
import { SignalBars } from "./SignalBars";
import { SignalProfile } from "./SignalProfile";

type Props = {
  flight: Flight | null;
  live: LiveAircraft | null;
  track: FlightTrack | null; // loaded track for a history flight
  attitude: { pitch: number; roll: number } | null;
  point: TrackPoint | null;
  camMode: CamMode;
  onCamMode: (m: CamMode) => void;
  onClose: () => void;
  onOverlay: (f: Flight) => void; // add a previous flight to the map overlay
  overlayIds: Set<number>;
  enrichOnline: boolean;
  signalAvailable: boolean; // the backend can read the decoder's signal levels
  /** Reports the route of the shown flight so the map can draw it. */
  onRoute: (flightId: number, route: Route | null) => void;
};

const CAMS: { id: CamMode; label: string }[] = [
  { id: "free", label: "Free" }, { id: "orbit", label: "Orbit" }, { id: "chase", label: "Chase" },
  { id: "cockpit", label: "Cockpit" }, { id: "side", label: "Side" }, { id: "top", label: "Top" },
];

function Readout({ label, value, unit, tone, icon }: { label: string; value: string; unit?: string; tone?: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-background/40 px-3 py-2">
      <div className="eyebrow flex items-center justify-between">{label}{icon}</div>
      <div className="num mt-0.5 flex items-baseline gap-1 text-xl font-semibold leading-none" style={{ color: tone }}>
        {value}
        {unit && <span className="text-[11px] font-normal text-muted-foreground">{unit}</span>}
      </div>
    </div>
  );
}

const airportCode = (a: Airport) => a.iata ?? a.icao ?? "?";

function RouteBlock({ route, pos, known, enrichOnline }: { route: Route | null; pos: { lat: number; lon: number } | null; known: boolean; enrichOnline: boolean }) {
  if (!route) {
    if (!known) return null;
    return (
      <p className="mt-3 rounded-md bg-background/40 px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground">
        {enrichOnline ? "No route on file for this callsign." : "Origin and destination need route lookup: start the backend with ENRICH_ONLINE=1."}
      </p>
    );
  }
  const { origin: o, destination: d } = route;
  let flown: number | null = null, togo: number | null = null;
  if (pos && o.lat != null && o.lon != null && d.lat != null && d.lon != null) {
    flown = haversineKm(o.lat, o.lon, pos.lat, pos.lon);
    togo = haversineKm(pos.lat, pos.lon, d.lat, d.lon);
  }
  const pct = flown != null && togo != null && flown + togo > 0 ? Math.round((flown / (flown + togo)) * 100) : null;
  return (
    <div className="mt-3">
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="num text-2xl font-semibold leading-none">{airportCode(o)}</div>
          <div className="mt-1 max-w-[7.5rem] truncate text-[11px] text-muted-foreground">{o.city ?? o.name ?? ""}</div>
        </div>
        <Plane className="mb-4 size-4 shrink-0 rotate-90 text-primary" />
        <div className="min-w-0 text-right">
          <div className="num text-2xl font-semibold leading-none">{airportCode(d)}</div>
          <div className="ml-auto mt-1 max-w-[7.5rem] truncate text-[11px] text-muted-foreground">{d.city ?? d.name ?? ""}</div>
        </div>
      </div>
      {pct != null && flown != null && togo != null && (
        <div className="mt-2.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-gradient-to-r from-primary/60 to-primary" style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
          </div>
          <div className="num mt-1 flex justify-between text-[10.5px] text-muted-foreground">
            <span>{fmtDist(flown)} flown</span>
            <span>{pct}%</span>
            <span>{fmtDist(togo)} to go</span>
          </div>
        </div>
      )}
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex justify-between gap-3 text-[13px]">
    <span className="text-muted-foreground">{k}</span>
    <span className="num max-w-[60%] truncate text-right">{v ?? "—"}</span>
  </div>
);

export function FlightDetail({ flight, live, track, attitude, point, camMode, onCamMode, onClose, onOverlay, overlayIds, enrichOnline, signalAvailable, onRoute }: Props) {
  const flightId = flight?.id ?? live?.flight_id ?? null;
  const [infoState, setInfo] = useState<{ id: number; data: FlightInfo } | null>(null);
  const [pastState, setPast] = useState<{ id: number; data: Flight[] } | null>(null);
  const [liveTrack, setLiveTrack] = useState<FlightTrack | null>(null);
  const [photoState, setPhoto] = useState<{ icao: string; data: Photo } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const info = infoState?.id === flightId ? infoState.data : null;
  const past = pastState?.id === flightId ? pastState.data : null;
  const isLive = !!live;
  const onRouteRef = useRef(onRoute);
  useEffect(() => {
    onRouteRef.current = onRoute;
  });

  useEffect(() => {
    if (flightId == null) return;
    let cancelled = false;
    getInfo(flightId)
      .then((data) => {
        if (cancelled) return;
        setInfo({ id: flightId, data });
        onRouteRef.current(flightId, data.route);
      })
      .catch(() => {});
    getHistory(flightId).then((data) => !cancelled && setPast({ id: flightId, data })).catch(() => !cancelled && setPast({ id: flightId, data: [] }));
    return () => {
      cancelled = true;
    };
  }, [flightId]);

  const icaoNow = flight?.icao24 ?? live?.icao24 ?? "";
  useEffect(() => {
    if (!enrichOnline || !icaoNow) return;
    let cancelled = false;
    getPhoto(icaoNow).then((data) => !cancelled && setPhoto({ icao: icaoNow, data })).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enrichOnline, icaoNow]);
  const photo = photoState?.icao === icaoNow && photoState.data.available ? photoState.data : null;

  const flash = (msg: string) => {
    setNote(msg);
    setTimeout(() => setNote(null), 2500);
  };
  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href).then(() => flash("Link copied"), () => flash("Could not copy"));
  };
  const watchAircraft = () => {
    addWatch("icao24", icaoNow).then(() => flash("Watching this aircraft"), (e) => flash(e instanceof Error ? e.message : "Could not add"));
  };

  // live flights have no loaded track: fetch the recorded one and refresh it while the card is open
  useEffect(() => {
    if (!isLive || flightId == null) return;
    let cancelled = false;
    const load = () => getTrack(flightId).then((t) => !cancelled && setLiveTrack(t)).catch(() => {});
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isLive, flightId]);

  const shownTrack = track ?? (liveTrack?.id === flightId ? liveTrack : null);
  const cursor = point && track ? track.points.indexOf(point) : undefined;

  const callsign = flight?.callsign ?? live?.callsign ?? null;
  const icao = flight?.icao24 ?? live?.icao24 ?? "";
  const airlineObj = info?.airline ?? flight?.airline ?? live?.airline ?? null;
  const country = info?.country ?? flight?.country ?? live?.country;
  const alt = point?.alt ?? live?.alt ?? null;
  const gs = point?.gs ?? live?.gs ?? null;
  const vr = point?.vrate ?? live?.vrate ?? null;
  const hdg = point?.track ?? live?.track ?? null;
  const rssi = point?.rssi ?? live?.rssi ?? null;
  const level = signalLevel(rssi);
  const ac = info?.aircraft;
  const route = info?.route ?? live?.route ?? null;
  const here = point ?? live ?? null;
  const livery = liveryFor(airlineObj?.icao);

  return (
    <div className="panel pointer-events-auto flex max-h-full w-[21rem] flex-col overflow-hidden rounded-md">
      <div className="relative shrink-0 border-b px-4 pb-3 pt-4" style={{ borderLeft: `3px solid ${livery.tail}` }}>
        <div className="flex items-start gap-3">
          <AirlineBadge icao={airlineObj?.icao} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="num truncate text-xl font-semibold leading-tight">{callsign ?? icao.toUpperCase()}</h2>
              {isLive && (
                <Badge className="gap-1.5 bg-climb/20 text-climb">
                  <span className="relative flex size-1.5"><span className="ping-soft absolute inset-0 rounded-full bg-climb" /><span className="relative size-1.5 rounded-full bg-climb" /></span>
                  LIVE
                </Badge>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {[airlineObj?.name, country].filter(Boolean).join(" · ") || "Unidentified"} · <span className="num">{icao.toUpperCase()}</span>
            </p>
          </div>
          <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close"><X /></Button>
        </div>
        <RouteBlock route={route} pos={here ? { lat: here.lat, lon: here.lon } : null} known={info != null} enrichOnline={enrichOnline} />
      </div>

      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        {photo?.src && (
          <figure className="overflow-hidden rounded-lg border">
            {/* eslint-disable-next-line @next/next/no-img-element -- a third-party thumbnail, loaded straight from its CDN */}
            <img src={photo.src} alt={`Photo of ${callsign ?? icao}`} className="aspect-[16/9] w-full object-cover" loading="lazy" />
            <figcaption className="bg-background/60 px-2 py-1 text-[10.5px] text-muted-foreground">
              Photo{photo.photographer ? ` by ${photo.photographer}` : ""} ·{" "}
              <a className="underline underline-offset-2 hover:text-foreground" href={photo.link} target="_blank" rel="noreferrer">planespotters.net</a>
            </figcaption>
          </figure>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Readout label="Altitude" value={alt == null ? "—" : altValue(alt)} unit={alt == null ? undefined : altUnit() === "ft" && alt >= 18000 ? `ft · ${fmtAlt(alt)}` : altUnit()} tone="var(--altitude)" />
          <Readout label="Speed" value={gs == null ? "—" : speedValue(gs)} unit={speedUnit()} />
          <Readout
            label="Vertical"
            value={vr == null ? "—" : vrateValue(vr)}
            unit={vrateUnit()}
            tone={vr == null || Math.abs(vr) < 100 ? undefined : vr > 0 ? "var(--climb)" : "var(--descend)"}
            icon={vr == null || Math.abs(vr) < 100 ? <Minus className="size-3" /> : vr > 0 ? <ArrowUp className="size-3 text-climb" /> : <ArrowDown className="size-3 text-descend" />}
          />
          <Readout label="Heading" value={hdg == null ? "—" : String(Math.round(hdg)).padStart(3, "0")} unit="°" />
          <Readout
            label="Signal"
            value={rssi == null ? "—" : rssi.toFixed(1)}
            unit={rssi == null ? undefined : "dBFS"}
            tone={level?.color}
            icon={<SignalBars rssi={rssi} />}
          />
          <Readout label="Messages" value={live?.msg_rate == null ? "—" : live.msg_rate.toFixed(1)} unit="msg/s" />
        </div>
        {rssi == null && (
          <p className="-mt-2 text-[10.5px] leading-snug text-muted-foreground">
            {signalAvailable ? "No signal level for this aircraft yet." : "Signal strength is off: the backend can't read the decoder's aircraft.json (see AIRCRAFT_JSON_URL)."}
          </p>
        )}

        <section>
          <div className="eyebrow mb-2">Attitude (estimated)</div>
          <div className="flex items-center gap-4 rounded-lg border bg-background/40 p-3">
            <AttitudeIndicator pitch={attitude?.pitch ?? 0} roll={attitude?.roll ?? 0} size={104} />
            <div className="flex-1 space-y-1.5">
              <Row k="Pitch" v={attitude ? `${attitude.pitch > 0 ? "+" : ""}${attitude.pitch.toFixed(1)}°` : "—"} />
              <Row k="Roll" v={attitude ? `${attitude.roll > 0 ? "+" : ""}${attitude.roll.toFixed(1)}°` : "—"} />
              <p className="pt-0.5 text-[10.5px] leading-snug text-muted-foreground">Derived from track and vertical rate. ADS-B carries no attitude.</p>
            </div>
          </div>
        </section>

        <section>
          <div className="eyebrow mb-1.5">Altitude profile</div>
          {shownTrack ? <AltitudeProfile points={shownTrack.points} cursor={cursor} /> : <p className="text-xs text-muted-foreground">{flightId == null ? "No recorded track yet." : "Loading…"}</p>}
        </section>

        {shownTrack && shownTrack.points.some((p) => p.rssi != null) && (
          <section>
            <div className="eyebrow mb-1.5">Signal over the flight (dBFS)</div>
            <SignalProfile points={shownTrack.points} cursor={cursor} />
          </section>
        )}

        <section className="space-y-1.5">
          <div className="eyebrow mb-1">Aircraft</div>
          <Row k="Registration" v={ac?.registration ?? live?.registration} />
          <Row k="Type" v={ac ? [ac.type_code, ac.type_name].filter(Boolean).join(" · ") : (live?.type_code ?? flight?.type_code)} />
          <Row k="Operator" v={ac?.operator} />
          {flight && <Row k="First seen" v={fmtTs(flight.first_seen)} />}
          {flight && <Row k="Duration" v={fmtDuration(flight.first_seen, flight.last_seen)} />}
          {flight && <Row k="Altitude range" v={`${fmtAlt(flight.min_alt)} – ${fmtAlt(flight.max_alt)}`} />}
          {info && !ac && <p className="pt-1 text-[10.5px] leading-snug text-muted-foreground">No registry entry. Import the OpenSky aircraft database or enable online lookups.</p>}
        </section>

        <section className="grid grid-cols-2 gap-1.5">
          <Button size="sm" variant="outline" onClick={copyLink}>{note === "Link copied" ? <Check /> : <Copy />} Copy link</Button>
          <Button size="sm" variant="outline" onClick={watchAircraft}><Eye /> Watch aircraft</Button>
          {note && note !== "Link copied" && <p className="col-span-2 text-center text-[11px] text-muted-foreground">{note}</p>}
        </section>

        <section>
          <div className="eyebrow mb-1.5 flex items-center gap-1.5"><Video className="size-3" /> Camera</div>
          <div className="grid grid-cols-3 gap-1">
            {CAMS.map((c) => (
              <Button key={c.id} size="xs" variant={camMode === c.id ? "default" : "outline"} onClick={() => onCamMode(c.id)}>{c.label}</Button>
            ))}
          </div>
        </section>

        {flightId != null && (
          <section>
            <div className="eyebrow mb-1.5 flex items-center gap-1.5"><Download className="size-3" /> Export</div>
            <div className="grid grid-cols-2 gap-1.5">
              <Button size="sm" variant="outline" nativeButton={false} render={<a href={exportUrl(flightId, "kml")} download />}>KML · Google Earth</Button>
              <Button size="sm" variant="outline" nativeButton={false} render={<a href={exportUrl(flightId, "csv")} download />}>CSV</Button>
            </div>
          </section>
        )}

        <section>
          <div className="eyebrow mb-1.5 flex items-center gap-1.5">
            <History className="size-3" /> Flown before {past && <Badge variant="secondary" className="num">{past.length}</Badge>}
          </div>
          {past === null && flightId != null && <p className="text-xs text-muted-foreground">Checking the log…</p>}
          {past?.length === 0 && <p className="text-xs text-muted-foreground">No other logged flights for this callsign or airframe.</p>}
          <ul className="space-y-1">
            {past?.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-2 rounded-lg border bg-background/40 px-2.5 py-1.5 text-xs">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{fmtTs(f.first_seen)}</span>
                  <span className="num text-muted-foreground">{f.callsign ?? f.icao24.toUpperCase()} · {fmtDuration(f.first_seen, f.last_seen)}</span>
                </span>
                <Button size="xs" variant={overlayIds.has(f.id) ? "secondary" : "outline"} disabled={overlayIds.has(f.id)} onClick={() => onOverlay(f)}>
                  {overlayIds.has(f.id) ? "Shown" : "Overlay"}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
