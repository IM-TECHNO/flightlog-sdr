"use client";

import { useEffect, useState } from "react";
import { BellRing, Eye, Plus, Siren, Trash2, Volume2, VolumeX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addWatch, deleteWatch, getWatchlist, type Alert, type WatchEntry } from "@/lib/api";

type Props = {
  alerts: Alert[];
  notify: boolean;
  onNotify: (on: boolean) => void;
  sound: boolean;
  onSound: (on: boolean) => void;
  onOpen: (a: Alert) => void;
};

const KINDS: { id: WatchEntry["kind"]; label: string; hint: string }[] = [
  { id: "callsign", label: "Callsign", hint: "e.g. IGO33 (matches IGO335)" },
  { id: "airline", label: "Airline", hint: "3-letter code, e.g. AIC" },
  { id: "icao24", label: "Airframe", hint: "6-char hex, e.g. 8016b7" },
];

const time = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });

export function AlertsPanel({ alerts, notify, onNotify, sound, onSound, onOpen }: Props) {
  const [watch, setWatch] = useState<WatchEntry[]>([]);
  const [kind, setKind] = useState<WatchEntry["kind"]>("callsign");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getWatchlist().then((w) => !cancelled && setWatch(w)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const add = async () => {
    if (!value.trim()) return;
    try {
      const w = await addWatch(kind, value);
      setWatch((l) => [...l, w]);
      setValue("");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add");
    }
  };
  const remove = async (id: number) => {
    await deleteWatch(id).catch(() => {});
    setWatch((l) => l.filter((w) => w.id !== id));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex gap-1.5">
        <Button size="sm" className="flex-1" variant={notify ? "default" : "outline"} onClick={() => onNotify(!notify)}>
          <BellRing /> Notifications {notify ? "on" : "off"}
        </Button>
        <Button size="sm" variant={sound ? "default" : "outline"} onClick={() => onSound(!sound)} aria-label="Alert sound" title="Alert sound">
          {sound ? <Volume2 /> : <VolumeX />}
        </Button>
      </div>

      <div className="scroll-thin -mr-2 min-h-0 flex-1 space-y-4 overflow-y-auto pr-2">
        <section>
          <div className="eyebrow mb-2 flex items-center gap-1.5"><Eye className="size-3" /> Watchlist</div>
          <div className="mb-2 grid grid-cols-3 gap-1">
            {KINDS.map((k) => (
              <Button key={k.id} size="xs" variant={kind === k.id ? "default" : "outline"} onClick={() => setKind(k.id)}>{k.label}</Button>
            ))}
          </div>
          <div className="flex gap-1.5">
            <Input
              className="num"
              placeholder={KINDS.find((k) => k.id === kind)?.hint}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void add()}
            />
            <Button size="icon" onClick={() => void add()} aria-label="Add to watchlist"><Plus /></Button>
          </div>
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
          <ul className="mt-2 space-y-1">
            {watch.length === 0 && <li className="text-xs text-muted-foreground">Nothing watched yet. You&apos;ll be alerted the first time a match is received.</li>}
            {watch.map((w) => (
              <li key={w.id} className="flex items-center justify-between rounded-lg border bg-background/30 px-2.5 py-1.5 text-sm">
                <span><span className="eyebrow mr-2">{w.kind}</span><span className="num font-medium">{w.value}</span></span>
                <Button size="icon-xs" variant="ghost" onClick={() => void remove(w.id)} aria-label={`Remove ${w.value}`}><Trash2 /></Button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <div className="eyebrow mb-2">Alert history</div>
          <ul className="space-y-1.5">
            {alerts.length === 0 && (
              <li className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                No alerts yet. Emergency squawks (7500, 7600, 7700) and watchlist matches show up here.
              </li>
            )}
            {alerts.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => onOpen(a)}
                  className={`flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-accent/60 ${a.kind === "emergency" ? "border-destructive/50 bg-destructive/10" : "bg-background/30"}`}
                >
                  {a.kind === "emergency" ? <Siren className="mt-0.5 size-4 shrink-0 text-destructive" /> : <Eye className="mt-0.5 size-4 shrink-0 text-primary" />}
                  <span className="min-w-0 flex-1">
                    <span className="num block truncate text-sm font-semibold">{a.callsign ?? a.icao24.toUpperCase()}</span>
                    <span className="block text-xs">{a.detail}</span>
                    <span className="num block text-[11px] text-muted-foreground">{time(a.ts)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
