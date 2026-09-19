"use client";

import { useId } from "react";

import type { TrackPoint } from "@/lib/api";
import { fmtAlt, fmtAltTick } from "@/lib/format";

type Props = {
  points: TrackPoint[];
  /** Index of the point to mark (the replay cursor); omit for none. */
  cursor?: number;
  height?: number;
};

/** Altitude-over-time area chart. Reads the points' own timestamps, so gaps show up as gaps in x. */
export function AltitudeProfile({ points, cursor, height = 84 }: Props) {
  const id = useId();
  const pts = points.filter((p) => p.alt != null);
  if (pts.length < 2) return <p className="text-xs text-muted-foreground">Not enough altitude data yet.</p>;

  const W = 296, padL = 34, padB = 16, padT = 6;
  const t0 = Date.parse(pts[0].ts), t1 = Date.parse(pts[pts.length - 1].ts);
  const max = Math.max(1000, Math.ceil(Math.max(...pts.map((p) => p.alt!)) / 5000) * 5000);
  const x = (ms: number) => padL + ((ms - t0) / Math.max(1, t1 - t0)) * (W - padL - 4);
  const y = (alt: number) => padT + (1 - alt / max) * (height - padT - padB);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(Date.parse(p.ts)).toFixed(1)} ${y(p.alt!).toFixed(1)}`).join("");
  const area = `${line}L${x(t1).toFixed(1)} ${y(0)}L${x(t0).toFixed(1)} ${y(0)}Z`;
  const cur = cursor != null ? points[Math.min(cursor, points.length - 1)] : null;
  const fmtT = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label="Altitude profile">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--altitude)" stopOpacity="0.55" />
          <stop offset="1" stopColor="var(--altitude)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={padL} x2={W - 4} y1={y(max * f)} y2={y(max * f)} stroke="currentColor" strokeOpacity={0.12} />
          <text x={padL - 5} y={y(max * f) + 3} textAnchor="end" fontSize={8} className="num fill-muted-foreground">
            {fmtAltTick(max * f)}
          </text>
        </g>
      ))}
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="var(--altitude)" strokeWidth={1.6} strokeLinejoin="round" />
      {cur?.alt != null && (
        <g>
          <line x1={x(Date.parse(cur.ts))} x2={x(Date.parse(cur.ts))} y1={padT} y2={height - padB} stroke="var(--primary)" strokeOpacity={0.6} strokeDasharray="2 2" />
          <circle cx={x(Date.parse(cur.ts))} cy={y(cur.alt)} r={3.2} fill="var(--primary)" stroke="var(--background)" strokeWidth={1.2} />
          <title>{fmtAlt(cur.alt)}</title>
        </g>
      )}
      <text x={padL} y={height - 3} fontSize={8} className="num fill-muted-foreground">{fmtT(t0)}</text>
      <text x={W - 4} y={height - 3} fontSize={8} textAnchor="end" className="num fill-muted-foreground">{fmtT(t1)}</text>
    </svg>
  );
}
