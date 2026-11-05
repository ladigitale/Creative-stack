/**
 * Déformation d'une image par des os (calcul pur, sans DOM) : « skinning » à mélange linéaire.
 *
 * Une grille de sommets recouvre l'image dans la **pose de repos**. Chaque sommet est lié aux quelques os les plus
 * proches, avec un poids qui décroît avec la distance à l'os (segment articulation → extrémité). À chaque image, un sommet
 * est placé à la moyenne pondérée des positions que lui donnerait chacun de ses os : près d'une articulation il suit
 * les deux os (le coude se plie), loin d'elle un seul (l'avant-bras reste rigide).
 *
 * Les os viennent de `sonic-skeleton` (`rest` : pose de repos, `bones` : pose courante), mêmes conventions
 * d'angles (voir ./skeleton.ts : degrés, 0 = vers le bas, positif = sens horaire à l'écran).
 */

export const MAX_GRID = 40;
export const MAX_INFLUENCES = 4;

/** Os tel que publié par `sonic-skeleton` : origine, extrémité, direction absolue (°). */
export type BoneFrame = { x: number; y: number; x2: number; y2: number; angle: number };

export type SkinOptions = {
  /** Centre de l'image dans la pose de repos (unités de la scène) et taille. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Nombre de colonnes et de lignes de mailles (2 à 40). */
  cols: number;
  rows: number;
  /** Os liés, dans la pose de repos. */
  rest: BoneFrame[];
  /** Exposant de la décroissance des poids avec la distance : grand = jonctions plus nettes, petit = plus souple. */
  falloff: number;
  /** Nombre d'os qui influencent un sommet (1 à 4). */
  influences: number;
};

export type Skin = {
  cols: number;
  rows: number;
  /** Nombre de sommets : `(cols + 1) × (rows + 1)`. */
  count: number;
  influences: number;
  /** Coordonnées de texture (u, v) par sommet. */
  uvs: Float32Array;
  /** Triangles (indices de sommets). */
  indices: Uint32Array;
  /** Position de repos par sommet (x, y), unités de la scène. */
  restPositions: Float32Array;
  /** Par sommet et par influence : indice de l'os, poids (somme 1), position locale (x, y) dans le repère de l'os de repos. */
  bone: Uint8Array;
  weight: Float32Array;
  local: Float32Array;
};

const RAD = Math.PI / 180;

const clampInt = (v: number, lo: number, hi: number, d: number): number => {
  const n = Math.round(Number.isFinite(v) ? v : d);
  return Math.max(lo, Math.min(hi, n));
};

/** Distance d'un point à un segment. */
export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** Rotation de l'angle `θ` (°) dans la convention du squelette : l'image de `(0, 1)` est `dir(θ)`. */
function rot(theta: number, x: number, y: number): [number, number] {
  const c = Math.cos(theta * RAD);
  const s = Math.sin(theta * RAD);
  return [x * c - y * s, x * s + y * c];
}

/** Construit la grille, les poids et les positions locales. Aucun os : `null`. */
export function buildSkin(opts: SkinOptions): Skin | null {
  const rest = opts.rest;
  if (rest.length === 0) return null;
  const cols = clampInt(opts.cols, 2, MAX_GRID, 8);
  const rows = clampInt(opts.rows, 2, MAX_GRID, 8);
  const k = Math.min(clampInt(opts.influences, 1, MAX_INFLUENCES, 3), rest.length);
  const falloff = Number.isFinite(opts.falloff) && opts.falloff > 0 ? opts.falloff : 2;
  const w = opts.w > 0 ? opts.w : 1;
  const h = opts.h > 0 ? opts.h : 1;
  const count = (cols + 1) * (rows + 1);
  const uvs = new Float32Array(count * 2);
  const restPositions = new Float32Array(count * 2);
  const bone = new Uint8Array(count * k);
  const weight = new Float32Array(count * k);
  const local = new Float32Array(count * k * 2);
  // Un sommet exactement sur un os ne divise pas par zéro et ne l'emporte pas à l'infini
  const eps = Math.max(w, h) * 0.01;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const i = r * (cols + 1) + c;
      const u = c / cols;
      const v = r / rows;
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = v;
      const px = opts.x - w / 2 + u * w;
      const py = opts.y - h / 2 + v * h;
      restPositions[i * 2] = px;
      restPositions[i * 2 + 1] = py;
      const dist = rest.map((b, bi) => ({ bi, d: distanceToSegment(px, py, b.x, b.y, b.x2, b.y2) }));
      dist.sort((a, b) => a.d - b.d || a.bi - b.bi);
      let sum = 0;
      const raw = dist.slice(0, k).map((e) => {
        const wgt = 1 / Math.pow(e.d + eps, falloff);
        sum += wgt;
        return { bi: e.bi, wgt };
      });
      raw.forEach((e, j) => {
        const slot = i * k + j;
        bone[slot] = e.bi;
        weight[slot] = e.wgt / sum;
        const b = rest[e.bi];
        const [lx, ly] = rot(-b.angle, px - b.x, py - b.y);
        local[slot * 2] = lx;
        local[slot * 2 + 1] = ly;
      });
    }
  }
  const indices = new Uint32Array(cols * rows * 6);
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      const b = a + 1;
      const d = a + cols + 1;
      const e = d + 1;
      indices.set([a, b, d, b, e, d], n);
      n += 6;
    }
  }
  return { cols, rows, count, influences: k, uvs, indices, restPositions, bone, weight, local };
}

/**
 * Positions déformées (x, y par sommet, unités de la scène) pour la pose courante `current` (mêmes os, même ordre que
 * `rest`). Écrit dans `out` (longueur `count × 2`). Un os absent de `current` garde sa pose de repos.
 */
export function skinVertices(skin: Skin, rest: BoneFrame[], current: BoneFrame[], out: Float32Array): void {
  const k = skin.influences;
  for (let i = 0; i < skin.count; i++) {
    let x = 0;
    let y = 0;
    for (let j = 0; j < k; j++) {
      const slot = i * k + j;
      const bi = skin.bone[slot];
      const b = current[bi] ?? rest[bi];
      const [rx, ry] = rot(b.angle, skin.local[slot * 2], skin.local[slot * 2 + 1]);
      const wgt = skin.weight[slot];
      x += wgt * (b.x + rx);
      y += wgt * (b.y + ry);
    }
    out[i * 2] = x;
    out[i * 2 + 1] = y;
  }
}
