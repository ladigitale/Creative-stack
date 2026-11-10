import { ringsToMulti, multiArea, ringArea, type Multi, type Pt, type Ring } from "../vector/geometry";
import { simplifyRing } from "../vector/ops";
import { ringsToPath } from "../vector/svgpath";

/**
 * Vectorisation d'une image par quantification des couleurs puis suivi de contours :
 * pixels → palette (k-moyennes) → un masque par couleur → contours exacts sur la grille →
 * lissage de l'escalier des pixels → simplification → chemins SVG (lignes, ou courbes avec coins vifs).
 */

export type RGBA = { data: ArrayLike<number>; width: number; height: number };

export type TraceOptions = {
  /** Nombre de couleurs (2..32). */
  colors?: number;
  /** Tolérance de simplification en pixels (défaut 1). */
  tolerance?: number;
  /** Surface minimale (px²) d'une tache gardée. */
  minArea?: number;
  /** Lissage du bruit : passes de filtre majoritaire 3×3. */
  denoise?: number;
  /** Courbes de Bézier (sinon polygones). */
  curves?: boolean;
  /** Empilement : chaque couche couvre aussi celles du dessus (pas de trous entre régions). */
  stack?: boolean;
  /** Plafond de couches × chemins (sécurité de taille). */
  maxChars?: number;
  /**
   * Palette imposée (#rgb / #rrggbb) : chaque pixel prend la plus proche de ces couleurs au lieu d'une palette
   * calculée (`colors` est alors ignoré). Pour vectoriser sur une palette d'harmonie.
   */
  palette?: string[];
};

export type Layer = { color: string; d: string; area: number };
export type TraceResult = { width: number; height: number; layers: Layer[]; palette: string[]; truncated: boolean };

export const MAX_PIXELS = 2_000_000;

const hex = (c: number[]) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** Générateur pseudo-aléatoire déterministe (même image → même palette). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dist2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/**
 * Palette : k-moyennes amorcées par k-means++ glouton (les grands aplats d'abord, pas les pixels
 * de transition des bords), puis fusion des couleurs quasi identiques.
 */
export function quantize(img: RGBA, k: number): number[][] {
  const n = img.width * img.height;
  const step = Math.max(1, Math.floor(n / 30000));
  const samples: number[][] = [];
  for (let i = 0; i < n; i += step) {
    if ((img.data[i * 4 + 3] ?? 255) < 128) continue;
    samples.push([img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]]);
  }
  if (!samples.length) return [];
  const rand = rng(0x5eed);
  // 1re couleur : la plus fréquente (grossièrement, par cases de 16 niveaux).
  const bins = new Map<number, number>();
  let top = 0, topKey = 0;
  for (const p of samples) {
    const key = ((p[0] >> 4) << 8) | ((p[1] >> 4) << 4) | (p[2] >> 4);
    const c = (bins.get(key) ?? 0) + 1;
    bins.set(key, c);
    if (c > top) { top = c; topKey = key; }
  }
  const first = samples.find((p) => (((p[0] >> 4) << 8) | ((p[1] >> 4) << 4) | (p[2] >> 4)) === topKey)!;
  let pal: number[][] = [first.slice()];
  const d = samples.map((p) => dist2(p, first));
  while (pal.length < k) {
    let total = 0;
    for (const v of d) total += v;
    if (total <= 0) break;
    // k-means++ « glouton » : plusieurs candidats tirés, on garde celui qui réduit le plus l'erreur totale
    // (un grand aplat l'emporte sur un pixel de transition isolé).
    let c = samples[0], bestCost = Infinity;
    for (let t = 0; t < 8; t++) {
      let r = rand() * total, idx = 0;
      for (; idx < d.length - 1; idx++) { r -= d[idx]; if (r <= 0) break; }
      const cand = samples[idx];
      let cost = 0;
      for (let i = 0; i < samples.length; i++) cost += Math.min(d[i], dist2(samples[i], cand));
      if (cost < bestCost) { bestCost = cost; c = cand; }
    }
    c = c.slice();
    pal.push(c);
    for (let i = 0; i < samples.length; i++) d[i] = Math.min(d[i], dist2(samples[i], c));
  }
  for (let it = 0; it < 10; it++) {
    const sum = pal.map(() => [0, 0, 0, 0]);
    for (const p of samples) {
      const j = nearest(pal, p[0], p[1], p[2]);
      sum[j][0] += p[0]; sum[j][1] += p[1]; sum[j][2] += p[2]; sum[j][3]++;
    }
    let moved = 0;
    pal = pal.map((c, j) => {
      if (!sum[j][3]) return c;
      const m = [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]];
      moved = Math.max(moved, dist2(c, m));
      return m;
    });
    if (moved < 0.25) break;
  }
  // Fusion des couleurs presque identiques (écart < 10 niveaux) : un aplat ne se scinde pas en deux.
  const out: number[][] = [];
  for (const c of pal) if (!out.some((o) => dist2(o, c) < 100)) out.push(c);
  return out;
}

function nearest(pal: number[][], r: number, g: number, b: number): number {
  let bj = 0, bd = Infinity;
  for (let j = 0; j < pal.length; j++) {
    const dr = pal[j][0] - r, dg = pal[j][1] - g, db = pal[j][2] - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bd) { bd = d; bj = j; }
  }
  return bj;
}

/** Étiquette de palette par pixel (−1 : transparent). */
export function label(img: RGBA, pal: number[][]): Int16Array {
  const out = new Int16Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = (img.data[i * 4 + 3] ?? 255) < 128 ? -1 : nearest(pal, img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
  }
  return out;
}

/** Filtre majoritaire 3×3 : retire le bruit isolé en gardant les arêtes nettes. */
export function denoise(lab: Int16Array, w: number, h: number, passes: number, k: number): Int16Array {
  let cur = lab;
  const cnt = new Int32Array(k + 1);
  for (let p = 0; p < passes; p++) {
    const next = new Int16Array(cur.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      cnt.fill(0);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        cnt[cur[yy * w + xx] + 1]++;
      }
      const own = cur[y * w + x], oc = cnt[own + 1];
      let bj = own, bc = -1;
      for (let j = 0; j <= k; j++) if (j !== own + 1 && cnt[j] > bc) { bc = cnt[j]; bj = j - 1; }
      // Pixel isolé ou sur un trait d'un pixel (≤ 3 voisins de sa couleur, soi compris) : il prend la couleur
      // dominante autour. C'est ce qui retire les liserés de transition laissés par l'anticrénelage.
      // Ailleurs, il ne change que devant une nette majorité (les arêtes restent en place).
      next[y * w + x] = (oc <= 3 && bc >= oc) || bc > oc + 1 ? bj : own;
    }
    cur = next;
  }
  return cur;
}

const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];

/** Contours d'un masque binaire, sommets aux coins de pixels ; anneaux fermés sans points alignés. */
export function traceMask(mask: Uint8Array, w: number, h: number): Ring[] {
  const W = w + 1;
  const out = new Uint8Array(W * (h + 1));
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    if (!on(x, y - 1)) out[y * W + x] |= 1; // haut : → droite
    if (!on(x + 1, y)) out[y * W + x + 1] |= 2; // droite : ↓ bas
    if (!on(x, y + 1)) out[(y + 1) * W + x + 1] |= 4; // bas : ← gauche
    if (!on(x - 1, y)) out[(y + 1) * W + x] |= 8; // gauche : ↑ haut
  }
  const rings: Ring[] = [];
  for (let v = 0; v < out.length; v++) {
    while (out[v]) {
      let d = out[v] & 1 ? 0 : out[v] & 2 ? 1 : out[v] & 4 ? 2 : 3;
      const sx = v % W, sy = (v / W) | 0;
      let x = sx, y = sy;
      const pts: Pt[] = [];
      let prev = -1;
      for (;;) {
        out[y * W + x] &= ~(1 << d);
        if (d !== prev) pts.push([x, y]);
        prev = d;
        x += DX[d]; y += DY[d];
        if (x === sx && y === sy) break;
        const m = out[y * W + x];
        const opts = [(d + 1) % 4, d, (d + 3) % 4];
        const nd = opts.find((o) => m & (1 << o));
        if (nd === undefined) break;
        d = nd;
      }
      if (pts.length >= 3) rings.push(pts);
    }
  }
  return rings;
}

/**
 * Retire l'escalier des pixels d'un contour suivi sur la grille : chaque arête est remplacée par son
 * milieu ; un sommet n'est gardé tel quel que s'il sépare deux arêtes d'au moins `CORNER_RUN` pixels
 * (vrai coin, pas une marche). Une diagonale en escalier devient une droite, un rectangle reste exact.
 */
const CORNER_RUN = 3;
export function smoothRing(r: Ring): Ring {
  const n = r.length;
  if (n < 3) return r;
  const len = (i: number) => {
    const a = r[i], b = r[(i + 1) % n];
    return Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
  };
  const out: Ring = [];
  for (let i = 0; i < n; i++) {
    const a = r[i], b = r[(i + 1) % n];
    if (Math.min(len((i + n - 1) % n), len(i)) >= CORNER_RUN) out.push([a[0], a[1]]);
    out.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  }
  return out;
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);
const pt = (p: Pt) => `${fmt(p[0])} ${fmt(p[1])}`;

/**
 * Contour simplifié → chemin lisse. Chaque sommet est soit un coin (segments droits), soit un point
 * de passage d'une courbe quadratique tracée d'un milieu d'arête au suivant et passant par le sommet.
 * Les points de contrôle restent à moins d'une demi-arête du contour : ni boucle ni débordement.
 * Coin : virage ≥ 70°, ou ≥ 35° entre deux arêtes longues (un petit cercle reste rond, un triangle pointu).
 */
export function ringToCurve(r: Ring, tol: number): string {
  const n = r.length;
  if (n < 3) return "";
  const longEdge = Math.max(6, 12 * tol);
  const corner = r.map((v, i) => {
    const p = r[(i + n - 1) % n], q = r[(i + 1) % n];
    const ax = v[0] - p[0], ay = v[1] - p[1], bx = q[0] - v[0], by = q[1] - v[1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (!la || !lb) return true;
    const turn = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) * 180 / Math.PI;
    return turn >= 70 || (turn >= 35 && Math.min(la, lb) >= longEdge);
  });
  if (corner.every(Boolean)) return `M${r.map(pt).join("L")}Z`;
  const mid = (i: number): Pt => {
    const a = r[i % n], b = r[(i + 1) % n];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  let d = `M${pt(mid(n - 1))}`;
  for (let i = 0; i < n; i++) {
    const v = r[i], m1 = mid(i + n - 1), m2 = mid(i);
    if (corner[i]) d += `L${pt(v)}L${pt(m2)}`;
    else d += `Q${pt([2 * v[0] - (m1[0] + m2[0]) / 2, 2 * v[1] - (m1[1] + m2[1]) / 2])} ${pt(m2)}`;
  }
  return d + "Z";
}

/** Couleurs #rgb / #rrggbb valides d'une palette imposée (32 au plus, doublons retirés). */
export function parsePalette(list: unknown): number[][] {
  if (!Array.isArray(list)) return [];
  const out: number[][] = [];
  const seen = new Set<string>();
  for (const c of list) {
    if (typeof c !== "string") continue;
    let h = c.trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(h)) h = "#" + h.slice(1).split("").map((x) => x + x).join("");
    if (!/^#[0-9a-f]{6}$/.test(h) || seen.has(h)) continue;
    seen.add(h);
    out.push([1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
    if (out.length >= 32) break;
  }
  return out;
}

/** Image → couches SVG (de la plus étendue, dessous, à la plus petite, dessus). */
export function trace(img: RGBA, opts: TraceOptions = {}): TraceResult {
  const { width: w, height: h } = img;
  if (!(w > 0 && h > 0) || w * h > MAX_PIXELS) throw new Error("taille d'image invalide ou trop grande");
  const k = Math.max(2, Math.min(32, Math.round(opts.colors ?? 8)));
  const tol = Math.max(0.1, opts.tolerance ?? 1);
  const minArea = Math.max(0, opts.minArea ?? 4);
  const maxChars = opts.maxChars ?? 1_500_000;
  const fixed = parsePalette(opts.palette);
  const pal = fixed.length ? fixed : quantize(img, k);
  if (!pal.length) return { width: w, height: h, layers: [], palette: [], truncated: false };
  let lab = label(img, pal);
  if ((opts.denoise ?? 1) > 0) lab = denoise(lab, w, h, Math.min(3, Math.round(opts.denoise ?? 1)), pal.length);
  const counts = new Array(pal.length).fill(0);
  for (const l of lab) if (l >= 0) counts[l]++;
  const order = pal.map((_, i) => i).filter((i) => counts[i] > 0).sort((a, b) => counts[b] - counts[a]);
  const stack = opts.stack !== false;
  const layers: Layer[] = [];
  let chars = 0, truncated = false;
  for (let oi = 0; oi < order.length; oi++) {
    const members = new Set(stack ? order.slice(oi) : [order[oi]]);
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) if (lab[i] >= 0 && members.has(lab[i])) mask[i] = 1;
    let m: Multi = ringsToMulti(traceMask(mask, w, h));
    m = m.filter((p) => multiArea([p]) >= minArea);
    if (!m.length) continue;
    m = m
      .map((p) => p.map((r) => simplifyRing(smoothRing(r), tol)).filter((r) => r.length >= 3 && ringArea(r) > 0.25))
      .filter((p) => p.length);
    if (!m.length) continue;
    const rings = m.flatMap((p) => p);
    const d = opts.curves ? rings.map((r) => ringToCurve(r, tol)).join("") : ringsToPath(rings);
    if (!d) continue;
    chars += d.length;
    if (chars > maxChars) { truncated = true; break; }
    layers.push({ color: hex(pal[order[oi]]), d, area: multiArea(m) });
  }
  return { width: w, height: h, layers, palette: order.map((i) => hex(pal[i])), truncated };
}

/** Document SVG autonome ; `size` : dimensions d'affichage (ex. celles de l'image d'origine). */
export function toSvg(r: TraceResult, size?: { width: number; height: number }): string {
  const body = r.layers.map((l) => `<path fill="${l.color}" fill-rule="evenodd" d="${l.d}"/>`).join("");
  const dims = size && size.width > 0 && size.height > 0 ? ` width="${Math.round(size.width)}" height="${Math.round(size.height)}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r.width} ${r.height}"${dims}>${body}</svg>`;
}
