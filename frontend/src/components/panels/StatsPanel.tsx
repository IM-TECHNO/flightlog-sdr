"use client";

import { useEffect, useState } from "react";
import { Mountain, Ruler, Timer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getDbInfo, getStats, MIN_MSGS, type DbInfo, type Stats } from "@/lib/api";
import { fmtAlt, fmtDist, fmtInt, fmtSeconds } from "@/lib/format";
import { AirportSection } from "./AirportSection";
import { CoverageSection } from "./CoverageSection";

const RANGES = [{ d: 1, label: "24h" }, { d: 7, label: "7 days" }, { d: 30, label: "30 days" }];

function Bars({ values, labels, height = 64, highlight }: { values: number[]; labels?: string[]; height?: number; highlight?: number }) {
  const max = Math.max(1, ...values);
  const W = 296, gap = 2, bw = (W - gap * (values.length - 1)) / values.length;
  return (
    <svg viewBox={`0 0 ${W} ${height + 14}`} className="w-full" role="img">
      {values.map((v, i) => {
        const h = Math.max(v ? 2 : 0, (v / max) * height);
        return (
          <g key={i}>
            <rect x={i * (bw + gap)} y={height - h} width={bw} height={h} rx={1.5} fill={i === highlight ? "var(--altitude)" : "var(--primary)"} fillOpacity={i === highlight ? 1 : 0.7}>
              <title>{`${labels?.[i] ?? i}: ${v}`}</title>
            </rect>
          </g>
        );
      })}
      {labels && [0, Math.floor(values.length / 2), values.length - 1].map((i) => (
        <text key={i} x={i * (bw + gap) + bw / 2} y={height + 11} fontSize={8} textAnchor={i === 0 ? "start" : i === values.length - 1 ? "end" : "middle"} className="num fill-muted-foreground" dx={i === 0 ? -bw / 2 : i === values.length - 1 ? bw / 2 : 0}>
          {labels[i]}
        </text>
      ))}
    </svg>
  );
}

const Tile = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-lg border bg-background/40 px-3 py-2">
    <div className="eyebrow">{label}</div>
    <div className="num mt-0.5 text-xl font-semibold leading-none">{value}</div>
  </div>
);

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section>
    <div className="eyebrow mb-2">{title}</div>
    {children}
  </section>
);

export function StatsPanel({ onOpenFlight }: { onOpenFlight: (flightId: number) => void }) {
  const [days, setDays] = useState(7);
  const [state, setState] = useState<{ days: number; data: Stats } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getStats(days)
        .then((data) => {
          if (cancelled) return;
          setState({ days, data });
          setError(false);
        })
        .catch(() => !cancelled && setError(true));
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [days]);

  const st = state?.days === days ? state.data : null;
  const busiest = st ? st.hourly.indexOf(Math.max(...st.hourly)) : -1;
  const airlineMax = Math.max(1, ...(st?.airlines.map((a) => a.flights) ?? [1]));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex gap-1">
        {RANGES.map((r) => (
          <Button key={r.d} size="xs" variant={days === r.d ? "default" : "outline"} onClick={() => setDays(r.d)}>{r.label}</Button>
        ))}
      </div>

      <div className="scroll-thin -mr-2 min-h-0 flex-1 space-y-5 overflow-y-auto pr-2">
        {error && !st && <p className="rounded-lg border border-dashed px-3 py-8 text-center text-sm text-destructive">Could not load stats. Restart the backend so it has the new /api/stats endpoint.</p>}
        {!st && !error && <p className="py-8 text-center text-sm text-muted-foreground">Crunching the log…</p>}
        {st && (
          <>
            <p className="-mb-2 text-[10.5px] text-muted-foreground">Contacts with fewer than {MIN_MSGS} messages are ignored.</p>
            <div className="grid grid-cols-3 gap-2">
              <Tile label="Flights" value={fmtInt(st.totals.flights)} />
              <Tile label="Aircraft" value={fmtInt(st.totals.aircraft)} />
              <Tile label="Fixes" value={st.totals.positions >= 10000 ? `${(st.totals.positions / 1000).toFixed(0)}k` : fmtInt(st.totals.positions)} />
            </div>

            {st.totals.flights === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">Nothing logged in this period yet.</p>
            ) : (
              <>
                <Section title="Flights per day">
                  <Bars values={st.daily.map((d) => d.flights)} labels={st.daily.map((d) => d.date.slice(5))} />
                </Section>
                <Section title={`By hour of day · busiest ${String(busiest).padStart(2, "0")}:00`}>
                  <Bars values={st.hourly} labels={st.hourly.map((_, h) => `${String(h).padStart(2, "0")}`)} highlight={busiest} />
                </Section>
                <Section title="Cruise altitude (max per flight, ft)">
                  <div className="space-y-1.5">
                    {st.altitude.map((a) => {
                      const m = Math.max(1, ...st.altitude.map((x) => x.flights));
                      return (
                        <div key={a.label} className="flex items-center gap-2 text-xs">
                          <span className="num w-14 shrink-0 text-muted-foreground">{a.label}</span>
                          <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-altitude/80" style={{ width: `${(a.flights / m) * 100}%` }} /></span>
                          <span className="num w-7 text-right">{a.flights}</span>
                        </div>
                      );
                    })}
                  </div>
                </Section>
                {st.airlines.length > 0 && (
                  <Section title="Top airlines">
                    <div className="space-y-1.5">
                      {st.airlines.map((a) => (
                        <div key={a.name} className="flex items-center gap-2 text-xs">
                          <span className="w-28 shrink-0 truncate">{a.name}</span>
                          <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary/80" style={{ width: `${(a.flights / airlineMax) * 100}%` }} /></span>
                          <span className="num w-7 text-right">{a.flights}</span>
                        </div>
                      ))}
                    </div>
                  </Section>
                )}
                <Section title="Records">
                  <div className="space-y-1.5">
                    {st.farthest && (
                      <Record icon={<Ruler className="size-3.5" />} label="Farthest" value={fmtDist(st.farthest.km, 1)} sub={st.farthest.callsign ?? st.farthest.icao24 ?? ""} onClick={() => onOpenFlight(st.farthest!.flight_id)} />
                    )}
                    {st.highest && <Record icon={<Mountain className="size-3.5" />} label="Highest" value={fmtAlt(st.highest.alt)} sub={st.highest.callsign ?? st.highest.icao24} onClick={() => onOpenFlight(st.highest!.flight_id)} />}
                    {st.longest && <Record icon={<Timer className="size-3.5" />} label="Longest seen" value={fmtSeconds(st.longest.seconds)} sub={st.longest.callsign ?? st.longest.icao24} onClick={() => onOpenFlight(st.longest!.flight_id)} />}
                    {!st.farthest && <p className="text-[11px] text-muted-foreground">Set RECEIVER_LAT and RECEIVER_LON to see your farthest catch.</p>}
                  </div>
                </Section>
                {st.frequent.some((f) => f.flights > 1) && (
                  <Section title="Regulars">
                    <div className="space-y-1">
                      {st.frequent.filter((f) => f.flights > 1).map((f) => (
                        <div key={f.icao24 + f.callsign} className="flex items-center justify-between text-xs">
                          <span className="num">{f.callsign ?? f.icao24.toUpperCase()}</span>
                          <span className="num text-muted-foreground">{f.flights} flights</span>
                        </div>
                      ))}
                    </div>
                  </Section>
                )}
              </>
            )}
            <Section title="Receiver coverage">
              <CoverageSection days={days} />
            </Section>
            <AirportSection days={days} onOpenFlight={onOpenFlight} />
            <DatabaseSection />
          </>
        )}
      </div>
    </div>
  );
}

const mb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`);

function DatabaseSection() {
  const [db, setDb] = useState<DbInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    getDbInfo().then((d) => !cancelled && setDb(d)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  if (!db) return null;
  return (
    <Section title="Database">
      <div className="space-y-1 text-[13px]">
        {[
          ["Size", db.size_bytes == null ? "n/a" : mb(db.size_bytes)],
          ["Flights", fmtInt(db.flights)],
          ["Position fixes", fmtInt(db.positions)],
          ["Oldest", db.oldest ? new Date(db.oldest).toLocaleDateString() : "—"],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between"><span className="text-muted-foreground">{k}</span><span className="num">{v}</span></div>
        ))}
      </div>
      <p className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground">
        {db.retention_days > 0
          ? `Positions older than ${db.retention_days} days are thinned to one per ${db.thin_keep_seconds} s, daily.`
          : "Old positions are kept in full. Set RETENTION_DAYS=30 to thin them automatically, or run python -m app.maintenance backup for a copy."}
      </p>
    </Section>
  );
}

function Record({ icon, label, value, sub, onClick }: { icon: React.ReactNode; label: string; value: string; sub: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-2.5 rounded-lg border bg-background/30 px-2.5 py-2 text-left transition-colors hover:bg-accent/60">
      <span className="grid size-7 place-items-center rounded-md bg-primary/15 text-primary">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="eyebrow block">{label}</span>
        <span className="num block truncate text-xs text-muted-foreground">{sub}</span>
      </span>
      <span className="num text-sm font-semibold">{value}</span>
    </button>
  );
}
