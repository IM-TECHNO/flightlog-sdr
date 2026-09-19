import { getUnits } from "./units";

export const FT_TO_M = 0.3048;
// Start instant used when history flights are replayed time-aligned instead of in real time.
export const ALIGN_EPOCH = Date.parse("2000-01-01T00:00:00Z");

// Every formatter reads the current unit system (see units.ts), so a toggle changes all readouts at once.
const metric = () => getUnits() === "metric";
const M_PER_FT = 0.3048, KMH_PER_KT = 1.852, MS_PER_FPM = 0.00508;

export function fmtAlt(ft: number | null | undefined): string {
  if (ft == null) return "—";
  if (metric()) return `${Math.round(ft * M_PER_FT).toLocaleString()} m`;
  return ft >= 18000 ? `FL${Math.round(ft / 100)}` : `${ft.toLocaleString()} ft`;
}

/** Number and unit separately, for large readouts. */
export const altValue = (ft: number) => (metric() ? Math.round(ft * M_PER_FT) : ft).toLocaleString();
export const altUnit = () => (metric() ? "m" : "ft");
export const speedValue = (kt: number) => String(Math.round(metric() ? kt * KMH_PER_KT : kt));
export const speedUnit = () => (metric() ? "km/h" : "kt");
export const vrateValue = (fpm: number) => {
  const v = metric() ? Math.round(fpm * MS_PER_FPM * 10) / 10 : fpm;
  return `${v > 0 ? "+" : ""}${v.toLocaleString()}`;
};
export const vrateUnit = () => (metric() ? "m/s" : "fpm");

export const fmtSpeed = (kt: number | null | undefined) => (kt == null ? "—" : `${speedValue(kt)} ${speedUnit()}`);
export const fmtVrate = (fpm: number | null | undefined) => (fpm == null ? "—" : `${vrateValue(fpm)} ${vrateUnit()}`);

/** Distances arrive in km; aviation units show nautical miles. */
export const fmtDist = (km: number, digits = 0) =>
  metric() ? `${km.toLocaleString(undefined, { maximumFractionDigits: digits })} km` : `${(km / KMH_PER_KT).toLocaleString(undefined, { maximumFractionDigits: digits })} NM`;

/** Altitude axis tick from a value in feet: "10k" (ft) or "3.0 km". */
export const fmtAltTick = (ft: number) => (metric() ? `${((ft * M_PER_FT) / 1000).toFixed(ft === 0 ? 0 : 1)}km` : ft === 0 ? "0" : `${Math.round(ft / 1000)}k`);
export const fmtTrack = (t: number | null | undefined) => (t == null ? "—" : `${Math.round(t)}°`);

export function fmtTs(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function fmtDuration(startIso: string, endIso: string): string {
  const s = Math.max(0, (Date.parse(endIso) - Date.parse(startIso)) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${Math.floor(s % 60)}s` : `${Math.floor(s)}s`;
}

export const toLocalInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

// Distinct overlay colours (readable on dark imagery and OSM tiles).
export const PALETTE = ["#ef4444", "#3b82f6", "#f59e0b", "#10b981", "#a855f7", "#ec4899", "#14b8a6", "#f97316", "#84cc16", "#06b6d4"];

export const fmtInt = (n: number) => n.toLocaleString();

export function fmtSeconds(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}
