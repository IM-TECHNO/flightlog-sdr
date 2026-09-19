import { useSyncExternalStore } from "react";

export type Units = "aviation" | "metric";

let current: Units = "aviation";
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    if (window.localStorage.getItem("flightlog.units") === "metric") current = "metric";
  } catch {
    /* storage unavailable: keep the default */
  }
}

export function getUnits(): Units {
  load();
  return current;
}

export function setUnits(u: Units) {
  current = u;
  try {
    window.localStorage.setItem("flightlog.units", u);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Re-renders the calling component tree when the unit system changes. */
export function useUnits(): Units {
  return useSyncExternalStore(subscribe, getUnits, () => "aviation" as Units);
}
