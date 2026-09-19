import { useSyncExternalStore } from "react";

/** Boolean preferences kept in localStorage; changing one re-renders every component that reads it. */
const listeners = new Set<() => void>();

function read(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(`flightlog.${key}`);
    return v == null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export function usePref(key: string, fallback = false): [boolean, (v: boolean) => void] {
  const value = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => read(key, fallback),
    () => fallback,
  );
  const set = (v: boolean) => {
    try {
      window.localStorage.setItem(`flightlog.${key}`, v ? "1" : "0");
    } catch {
      /* storage unavailable: the choice lasts until reload */
    }
    listeners.forEach((l) => l());
  };
  return [value, set];
}

/** Read outside React (e.g. inside a polling callback). */
export const getPref = read;
