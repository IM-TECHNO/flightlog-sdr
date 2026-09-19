"use client";

import { useEffect, useState } from "react";

import { getCoverage, type Coverage } from "@/lib/api";
import { fmtDist } from "@/lib/format";

const SIZE = 250, C = SIZE / 2, R = 104;

const polar = (deg: number, r: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
};

/** Furthest position received in each 10-degree sector: a picture of what the antenna reaches. */
export function CoverageSection({ days }: { days: number }) {
  const [state, setState] = useState<{ days: number; data: Coverage } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => getCoverage(days).then((data) => !cancelled && setState({ days, data })).catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [days]);

  const cov = state?.days === days ? state.data : null;
  if (!cov) return <p className="text-xs text-muted-foreground">Loading coverage…</p>;
  if (!cov.enabled) return <p className="text-[11px] text-muted-foreground">Set RECEIVER_LAT and RECEIVER_LON to see your coverage.</p>;
  if (cov.max_km === 0) return <p className="text-xs text-muted-foreground">No positions received yet.</p>;

  const scale = Math.ceil(cov.max_km / 50) * 50; // outer ring, rounded up to a tidy number
  const rings = [0.25, 0.5, 0.75, 1];
  return (
    <div>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="mx-auto w-full max-w-[16rem]" role="img" aria-label="Coverage by bearing">
        {rings.map((f) => (
          <g key={f}>
            <circle cx={C} cy={C} r={R * f} fill="none" stroke="currentColor" strokeOpacity={0.14} />
            <text x={C + 3} y={C - R * f + 9} fontSize={8} className="num fill-muted-foreground">{fmtDist(scale * f)}</text>
          </g>
        ))}
        {[0, 90, 180, 270].map((d) => {
          const [x, y] = polar(d, R + 12);
          return <text key={d} x={x} y={y + 3} textAnchor="middle" fontSize={10} className="fill-muted-foreground">{"NESW"[d / 90]}</text>;
        })}
        {cov.bins.map((b) => {
          if (!b.max_km) return null;
          const r = (b.max_km / scale) * R;
          const [x1, y1] = polar(b.bearing, r), [x2, y2] = polar(b.bearing + 10, r);
          return (
            <path key={b.bearing} d={`M${C} ${C} L${x1.toFixed(1)} ${y1.toFixed(1)} A${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z`}
              fill="var(--primary)" fillOpacity={0.45} stroke="var(--primary)" strokeWidth={0.8}>
              <title>{`${b.bearing}°–${b.bearing + 10}°: ${fmtDist(b.max_km, 1)} (${b.count} fixes)`}</title>
            </path>
          );
        })}
        <circle cx={C} cy={C} r={2.5} fill="var(--climb)" />
      </svg>
      <p className="num mt-1 text-center text-[11px] text-muted-foreground">
        Longest reach {fmtDist(cov.max_km, 0)} · {cov.positions.toLocaleString()} fixes
      </p>
      <p className="mt-0.5 text-center text-[10.5px] text-muted-foreground">Turn on the Heatmap layer on the map to see where they came from.</p>
    </div>
  );
}
