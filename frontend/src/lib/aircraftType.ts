import { liveryKey } from "./livery";
import type { Shape } from "./planeModel";

const set = (s: string) => new Set(s.split(/\s+/));

const WIDE = set("A30B A306 A310 A332 A333 A337 A338 A339 A359 A35K A3ST B762 B763 B764 B772 B773 B77L B77W B788 B789 B78X MD11 DC10 IL96 A124");
const QUAD = set("B741 B742 B743 B744 B748 A342 A343 A345 A346 A388 IL76 B52 C5M");
const TURBOPROP = set("AT43 AT44 AT45 AT46 AT72 AT73 AT75 AT76 DH8A DH8B DH8C DH8D SF34 JS31 JS32 JS41 B190 E120 F50 F27 SB20 D328 AN24 AN26 AN32 C130 C30J PC12 TBM7 TBM8 TBM9 BE20 BE9L BE99 C208 DHC6 DHC7 SW4");
const REGIONAL = set("E135 E145 E170 E175 E75L E75S E190 E195 E290 E295 CRJ1 CRJ2 CRJ7 CRJ9 CRJX CRJ5 SU95 E50P E55P CL60 GLEX GL5T GL6T GL7T H25B H25C PC24 C680 C700 C750 C56X C68A");
const REGIONAL_RE = /^(GLF\d|C25[A-Z]|LJ\d\d|FA\d[A-Z0-9]|C5\d\d|CL\d\d)$/;
const LIGHT_RE = /^(C1\d\d|C2[01]\d|P28[A-Z]|PA\d\d|SR2\d|DA\d\d|BE3\d|BE5\d|M20[A-Z]|AA\d|R22|R44|R66|EC\d\d|AS\d\d|B06|B407|H\d\d|S76|A109|A139)$/;

export function shapeFor(typeCode?: string | null): Shape {
  const t = (typeCode ?? "").toUpperCase();
  if (!t) return "narrow";
  if (QUAD.has(t)) return "quad";
  if (WIDE.has(t)) return "wide";
  if (TURBOPROP.has(t)) return "turboprop";
  if (REGIONAL.has(t) || REGIONAL_RE.test(t)) return "regional";
  if (LIGHT_RE.test(t)) return "light";
  return "narrow";
}

const LENGTH_M: Record<string, number> = {
  A318: 31.4, A319: 33.8, A19N: 33.8, A320: 37.6, A20N: 37.6, A321: 44.5, A21N: 44.5,
  B737: 33.6, B738: 39.5, B739: 42.1, B37M: 35.6, B38M: 39.5, B39M: 42.2, B752: 47.3, B753: 54.4,
  A332: 58.8, A333: 63.7, A338: 58.8, A339: 63.7, A359: 66.8, A35K: 73.8, B762: 48.5, B763: 54.9,
  B772: 63.7, B77L: 63.7, B773: 73.9, B77W: 73.9, B788: 56.7, B789: 62.8, B78X: 68.3,
  B744: 70.7, B748: 76.3, A388: 72.7, A343: 63.7, A346: 75.4,
  AT72: 27.2, AT76: 27.2, AT45: 22.7, DH8D: 32.8, DH8C: 25.7, E170: 29.9, E175: 31.7, E190: 36.2, E195: 38.7,
  CRJ2: 26.8, CRJ7: 32.5, CRJ9: 36.2, E145: 29.9, C172: 8.3, C152: 7.3, PA28: 7.2, SR22: 7.9,
};
const DEFAULT_LENGTH_M: Record<Shape, number> = { narrow: 38, wide: 63, quad: 72, regional: 30, turboprop: 27, light: 8.5 };

/** Real fuselage length in metres for a type (or a typical one for its body shape). */
export function lengthFor(typeCode?: string | null): number {
  const t = (typeCode ?? "").toUpperCase();
  return LENGTH_M[t] ?? DEFAULT_LENGTH_M[shapeFor(t)];
}

/** Model URL and scale for an aircraft type in an airline's colours. */
export function modelFor(typeCode?: string | null, airline?: string | null): { uri: string; scale: number; key: string } {
  const shape = shapeFor(typeCode);
  const key = `${shape}/${liveryKey(airline)}`;
  return { uri: `/models/${key}.gltf`, scale: lengthFor(typeCode), key };
}
