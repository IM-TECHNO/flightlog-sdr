/** Browser notifications and an alert beep. Both need a user gesture first, so they are opt-in toggles. */
import type { Alert } from "./api";

let ctx: AudioContext | null = null;

export function beep(emergency: boolean) {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const tones = emergency ? [880, 660, 880, 660] : [660, 880];
    tones.forEach((freq, i) => {
      const o = ctx!.createOscillator(), g = ctx!.createGain();
      const t = ctx!.currentTime + i * 0.18;
      o.frequency.value = freq;
      o.type = "sine";
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g).connect(ctx!.destination);
      o.start(t);
      o.stop(t + 0.17);
    });
  } catch {
    /* audio unavailable */
  }
}

export const notificationsSupported = () => typeof window !== "undefined" && "Notification" in window;

export async function askNotificationPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}

export function showNotification(a: Alert) {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  const who = a.callsign ?? a.icao24.toUpperCase();
  new Notification(a.kind === "emergency" ? `Emergency: ${who}` : `Spotted: ${who}`, { body: a.detail, tag: `flightlog-${a.id}` });
}
