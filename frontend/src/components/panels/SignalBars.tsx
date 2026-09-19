import { fmtRssi, signalLevel } from "@/lib/signal";

/** Four ascending bars showing signal strength; dim when the decoder gives no level for the aircraft. */
export function SignalBars({ rssi, className = "" }: { rssi: number | null | undefined; className?: string }) {
  const level = signalLevel(rssi);
  const title = level ? `${fmtRssi(rssi)} · ${level.label}` : "No signal data";
  return (
    <span className={`inline-flex h-3 items-end gap-[2px] ${className}`} title={title} role="img" aria-label={title}>
      {[1, 2, 3, 4].map((n) => (
        <i
          key={n}
          className="block w-[3px] rounded-[1px]"
          style={{ height: 3 + n * 2.25, background: level && n <= level.bars ? level.color : "#30363d" }}
        />
      ))}
    </span>
  );
}
