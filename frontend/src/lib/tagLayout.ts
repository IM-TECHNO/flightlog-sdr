/** Screen layout for floating flight tags. Pure functions with no imports, so they can be tested on their own. */

export type TagBox = { id: string; ax: number; ay: number; w: number; h: number };
export type TagPlace = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

const GAP = 4;
const MARGIN = 4;
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;

/**
 * Put each tag up and to the right of its aircraft (ax, ay), flipped to the left near the right edge, and keep tags
 * from overlapping. When a tag collides it is stacked below what it hit; if that runs off the screen it is stacked
 * above instead, and if that fails too it moves into the next column outwards. Aircraft are handled top to bottom.
 */
export function layoutTags(boxes: TagBox[], width: number, height: number): Map<string, TagPlace> {
  const placed: Rect[] = [];
  const out = new Map<string, TagPlace>();

  for (const b of [...boxes].sort((p, q) => p.ay - q.ay || p.ax - q.ax)) {
    const flip = b.ax + 18 + b.w > width - MARGIN;
    const dir = flip ? -1 : 1;
    const baseX = flip ? b.ax - b.w - 18 : b.ax + 18;
    let startY = b.ay - b.h - 12;
    if (startY < MARGIN) startY = b.ay + 12; // near the top: below the aircraft instead
    startY = Math.min(startY, height - b.h - MARGIN);

    let me: Rect = { x: Math.max(MARGIN, baseX), y: startY, w: b.w, h: b.h };
    let found = false;
    for (let col = 0; col < 6 && !found; col++) {
      const x = Math.min(Math.max(MARGIN, baseX + dir * col * (b.w + GAP)), width - b.w - MARGIN);
      // first try stacking downwards, then upwards
      for (const step of [1, -1]) {
        me = { x, y: startY, w: b.w, h: b.h };
        for (let guard = 0; guard < 60; guard++) {
          const hit = placed.find((p) => overlaps(me, p));
          if (!hit) break;
          me.y = step === 1 ? hit.y + hit.h + GAP : hit.y - b.h - GAP;
        }
        if (!placed.some((p) => overlaps(me, p)) && me.y >= MARGIN && me.y + b.h <= height - MARGIN) {
          found = true;
          break;
        }
      }
    }
    if (!found) me = { x: Math.max(MARGIN, baseX), y: Math.min(Math.max(startY, MARGIN), height - b.h - MARGIN), w: b.w, h: b.h }; // crowded beyond help
    placed.push(me);
    out.set(b.id, { x: me.x, y: me.y });
  }
  return out;
}

/** Nearest point on a tag's rectangle to the aircraft: where the leader line ends. */
export function anchorOn(place: TagPlace, w: number, h: number, ax: number, ay: number): [number, number] {
  return [Math.min(Math.max(ax, place.x), place.x + w), Math.min(Math.max(ay, place.y), place.y + h)];
}
