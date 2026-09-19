import type { LiveAircraft } from "./api";

export type Near = {
  a: LiveAircraft;
  distKm: number; // horizontal distance from the receiver now
  bearing: number; // degrees from the receiver
  /** Minutes until the closest point of approach (null when moving away or too slow to tell). */
  tcpaMin: number | null;
  dcpaKm: number | null; // horizontal distance at that point
};

const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON_EQ = 111.32;

/** Where each aircraft is relative to the receiver, and when it will pass closest if it keeps its heading and speed. */
export function nearest(aircraft: LiveAircraft[], rx: { lat: number; lon: number }): Near[] {
  const cosLat = Math.cos((rx.lat * Math.PI) / 180);
  return aircraft.map((a) => {
    const dx = (a.lon - rx.lon) * KM_PER_DEG_LON_EQ * cosLat; // km east
    const dy = (a.lat - rx.lat) * KM_PER_DEG_LAT; // km north
    const distKm = Math.hypot(dx, dy);
    const bearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    let tcpaMin: number | null = null, dcpaKm: number | null = null;
    if (a.gs != null && a.track != null && a.gs > 30) {
      const v = a.gs * 1.852; // km/h
      const vx = v * Math.sin((a.track * Math.PI) / 180), vy = v * Math.cos((a.track * Math.PI) / 180);
      const t = -(dx * vx + dy * vy) / (vx * vx + vy * vy); // hours
      if (t > 0) {
        tcpaMin = t * 60;
        dcpaKm = Math.hypot(dx + vx * t, dy + vy * t);
      }
    }
    return { a, distKm, bearing, tcpaMin, dcpaKm };
  });
}

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const compass = (deg: number) => POINTS[Math.round(deg / 45) % 8];
