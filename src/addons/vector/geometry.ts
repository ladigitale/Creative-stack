/**
 * Géométrie vectorielle de base : types, aire, boîte, orientation, contenance, groupement
 * de contours en polygones à trous. Fonctions pures.
 */

export type Pt = [number, number];
/** Contour fermé, sans point de fermeture répété. */
export type Ring = Pt[];
/** Polygone : contour extérieur puis trous. */
export type Poly = Ring[];
export type Multi = Poly[];
export type BBox = { x: number; y: number; w: number; h: number };

/** Aire signée (positive = sens trigonométrique en repère mathématique, horaire à l'écran y↓). */
export function signedArea(r: Ring): number {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const [x0, y0] = r[i];
    const [x1, y1] = r[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

export const ringArea = (r: Ring): number => Math.abs(signedArea(r));

/** Aire d'un polygone à trous. */
export function polyArea(p: Poly): number {
  return p.reduce((n, r, i) => n + (i === 0 ? ringArea(r) : -ringArea(r)), 0);
}

export const multiArea = (m: Multi): number => m.reduce((n, p) => n + polyArea(p), 0);

export function ringBBox(r: Ring): BBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of r) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}

export function multiBBox(m: Multi): BBox {
  const all: Pt[] = [];
  for (const p of m) if (p[0]) all.push(...p[0]);
  return ringBBox(all);
}

export function unionBBox(a: BBox, b: BBox): BBox {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export const intersects = (a: BBox, b: BBox): boolean => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;

/** Point dans un contour (règle pair-impair). */
export function inRing(p: Pt, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function centroid(r: Ring): Pt {
  const a = signedArea(r);
  if (Math.abs(a) < 1e-12) {
    const n = r.length || 1;
    return [r.reduce((s, p) => s + p[0], 0) / n, r.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0, cy = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % n];
    const f = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/** Retire les points confondus (et le point de fermeture répété). */
export function dedupe(r: Ring, eps = 1e-9): Ring {
  const out: Ring = [];
  for (const p of r) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > eps || Math.abs(q[1] - p[1]) > eps) out.push(p);
  }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) <= eps && Math.abs(out[0][1] - out[out.length - 1][1]) <= eps) out.pop();
  return out;
}

/**
 * Groupe des contours fermés en polygones à trous par profondeur d'imbrication (pair-impair) :
 * un contour de profondeur paire est un extérieur, de profondeur impaire un trou de son parent direct.
 */
export function ringsToMulti(rings: Ring[]): Multi {
  const rs = rings.map((r) => dedupe(r)).filter((r) => r.length >= 3 && ringArea(r) > 1e-12);
  const order = rs.map((r, i) => ({ r, i, a: ringArea(r) })).sort((p, q) => q.a - p.a);
  const parent: number[] = new Array(rs.length).fill(-1);
  const depth: number[] = new Array(rs.length).fill(0);
  for (let k = 0; k < order.length; k++) {
    const cur = order[k];
    let best = -1;
    for (let j = k - 1; j >= 0; j--) {
      if (inRing(cur.r[0], order[j].r) && (best === -1 || order[j].a < order[best].a)) best = j;
    }
    if (best >= 0) {
      parent[cur.i] = order[best].i;
      depth[cur.i] = depth[order[best].i] + 1;
    }
  }
  const polys = new Map<number, Poly>();
  for (const { r, i } of order) if (depth[i] % 2 === 0) polys.set(i, [r]);
  for (const { r, i } of order) if (depth[i] % 2 === 1) polys.get(parent[i])?.push(r);
  return [...polys.values()];
}
