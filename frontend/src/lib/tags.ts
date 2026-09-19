/**
 * Floating flight tags: small HTML boxes that follow each aircraft across the screen, like tooltips.
 * Built imperatively (the map moves them every frame, which React should not be involved in).
 * All text goes in via textContent: callsigns come off the radio and are untrusted.
 */
import type { LiveAircraft } from "./api";
import { fmtAlt, fmtSpeed, fmtVrate, fmtTrack } from "./format";
import { liveryFor } from "./livery";
import { fmtRssi, signalLevel } from "./signal";

export type TagDetail = "compact" | "full";

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const code = (a: { iata: string | null; icao: string | null }) => a.iata ?? a.icao ?? "?";

function signalGlyph(rssi: number | null | undefined): HTMLElement {
  const level = signalLevel(rssi);
  const g = node("span", "t-sig");
  g.title = level ? `${fmtRssi(rssi)} · ${level.label}` : "No signal data";
  for (let n = 1; n <= 4; n++) {
    const bar = document.createElement("i");
    bar.style.height = `${3 + n * 2.25}px`;
    if (level && n <= level.bars) bar.style.background = level.color;
    g.appendChild(bar);
  }
  return g;
}

/** (Re)build the contents of one tag. Cheap enough to run for every aircraft once a second. */
export function fillTag(root: HTMLElement, ac: LiveAircraft, detail: TagDetail, selected: boolean): void {
  root.className = `flight-tag${ac.emergency ? " tag-emergency" : ""}${selected ? " tag-selected" : ""}`;
  root.style.borderLeftColor = ac.emergency ? "" : liveryFor(ac.airline?.icao).tail;
  root.replaceChildren();

  const vr = ac.vrate ?? 0;
  const climb = vr > 150 ? node("span", "t-up", "▲") : vr < -150 ? node("span", "t-down", "▼") : null;

  const head = node("div", "t-row");
  head.appendChild(node("span", "t-call", ac.callsign ?? ac.icao24.toUpperCase()));
  if (ac.watched) head.appendChild(node("span", "t-alt", "★"));
  if (ac.emergency) head.appendChild(node("span", "t-down", `SQ ${ac.squawk}`));
  const alt = node("span", "t-alt", fmtAlt(ac.alt));
  head.appendChild(alt);
  if (climb) head.appendChild(climb);
  root.appendChild(head);

  const speed = node("div", "t-row");
  speed.appendChild(node("span", "", fmtSpeed(ac.gs)));
  if (detail === "compact") {
    if (ac.vrate != null) speed.appendChild(node("span", "t-dim", fmtVrate(ac.vrate)));
    speed.appendChild(signalGlyph(ac.rssi));
    root.appendChild(speed);
    return;
  }
  if (ac.vrate != null) speed.appendChild(node("span", vr > 150 ? "t-up" : vr < -150 ? "t-down" : "t-dim", fmtVrate(ac.vrate)));
  root.appendChild(speed);

  const who = [ac.airline?.name ?? ac.country, ac.type_code].filter(Boolean).join(" · ");
  if (who) root.appendChild(node("div", "t-dim", who));
  if (ac.route) {
    const r = node("div", "t-row");
    r.appendChild(node("span", "", `${code(ac.route.origin)} → ${code(ac.route.destination)}`));
    if (ac.registration) r.appendChild(node("span", "t-dim", ac.registration));
    root.appendChild(r);
  } else if (ac.registration) {
    root.appendChild(node("div", "t-dim", ac.registration));
  }

  const foot = node("div", "t-row");
  foot.appendChild(node("span", "t-dim", `HDG ${fmtTrack(ac.track)}`));
  foot.appendChild(signalGlyph(ac.rssi));
  if (ac.rssi != null) foot.appendChild(node("span", "t-dim", fmtRssi(ac.rssi)));
  root.appendChild(foot);
}

export { anchorOn, layoutTags } from "./tagLayout";
export type { TagBox, TagPlace } from "./tagLayout";
