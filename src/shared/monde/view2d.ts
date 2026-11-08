/**
 * Projection 2D d'un `monde` (vue de dessus, de profil, de face, isométrique) : la même scène 3D, regardée
 * par une caméra orthographique. Chaque pièce devient une silhouette (enveloppe convexe de sa forme vue
 * de la direction courante), placée à chaque image par une transformation affine exacte de sa matrice monde.
 *
 * Performance : la silhouette n'est recalculée que si la direction de vue, dans le repère de la pièce, change
 * de case (quantification sphérique) ; sinon seule l'affine bouge (aucun redessin).
 */
import type { M4, V3 } from "./math";
import type { View2d } from "./format";

/** Projection écran (2 × 3) et axe de profondeur (vers la caméra) d'une vue, en coordonnées monde. */
export type Proj = { px: V3; py: V3; depth: V3; dir: V3 };

const C30 = Math.cos(Math.PI / 6), S30 = 0.5;

export function projOf(view: View2d["view"]): Proj {
  switch (view) {
    case "side":
      return { px: [1, 0, 0], py: [0, -1, 0], depth: [0, 0, 1], dir: [0, 0, -1] };
    case "front":
      return { px: [0, 0, -1], py: [0, -1, 0], depth: [1, 0, 0], dir: [-1, 0, 0] };
    case "iso": {
      // projection 2:1 classique ; sa direction exacte (noyau de la projection) est (-1, -1, -1)
      const d = norm([-1, -1, -1]);
      return { px: [C30, 0, -C30], py: [S30, -1, S30], depth: [-d[0], -d[1], -d[2]], dir: d };
    }
    default:
      return { px: [1, 0, 0], py: [0, 0, 1], depth: [0, 1, 0], dir: [0, -1, 0] };
  }
}

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Enveloppe convexe (chaîne monotone), sens trigonométrique. `pts` : [x0, y0, x1, y1, …]. */
export function hull(pts: number[]): number[] {
  const n = pts.length / 2;
  if (n < 3) return pts.slice();
  const idx = [...Array(n).keys()].sort((a, b) => pts[a * 2] - pts[b * 2] || pts[a * 2 + 1] - pts[b * 2 + 1]);
  const cross = (o: number, a: number, b: number) =>
    (pts[a * 2] - pts[o * 2]) * (pts[b * 2 + 1] - pts[o * 2 + 1]) - (pts[a * 2 + 1] - pts[o * 2 + 1]) * (pts[b * 2] - pts[o * 2]);
  const lower: number[] = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  const upper: number[] = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  const h = lower.slice(0, -1).concat(upper.slice(0, -1));
  const out: number[] = [];
  for (const i of h) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

/** Sous-échantillon des sommets d'une forme (≤ max points), pour les silhouettes. */
export function samplePoints(pos: Float32Array, max = 96): Float32Array {
  const n = pos.length / 3;
  if (n <= max) return pos;
  const out = new Float32Array(max * 3);
  for (let k = 0; k < max; k++) {
    const i = Math.floor((k * n) / max);
    out[k * 3] = pos[i * 3];
    out[k * 3 + 1] = pos[i * 3 + 1];
    out[k * 3 + 2] = pos[i * 3 + 2];
  }
  return out;
}

const LON = 24, LAT = 12;

/** Case de quantification d'une direction (repère de la pièce). */
export function bucketOf(d: V3): number {
  const lat = Math.min(LAT - 1, Math.floor(((Math.asin(Math.max(-1, Math.min(1, d[1]))) / Math.PI) + 0.5) * LAT));
  const lon = Math.floor(((Math.atan2(d[2], d[0]) / (2 * Math.PI)) + 0.5) * LON) % LON;
  return lat * LON + lon;
}

/** Direction centrale d'une case. */
export function bucketDir(b: number): V3 {
  const lat = Math.floor(b / LON), lon = b % LON;
  const la = ((lat + 0.5) / LAT - 0.5) * Math.PI;
  const lo = ((lon + 0.5) / LON - 0.5) * 2 * Math.PI;
  return [Math.cos(la) * Math.cos(lo), Math.sin(la), Math.cos(la) * Math.sin(lo)];
}

/** Base (u, v) du plan perpendiculaire à `d`, orientée de façon stable. */
export function basisOf(d: V3): [V3, V3] {
  const ref: V3 = Math.abs(d[1]) < 0.95 ? [0, 1, 0] : [0, 0, 1];
  // u = ref × d, v = d × u
  let u: V3 = [ref[1] * d[2] - ref[2] * d[1], ref[2] * d[0] - ref[0] * d[2], ref[0] * d[1] - ref[1] * d[0]];
  u = norm(u);
  const v: V3 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  return [u, v];
}

/** Silhouette (dans la base u, v) de points de pièce. */
export function silhouette(pts: Float32Array, u: V3, v: V3): number[] {
  const flat: number[] = [];
  for (let i = 0; i < pts.length; i += 3) {
    flat.push(pts[i] * u[0] + pts[i + 1] * u[1] + pts[i + 2] * u[2], pts[i] * v[0] + pts[i + 1] * v[1] + pts[i + 2] * v[2]);
  }
  return hull(flat);
}

/**
 * Direction de vue exprimée dans le repère local d'une matrice monde (rotation × échelle) :
 * transposée de la partie linéaire, normalisée. Pour une échelle non uniforme, c'est une approximation suffisante.
 */
export function localDir(w: M4, dir: V3, out: V3): V3 {
  const sx = Math.hypot(w[0], w[1], w[2]) || 1, sy = Math.hypot(w[4], w[5], w[6]) || 1, sz = Math.hypot(w[8], w[9], w[10]) || 1;
  out[0] = (w[0] * dir[0] + w[1] * dir[1] + w[2] * dir[2]) / sx;
  out[1] = (w[4] * dir[0] + w[5] * dir[1] + w[6] * dir[2]) / sy;
  out[2] = (w[8] * dir[0] + w[9] * dir[1] + w[10] * dir[2]) / sz;
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l;
  out[1] /= l;
  out[2] /= l;
  return out;
}

/**
 * Affine écran d'une pièce : point (s, t) de sa silhouette (base u, v) → écran.
 * Renvoie [a, b, c, d, tx, ty] au sens de PIXI.Matrix (x' = a s + c t + tx, y' = b s + d t + ty).
 */
export function affineOf(w: M4, u: V3, v: V3, p: Proj, unit: number, ox: number, oy: number, out: number[]): number[] {
  // W·u et W·v (partie linéaire), puis projection écran
  const wu0 = w[0] * u[0] + w[4] * u[1] + w[8] * u[2], wu1 = w[1] * u[0] + w[5] * u[1] + w[9] * u[2], wu2 = w[2] * u[0] + w[6] * u[1] + w[10] * u[2];
  const wv0 = w[0] * v[0] + w[4] * v[1] + w[8] * v[2], wv1 = w[1] * v[0] + w[5] * v[1] + w[9] * v[2], wv2 = w[2] * v[0] + w[6] * v[1] + w[10] * v[2];
  out[0] = (p.px[0] * wu0 + p.px[1] * wu1 + p.px[2] * wu2) * unit;
  out[1] = (p.py[0] * wu0 + p.py[1] * wu1 + p.py[2] * wu2) * unit;
  out[2] = (p.px[0] * wv0 + p.px[1] * wv1 + p.px[2] * wv2) * unit;
  out[3] = (p.py[0] * wv0 + p.py[1] * wv1 + p.py[2] * wv2) * unit;
  out[4] = ox + (p.px[0] * w[12] + p.px[1] * w[13] + p.px[2] * w[14]) * unit;
  out[5] = oy + (p.py[0] * w[12] + p.py[1] * w[13] + p.py[2] * w[14]) * unit;
  return out;
}

/** Profondeur (vers la caméra) d'un point monde. */
export function depthOf(p: Proj, x: number, y: number, z: number): number {
  return p.depth[0] * x + p.depth[1] * y + p.depth[2] * z;
}
