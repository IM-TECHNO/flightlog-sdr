import { liveryFor } from "@/lib/livery";

/** Small square in the airline's tail colour with its ICAO code (or a plane glyph when unknown). */
export function AirlineBadge({ icao, size = 34 }: { icao?: string | null; size?: number }) {
  const l = liveryFor(icao);
  const known = !!icao;
  return (
    <span
      className="num grid shrink-0 place-items-center rounded-[3px] text-[10px] font-bold text-white"
      style={{
        width: size,
        height: size,
        background: l.tail,
        border: `1px solid color-mix(in srgb, ${l.stripe} 55%, transparent)`,
        textShadow: "0 1px 2px rgb(0 0 0 / 55%)",
      }}
      aria-hidden
    >
      {known ? icao : "✈"}
    </span>
  );
}
