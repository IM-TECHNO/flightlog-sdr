/**
 * Procedural aircraft models (glTF), one per body shape and airline livery.
 * Geometry is lofted from cross-sections; the livery is baked into vertex colours (COLOR_0).
 * Unit length = fuselage length; nose toward glTF +Z, Y up, left = +X.
 */
import type { Livery } from "./livery";

export type Shape = "narrow" | "wide" | "quad" | "regional" | "turboprop" | "light";
export const SHAPES: Shape[] = ["narrow", "wide", "quad", "regional", "turboprop", "light"];
export const isShape = (s: string): s is Shape => (SHAPES as string[]).includes(s);

type V = [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const centroid = (pts: V[]): V => mul(pts.reduce(add, [0, 0, 0] as V), 1 / pts.length);
const toLinear = (hex: string): V => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.pow(v / 255, 2.2)) as V;
};

class Mesh {
  p: number[] = [];
  n: number[] = [];
  c: number[] = [];
  i: number[] = [];
  vertex(pos: V, nor: V, col: V): number {
    this.p.push(...pos);
    this.n.push(...nor);
    this.c.push(...col);
    return this.p.length / 3 - 1;
  }
}

type Ref = [number, number] | null; // [ring, index]; null = cap centre

/** Connect consecutive rings into a closed tube; winding is fixed per face so normals point away from the centre line. */
function loft(m: Mesh, rings: V[][], o: { smooth?: boolean; color: (p: V, r: number, j: number) => V; capStart?: boolean; capEnd?: boolean }) {
  const R = rings.length, N = rings[0].length;
  const cents = rings.map(centroid);
  const col = (r: number, j: number) => o.color(rings[r][j], r, j);
  const smoothIdx = o.smooth ? rings.map((ring, r) => ring.map((p, j) => m.vertex(p, [0, 0, 0], col(r, j)))) : null;
  const tris: { refs: Ref[]; center?: V }[] = [];

  for (let r = 0; r < R - 1; r++) {
    for (let j = 0; j < N; j++) {
      const j2 = (j + 1) % N;
      const q: [number, number][] = [[r, j], [r, j2], [r + 1, j2], [r + 1, j]];
      const pts = q.map(([a, b]) => rings[a][b]);
      const out = sub(mul(pts.reduce(add, [0, 0, 0] as V), 0.25), mul(add(cents[r], cents[r + 1]), 0.5));
      const flip = dot(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])), out) < 0;
      for (const t of [[0, 1, 2], [0, 2, 3]]) tris.push({ refs: (flip ? [t[0], t[2], t[1]] : t).map((k) => q[k]) });
    }
  }
  const cap = (r: number, away: V) => {
    const c = cents[r];
    for (let j = 0; j < N; j++) {
      const a: Ref = [r, j], b: Ref = [r, (j + 1) % N];
      const n = cross(sub(rings[r][b![1]], c), sub(rings[r][a![1]], c));
      tris.push({ refs: dot(n, sub(c, away)) >= 0 ? [null, b, a] : [null, a, b], center: c });
    }
  };
  if (o.capStart) cap(0, cents[R - 1]);
  if (o.capEnd) cap(R - 1, cents[0]);

  for (const t of tris) {
    const pos = t.refs.map((k) => (k === null ? (t.center as V) : rings[k[0]][k[1]]));
    const fn = cross(sub(pos[1], pos[0]), sub(pos[2], pos[0]));
    const area = len(fn);
    if (area < 1e-12) continue;
    const nrm = mul(fn, 1 / area);
    const cols = t.refs.map((k) => (k === null ? col((t.refs[1] as [number, number])[0], (t.refs[1] as [number, number])[1]) : col(k[0], k[1])));
    if (smoothIdx && t.refs.every((k) => k !== null)) {
      const ids = (t.refs as [number, number][]).map(([r, j]) => smoothIdx[r][j]);
      for (const id of ids) for (let a = 0; a < 3; a++) m.n[id * 3 + a] += fn[a];
      m.i.push(...ids);
    } else {
      m.i.push(...pos.map((p, k) => m.vertex(p, nrm, cols[k])));
    }
  }
  if (smoothIdx) {
    for (const row of smoothIdx) for (const id of row) {
      const v: V = [m.n[id * 3], m.n[id * 3 + 1], m.n[id * 3 + 2]];
      const l = len(v) || 1;
      for (let a = 0; a < 3; a++) m.n[id * 3 + a] = v[a] / l;
    }
  }
}

const PROFILE: [number, number][] = [[0, 0], [0.06, 0.55], [0.3, 1], [0.7, 0.72], [1, 0.08], [1, -0.08], [0.7, -0.45], [0.3, -0.7], [0.06, -0.4]];
type Sec = { o: V; chordDir?: V; thickDir?: V; chord: number; thick: number };
const section = (s: Sec): V[] =>
  PROFILE.map(([u, v]) => add(add(s.o, mul(s.chordDir ?? [0, 0, -1], u * s.chord)), mul(s.thickDir ?? [0, 1, 0], v * s.thick)));
const mirrorX = (s: Sec): Sec => {
  const t = s.thickDir ?? [0, 1, 0];
  return { ...s, o: [-s.o[0], s.o[1], s.o[2]], thickDir: [-t[0], t[1], t[2]] };
};
const sec = (x: number, y: number, z: number, chord: number, thick: number, vertical = false): Sec => ({
  o: [x, y, z], chord, thick, ...(vertical ? { thickDir: [1, 0, 0] as V } : {}),
});

type Spec = {
  rs: number; // fuselage radius scale
  wing: Sec[];
  winglet?: Sec[];
  stab: Sec[];
  fin: Sec[];
  engines: { x: number; y: number; z0: number; z1: number; r: number }[];
  props?: { x: number; y: number; z: number; r: number }[];
};

const NARROW_WING = [sec(0.03, -0.03, 0.13, 0.27, 0.03), sec(0.2, -0.02, 0.01, 0.16, 0.016), sec(0.47, 0.006, -0.135, 0.07, 0.008)];
const CONV_FIN = [sec(0, 0.03, -0.27, 0.19, 0.014, true), sec(0, 0.12, -0.36, 0.13, 0.01, true), sec(0, 0.215, -0.44, 0.075, 0.006, true)];
const CONV_STAB = [sec(0.02, 0.028, -0.385, 0.12, 0.011), sec(0.19, 0.046, -0.455, 0.05, 0.006)];
const wingletAt = (x: number, y: number, z: number, h = 0.052): Sec[] => [sec(x + 0.002, y, z, 0.07, 0.007, true), sec(x + 0.012, y + h, z - 0.03, 0.035, 0.005, true)];

const SPECS: Record<Shape, Spec> = {
  narrow: {
    rs: 1, wing: NARROW_WING, winglet: wingletAt(0.47, 0.006, -0.135), stab: CONV_STAB, fin: CONV_FIN,
    engines: [{ x: 0.155, y: -0.06, z0: 0.135, z1: 0.005, r: 0.03 }],
  },
  wide: {
    rs: 1.14,
    wing: [sec(0.035, -0.035, 0.1, 0.3, 0.036), sec(0.24, -0.022, -0.02, 0.18, 0.02), sec(0.5, 0.012, -0.17, 0.075, 0.009)],
    winglet: wingletAt(0.5, 0.012, -0.17, 0.045),
    stab: [sec(0.02, 0.03, -0.375, 0.14, 0.013), sec(0.21, 0.05, -0.46, 0.055, 0.007)],
    fin: [sec(0, 0.035, -0.26, 0.21, 0.016, true), sec(0, 0.14, -0.36, 0.14, 0.011, true), sec(0, 0.235, -0.44, 0.08, 0.007, true)],
    engines: [{ x: 0.19, y: -0.07, z0: 0.11, z1: -0.03, r: 0.042 }],
  },
  quad: {
    rs: 1.17,
    wing: [sec(0.035, -0.04, 0.1, 0.32, 0.04), sec(0.26, -0.025, -0.03, 0.19, 0.022), sec(0.5, 0.02, -0.18, 0.08, 0.01)],
    winglet: wingletAt(0.5, 0.02, -0.18, 0.05),
    stab: [sec(0.02, 0.032, -0.375, 0.14, 0.013), sec(0.21, 0.05, -0.46, 0.055, 0.007)],
    fin: [sec(0, 0.035, -0.26, 0.22, 0.016, true), sec(0, 0.14, -0.36, 0.15, 0.011, true), sec(0, 0.24, -0.44, 0.08, 0.007, true)],
    engines: [{ x: 0.15, y: -0.07, z0: 0.1, z1: -0.03, r: 0.036 }, { x: 0.3, y: -0.05, z0: 0.06, z1: -0.07, r: 0.036 }],
  },
  regional: {
    rs: 0.86,
    wing: [sec(0.03, -0.03, 0.1, 0.22, 0.026), sec(0.36, 0.004, -0.09, 0.06, 0.008)],
    winglet: wingletAt(0.36, 0.004, -0.09, 0.03),
    stab: [sec(0.012, 0.19, -0.4, 0.11, 0.009), sec(0.17, 0.2, -0.45, 0.05, 0.006)], // T-tail
    fin: [sec(0, 0.03, -0.28, 0.17, 0.013, true), sec(0, 0.2, -0.42, 0.09, 0.008, true)],
    engines: [{ x: 0.085, y: 0.028, z0: -0.2, z1: -0.34, r: 0.028 }], // rear-mounted
  },
  turboprop: {
    rs: 0.8,
    wing: [sec(0.03, 0.052, 0.06, 0.15, 0.022), sec(0.5, 0.05, 0.03, 0.085, 0.01)], // high, straight wing
    stab: [sec(0.02, 0.05, -0.4, 0.1, 0.01), sec(0.17, 0.055, -0.43, 0.06, 0.006)],
    fin: [sec(0, 0.03, -0.3, 0.16, 0.013, true), sec(0, 0.12, -0.4, 0.1, 0.009, true), sec(0, 0.2, -0.45, 0.06, 0.006, true)],
    engines: [{ x: 0.19, y: 0.035, z0: 0.16, z1: -0.06, r: 0.03 }],
    props: [{ x: 0.19, y: 0.035, z: 0.165, r: 0.075 }],
  },
  light: {
    rs: 0.5,
    wing: [sec(0.02, 0.032, 0.14, 0.17, 0.02), sec(0.62, 0.03, 0.13, 0.13, 0.014)], // high, rectangular wing
    stab: [sec(0.01, 0.045, -0.4, 0.11, 0.009), sec(0.2, 0.05, -0.43, 0.08, 0.006)],
    fin: [sec(0, 0.03, -0.32, 0.15, 0.012, true), sec(0, 0.14, -0.43, 0.09, 0.008, true)],
    engines: [],
    props: [{ x: 0, y: 0, z: 0.505, r: 0.14 }],
  },
};

function buildPlane(shape: Shape, l: Livery): Mesh {
  const C = Object.fromEntries(Object.entries(l).map(([k, v]) => [k, toLinear(v)])) as Record<keyof Livery, V>;
  const WING = toLinear("#c5ccd8"), DARK = toLinear("#15181f"), GLASS = toLinear("#0b1220"), RADOME = toLinear("#3a3f4a");
  const spec = SPECS[shape];
  const m = new Mesh();

  const stations: [number, number, number][] = [[0.5, 0.004, -0.006], [0.488, 0.02, -0.006], [0.465, 0.036, -0.005], [0.43, 0.048, -0.002],
    [0.37, 0.055, 0], [0.28, 0.058, 0], [-0.18, 0.058, 0], [-0.26, 0.054, 0.004], [-0.34, 0.044, 0.013],
    [-0.42, 0.029, 0.025], [-0.48, 0.013, 0.035], [-0.5, 0.006, 0.039]];
  const SEG = 24;
  const rings = stations.map(([z, r, cy]) =>
    Array.from({ length: SEG }, (_, j) => {
      const t = (j / SEG) * 2 * Math.PI;
      return [r * spec.rs * Math.sin(t), cy * spec.rs + r * spec.rs * Math.cos(t), z] as V;
    }));
  loft(m, rings, {
    smooth: true, capStart: true, capEnd: true,
    color: (p, _r, j) => {
      const z = p[2], deg = (j / SEG) * 360, top = Math.min(deg, 360 - deg);
      if (z > 0.47) return RADOME;
      if (z > 0.405 && z < 0.475 && top < 72) return GLASS;
      if (z < -0.33) return C.tail;
      if (top > 118) return C.belly;
      if (Math.abs(top - 90) < 9 && z > -0.33 && z < 0.4) return C.stripe;
      return C.body;
    },
  });

  for (const side of [(s: Sec) => s, mirrorX]) {
    loft(m, spec.wing.map((s) => section(side(s))), { capEnd: true, color: () => WING });
    if (spec.winglet) loft(m, spec.winglet.map((s) => section(side(s))), { capEnd: true, color: () => C.tail });
    loft(m, spec.stab.map((s) => section(side(s))), { capEnd: true, color: () => C.tail });
  }
  loft(m, spec.fin.map(section), { capEnd: true, color: () => C.tail });

  const nacelle = (x: number, y: number, z0: number, z1: number, r: number) => {
    const prof: [number, number][] = [[z0, r * 1.05], [z0 - (z0 - z1) * 0.08, r * 0.96], [z0 - (z0 - z1) * 0.5, r], [z0 - (z0 - z1) * 0.85, r * 0.9], [z1, r * 0.45]];
    const rs = prof.map(([z, rr]) => Array.from({ length: 16 }, (_, j) => {
      const t = (j / 16) * 2 * Math.PI;
      return [x + rr * Math.sin(t), y + rr * Math.cos(t), z] as V;
    }));
    loft(m, rs, { smooth: true, capStart: true, capEnd: true, color: (_p, r) => (r === 0 || r === prof.length - 1 ? DARK : C.engine) });
  };
  for (const e of spec.engines) for (const x of e.x === 0 ? [0] : [e.x, -e.x]) nacelle(x, e.y, e.z0, e.z1, e.r);
  for (const pr of spec.props ?? []) {
    for (const x of pr.x === 0 ? [0] : [pr.x, -pr.x]) {
      const disc = [pr.z - 0.003, pr.z + 0.003].map((z) => Array.from({ length: 20 }, (_, j) => {
        const t = (j / 20) * 2 * Math.PI;
        return [x + pr.r * Math.sin(t), pr.y + pr.r * Math.cos(t), z] as V;
      }));
      loft(m, disc, { capStart: true, capEnd: true, color: () => DARK });
    }
  }
  return m;
}

/** glTF JSON (with an embedded buffer) for a body shape in an airline's colours. */
export function buildGltf(shape: Shape, livery: Livery): object {
  const m = buildPlane(shape, livery);
  const P = new Float32Array(m.p), N = new Float32Array(m.n), Cc = new Float32Array(m.c);
  const I = m.p.length / 3 > 65535 ? new Uint32Array(m.i) : new Uint16Array(m.i);
  const bufs = [P, N, Cc, I].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  const padded = bufs.map((b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]));
  let off = 0;
  const views = padded.map((b, k) => {
    const v = { buffer: 0, byteOffset: off, byteLength: bufs[k].length, target: k === 3 ? 34963 : 34962 };
    off += b.length;
    return v;
  });
  const min = [0, 1, 2].map((k) => Math.min(...m.p.filter((_, i) => i % 3 === k)));
  const max = [0, 1, 2].map((k) => Math.max(...m.p.filter((_, i) => i % 3 === k)));
  return {
    asset: { version: "2.0", generator: "flightlog planeModel" },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.05, roughnessFactor: 0.5 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: P.length / 3, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count: N.length / 3, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: Cc.length / 3, type: "VEC3" },
      { bufferView: 3, componentType: I instanceof Uint32Array ? 5125 : 5123, count: I.length, type: "SCALAR" },
    ],
    bufferViews: views,
    buffers: [{ byteLength: off, uri: "data:application/octet-stream;base64," + Buffer.concat(padded).toString("base64") }],
  };
}
