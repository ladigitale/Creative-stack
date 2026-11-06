import { ringsToMulti, multiArea, type Multi, type Pt, type Ring } from "../vector/geometry";
import { fitMulti, simplifyMulti } from "../vector/ops";
import { ringsToPath } from "../vector/svgpath";

/**
 * Vectorisation d'une image par quantification des couleurs puis suivi de contours :
 * pixels → palette (k-moyennes) → un masque par couleur → contours exacts sur la grille →
 * simplification → chemins SVG (lignes ou courbes de Bézier).
 */

export type RGBA = { data: ArrayLike<number>; width: number; height: number };

export type TraceOptions = {
  /** Nombre de couleurs (2..32). */
  colors?: number;
  /** Tolérance de simplification en pixels. */
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
};

export type Layer = { color: string; d: string; area: number };
export type TraceResult = { width: number; height: number; layers: Layer[]; palette: string[]; truncated: boolean };

export const MAX_PIXELS = 2_000_000;

const hex = (c: number[]) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** Palette par coupe médiane puis affinage k-moyennes sur un échantillon des pixels opaques. */
export function quantize(img: RGBA, k: number): number[][] {
  const n = img.width * img.height;
  const step = Math.max(1, Math.floor(n / 20000));
  const samples: number[][] = [];
  for (let i = 0; i < n; i += step) {
    if ((img.data[i * 4 + 3] ?? 255) < 128) continue;
    samples.push([img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]]);
  }
  if (!samples.length) return [];
  let boxes: number[][][] = [samples];
  while (boxes.length < k) {
    let bi = -1, best = 0, ch = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const p of b) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c]; }
        const range = (hi - lo) * Math.sqrt(b.length);
        if (range > best) { best = range; bi = i; ch = c; }
      }
    });
    if (bi < 0 || best === 0) break;
    // Coupe au milieu de l'étendue (et non à la médiane) : un aplat dominant ne mange pas les autres couleurs.
    const b = boxes[bi];
    let lo = 255, hi = 0;
    for (const p of b) { if (p[ch] < lo) lo = p[ch]; if (p[ch] > hi) hi = p[ch]; }
    const cut = (lo + hi) / 2;
    const left = b.filter((p) => p[ch] <= cut), right = b.filter((p) => p[ch] > cut);
    boxes.splice(bi, 1, left, right);
  }
  let pal = boxes.map((b) => [0, 1, 2].map((c) => b.reduce((s, p) => s + p[c], 0) / b.length));
  for (let it = 0; it < 4; it++) {
    const sum = pal.map(() => [0, 0, 0, 0]);
    for (const p of samples) {
      const j = nearest(pal, p[0], p[1], p[2]);
      sum[j][0] += p[0]; sum[j][1] += p[1]; sum[j][2] += p[2]; sum[j][3]++;
    }
    pal = pal.map((c, j) => (sum[j][3] ? [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]] : c));
  }
  return pal;
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
      let bj = cur[y * w + x], bc = cnt[bj + 1];
      for (let j = 0; j <= k; j++) if (cnt[j] > bc + 1) { bc = cnt[j]; bj = j - 1; }
      next[y * w + x] = bj;
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

/** Image → couches SVG (de la plus étendue, dessous, à la plus petite, dessus). */
export function trace(img: RGBA, opts: TraceOptions = {}): TraceResult {
  const { width: w, height: h } = img;
  if (!(w > 0 && h > 0) || w * h > MAX_PIXELS) throw new Error("taille d'image invalide ou trop grande");
  const k = Math.max(2, Math.min(32, Math.round(opts.colors ?? 8)));
  const tol = Math.max(0.1, opts.tolerance ?? 0.8);
  const minArea = Math.max(0, opts.minArea ?? 4);
  const maxChars = opts.maxChars ?? 1_500_000;
  const pal = quantize(img, k);
  if (!pal.length) return { width: w, height: h, layers: [], palette: [], truncated: false };
  let lab = label(img, pal);
  if ((opts.denoise ?? 1) > 0) lab = denoise(lab, w, h, Math.min(3, opts.denoise ?? 1), pal.length);
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
    m = simplifyMulti(m, tol);
    const d = opts.curves ? fitMulti(m, tol) : ringsToPath(m.flatMap((p) => p));
    if (!d) continue;
    chars += d.length;
    if (chars > maxChars) { truncated = true; break; }
    layers.push({ color: hex(pal[order[oi]]), d, area: multiArea(m) });
  }
  return { width: w, height: h, layers, palette: order.map((i) => hex(pal[i])), truncated };
}

/** Document SVG autonome. */
export function toSvg(r: TraceResult): string {
  const body = r.layers.map((l) => `<path fill="${l.color}" fill-rule="evenodd" d="${l.d}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r.width} ${r.height}">${body}</svg>`;
}
