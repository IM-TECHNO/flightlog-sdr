// Live attitude estimate from two consecutive samples. Mirrors backend/app/attitude.py.
const G = 9.80665, KT = 0.514444, FPM = 0.00508;
const clamp = (v: number, l: number) => Math.max(-l, Math.min(l, v));

export type Sample = { t: number; alt: number | null; gs: number | null; track: number | null; vrate: number | null };

export function estimateAttitude(prev: Sample | undefined, cur: Sample): { pitch: number; roll: number } {
  const gs = (cur.gs ?? 0) * KT;
  if (gs < 20) return { pitch: 0, roll: 0 };
  let vrate = cur.vrate;
  const dt = prev ? (cur.t - prev.t) / 1000 : 0;
  if (vrate == null && prev && dt > 0 && cur.alt != null && prev.alt != null) vrate = ((cur.alt - prev.alt) / dt) * 60;
  const pitch = vrate == null ? 0 : clamp((Math.atan2(vrate * FPM, gs) * 180) / Math.PI, 25);
  let roll = 0;
  if (prev && dt > 0.2 && cur.track != null && prev.track != null) {
    const dpsi = ((cur.track - prev.track + 540) % 360) - 180;
    roll = clamp((Math.atan((gs * ((dpsi * Math.PI) / 180 / dt)) / G) * 180) / Math.PI, 45);
  }
  return { pitch, roll };
}
