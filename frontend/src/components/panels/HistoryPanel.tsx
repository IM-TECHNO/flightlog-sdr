"use client";

import { useCallback, useEffect, useState } from "react";
import { Film, Search, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { getFlights, getReplay, MIN_MSGS, type Flight, type FlightTrack } from "@/lib/api";
import { fmtAlt, fmtDuration, fmtTs, toLocalInput } from "@/lib/format";
import { AirlineBadge } from "./AirlineBadge";

type Props = {
  overlay: { flight: Flight; color: string }[];
  selectedId: number | null;
  align: boolean;
  onAlign: (v: boolean) => void;
  onToggle: (f: Flight) => void;
  onSelect: (f: Flight) => void;
  onClear: () => void;
  /** Everything that flew in the chosen window, ready to play back together. */
  onReplay: (flights: FlightTrack[]) => void;
};

const PRESETS: [string, number][] = [["1h", 1], ["24h", 24], ["7d", 168], ["30d", 720]];
const HOUR = 3600_000;

/** Input strings for "the last `hours`, up to an hour from now" (so flights in progress are included). */
const rangeFor = (hours: number) => ({
  start: toLocalInput(new Date(Date.now() - hours * HOUR)),
  end: toLocalInput(new Date(Date.now() + HOUR)),
});
const toQuery = (start: string, end: string, q: string, hideBrief: boolean) => ({
  min_msgs: hideBrief ? MIN_MSGS : 0,
  start: start ? new Date(start).toISOString() : undefined,
  end: end ? new Date(end).toISOString() : undefined,
  q: q.trim() || undefined,
  limit: 300,
});

export function HistoryPanel({ overlay, selectedId, align, onAlign, onToggle, onSelect, onClear, onReplay }: Props) {
  const [start, setStart] = useState(() => rangeFor(24).start);
  const [end, setEnd] = useState(() => rangeFor(24).end);
  const [q, setQ] = useState("");
  const [hideBrief, setHideBrief] = useState(true);
  const [replay, setReplay] = useState<{ state: "idle" | "loading" | "error"; note?: string }>({ state: "idle" });

  const playAll = async () => {
    setReplay({ state: "loading" });
    try {
      const r = await getReplay(new Date(start).toISOString(), new Date(end).toISOString());
      onReplay(r.flights);
      setReplay({
        state: "idle",
        note: r.flights.length === 0 ? "Nothing flew in this window." : `Showing ${r.flights.length} flights${r.stride > 1 ? `, thinned to every ${r.stride}th point` : ""}. Press play on the timeline.`,
      });
    } catch {
      setReplay({ state: "error", note: "Could not load the replay." });
    }
  };
  const [flights, setFlights] = useState<Flight[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  const search = useCallback(
    async (s = start, e = end, query = q, brief = hideBrief) => {
      setState("loading");
      try {
        setFlights(await getFlights(toQuery(s, e, query, brief)));
        setState("idle");
      } catch {
        setState("error");
      }
    },
    [start, end, q, hideBrief],
  );

  useEffect(() => {
    // initial load (default range); later searches go through `search`
    let cancelled = false;
    getFlights(toQuery(rangeFor(24).start, rangeFor(24).end, "", true))
      .then((f) => !cancelled && setFlights(f))
      .catch(() => !cancelled && setState("error"));
    return () => {
      cancelled = true;
    };
  }, []);

  const preset = (hours: number) => {
    const r = rangeFor(hours);
    setStart(r.start);
    setEnd(r.end);
    void search(r.start, r.end);
  };
  const colorOf = (id: number) => overlay.find((o) => o.flight.id === id)?.color;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="grid gap-2">
        <div className="grid grid-cols-2 gap-2">
          <label className="eyebrow">
            From
            <Input className="num mt-1 text-xs" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="eyebrow">
            To
            <Input className="num mt-1 text-xs" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>
        <div className="flex gap-1">
          {PRESETS.map(([label, h]) => (
            <Button key={label} size="xs" variant="outline" onClick={() => preset(h)}>
              {label}
            </Button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            placeholder="Callsign or ICAO24"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void search()}
          />
          <Button onClick={() => void search()} disabled={state === "loading"} aria-label="Search">
            <Search />
          </Button>
        </div>
      </div>

      <label className="flex cursor-pointer items-center gap-2 px-0.5 text-[13px]">
        <Checkbox
          checked={hideBrief}
          onCheckedChange={(v) => {
            setHideBrief(v === true);
            void search(start, end, q, v === true);
          }}
        />
        Hide brief contacts <span className="text-[11px] text-muted-foreground">(&lt; {MIN_MSGS} messages)</span>
      </label>

      <div>
        <Button className="w-full" variant="secondary" size="sm" onClick={() => void playAll()} disabled={replay.state === "loading"}>
          <Film /> {replay.state === "loading" ? "Loading…" : "Replay all traffic in this range"}
        </Button>
        {replay.note && <p className={`mt-1 text-[11px] leading-snug ${replay.state === "error" ? "text-destructive" : "text-muted-foreground"}`}>{replay.note}</p>}
      </div>

      <div className="flex items-center justify-between rounded-lg border bg-background/40 px-2.5 py-2 text-sm">
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox checked={align} onCheckedChange={(v) => onAlign(v === true)} />
          Align start times
        </label>
        <Button size="xs" variant="ghost" onClick={onClear} disabled={overlay.length === 0}>
          <Trash2 /> Clear ({overlay.length})
        </Button>
      </div>
      <p className="-mt-1 text-[11px] leading-tight text-muted-foreground">
        {align
          ? "All overlaid flights start together so different days can be compared side by side."
          : "Flights replay at their real times; pick flights from the same window to see them together."}
      </p>

      <div className="scroll-thin -mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
        <ul className="space-y-1.5">
          {state === "error" && <li className="py-4 text-center text-sm text-destructive">Could not reach the API.</li>}
          {state === "idle" && flights.length === 0 && (
            <li className="rounded-lg border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">No flights logged in this range.</li>
          )}
          {flights.map((f) => {
            const color = colorOf(f.id);
            return (
              <li
                key={f.id}
                className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-sm transition-colors hover:bg-accent/50 ${selectedId === f.id ? "border-primary/70 bg-accent/70" : "bg-background/30"}`}
              >
                <Checkbox checked={!!color} onCheckedChange={() => onToggle(f)} aria-label={`Overlay ${f.callsign ?? f.icao24}`} />
                <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={() => onSelect(f)}>
                  <AirlineBadge icao={f.airline?.icao} size={30} />
                  <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 font-semibold">
                    {color && <span className="size-2 shrink-0 rounded-full ring-2 ring-background" style={{ background: color }} />}
                    <span className="num truncate">{f.callsign ?? f.icao24.toUpperCase()}</span>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {fmtTs(f.first_seen)} · {fmtDuration(f.first_seen, f.last_seen)} · {fmtAlt(f.max_alt)}
                  </span>
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
