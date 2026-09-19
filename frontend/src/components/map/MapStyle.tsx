"use client";

import { Projector } from "lucide-react";

type Props = {
  dim: boolean;
  onDim: (dim: boolean) => void;
  onProjector: () => void;
};

/** How the map looks: the normal street map, a dimmed one, or projector mode (black, only aircraft and outlines). */
export function MapStyle({ dim, onDim, onProjector }: Props) {
  const base = "num flex h-7 items-center gap-1.5 rounded px-2.5 text-xs transition-colors";
  const on = "bg-accent text-foreground";
  const off = "text-muted-foreground hover:text-foreground";
  return (
    <div className="panel pointer-events-auto flex items-center gap-0.5 rounded-md p-1" role="group" aria-label="Map style">
      <span className="eyebrow px-1.5">map</span>
      <button type="button" className={`${base} ${!dim ? on : off}`} aria-pressed={!dim} onClick={() => onDim(false)}>
        standard
      </button>
      <button type="button" className={`${base} ${dim ? on : off}`} aria-pressed={dim} onClick={() => onDim(true)}>
        dim
      </button>
      <button
        type="button"
        className={`${base} border border-primary/50 text-primary hover:bg-primary/15`}
        title="Projector mode (P): black map with borders and airports, and only aircraft with floating tags"
        onClick={onProjector}
      >
        <Projector className="size-3.5" /> projector
      </button>
    </div>
  );
}
