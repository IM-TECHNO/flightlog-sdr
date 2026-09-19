"use client";

import { useEffect, useState } from "react";
import { PlaneLanding, PlaneTakeoff, Repeat2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { getAirport, type AirportActivity } from "@/lib/api";

const time = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Arrivals, departures, runway use and possible go-arounds, as far as the receiver could see them. */
export function AirportSection({ days, onOpenFlight }: { days: number; onOpenFlight: (id: number) => void }) {
  const [state, setState] = useState<{ days: number; data: AirportActivity } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => getAirport(days).then((data) => !cancelled && setState({ days, data })).catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [days]);

  const a = state?.days === days ? state.data : null;
  if (!a) return <p className="text-xs text-muted-foreground">Loading airport activity…</p>;
  if (!a.enabled) return null;
  const { summary, movements, airport } = a;
  const runways = Object.entries(summary.by_runway).sort((x, y) => y[1] - x[1]);
  const top = Math.max(1, ...runways.map(([, n]) => n));

  return (
    <section>
      <div className="eyebrow mb-2">{airport.name} ({airport.icao})</div>
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "Arrivals", value: summary.arrivals, Icon: PlaneLanding },
          { label: "Departures", value: summary.departures, Icon: PlaneTakeoff },
          { label: "Go-arounds", value: summary.go_arounds, Icon: Repeat2 },
        ].map(({ label, value, Icon }) => (
          <div key={label} className="rounded-lg border bg-background/40 px-2.5 py-2">
            <div className="eyebrow flex items-center justify-between">{label}<Icon className="size-3" /></div>
            <div className="num mt-0.5 text-xl font-semibold leading-none">{value}</div>
          </div>
        ))}
      </div>
      {runways.length > 0 && (
        <div className="mt-2.5 space-y-1.5">
          {runways.map(([rw, n]) => (
            <div key={rw} className="flex items-center gap-2 text-xs">
              <span className="num w-14 shrink-0 text-muted-foreground">RWY {rw}</span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary/80" style={{ width: `${(n / top) * 100}%` }} /></span>
              <span className="num w-6 text-right">{n}</span>
            </div>
          ))}
        </div>
      )}
      <ul className="mt-3 space-y-1">
        {movements.length === 0 && <li className="text-xs text-muted-foreground">No movements seen. Low aircraft near the field are only heard when the receiver has line of sight to them.</li>}
        {movements.slice(0, 8).map((m) => (
          <li key={m.flight_id}>
            <button type="button" onClick={() => onOpenFlight(m.flight_id)} className="flex w-full items-center gap-2 rounded-lg border bg-background/30 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent/60">
              {m.kind === "arrival" ? <PlaneLanding className="size-3.5 shrink-0 text-climb" /> : <PlaneTakeoff className="size-3.5 shrink-0 text-primary" />}
              <span className="num flex-1 truncate font-semibold">{m.callsign ?? m.icao24.toUpperCase()}</span>
              {m.runway && <span className="num text-muted-foreground">{m.runway}</span>}
              {m.go_around && <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">go-around?</Badge>}
              <span className="num text-muted-foreground">{time(m.time)}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground">Estimated from what your receiver heard: a movement is counted when a flight is first or last seen low near the field. Go-arounds are a best guess.</p>
    </section>
  );
}
