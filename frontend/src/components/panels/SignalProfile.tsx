"use client";

import type { TrackPoint } from "@/lib/api";

type Props = {
  points: TrackPoint[];
  /** Index of the point to mark (the replay cursor); omit for none. */
  cursor?: number;
  height?: number;
};

const MIN = -50; // dBFS at the bottom of the chart; 0 is the strongest possible signal

/** Received signal level over the flight: the antenna's view of the aircraft as it flew away and back. */
export function SignalProfile({ points, cursor, height = 70 }: Props) {
  const pts = points.filter((p) => p.rssi != null);
  if (pts.length < 2) return null;

  const W = 296, padL = 34, padB = 14, padT = 5;
  const t0 = Date.parse(pts[0].ts), t1 = Date.parse(pts[pts.length - 1].ts);
  const x = (ms: number) => padL + ((ms - t0) / Math.max(1, t1 - t0)) * (W - padL - 4);
  const y = (db: number) => padT + (Math.min(0, Math.max(MIN, db)) / MIN) * (height - padT - padB);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(Date.parse(p.ts)).toFixed(1)} ${y(p.rssi!).toFixed(1)}`).join("");
  const cur = cursor != null ? points[Math.min(cursor, points.length - 1)] : null;
  const fmtT = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label="Signal strength over the flight">
      {[0, -25, -50].map((db) => (
        <g key={db}>
          <line x1={padL} x2={W - 4} y1={y(db)} y2={y(db)} stroke="currentColor" strokeOpacity={0.12} />
          <text x={padL - 5} y={y(db) + 3} textAnchor="end" fontSize={8} className="num fill-muted-foreground">{db}</text>
        </g>
      ))}
      <path d={line} fill="none" stroke="var(--primary)" strokeWidth={1.5} strokeLinejoin="round" />
      {cur?.rssi != null && (
        <g>
          <line x1={x(Date.parse(cur.ts))} x2={x(Date.parse(cur.ts))} y1={padT} y2={height - padB} stroke="var(--primary)" strokeOpacity={0.5} strokeDasharray="2 2" />
          <circle cx={x(Date.parse(cur.ts))} cy={y(cur.rssi)} r={3} fill="var(--primary)" stroke="var(--background)" strokeWidth={1.2} />
        </g>
      )}
      <text x={padL} y={height - 2} fontSize={8} className="num fill-muted-foreground">{fmtT(t0)}</text>
      <text x={W - 4} y={height - 2} fontSize={8} textAnchor="end" className="num fill-muted-foreground">{fmtT(t1)}</text>
    </svg>
  );
}
