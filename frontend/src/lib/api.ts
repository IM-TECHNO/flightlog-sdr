/** Backend address: `?api=http://host:8000` in the page URL wins, then NEXT_PUBLIC_API_URL, then this page's host on port 8000. */
const apiFromUrl = () => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("api"));
// Default: the same host the page was opened from, port 8000, so a phone on the home network reaches your PC.
const defaultApi = () => (typeof window === "undefined" ? "http://localhost:8000" : `${window.location.protocol}//${window.location.hostname}:8000`);
export const API = apiFromUrl() ?? process.env.NEXT_PUBLIC_API_URL ?? defaultApi();

export type Airline = { icao: string; name: string | null } | null;

export type Flight = {
  id: number;
  icao24: string;
  callsign: string | null;
  first_seen: string;
  last_seen: string;
  msg_count: number;
  max_alt: number | null;
  min_alt: number | null;
  country: string | null;
  airline: Airline;
  type_code?: string | null;
};

export type TrackPoint = {
  ts: string;
  lat: number;
  lon: number;
  alt: number | null;
  gs: number | null;
  track: number | null;
  vrate: number | null;
  rssi?: number | null;
  pitch: number;
  roll: number;
};

export type FlightTrack = Flight & { points: TrackPoint[] };

export type LiveAircraft = {
  flight_id: number | null;
  icao24: string;
  callsign: string | null;
  lat: number;
  lon: number;
  alt: number | null;
  gs: number | null;
  track: number | null;
  vrate: number | null;
  flight_seq: number;
  last_seen: string;
  route: Route | null;
  squawk: string | null;
  emergency: string | null;
  watched: boolean;
  on_ground: boolean | null;
  type_code: string | null;
  registration: string | null;
  rssi: number | null; // dBFS, when the decoder reports it
  msg_rate: number | null; // messages per second
  country: string | null;
  airline: Airline;
};

export type Airport = {
  icao: string | null;
  iata: string | null;
  name: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
};
export type Route = { origin: Airport; destination: Airport };
export type FlightInfo = {
  country: string | null;
  airline: Airline;
  aircraft: {
    registration: string | null;
    type_code: string | null;
    type_name: string | null;
    manufacturer: string | null;
    operator: string | null;
  } | null;
  route: Route | null;
};

export type AppConfig = {
  receiver: { lat: number; lon: number };
  enrich_online: boolean;
  airport: { icao: string; name: string; lat: number; lon: number; elev_ft: number } | null;
  signal_available: boolean;
};

async function send<T>(method: "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `${path}: ${res.status}`);
  return res.json();
}

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

export const getConfig = () => get<AppConfig>("/api/config");
/** Contacts with fewer messages than this are stray edge-of-range pings and are hidden by default. */
export const MIN_MSGS = 5;
export const getFlights = (p: { start?: string; end?: string; q?: string; limit?: number; min_msgs?: number }) =>
  get<Flight[]>("/api/flights", p);
export const getTrack = (id: number) => get<FlightTrack>(`/api/flights/${id}/track`);
export const getInfo = (id: number) => get<FlightInfo>(`/api/flights/${id}/info`);
export const getHistory = (id: number) => get<Flight[]>(`/api/flights/${id}/history`);
export const liveSocketUrl = () => API.replace(/^http/, "ws") + "/api/ws/live";

export type Stats = {
  days: number;
  totals: { flights: number; aircraft: number; positions: number };
  daily: { date: string; flights: number }[];
  hourly: number[];
  altitude: { label: string; flights: number }[];
  airlines: { name: string; flights: number }[];
  frequent: { icao24: string; callsign: string | null; flights: number }[];
  farthest: { km: number; flight_id: number; callsign: string | null; icao24: string | null; alt: number | null } | null;
  longest: { flight_id: number; callsign: string | null; icao24: string; seconds: number } | null;
  highest: { flight_id: number; callsign: string | null; icao24: string; alt: number } | null;
};

/** `tz` shifts the hour/day buckets to the browser's local time. */
export const getStats = (days: number) => get<Stats>("/api/stats", { days, tz: -new Date().getTimezoneOffset(), min_msgs: MIN_MSGS });
export const exportUrl = (id: number, format: "kml" | "csv") => `${API}/api/flights/${id}/export?format=${format}`;

export type Alert = { id: number; ts: string; kind: "emergency" | "watch"; icao24: string; callsign: string | null; flight_id: number | null; detail: string };
export type WatchEntry = { id: number; kind: "callsign" | "icao24" | "airline"; value: string; label: string | null };
export const getAlerts = (after = 0) => get<Alert[]>("/api/alerts", { after });
export const getWatchlist = () => get<WatchEntry[]>("/api/watchlist");
export const addWatch = (kind: WatchEntry["kind"], value: string, label?: string) => send<WatchEntry>("POST", "/api/watchlist", { kind, value, label });
export const deleteWatch = (id: number) => send<{ ok: boolean }>("DELETE", `/api/watchlist/${id}`);

export type Coverage =
  | { enabled: false }
  | { enabled: true; receiver: { lat: number; lon: number }; bins: { bearing: number; max_km: number; count: number }[]; max_km: number; positions: number };
export type Heat = { cell: number; cells: [number, number, number][]; max: number };
export const getCoverage = (days = 30) => get<Coverage>("/api/coverage", { days });
export const getHeatmap = (days = 30, cell = 0.02) => get<Heat>("/api/heatmap", { days, cell });

export type Movement = { flight_id: number; callsign: string | null; icao24: string; kind: "arrival" | "departure"; time: string; go_around: boolean; runway: string | null; min_agl_ft: number | null };
export type AirportActivity =
  | { enabled: false }
  | {
      enabled: true;
      airport: { icao: string; name: string; lat: number; lon: number; elev_ft: number };
      days: number;
      summary: { arrivals: number; departures: number; go_arounds: number; by_runway: Record<string, number> };
      movements: Movement[];
    };
export const getAirport = (days = 7) => get<AirportActivity>("/api/airport", { days, min_msgs: MIN_MSGS });

export type Photo = { available: boolean; src?: string; link?: string; photographer?: string; reason?: string };
export const getPhoto = (icao24: string) => get<Photo>(`/api/photo/${icao24}`);

export type DbInfo = { size_bytes: number | null; flights: number; positions: number; oldest: string | null; newest: string | null; retention_days: number; thin_keep_seconds: number };
export const getDbInfo = () => get<DbInfo>("/api/db");

export type Replay = { stride: number; flights: FlightTrack[] };
export const getReplay = (start: string, end: string) => get<Replay>("/api/replay", { start, end, min_msgs: MIN_MSGS });

export type ReceiverStatus = {
  controllable: boolean;
  reason: string | null;
  decoder: { running: boolean; pid: number | null };
  cfg_path: string | null;
  gain: number | null; // dB in dump1090.cfg
  gain_max: number;
  signal: { aircraft: number; median: number | null; strongest: number | null; weakest: number | null; strong: number; msg_rate: number };
  verdict: { level: "ok" | "high" | "low" | "unknown"; text: string };
  history: { gain: number; minutes: number; avg_aircraft: number; avg_msg_rate: number; avg_rssi: number | null; best_km: number | null }[];
};
export type GainResult = { applied: boolean; restarted: boolean; previous: number | null; gain: number | null; message: string; status: ReceiverStatus };
export const getReceiver = () => get<ReceiverStatus>("/api/receiver");
export const setReceiverGain = (gain: number, restart: boolean) => send<GainResult>("POST", "/api/receiver/gain", { gain, restart });
