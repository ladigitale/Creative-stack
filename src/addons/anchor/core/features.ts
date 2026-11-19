import { boxBlur, resizeGray, type Gray } from "./image";

/**
 * Points caractéristiques façon ORB : coins FAST-9 sur une pyramide, orientation par centroïde
 * d'intensité, descripteur binaire BRIEF tourné (256 bits = 8 mots de 32 bits).
 *
 * Le motif BRIEF est figé (graine constante, `PATTERN_VERSION`) : des références enregistrées
 * aujourd'hui doivent rester comparables demain. Changer le motif = incrémenter la version.
 */

export const PATTERN_VERSION = 1;
export const DESC_WORDS = 8;

export type Features = {
  /** Nombre de points. */
  n: number;
  /** Coordonnées en pixels de l'image de niveau 0. */
  x: Float32Array;
  y: Float32Array;
  /** Niveau de pyramide d'origine. */
  level: Uint8Array;
  /** Descripteurs, `DESC_WORDS` mots par point. */
  desc: Uint32Array;
  width: number;
  height: number;
};

export type FeatureOptions = {
  /** Points gardés au plus (tous niveaux confondus). */
  maxPoints?: number;
  /** Niveaux de pyramide (1 = pas de pyramide). */
  levels?: number;
  /** Facteur d'échelle entre deux niveaux. */
  scale?: number;
  /** Seuil FAST de départ (abaissé si trop peu de coins). */
  threshold?: number;
  /** Ne garde que les points pour lesquels `mask(x, y)` (pixels du niveau 0) est vrai. */
  mask?: (x: number, y: number) => boolean;
};

const CIRCLE: Array<[number, number]> = [
  [0, -3], [1, -3], [2, -2], [3, -1], [3, 0], [3, 1], [2, 2], [1, 3],
  [0, 3], [-1, 3], [-2, 2], [-3, 1], [-3, 0], [-3, -1], [-2, -2], [-1, -3],
];

/** Rayon du disque d'orientation et du motif BRIEF. */
const PATCH = 15;
/** Marge aux bords : motif tourné (≤ rayon) + orientation. */
const BORDER = PATCH + 2;
const BINS = 32;

type Corner = { x: number; y: number; s: number };

/** Coins FAST-9 avec score (somme des écarts au-delà du seuil sur l'arc) et suppression des non-maxima 3×3. */
export function fast9(img: Gray, threshold: number, border = 3): Corner[] {
  const { data, width: w, height: h } = img;
  const off = CIRCLE.map(([dx, dy]) => dy * w + dx);
  const score = new Float32Array(w * h);
  const b0 = Math.max(3, border);
  const ring = new Int16Array(16);
  for (let y = b0; y < h - b0; y++) {
    for (let x = b0; x < w - b0; x++) {
      const p = y * w + x;
      const c = data[p];
      const hi = c + threshold, lo = c - threshold;
      // Test rapide sur 4 points cardinaux : un arc de 9 en contient au moins 2.
      const v0 = data[p + off[0]], v4 = data[p + off[4]], v8 = data[p + off[8]], v12 = data[p + off[12]];
      const nb = (v0 > hi ? 1 : 0) + (v4 > hi ? 1 : 0) + (v8 > hi ? 1 : 0) + (v12 > hi ? 1 : 0);
      const nd = (v0 < lo ? 1 : 0) + (v4 < lo ? 1 : 0) + (v8 < lo ? 1 : 0) + (v12 < lo ? 1 : 0);
      if (nb < 2 && nd < 2) continue;
      for (let i = 0; i < 16; i++) ring[i] = data[p + off[i]] - c;
      const s = arcScore(ring, threshold);
      if (s > 0) score[p] = s;
    }
  }
  const out: Corner[] = [];
  for (let y = b0; y < h - b0; y++) {
    for (let x = b0; x < w - b0; x++) {
      const p = y * w + x;
      const s = score[p];
      if (s <= 0) continue;
      if (s < score[p - 1] || s <= score[p + 1] || s < score[p - w - 1] || s < score[p - w] || s < score[p - w + 1]
        || s <= score[p + w - 1] || s <= score[p + w] || s <= score[p + w + 1]) continue;
      out.push({ x, y, s });
    }
  }
  return out;
}

/** Score si un arc contigu de 9 pixels est entièrement plus clair (ou plus sombre) que le centre ± seuil, sinon 0. */
function arcScore(ring: Int16Array, t: number): number {
  let run = 0, best = 0;
  for (let i = 0; i < 25; i++) {
    run = ring[i & 15] > t ? run + 1 : 0;
    if (run > best) best = run;
  }
  let sign = 0;
  if (best >= 9) sign = 1;
  else {
    run = 0; best = 0;
    for (let i = 0; i < 25; i++) {
      run = ring[i & 15] < -t ? run + 1 : 0;
      if (run > best) best = run;
    }
    if (best >= 9) sign = -1;
  }
  if (!sign) return 0;
  let s = 0;
  for (let i = 0; i < 16; i++) {
    const d = ring[i] * sign - t;
    if (d > 0) s += d;
  }
  return s;
}

/** Bornes horizontales du disque de rayon PATCH, ligne par ligne. */
const UMAX: number[] = (() => {
  const u: number[] = [];
  for (let v = 0; v <= PATCH; v++) u.push(Math.floor(Math.sqrt(PATCH * PATCH - v * v)));
  return u;
})();

/** Orientation (radians) par centroïde d'intensité sur le disque. */
export function orientation(img: Gray, x: number, y: number): number {
  const { data, width: w } = img;
  const c = y * w + x;
  let m01 = 0, m10 = 0;
  for (let u = -PATCH; u <= PATCH; u++) m10 += u * data[c + u];
  for (let v = 1; v <= PATCH; v++) {
    const d = UMAX[v];
    let sumV = 0;
    for (let u = -d; u <= d; u++) {
      const plus = data[c + v * w + u], minus = data[c - v * w + u];
      sumV += plus - minus;
      m10 += u * (plus + minus);
    }
    m01 += v * sumV;
  }
  return Math.atan2(m01, m10);
}

/** Motif BRIEF figé : 256 paires (ax, ay, bx, by) dans le disque, tirage gaussien à graine constante. */
const PATTERN: Int8Array = (() => {
  let s = 0x2f6b9d1 >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    const u = Math.max(1e-9, rnd()), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const sigma = 31 / 5;
  const rmax = PATCH - 2;
  const pt = (): [number, number] => {
    for (;;) {
      const x = Math.round(gauss() * sigma), y = Math.round(gauss() * sigma);
      if (x * x + y * y <= rmax * rmax) return [x, y];
    }
  };
  const p = new Int8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    let a = pt(), b = pt();
    while (a[0] === b[0] && a[1] === b[1]) b = pt();
    p.set([a[0], a[1], b[0], b[1]], i * 4);
  }
  return p;
})();

/** Décalages du motif tourné, par case d'angle, pour une largeur d'image donnée. */
function rotatedOffsets(w: number): Int32Array[] {
  const bins: Int32Array[] = [];
  for (let b = 0; b < BINS; b++) {
    const a = (b / BINS) * 2 * Math.PI;
    const c = Math.cos(a), s = Math.sin(a);
    const o = new Int32Array(512);
    for (let i = 0; i < 256; i++) {
      for (let k = 0; k < 2; k++) {
        const px = PATTERN[i * 4 + k * 2], py = PATTERN[i * 4 + k * 2 + 1];
        const rx = Math.round(c * px - s * py), ry = Math.round(s * px + c * py);
        o[i * 2 + k] = ry * w + rx;
      }
    }
    bins.push(o);
  }
  return bins;
}

function binOf(angle: number): number {
  const t = angle / (2 * Math.PI);
  return ((Math.round((t - Math.floor(t)) * BINS) % BINS) + BINS) % BINS;
}

/** Garde au plus `max` coins, répartis sur une grille pour couvrir toute l'image. */
function spread(corners: Corner[], w: number, h: number, max: number): Corner[] {
  if (corners.length <= max) return corners;
  corners.sort((a, b) => b.s - a.s);
  const gx = 8, gy = 6;
  const cap = Math.max(2, Math.ceil((max / (gx * gy)) * 2));
  const count = new Uint16Array(gx * gy);
  const out: Corner[] = [];
  const rest: Corner[] = [];
  for (const c of corners) {
    const cell = Math.min(gy - 1, ((c.y / h) * gy) | 0) * gx + Math.min(gx - 1, ((c.x / w) * gx) | 0);
    if (count[cell] < cap) { count[cell]++; out.push(c); if (out.length >= max) return out; }
    else rest.push(c);
  }
  for (const c of rest) { out.push(c); if (out.length >= max) break; }
  return out;
}

/** Extrait points et descripteurs d'une image grise. */
export function extractFeatures(img: Gray, opts: FeatureOptions = {}): Features {
  const maxPoints = Math.max(16, Math.min(4000, opts.maxPoints ?? 600));
  const levels = Math.max(1, Math.min(6, opts.levels ?? 4));
  const scale = Math.max(1.1, Math.min(2, opts.scale ?? 1.4));
  const t0 = Math.max(4, Math.min(60, opts.threshold ?? 20));

  const xs: number[] = [], ys: number[] = [], ls: number[] = [];
  const descs: Uint32Array[] = [];
  let level: Gray = img;
  let f = 1;
  // Budget par niveau décroissant (les niveaux réduits ont moins de surface).
  const weights = Array.from({ length: levels }, (_, i) => 1 / Math.pow(scale * scale, i));
  const wsum = weights.reduce((a, b) => a + b, 0);
  for (let l = 0; l < levels; l++) {
    if (l > 0) {
      f *= scale;
      const nw = Math.round(img.width / f), nh = Math.round(img.height / f);
      if (nw < 2 * BORDER + 8 || nh < 2 * BORDER + 8) break;
      level = resizeGray(img, nw, nh);
    }
    const budget = Math.max(8, Math.round((maxPoints * weights[l]) / wsum));
    let t = t0;
    let corners = fast9(level, t, BORDER);
    while (corners.length < budget && t > 5) {
      t = Math.max(5, Math.round(t * 0.6));
      corners = fast9(level, t, BORDER);
    }
    if (opts.mask) corners = corners.filter((c) => opts.mask!(c.x * f, c.y * f));
    corners = spread(corners, level.width, level.height, budget);
    if (!corners.length) continue;
    const blurred = boxBlur(level, 2);
    const rot = rotatedOffsets(level.width);
    for (const c of corners) {
      const a = orientation(level, c.x, c.y);
      const o = rot[binOf(a)];
      const p = c.y * level.width + c.x;
      const d = new Uint32Array(DESC_WORDS);
      const bd = blurred.data;
      for (let i = 0; i < 256; i++) {
        if (bd[p + o[i * 2]] < bd[p + o[i * 2 + 1]]) d[i >> 5] |= 1 << (i & 31);
      }
      descs.push(d);
      xs.push(c.x * f + (f - 1) / 2);
      ys.push(c.y * f + (f - 1) / 2);
      ls.push(l);
    }
  }
  const n = xs.length;
  const desc = new Uint32Array(n * DESC_WORDS);
  descs.forEach((d, i) => desc.set(d, i * DESC_WORDS));
  return { n, x: Float32Array.from(xs), y: Float32Array.from(ys), level: Uint8Array.from(ls), desc, width: img.width, height: img.height };
}
