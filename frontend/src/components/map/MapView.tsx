"use client";

import { useEffect, useRef } from "react";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

import { estimateAttitude, type Sample } from "@/lib/attitude";
import { ALIGN_EPOCH, FT_TO_M, fmtAlt, fmtDist } from "@/lib/format";
import { useUnits, type Units } from "@/lib/units";
import type { FlightTrack, Heat, LiveAircraft } from "@/lib/api";
import { modelFor } from "@/lib/aircraftType";
import { anchorOn, fillTag, layoutTags, type TagDetail } from "@/lib/tags";
import { applyCameraMode, attitudeQuaternion, type FollowMode } from "./orient";

if (typeof window !== "undefined") (window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = "/cesium";

export type MapTrack = { flight: FlightTrack; color: string };
export type Selection = { flightId: number | null; icao24: string } | null;
/** "free": the camera is yours; "orbit": Cesium keeps the aircraft centred; the rest are attached views. */
export type CamMode = "free" | "orbit" | FollowMode;
export type Layers = { trails: boolean; drops: boolean; labels: boolean; rings: boolean; routes: boolean; weather: boolean; heatmap: boolean; tags: boolean; dim: boolean; outlines: boolean; airports: boolean };
export type RouteEnd = { lat: number; lon: number; label: string };
export type RouteLine = { origin: RouteEnd; destination: RouteEnd };

type Props = {
  mode: "live" | "history";
  live: LiveAircraft[];
  tracks: MapTrack[];
  align: boolean; // history: start every flight at the same moment instead of real time
  selection: Selection;
  onSelect: (s: Selection) => void;
  receiver: { lat: number; lon: number } | null;
  /** Where Home/initial framing goes when no receiver position is configured (e.g. where traffic was first seen). */
  homeView: { lat: number; lon: number } | null;
  camMode: CamMode;
  layers: Layers;
  /** Origin/destination of the selected flight, drawn as a dashed great-circle arc. */
  route: RouteLine | null;
  heat: Heat | null; // reception density, drawn when the heatmap layer is on
  airport: { icao: string; lat: number; lon: number; elev_ft: number } | null;
  /** Projector mode: black map, no map furniture; only aircraft and their floating tags. */
  projector: boolean;
  tagDetail: TagDetail;
  frameSignal: number; // bump to fly the camera so all current traffic is in view
  homeSignal: number;
  onClock?: (ms: number) => void; // history replay time (ms since epoch), ~4 Hz
  onLiveAttitude?: (icao24: string, att: { pitch: number; roll: number }) => void;
};

type LiveState = {
  entity: Cesium.Entity;
  trailEntity: Cesium.Entity;
  dropEntity: Cesium.Entity;
  position: Cesium.SampledPositionProperty;
  orientation: Cesium.SampledProperty;
  trail: Cesium.Cartesian3[];
  drop: Cesium.Cartesian3[];
  color: Cesium.Color;
  bright: Cesium.Color; // the same hue, lighter and fully saturated: used for the glowing lines of projector mode
  lastSeen: string;
  prev?: Sample;
  pitch: number;
  roll: number;
  track: number;
  modelKey: string;
};

const MODEL_OPTS = { maximumScale: 20000 };
const pixelSize = (projector: boolean) => (projector ? 64 : 44);
/** Model for an aircraft: body shape from its type, colours from its airline, real length as scale. */
const modelOptions = (type: string | null | undefined, airline: string | null | undefined, projector = false) => {
  const m = modelFor(type, airline);
  return { uri: m.uri, scale: m.scale, minimumPixelSize: pixelSize(projector), ...MODEL_OPTS };
};
const LABEL_FONT = '600 12px "IBM Plex Mono", ui-monospace, monospace';
/** Range ring radii in km: round numbers in the unit system in use (nautical miles for aviation). */
const ringDistances = (units: Units) => (units === "metric" ? [50, 100, 200] : [25, 50, 100, 150].map((nm) => nm * 1.852));
const RING_MAX = 4; // ring ids are ring:0 .. ring:3; a metric set only uses the first three

const altHue = (ft: number | null) => 0.62 - Math.min(1, (ft ?? 0) / 40000) * 0.62;
const altColor = (ft: number | null) => Cesium.Color.fromHsl(altHue(ft), 0.9, 0.55);
const altBright = (ft: number | null) => Cesium.Color.fromHsl(altHue(ft), 1, 0.62);

/** Flight trail: a plain coloured line normally, a glowing bright one in projector mode. */
const trailMaterial = (st: { color: Cesium.Color; bright: Cesium.Color }, projector: boolean) =>
  projector
    ? new Cesium.PolylineGlowMaterialProperty({ color: new Cesium.CallbackProperty(() => st.bright, false), glowPower: 0.3, taperPower: 1 })
    : new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => st.color, false));

type Geo = {
  outlines?: Cesium.PolylineCollection;
  states?: Cesium.PolylineCollection;
  points?: Cesium.PointPrimitiveCollection;
  labels?: Cesium.LabelCollection;
  loading: Set<string>;
};

/** Border lines from a static file of flat [lon, lat, lon, lat, ...] arrays. Missing file = no layer. */
async function loadLines(url: string, css: string, width: number, prims: Cesium.PrimitiveCollection): Promise<Cesium.PolylineCollection | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const lines: number[][] = await res.json();
    const pc = new Cesium.PolylineCollection();
    const material = Cesium.Material.fromType("Color", { color: Cesium.Color.fromCssColorString(css) });
    for (const l of lines) {
      const withHeight: number[] = [];
      for (let i = 0; i < l.length; i += 2) withHeight.push(l[i], l[i + 1], 60); // a little above the surface: no z-fighting
      pc.add({ positions: Cesium.Cartesian3.fromDegreesArrayHeights(withHeight), width, material });
    }
    prims.add(pc);
    return pc;
  } catch {
    return undefined;
  }
}

/** Airports with an IATA code as dots; labels for international ones and everything near `home`. */
async function loadAirports(prims: Cesium.PrimitiveCollection, home: { lat: number; lon: number } | null) {
  try {
    const res = await fetch("/geo/airports.json");
    if (!res.ok) return undefined;
    const list: [string, string, string, number, number, number][] = await res.json();
    const points = new Cesium.PointPrimitiveCollection();
    const labels = new Cesium.LabelCollection();
    for (const [icao, iata, , lat, lon, intl] of list) {
      const pos = Cesium.Cartesian3.fromDegrees(lon, lat, 150); // above the surface so it never z-fights; still depth-tested, so the far side of the Earth stays hidden
      points.add({
        position: pos,
        pixelSize: intl ? 4 : 2.5,
        color: Cesium.Color.fromCssColorString(intl ? "#9fb3c8" : "#66788c"),
        translucencyByDistance: intl ? undefined : new Cesium.NearFarScalar(5e5, 1, 4e6, 0), // small fields only when zoomed in
      });
      const near = !!home && Math.abs(lat - home.lat) < 6 && Math.abs(lon - home.lon) < 6;
      if (intl || near)
        labels.add({
          position: pos,
          text: iata || icao,
          font: '600 10px "JetBrains Mono", monospace',
          fillColor: Cesium.Color.fromCssColorString("#aebccc"),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(6, -4),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, intl ? 1_600_000 : 500_000),
        });
    }
    prims.add(points);
    prims.add(labels);
    return { points, labels };
  } catch {
    return undefined;
  }
}
const label = (cs: string | null, icao: string, alt: number | null) => `${cs ?? icao.toUpperCase()}\n${fmtAlt(alt)}`;

function parseId(id: string | undefined): Selection {
  if (!id) return null;
  if (id.startsWith("live:")) return { flightId: null, icao24: id.slice(5) };
  if (id.startsWith("flight:") || id.startsWith("track:")) return { flightId: Number(id.split(":")[1]), icao24: "" };
  return null;
}

export default function MapView(props: Props) {
  const { mode, live, tracks, align, selection, receiver, homeView, camMode, homeSignal, route, heat, airport, layers, projector, tagDetail, frameSignal } = props;
  const tagsOn = mode === "live" && (projector || layers.tags);
  const units = useUnits();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const liveStore = useRef(new Map<string, LiveState>());
  const histIds = useRef<string[]>([]);
  const histKey = useRef("");
  const syncing = useRef(false);
  const onSelectRef = useRef(props.onSelect);
  const onClockRef = useRef(props.onClock);
  const onAttRef = useRef(props.onLiveAttitude);
  const selectionRef = useRef(selection);
  const layersRef = useRef(props.layers);
  const camModeRef = useRef<CamMode>(camMode);
  const camEntityRef = useRef<Cesium.Entity | undefined>(undefined);
  const tagsRoot = useRef<HTMLDivElement>(null);
  const tagStore = useRef(new Map<string, { el: HTMLDivElement; line: SVGLineElement; w: number; h: number }>());
  const tagsOnRef = useRef(tagsOn);
  const projectorRef = useRef(projector);
  const liveRef = useRef(live);
  const geoRef = useRef<Geo>({ loading: new Set() });
  const homeRef = useRef<{ lat: number; lon: number } | null>(null);
  useEffect(() => {
    // keep the latest callbacks/selection visible to long-lived Cesium listeners
    onSelectRef.current = props.onSelect;
    onClockRef.current = props.onClock;
    onAttRef.current = props.onLiveAttitude;
    selectionRef.current = selection;
    layersRef.current = props.layers;
    camModeRef.current = camMode;
    tagsOnRef.current = tagsOn;
    projectorRef.current = projector;
    liveRef.current = live;
    homeRef.current = receiver ?? homeView;
  });

  // --- viewer lifecycle -------------------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;
    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayer: new Cesium.ImageryLayer(
        new Cesium.UrlTemplateImageryProvider({
          url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          maximumLevel: 19,
          credit: "© OpenStreetMap contributors",
        }),
      ),
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      sceneModePicker: true,
      shouldAnimate: true,
    });
    viewerRef.current = viewer;
    if (process.env.NODE_ENV !== "production") (window as unknown as { __viewer?: Cesium.Viewer }).__viewer = viewer; // debugging aid
    viewer.selectedEntityChanged.addEventListener((e) => {
      if (syncing.current) return;
      onSelectRef.current(parseId(e?.id));
    });
    let lastEmit = 0;
    viewer.clock.onTick.addEventListener((clock) => {
      const now = performance.now();
      if (now - lastEmit < 250) return;
      lastEmit = now;
      onClockRef.current?.(Cesium.JulianDate.toDate(clock.currentTime).getTime());
    });
    const detachCamera = viewer.scene.preRender.addEventListener(() => {
      const m = camModeRef.current, e = camEntityRef.current;
      if (!e || m === "free" || m === "orbit") return;
      const t = viewer.clock.currentTime;
      const pos = e.position?.getValue(t), q = e.orientation?.getValue(t) as Cesium.Quaternion | undefined;
      if (pos && q) applyCameraMode(viewer.camera, m, pos, q);
    });
    // floating tags follow their aircraft: recomputed after every rendered frame
    const positionTags = () => {
      const tags = tagStore.current;
      if (!tags.size) return;
      const scene = viewer.scene, now = viewer.clock.currentTime;
      const W = scene.canvas.clientWidth, H = scene.canvas.clientHeight;
      const occluder = new Cesium.Occluder(new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, Cesium.Ellipsoid.WGS84.minimumRadius), scene.camera.positionWC); // the globe, as seen from the camera
      const visible: { id: string; ax: number; ay: number; w: number; h: number }[] = [];
      for (const [id, tg] of tags) {
        const pos = liveStore.current.get(id)?.entity.position?.getValue(now);
        const p = pos && occluder.isPointVisible(pos) ? scene.cartesianToCanvasCoordinates(pos) : undefined;
        if (p && p.x > -40 && p.x < W + 40 && p.y > -40 && p.y < H + 40) visible.push({ id, ax: p.x, ay: p.y, w: tg.w, h: tg.h });
        else {
          tg.el.style.visibility = "hidden";
          tg.line.style.display = "none";
        }
      }
      const place = layoutTags(visible, W, H);
      for (const b of visible) {
        const tg = tags.get(b.id)!, pl = place.get(b.id)!;
        const [x2, y2] = anchorOn(pl, b.w, b.h, b.ax, b.ay);
        tg.el.style.visibility = "visible";
        tg.el.style.transform = `translate(${pl.x.toFixed(1)}px, ${pl.y.toFixed(1)}px)`;
        tg.line.style.display = "";
        tg.line.setAttribute("x1", b.ax.toFixed(1));
        tg.line.setAttribute("y1", b.ay.toFixed(1));
        tg.line.setAttribute("x2", x2.toFixed(1));
        tg.line.setAttribute("y2", y2.toFixed(1));
      }
    };
    viewer.scene.postRender.addEventListener(positionTags);
    const tagRefs = tagStore.current;
    const store = liveStore.current;
    return () => {
      viewer.scene.postRender.removeEventListener(positionTags);
      for (const t of tagRefs.values()) {
        t.el.remove();
        t.line.remove();
      }
      tagRefs.clear();
      geoRef.current = { loading: new Set() }; // the collections go with the viewer
      detachCamera();
      store.clear();
      histIds.current = [];
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  // --- mode switch: reset clock + widgets, drop the other mode's entities -----------------------
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    for (const s of liveStore.current.values()) {
      v.entities.remove(s.entity);
      v.entities.remove(s.trailEntity);
      v.entities.remove(s.dropEntity);
    }
    liveStore.current.clear();
    for (const id of histIds.current) v.entities.removeById(id);
    histIds.current = [];
    histKey.current = "";
    v.trackedEntity = undefined;
    const isLive = mode === "live";
    (v.animation.container as HTMLElement).style.display = isLive ? "none" : "";
    (v.timeline.container as HTMLElement).style.display = isLive ? "none" : "";
    if (isLive) {
      v.clock.clockRange = Cesium.ClockRange.UNBOUNDED;
      v.clock.multiplier = 1;
      v.clock.currentTime = Cesium.JulianDate.now();
      v.clock.shouldAnimate = true;
    } else {
      v.clock.shouldAnimate = false;
    }
  }, [mode]);

  // --- receiver marker + range rings (labelled; shown in projector mode too) -----------------------
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || !receiver) return;
    const km = ringDistances(units);
    const ids = ["receiver", ...km.flatMap((_, i) => [`ring:${i}`, `ringlabel:${i}`])];
    const centre = Cesium.Cartesian3.fromDegrees(receiver.lon, receiver.lat, 60);
    const lime = Cesium.Color.LIME;
    const showRings = layersRef.current.rings || projectorRef.current;
    v.entities.add({
      id: "receiver",
      position: centre,
      point: { pixelSize: 9, color: lime, outlineColor: Cesium.Color.BLACK, outlineWidth: 1 },
      label: {
        text: "RX", font: LABEL_FONT, fillColor: lime, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -16),
      },
    });
    const cosLat = Math.max(0.05, Math.cos((receiver.lat * Math.PI) / 180));
    km.forEach((r, i) => {
      // a circle of points at distance r (flat-earth arithmetic is plenty accurate within a few hundred km)
      const pts = Array.from({ length: 145 }, (_, k) => {
        const t = (k / 144) * 2 * Math.PI;
        return Cesium.Cartesian3.fromDegrees(receiver.lon + (r / (111.32 * cosLat)) * Math.sin(t), receiver.lat + (r / 110.57) * Math.cos(t), 60);
      });
      v.entities.add({
        id: `ring:${i}`,
        show: showRings,
        polyline: { positions: new Cesium.CallbackProperty(() => pts, false), width: 1.5, material: lime.withAlpha(0.55) },
      });
      v.entities.add({
        id: `ringlabel:${i}`,
        show: showRings,
        position: Cesium.Cartesian3.fromDegrees(receiver.lon, receiver.lat + r / 110.57, 60), // top of the ring
        label: {
          text: fmtDist(r), font: LABEL_FONT, fillColor: lime.withAlpha(0.85), outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE, verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -3),
        },
      });
    });
    return () => {
      if (v.isDestroyed()) return; // the viewer effect's cleanup runs first on unmount
      for (const id of ids) v.entities.removeById(id);
    };
  }, [receiver, units]);

  // start looking at the receiver (once per receiver position; changing units must not move the camera)
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || !receiver) return;
    v.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(receiver.lon, receiver.lat - 1.0, 220000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-40), roll: 0 },
      duration: 0,
    });
  }, [receiver]);

  const home = receiver ?? homeView;
  const framedHome = useRef(false);
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || !home) return;
    const fly = (duration?: number) =>
      v.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(home.lon, home.lat - 1.0, 220000),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-40), roll: 0 },
        duration,
      });
    if (homeSignal > 0) {
      v.trackedEntity = undefined;
      camEntityRef.current = undefined;
      fly();
    } else if (!receiver && !framedHome.current) {
      framedHome.current = true; // frame the first traffic seen, once
      fly(1.5);
    }
  }, [homeSignal, home, receiver]);

  // --- origin / destination of the selected flight ---------------------------------------------
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || !route || projector) return;
    const ids = ["route:line", "route:origin", "route:dest"];
    const at = (e: RouteEnd) => Cesium.Cartesian3.fromDegrees(e.lon, e.lat, 0);
    // Great-circle points computed here and fed through a CallbackProperty, like the trails: that path
    // draws immediately instead of waiting on asynchronous geometry workers. Slightly raised so the
    // chords between points never dip below the globe surface.
    const geo = new Cesium.EllipsoidGeodesic(
      Cesium.Cartographic.fromDegrees(route.origin.lon, route.origin.lat),
      Cesium.Cartographic.fromDegrees(route.destination.lon, route.destination.lat),
    );
    const N = 96;
    const arc = Array.from({ length: N + 1 }, (_, i) => {
      const c = geo.interpolateUsingFraction(i / N);
      return Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, 250);
    });
    // amber dashes on dark gaps stay readable over both pale sea and dark land
    const dashed = () =>
      new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.fromCssColorString("#fbbf24"),
        gapColor: Cesium.Color.BLACK.withAlpha(0.45),
        dashLength: 20,
      });
    v.entities.add({
      id: "route:line",
      show: layersRef.current.routes,
      polyline: {
        positions: new Cesium.CallbackProperty(() => arc, false),
        width: 3.5,
        material: dashed(),
        depthFailMaterial: dashed(),
      },
    });
    [["route:origin", route.origin, Cesium.Color.LIME], ["route:dest", route.destination, Cesium.Color.ORANGE]].forEach(([id, end, color]) => {
      const e = end as RouteEnd;
      v.entities.add({
        id: id as string,
        show: layersRef.current.routes,
        position: at(e),
        point: { pixelSize: 10, color: color as Cesium.Color, outlineColor: Cesium.Color.BLACK, outlineWidth: 2 },
        label: {
          text: e.label,
          font: LABEL_FONT,
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -18),
        },
      });
    });
    return () => {
      if (v.isDestroyed()) return;
      for (const id of ids) v.entities.removeById(id);
    };
  }, [route, projector]);

  // --- airport marker ---------------------------------------------------------------------------
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || !airport) return;
    const e = v.entities.add({
      id: "airport",
      position: Cesium.Cartesian3.fromDegrees(airport.lon, airport.lat, airport.elev_ft * FT_TO_M),
      point: { pixelSize: 9, color: Cesium.Color.DEEPSKYBLUE, outlineColor: Cesium.Color.BLACK, outlineWidth: 2 },
      label: {
        text: airport.icao,
        font: LABEL_FONT,
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -16),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2_000_000),
      },
    });
    return () => {
      if (!v.isDestroyed()) v.entities.remove(e);
    };
  }, [airport]);

  // --- weather radar (RainViewer tiles; the service only serves up to zoom 7, Cesium upscales) --
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || !layers.weather || projector) return;
    let cancelled = false;
    let layer: Cesium.ImageryLayer | undefined;
    const load = async () => {
      try {
        const j = await (await fetch("https://api.rainviewer.com/public/weather-maps.json")).json();
        const frame = j.radar?.past?.at(-1);
        if (!frame || cancelled || v.isDestroyed()) return;
        const next = v.imageryLayers.addImageryProvider(
          new Cesium.UrlTemplateImageryProvider({
            url: `${j.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`,
            maximumLevel: 7,
            credit: "Weather radar © RainViewer",
          }),
        );
        next.alpha = 0.65;
        if (layer) v.imageryLayers.remove(layer);
        layer = next;
      } catch {
        /* offline or blocked: the map simply has no radar */
      }
    };
    void load();
    const timer = setInterval(load, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (layer && !v.isDestroyed()) v.imageryLayers.remove(layer);
    };
  }, [layers.weather, projector]);

  // --- reception heatmap: cells painted onto a canvas, draped over the area as one image -------
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || !layers.heatmap || projector || !heat || heat.cells.length === 0) return;
    const c = heat.cell;
    const lats = heat.cells.map((x) => x[0]), lons = heat.cells.map((x) => x[1]);
    const south = Math.min(...lats) - c / 2, north = Math.max(...lats) + c / 2;
    const west = Math.min(...lons) - c / 2, east = Math.max(...lons) + c / 2;
    const cols = Math.max(1, Math.round((east - west) / c)), rows = Math.max(1, Math.round((north - south) / c));
    const px = Math.max(1, Math.min(6, Math.floor(2048 / Math.max(cols, rows))));
    const canvas = document.createElement("canvas");
    canvas.width = cols * px;
    canvas.height = rows * px;
    const g = canvas.getContext("2d");
    if (!g) return;
    const norm = Math.log(1 + heat.max) || 1;
    for (const [lat, lon, n] of heat.cells) {
      const t = Math.log(1 + n) / norm;
      g.fillStyle = `hsla(${Math.round((1 - t) * 240)}, 95%, 55%, ${(0.25 + 0.6 * t).toFixed(2)})`; // blue (rare) to red (busy)
      g.fillRect(Math.round((lon - c / 2 - west) / c) * px, Math.round((north - (lat + c / 2)) / c) * px, px, px);
    }
    const e = v.entities.add({
      id: "heatmap",
      rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(west, south, east, north),
        material: new Cesium.ImageMaterialProperty({ image: canvas, transparent: true }),
        height: 30, // a little above the surface so it never z-fights with the map
      },
    });
    return () => {
      if (!v.isDestroyed()) v.entities.remove(e);
    };
  }, [layers.heatmap, heat, projector]);

  // --- live aircraft ----------------------------------------------------------------------------
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || mode !== "live") return;
    const store = liveStore.current;
    const now = Cesium.JulianDate.now();
    // Background tabs throttle animation frames, letting the clock fall behind wall time; resync so
    // the interpolated positions (stamped in wall time) don't freeze.
    if (Math.abs(Cesium.JulianDate.secondsDifference(v.clock.currentTime, now)) > 3) v.clock.currentTime = now.clone();
    const tNext = Cesium.JulianDate.addSeconds(now, 1, new Cesium.JulianDate());
    const seen = new Set<string>();

    for (const ac of live) {
      seen.add(ac.icao24);
      const pos = Cesium.Cartesian3.fromDegrees(ac.lon, ac.lat, (ac.alt ?? 0) * FT_TO_M);
      let st = store.get(ac.icao24);
      if (!st) {
        const position = new Cesium.SampledPositionProperty();
        position.setInterpolationOptions({ interpolationDegree: 1, interpolationAlgorithm: Cesium.LinearApproximation });
        position.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
        position.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
        const orientation = new Cesium.SampledProperty(Cesium.Quaternion);
        orientation.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
        orientation.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
        const created: LiveState = {
          entity: undefined as unknown as Cesium.Entity,
          trailEntity: undefined as unknown as Cesium.Entity,
          dropEntity: undefined as unknown as Cesium.Entity,
          position, orientation, trail: [], drop: [pos, pos], color: altColor(ac.alt), bright: altBright(ac.alt), lastSeen: "", pitch: 0, roll: 0,
          track: ac.track ?? 0,
          modelKey: modelFor(ac.type_code, ac.airline?.icao).key,
        };
        created.entity = v.entities.add({
          id: `live:${ac.icao24}`,
          position,
          orientation: orientation as unknown as Cesium.Property,
          model: modelOptions(ac.type_code, ac.airline?.icao, projectorRef.current),
          label: {
            show: layersRef.current.labels && !tagsOnRef.current,
            font: LABEL_FONT,
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -30),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 900000),
          },
        });
        created.trailEntity = v.entities.add({
          id: `livetrail:${ac.icao24}`,
          show: layersRef.current.trails,
          polyline: {
            positions: new Cesium.CallbackProperty(() => created.trail, false),
            width: projectorRef.current ? 5 : 2.5,
            material: trailMaterial(created, projectorRef.current),
          },
        });
        created.dropEntity = v.entities.add({
          id: `livedrop:${ac.icao24}`,
          show: layersRef.current.drops,
          polyline: {
            positions: new Cesium.CallbackProperty(() => created.drop, false),
            width: 1,
            material: Cesium.Color.WHITE.withAlpha(projectorRef.current ? 0.45 : 0.25),
          },
        });
        store.set(ac.icao24, created);
        st = created;
      }
      const s = st;
      s.entity.label!.text = new Cesium.ConstantProperty(label(ac.callsign, ac.icao24, ac.alt));
      // the type arrives after the first sighting (registry lookup): swap to the right body shape
      const mk = modelFor(ac.type_code, ac.airline?.icao);
      if (mk.key !== s.modelKey && s.entity.model) {
        s.modelKey = mk.key;
        s.entity.model.uri = new Cesium.ConstantProperty(mk.uri);
        s.entity.model.scale = new Cesium.ConstantProperty(mk.scale);
      }
      if (s.entity.label)
        s.entity.label.fillColor = new Cesium.ConstantProperty(ac.emergency ? Cesium.Color.RED : ac.watched ? Cesium.Color.GOLD : Cesium.Color.WHITE);
      if (ac.last_seen === s.lastSeen) continue; // no new data: keep holding last position
      s.lastSeen = ac.last_seen;

      const sample: Sample = { t: Date.parse(ac.last_seen), alt: ac.alt, gs: ac.gs, track: ac.track, vrate: ac.vrate };
      const att = estimateAttitude(s.prev, sample);
      s.pitch += (att.pitch - s.pitch) * 0.3;
      s.roll += (att.roll - s.roll) * 0.25;
      s.prev = sample;
      if (selectionRef.current?.icao24 === ac.icao24) onAttRef.current?.(ac.icao24, { pitch: s.pitch, roll: s.roll });
      if (ac.track != null) s.track = ac.track;

      s.position.addSample(tNext, pos);
      s.orientation.addSample(tNext, attitudeQuaternion(pos, s.track, s.pitch, s.roll));
      s.trail.push(pos);
      if (s.trail.length > 400) s.trail.shift();
      s.drop = [pos, Cesium.Cartesian3.fromDegrees(ac.lon, ac.lat, 0)];
      s.color = altColor(ac.alt);
      s.bright = altBright(ac.alt);
      const stale = Cesium.JulianDate.addSeconds(tNext, -30, new Cesium.JulianDate());
      s.position.removeSamples(new Cesium.TimeInterval({ start: Cesium.JulianDate.fromDate(new Date(0)), stop: stale }));
      s.orientation.removeSamples(new Cesium.TimeInterval({ start: Cesium.JulianDate.fromDate(new Date(0)), stop: stale }));
    }
    for (const [icao, s] of store) {
      if (seen.has(icao)) continue;
      v.entities.remove(s.entity);
      v.entities.remove(s.trailEntity);
      v.entities.remove(s.dropEntity);
      store.delete(icao);
    }
  }, [live, mode]);

  // --- history overlay --------------------------------------------------------------------------
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || mode !== "history") return;
    // Rebuilding removes the selected entity, which Cesium reports as a deselect; that must not
    // clear the app's selection (the selection effect below re-selects the new entity).
    syncing.current = true;
    for (const id of histIds.current) v.entities.removeById(id);
    syncing.current = false;
    histIds.current = [];
    const usable = tracks.filter((t) => t.flight.points.length > 0);
    if (!usable.length) return;

    let minT = Infinity, maxT = -Infinity;
    const paths: Cesium.Entity[] = [];
    for (const { flight, color } of usable) {
      const t0 = Date.parse(flight.points[0].ts);
      const times = flight.points.map((p) => (align ? ALIGN_EPOCH + (Date.parse(p.ts) - t0) : Date.parse(p.ts)));
      minT = Math.min(minT, times[0]);
      maxT = Math.max(maxT, times[times.length - 1]);
      const col = Cesium.Color.fromCssColorString(color);

      const position = new Cesium.SampledPositionProperty();
      position.setInterpolationOptions({ interpolationDegree: 1, interpolationAlgorithm: Cesium.LinearApproximation });
      const orientation = new Cesium.SampledProperty(Cesium.Quaternion);
      const flat: number[] = [];
      let track = flight.points.find((p) => p.track != null)?.track ?? 0;
      flight.points.forEach((p, i) => {
        const cart = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, (p.alt ?? 0) * FT_TO_M);
        const jd = Cesium.JulianDate.fromDate(new Date(times[i]));
        if (p.track != null) track = p.track;
        position.addSample(jd, cart);
        orientation.addSample(jd, attitudeQuaternion(cart, track, p.pitch, p.roll));
        flat.push(p.lon, p.lat, (p.alt ?? 0) * FT_TO_M);
      });

      const pathId = `track:${flight.id}`;
      paths.push(
        v.entities.add({
          id: pathId,
          show: layersRef.current.trails,
          polyline: { positions: Cesium.Cartesian3.fromDegreesArrayHeights(flat), width: 3, material: col.withAlpha(0.85) },
        }),
      );
      const start = Cesium.JulianDate.fromDate(new Date(times[0]));
      const stop = Cesium.JulianDate.fromDate(new Date(times[times.length - 1]));
      v.entities.add({
        id: `flight:${flight.id}`,
        availability: new Cesium.TimeIntervalCollection([new Cesium.TimeInterval({ start, stop })]),
        position,
        orientation: orientation as unknown as Cesium.Property,
        model: modelOptions(flight.type_code, flight.airline?.icao),
        label: {
          show: layersRef.current.labels,
          text: flight.callsign ?? flight.icao24.toUpperCase(),
          font: LABEL_FONT,
          fillColor: col,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -30),
        },
      });
      histIds.current.push(pathId, `flight:${flight.id}`);
    }

    const start = Cesium.JulianDate.fromDate(new Date(minT));
    const stop = Cesium.JulianDate.fromDate(new Date(maxT));
    v.clock.startTime = start;
    v.clock.stopTime = stop;
    v.clock.currentTime = start;
    v.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
    v.clock.multiplier = Math.max(1, (maxT - minT) / 1000 / 60); // whole overlay plays in about a minute
    v.clock.shouldAnimate = false;
    v.timeline.zoomTo(start, stop);

    const key = usable.map((t) => t.flight.id).sort().join(",");
    if (key !== histKey.current) {
      histKey.current = key;
      v.flyTo(paths, { duration: 1.2 });
    }
  }, [tracks, align, mode]);

  // --- selection highlight + follow -------------------------------------------------------------
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const id = selection
      ? mode === "live" && selection.icao24
        ? `live:${selection.icao24}`
        : selection.flightId != null
          ? `flight:${selection.flightId}`
          : undefined
      : undefined;
    const entity = id ? v.entities.getById(id) : undefined;
    syncing.current = true;
    v.selectedEntity = entity;
    syncing.current = false;
    camEntityRef.current = entity;
    v.trackedEntity = camMode === "orbit" && entity ? entity : undefined;
    for (const { flight } of tracks) {
      const p = v.entities.getById(`track:${flight.id}`)?.polyline;
      if (p) p.width = new Cesium.ConstantProperty(selection?.flightId === flight.id ? 6 : 3);
    }
  }, [selection, camMode, mode, tracks]);

  // --- layer toggles ----------------------------------------------------------------------------
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    for (const s of liveStore.current.values()) {
      if (s.entity.label) s.entity.label.show = new Cesium.ConstantProperty(layers.labels && !tagsOn);
      s.trailEntity.show = layers.trails;
      s.dropEntity.show = layers.drops;
    }
    for (const id of histIds.current) {
      const e = v.entities.getById(id);
      if (!e) continue;
      if (id.startsWith("track:")) e.show = layers.trails;
      else if (e.label) e.label.show = new Cesium.ConstantProperty(layers.labels && !tagsOn);
    }
    for (let i = 0; i < RING_MAX; i++)
      for (const id of [`ring:${i}`, `ringlabel:${i}`]) {
        const ring = v.entities.getById(id);
        if (ring) ring.show = layers.rings || projector; // the rings are part of the projector picture
      }
    for (const id of ["route:line", "route:origin", "route:dest"]) {
      const r = v.entities.getById(id);
      if (r) r.show = layers.routes && !projector;
    }
  }, [layers, tracks, mode, tagsOn, projector]);

  // --- projector mode: black map, no sky or lighting, receiver and airport markers hidden ------------
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const sc = v.scene, g = sc.globe, base = v.imageryLayers.get(0);
    if (base) {
      base.show = !projector; // no streets, no city
      base.brightness = layers.dim ? 0.55 : 1; // developer theme: a dimmed map
      base.saturation = layers.dim ? 0.4 : 1;
      base.contrast = layers.dim ? 1.15 : 1;
    }
    g.baseColor = projector ? Cesium.Color.BLACK : Cesium.Color.BLUE;
    g.showGroundAtmosphere = !projector;
    g.enableLighting = false;
    sc.backgroundColor = Cesium.Color.BLACK;
    if (sc.skyBox) sc.skyBox.show = !projector;
    if (sc.skyAtmosphere) sc.skyAtmosphere.show = !projector;
    if (sc.sun) sc.sun.show = !projector;
    if (sc.moon) sc.moon.show = !projector;
    sc.fog.enabled = !projector;
    for (const st of liveStore.current.values()) {
      if (st.entity.model) st.entity.model.minimumPixelSize = new Cesium.ConstantProperty(pixelSize(projector));
      if (st.trailEntity.polyline) {
        st.trailEntity.polyline.material = trailMaterial(st, projector); // glowing bright lines in projector mode
        st.trailEntity.polyline.width = new Cesium.ConstantProperty(projector ? 5 : 2.5);
      }
      if (st.dropEntity.polyline) st.dropEntity.polyline.material = new Cesium.ColorMaterialProperty(Cesium.Color.WHITE.withAlpha(projector ? 0.45 : 0.25));
    }
  }, [projector, layers.dim]);

  // --- map outlines and airports: static data, loaded the first time they are wanted ------------------
  const showOutlines = projector || layers.outlines;
  const showAirports = projector || layers.airports;
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const g = geoRef.current, prims = v.scene.primitives;
    const want = async (key: string, build: () => Promise<void>) => {
      if (g.loading.has(key)) return;
      g.loading.add(key);
      await build();
    };
    if (showOutlines) {
      if (g.outlines) g.outlines.show = true;
      else void want("outlines", async () => {
        g.outlines = await loadLines("/geo/countries.json", projectorRef.current ? "#56677c" : "#6b7c90", 1.3, prims);
        if (g.outlines) g.outlines.show = true;
      });
      if (g.states) g.states.show = true;
      else void want("states", async () => {
        g.states = await loadLines("/geo/states.json", "#38465a", 1, prims); // optional file: no states layer without it
        if (g.states) g.states.show = true;
      });
    } else {
      if (g.outlines) g.outlines.show = false;
      if (g.states) g.states.show = false;
    }
    if (showAirports) {
      if (g.points && g.labels) {
        g.points.show = true;
        g.labels.show = true;
      } else void want("airports", async () => {
        const a = await loadAirports(prims, homeRef.current);
        if (a) {
          g.points = a.points;
          g.labels = a.labels;
        }
      });
    } else {
      if (g.points) g.points.show = false;
      if (g.labels) g.labels.show = false;
    }
  }, [showOutlines, showAirports]);

  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const e = v.entities.getById("airport"); // the airport dots and codes replace this single marker
    if (e) e.show = !projector;
  }, [projector, receiver, airport]);

  // --- floating tags: build/refresh their contents whenever the data changes ------------------------
  useEffect(() => {
    const root = tagsRoot.current;
    const svg = root?.querySelector("svg");
    const store = tagStore.current;
    if (!root || !svg) return;
    if (!tagsOn) {
      for (const t of store.values()) {
        t.el.remove();
        t.line.remove();
      }
      store.clear();
      return;
    }
    const seen = new Set<string>();
    for (const ac of live) {
      seen.add(ac.icao24);
      let t = store.get(ac.icao24);
      if (!t) {
        const el = document.createElement("div");
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        root.appendChild(el);
        svg.appendChild(line);
        t = { el, line, w: 0, h: 0 };
        store.set(ac.icao24, t);
      }
      t.el.onclick = () => onSelectRef.current({ flightId: null, icao24: ac.icao24 });
      fillTag(t.el, ac, tagDetail, selection?.icao24 === ac.icao24);
      t.w = t.el.offsetWidth;
      t.h = t.el.offsetHeight;
    }
    for (const [icao, t] of store) {
      if (seen.has(icao)) continue;
      t.el.remove();
      t.line.remove();
      store.delete(icao);
    }
  }, [live, tagsOn, tagDetail, selection]);

  // --- fit all current traffic (projector mode: "frame everything") ---------------------------------
  useEffect(() => {
    const v = viewerRef.current;
    const list = liveRef.current;
    if (!v || frameSignal === 0 || list.length === 0) return;
    v.trackedEntity = undefined;
    camEntityRef.current = undefined;
    const lons = list.map((a) => a.lon), lats = list.map((a) => a.lat);
    const pad = (span: number) => Math.max(0.15, span * 0.25);
    const dLon = Math.max(...lons) - Math.min(...lons), dLat = Math.max(...lats) - Math.min(...lats);
    v.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(
        Math.min(...lons) - pad(dLon), Math.min(...lats) - pad(dLat), Math.max(...lons) + pad(dLon), Math.max(...lats) + pad(dLat),
      ),
      duration: 1.2,
    });
  }, [frameSignal]);

  return (
    <>
      <div ref={containerRef} className="absolute inset-0" />
      <div ref={tagsRoot} className="tags-layer">
        <svg className="tags-lines" aria-hidden />
      </div>
    </>
  );
}
