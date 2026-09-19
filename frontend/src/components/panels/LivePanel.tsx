"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Search, Siren, Star } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import type { LiveAircraft } from "@/lib/api";
import { fmtAlt, fmtSpeed } from "@/lib/format";
import { AirlineBadge } from "./AirlineBadge";
import { OverheadCard } from "./OverheadCard";
import { SignalBars } from "./SignalBars";

export const ALT_MAX = 45000;

const code = (a: { iata: string | null; icao: string | null }) => a.iata ?? a.icao ?? "?";

type Props = {
  aircraft: LiveAircraft[]; // already altitude-filtered
  total: number;
  selectedIcao: string | null;
  receiver: { lat: number; lon: number } | null;
  altRange: [number, number];
  onAltRange: (r: [number, number]) => void;
  onPick: (a: LiveAircraft) => void;
};

export function LivePanel({ aircraft, total, selectedIcao, receiver, altRange, onAltRange, onPick }: Props) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...aircraft]
      .filter((a) => !needle || a.icao24.includes(needle) || (a.callsign ?? "").toLowerCase().includes(needle) || (a.airline?.name ?? "").toLowerCase().includes(needle))
      .sort((a, b) => Number(!!b.emergency) - Number(!!a.emergency) || (b.alt ?? 0) - (a.alt ?? 0));
  }, [aircraft, q]);
  const filtered = altRange[0] > 0 || altRange[1] < ALT_MAX;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-8" placeholder="Callsign, airline or ICAO24" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {receiver && <OverheadCard aircraft={aircraft} receiver={receiver} onPick={onPick} />}

      <div className="rounded-lg border bg-background/40 px-3 py-2.5">
        <div className="mb-2.5 flex items-center justify-between">
          <span className="eyebrow">Altitude filter</span>
          <button
            type="button"
            className="num text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            disabled={!filtered}
            onClick={() => onAltRange([0, ALT_MAX])}
          >
            {filtered ? `${fmtAlt(altRange[0])} – ${fmtAlt(altRange[1])} · reset` : "all altitudes"}
          </button>
        </div>
        <Slider
          min={0}
          max={ALT_MAX}
          step={1000}
          value={altRange}
          onValueChange={(v) => Array.isArray(v) && onAltRange([v[0], v[1]])}
          aria-label="Altitude range"
        />
      </div>

      <div className="flex items-center justify-between px-0.5">
        <span className="eyebrow">Aircraft</span>
        <span className="num text-[11px] text-muted-foreground">{rows.length}{rows.length !== total ? ` of ${total}` : ""}</span>
      </div>

      <div className="scroll-thin -mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
        <ul className="space-y-1.5">
          {rows.length === 0 && (
            <li className="rounded-lg border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
              {total === 0 ? "No aircraft yet. Is dump1090 running and the backend connected?" : "Nothing matches these filters."}
            </li>
          )}
          {rows.map((a) => {
            const vr = a.vrate ?? 0;
            return (
              <li key={a.icao24}>
                <button
                  type="button"
                  onClick={() => onPick(a)}
                  className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-accent/60 ${
                    a.emergency ? "border-destructive/60 bg-destructive/10" : selectedIcao === a.icao24 ? "border-primary/70 bg-accent/70" : "bg-background/30"
                  }`}
                >
                  <AirlineBadge icao={a.airline?.icao} />
                  <span className="min-w-0 flex-1">
                    <span className="num flex items-center gap-1 truncate text-sm font-semibold">
                      {a.callsign ?? a.icao24.toUpperCase()}
                      {a.watched && <Star className="size-3 shrink-0 fill-altitude text-altitude" aria-label="On your watchlist" />}
                      {a.emergency && <span className="flex shrink-0 items-center gap-0.5 rounded bg-destructive px-1 text-[10px] text-white"><Siren className="size-2.5" />{a.squawk}</span>}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {a.route && <span className="num font-medium text-foreground/85">{code(a.route.origin)} → {code(a.route.destination)} · </span>}
                      {a.airline?.name ?? a.country ?? "Unidentified"}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="num flex items-center justify-end gap-0.5 text-sm font-medium text-altitude">
                      {vr > 150 && <ArrowUp className="size-3 text-climb" />}
                      {vr < -150 && <ArrowDown className="size-3 text-descend" />}
                      {fmtAlt(a.alt)}
                    </span>
                    <span className="num mt-0.5 flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground"><SignalBars rssi={a.rssi} />{fmtSpeed(a.gs)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
