"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, RotateCw, TrendingDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { getReceiver, setReceiverGain, type LiveAircraft, type ReceiverStatus } from "@/lib/api";
import { fmtDist } from "@/lib/format";

const LEVELS = {
  ok: { Icon: CheckCircle2, color: "var(--climb)", label: "balanced" },
  high: { Icon: AlertTriangle, color: "var(--destructive)", label: "too hot?" },
  low: { Icon: TrendingDown, color: "var(--altitude)", label: "weak" },
  unknown: { Icon: CircleHelp, color: "var(--muted-foreground)", label: "not enough data" },
} as const;

const BINS: { label: string; test: (v: number) => boolean; color: string }[] = [
  { label: "> -3 (overdriven?)", test: (v) => v > -3, color: "#f85149" },
  { label: "-3 to -10", test: (v) => v <= -3 && v > -10, color: "#3fb950" },
  { label: "-10 to -20", test: (v) => v <= -10 && v > -20, color: "#3fb950" },
  { label: "-20 to -30", test: (v) => v <= -20 && v > -30, color: "#e3b341" },
  { label: "< -30", test: (v) => v <= -30, color: "#8b949e" },
];

/** Receiver gain: the setting in dump1090.cfg, an assistant that reads the live signal mix, and a per-gain comparison. */
export function ReceiverPanel({ live }: { live: LiveAircraft[] }) {
  const [rx, setRx] = useState<ReceiverStatus | null>(null);
  const [error, setError] = useState(false);
  const [gain, setGain] = useState<number | null>(null); // slider position, seeded from the config
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getReceiver()
        .then((r) => {
          if (cancelled) return;
          setRx(r);
          setError(false);
          setGain((g) => g ?? (r.gain != null ? Math.round(r.gain) : 30));
        })
        .catch(() => !cancelled && setError(true));
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const rssis = useMemo(() => live.map((a) => a.rssi).filter((v): v is number => v != null), [live]);
  const counts = BINS.map((b) => rssis.filter(b.test).length);
  const top = Math.max(1, ...counts);
  const best = useMemo(() => {
    const h = rx?.history ?? [];
    return { rate: Math.max(0, ...h.map((r) => r.avg_msg_rate)), km: Math.max(0, ...h.map((r) => r.best_km ?? 0)) };
  }, [rx]);

  const apply = async (restart: boolean) => {
    if (gain == null) return;
    setBusy(true);
    setConfirm(false);
    try {
      const r = await setReceiverGain(gain, restart);
      setRx(r.status);
      setGain(r.gain != null ? Math.round(r.gain) : gain);
      setResult({ ok: r.applied, text: r.message });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : "Could not change the gain." });
    } finally {
      setBusy(false);
    }
  };

  if (error && !rx)
    return <p className="rounded border border-dashed px-3 py-8 text-center text-sm text-destructive">Could not load receiver status. Restart the backend so it has the new /api/receiver endpoint.</p>;
  if (!rx) return <p className="py-8 text-center text-sm text-muted-foreground">Reading the receiver…</p>;

  const v = LEVELS[rx.verdict.level];
  const changed = gain != null && rx.gain != null && Math.round(rx.gain) !== gain;

  return (
    <div className="scroll-thin -mr-2 min-h-0 flex-1 space-y-5 overflow-y-auto pr-2">
      <section>
        <div className="eyebrow mb-2">Tuner gain</div>
        <div className="flex items-end justify-between">
          <div className="num text-3xl font-bold leading-none">
            {rx.gain ?? "—"}
            <span className="ml-1 text-sm font-normal text-muted-foreground">dB</span>
          </div>
          <span className={`num rounded border px-2 py-0.5 text-[11px] ${rx.decoder.running ? "border-climb/40 text-climb" : "border-destructive/40 text-destructive"}`}>
            {rx.decoder.running ? `dump1090 running · pid ${rx.decoder.pid}` : "dump1090 not found"}
          </span>
        </div>
        {rx.cfg_path && <p className="num mt-1 truncate text-[10.5px] text-muted-foreground" title={rx.cfg_path}>{rx.cfg_path}</p>}

        <div className="mt-4 space-y-3 rounded border bg-background/40 p-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">New gain</span>
            <span className="num font-semibold">
              {changed && <span className="text-muted-foreground">{Math.round(rx.gain ?? 0)} → </span>}
              {gain ?? "—"} dB
            </span>
          </div>
          <Slider min={0} max={rx.gain_max} step={1} value={[gain ?? 0]} disabled={!rx.controllable || busy} onValueChange={(x) => Array.isArray(x) && setGain(x[0])} aria-label="Tuner gain in dB" />
          <div className="num flex justify-between text-[10px] text-muted-foreground"><span>0</span><span>25</span><span>{rx.gain_max}</span></div>

          {!rx.controllable ? (
            <p className="text-[11.5px] leading-snug text-muted-foreground">{rx.reason}</p>
          ) : confirm ? (
            <div className="space-y-2 rounded border border-destructive/40 bg-destructive/10 p-2.5 text-[11.5px] leading-snug">
              <p>This restarts dump1090 (a few seconds without data, and it reopens in a new window). If it doesn&apos;t come back, the old setting is restored automatically.</p>
              <div className="flex gap-1.5">
                <Button size="xs" onClick={() => void apply(true)} disabled={busy}><RotateCw /> Restart now</Button>
                <Button size="xs" variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-1.5">
              <Button size="sm" variant="outline" disabled={busy || !changed} onClick={() => void apply(false)}>Save to config</Button>
              <Button size="sm" disabled={busy || !changed} onClick={() => setConfirm(true)}><RotateCw /> Save &amp; restart</Button>
            </div>
          )}
          {result && <p className={`text-[11.5px] leading-snug ${result.ok ? "text-climb" : "text-destructive"}`}>{result.text}</p>}
          <p className="text-[10.5px] leading-snug text-muted-foreground">Whole dB; dump1090 uses the nearest step your tuner supports. It only reads gain at start-up, so a change needs a restart.</p>
        </div>
      </section>

      <section>
        <div className="eyebrow mb-2">Assistant</div>
        <div className="flex items-start gap-2 rounded border bg-background/40 p-3" style={{ borderColor: `color-mix(in srgb, ${v.color} 45%, transparent)` }}>
          <v.Icon className="mt-0.5 size-4 shrink-0" style={{ color: v.color }} />
          <div>
            <div className="num text-xs font-semibold" style={{ color: v.color }}>{v.label}</div>
            <p className="text-[12px] leading-snug">{rx.verdict.text}</p>
          </div>
        </div>
        <div className="num mt-2 grid grid-cols-3 gap-2 text-center text-[11px]">
          {[
            ["aircraft", String(rx.signal.aircraft)],
            ["median", rx.signal.median == null ? "—" : `${rx.signal.median} dBFS`],
            ["msg/s", rx.signal.msg_rate.toFixed(1)],
          ].map(([k, val]) => (
            <div key={k} className="rounded border bg-background/40 px-1 py-1.5"><div className="text-muted-foreground">{k}</div><div className="font-semibold">{val}</div></div>
          ))}
        </div>
      </section>

      <section>
        <div className="eyebrow mb-2">Signal mix right now (dBFS)</div>
        {rssis.length === 0 ? (
          <p className="text-xs text-muted-foreground">No aircraft with a signal level in view.</p>
        ) : (
          <div className="space-y-1.5">
            {BINS.map((b, i) => (
              <div key={b.label} className="flex items-center gap-2 text-xs">
                <span className="num w-[8.5rem] shrink-0 text-muted-foreground">{b.label}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-sm bg-muted"><span className="block h-full" style={{ width: `${(counts[i] / top) * 100}%`, background: b.color }} /></span>
                <span className="num w-5 text-right">{counts[i]}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="eyebrow mb-2">Compare gain settings</div>
        {rx.history.length === 0 ? (
          <p className="text-xs leading-snug text-muted-foreground">Nothing recorded yet. Once a minute, while aircraft are in view, the app notes the gain in force and how well the receiver is doing.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="num w-full text-[11px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pb-1 font-medium">dB</th><th className="pb-1 text-right font-medium">min</th><th className="pb-1 text-right font-medium">a/c</th>
                  <th className="pb-1 text-right font-medium">msg/s</th><th className="pb-1 text-right font-medium">dBFS</th><th className="pb-1 text-right font-medium">reach</th>
                </tr>
              </thead>
              <tbody>
                {rx.history.map((h) => (
                  <tr key={h.gain} className={`border-t ${rx.gain != null && Math.round(rx.gain) === Math.round(h.gain) ? "bg-accent/50" : ""}`}>
                    <td className="py-1 font-semibold">{h.gain}</td>
                    <td className="py-1 text-right text-muted-foreground">{h.minutes}</td>
                    <td className="py-1 text-right">{h.avg_aircraft}</td>
                    <td className={`py-1 text-right ${h.avg_msg_rate > 0 && h.avg_msg_rate === best.rate ? "font-bold text-climb" : ""}`}>{h.avg_msg_rate}</td>
                    <td className="py-1 text-right">{h.avg_rssi ?? "—"}</td>
                    <td className={`py-1 text-right ${h.best_km != null && h.best_km === best.km ? "font-bold text-climb" : ""}`}>{h.best_km == null ? "—" : fmtDist(h.best_km)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground">Averages per gain over the last 14 days (min = minutes sampled). Traffic varies through the day, so compare settings at similar times and give each 15+ minutes. Green marks the best message rate and reach.</p>
          </div>
        )}
      </section>
    </div>
  );
}
