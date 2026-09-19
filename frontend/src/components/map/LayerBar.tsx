"use client";

import { ArrowDownToLine, CloudRain, Flame, Map as MapIcon, PlaneLanding, Radar, Route, Spline, Tag, TextCursorInput } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Layers } from "./MapView";

const ITEMS: { key: keyof Layers; label: string; Icon: typeof Tag }[] = [
  { key: "trails", label: "Trails", Icon: Spline },
  { key: "drops", label: "Drop lines", Icon: ArrowDownToLine },
  { key: "labels", label: "Labels", Icon: Tag },
  { key: "rings", label: "Range rings", Icon: Radar },
  { key: "routes", label: "Route", Icon: Route },
  { key: "weather", label: "Weather", Icon: CloudRain },
  { key: "heatmap", label: "Heatmap", Icon: Flame },
  { key: "tags", label: "Tags", Icon: TextCursorInput },
  { key: "outlines", label: "Borders", Icon: MapIcon },
  { key: "airports", label: "Airports", Icon: PlaneLanding },
];

export function LayerBar({ layers, onChange }: { layers: Layers; onChange: (l: Layers) => void }) {
  return (
    <div className="panel pointer-events-auto flex items-center gap-1 rounded-md p-1" role="group" aria-label="Map layers">
      {ITEMS.map(({ key, label, Icon }) => (
        <Button
          key={key}
          size="sm"
          variant={layers[key] ? "secondary" : "ghost"}
          className={`rounded ${layers[key] ? "" : "text-muted-foreground"}`}
          aria-pressed={layers[key]}
          title={label}
          onClick={() => onChange({ ...layers, [key]: !layers[key] })}
        >
          <Icon /> <span className="hidden 2xl:inline">{label}</span>
          <span className="sr-only 2xl:hidden">{label}</span>
        </Button>
      ))}
    </div>
  );
}
