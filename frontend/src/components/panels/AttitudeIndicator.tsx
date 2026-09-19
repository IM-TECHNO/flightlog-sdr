"use client";

// Artificial horizon driven by estimated pitch (deg, +nose up) and roll (deg, +right wing down).
export function AttitudeIndicator({ pitch, roll, size = 132 }: { pitch: number; roll: number; size?: number }) {
  const r = size / 2;
  const pxPerDeg = r / 30;
  const shift = Math.max(-r * 1.6, Math.min(r * 1.6, pitch * pxPerDeg));
  const ticks = [-20, -10, 10, 20];
  return (
    <svg
      width={size}
      height={size}
      viewBox={`${-r} ${-r} ${size} ${size}`}
      role="img"
      aria-label={`Pitch ${pitch.toFixed(1)} degrees, roll ${roll.toFixed(1)} degrees`}
    >
      <defs>
        <clipPath id="adi-clip">
          <circle r={r - 2} />
        </clipPath>
      </defs>
      <g clipPath="url(#adi-clip)">
        <g transform={`rotate(${-roll})`}>
          <g transform={`translate(0 ${shift})`}>
            <rect x={-r * 3} y={-r * 3} width={r * 6} height={r * 3} fill="#3b82f6" />
            <rect x={-r * 3} y={0} width={r * 6} height={r * 3} fill="#92400e" />
            <line x1={-r * 3} x2={r * 3} y1={0} y2={0} stroke="#fff" strokeWidth={1.5} />
            {ticks.map((t) => (
              <g key={t}>
                <line x1={-r * 0.25} x2={r * 0.25} y1={-t * pxPerDeg} y2={-t * pxPerDeg} stroke="#fff" strokeWidth={1} />
                <text x={r * 0.3} y={-t * pxPerDeg + 3} fontSize={8} fill="#fff">
                  {Math.abs(t)}
                </text>
              </g>
            ))}
          </g>
        </g>
      </g>
      <circle r={r - 2} fill="none" stroke="currentColor" strokeOpacity={0.4} strokeWidth={2} />
      <path
        d={`M ${-r * 0.55} 0 H ${-r * 0.2} V 6 M ${r * 0.55} 0 H ${r * 0.2} V 6`}
        fill="none"
        stroke="#facc15"
        strokeWidth={3}
      />
      <circle r={2.5} fill="#facc15" />
    </svg>
  );
}
