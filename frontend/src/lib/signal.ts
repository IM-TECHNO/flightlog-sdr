/**
 * Signal strength as the decoder reports it: RSSI in dBFS, where 0 is the strongest possible and typical
 * aircraft sit between -5 and -35. Thresholds are a rule of thumb, not a calibrated scale.
 */
export type SignalLevel = { bars: 1 | 2 | 3 | 4; label: string; color: string };

export function signalLevel(rssi: number | null | undefined): SignalLevel | null {
  if (rssi == null) return null;
  if (rssi >= -10) return { bars: 4, label: "excellent", color: "#3fb950" };
  if (rssi >= -20) return { bars: 3, label: "good", color: "#3fb950" };
  if (rssi >= -28) return { bars: 2, label: "fair", color: "#e3b341" };
  return { bars: 1, label: "weak", color: "#f85149" };
}

export const fmtRssi = (rssi: number | null | undefined) => (rssi == null ? "—" : `${rssi.toFixed(1)} dBFS`);
