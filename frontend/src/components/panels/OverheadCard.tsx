"use client";

import { useMemo, useState } from "react";
import { ChevronDown, LocateFixed, Navigation } from "lucide-react";

import type { LiveAircraft } from "@/lib/api";
import { fmtAlt, fmtDist } from "@/lib/format";
import { compass, nearest } from "@/lib/overhead";

type Props = { aircraft: LiveAircraft[]; receiver: { lat: number; lon: number }; onPick: (a: LiveAircraft) => void };

const mins = (m: number) => (m < 1 ? `${Math.max(1, Math.round(m * 60))}s` : m < 60 ? `${Math.floor(m)}m ${String(Math.round((m % 1) * 60)).padStart(2, "0")}s` : `${Math.round(m)}m`);

/** Nearest aircraft to the receiver now, and who will pass closest soon. */
export function OverheadCard({ aircraft, receiver, onPick }: Props) {
  const [open, setOpen] = useState(true);
  const { closest, upcoming } = useMemo(() => {
    const all = nearest(aircraft, receiver);
    return {
      closest: [...all].sort((a, b) => a.distKm - b.distKm).slice(0, 3),
      upcoming: all.filter((n) => n.tcpaMin != null && n.tcpaMin < 15 && (n.dcpaKm ?? 99) < 10)
        .sort((a, b) => (a.tcpaMin ?? 0) - (b.tcpaMin ?? 0)).slice(0, 3),
    };
  }, [aircraft, receiver]);
  if (!closest.length) return null;

  return (
    <div className="rounded-lg border bg-background/40">
      <button type="button" className="flex w-full items-center justify-between px-3 py-2" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="eyebrow flex items-center gap-1.5"><LocateFixed className="size-3" /> Overhead now</span>
        <span className="num flex items-center gap-2 text-[11px] text-muted-foreground">
          {fmtDist(closest[0].distKm, 1)} <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 pb-2.5 pt-2">
          {closest.map((n) => (
            <button key={n.a.icao24} type="button" className="flex w-full items-center gap-2 text-left text-xs hover:text-primary" onClick={() => onPick(n.a)}>
              <Navigation className="size-3 shrink-0 text-primary" style={{ transform: `rotate(${Math.round(n.bearing - 45)}deg)` }} />
              <span className="num w-[4.5rem] truncate font-semibold">{n.a.callsign ?? n.a.icao24.toUpperCase()}</span>
              <span className="num flex-1 text-muted-foreground">{fmtDist(n.distKm, 1)} {compass(n.bearing)}</span>
              <span className="num text-altitude">{fmtAlt(n.a.alt)}</span>
            </button>
          ))}
          {upcoming.length > 0 && (
            <div className="border-t pt-2">
              <div className="eyebrow mb-1">Passing closest soon</div>
              {upcoming.map((n) => (
                <button key={n.a.icao24} type="button" className="flex w-full items-center justify-between py-0.5 text-left text-xs hover:text-primary" onClick={() => onPick(n.a)}>
                  <span className="num font-semibold">{n.a.callsign ?? n.a.icao24.toUpperCase()}</span>
                  <span className="num text-muted-foreground">in {mins(n.tcpaMin!)} · {fmtDist(n.dcpaKm!, 1)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
