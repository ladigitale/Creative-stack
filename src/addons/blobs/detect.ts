/**
 * Comptage d'objets : seuillage adaptatif (éclairage aplati + Otsu), ouverture morphologique,
 * composantes connexes, puis séparation des objets qui se touchent (transformée de distance,
 * graines aux maxima, partage par croissance). Pur, sans DOM.
 */

export type Polarity = "auto" | "dark" | "light";

export interface BlobOptions {
  /** Objets plus sombres ou plus clairs que le fond ; auto = la classe minoritaire. */
  polarity?: Polarity;
  /** Rayon du flou qui estime l'éclairage, en fraction du petit côté (0.02..0.5). */
  flatten?: number;
  /** Décalage du seuil d'Otsu, en écarts-types (négatif = plus permissif). */
  bias?: number;
  /** Ouverture morphologique (px) : efface poussières et reflets fins. */
  open?: number;
  /** Aire minimale absolue en fraction de l'image. */
  minAreaFrac?: number;
  /** Aire minimale relative à l'aire médiane (0..1). */
  minAreaRel?: number;
  /** Sépare les objets qui se touchent. */
  split?: boolean;
  /** Une composante est candidate à la séparation au-delà de ce multiple de la médiane. */
  splitRatio?: number;
  /** Pic de distance minimal relatif au pic de la composante (0..1). */
  peakRel?: number;
  /** Part minimale de l'aire de référence pour un morceau issu d'une séparation. */
  minPartRel?: number;
  /** Ignore les composantes qui touchent le bord. */
  dropBorder?: boolean;
  /** Aire de référence (px) imposée ; sinon celle de `refPoint`, sinon la médiane. */
  refArea?: number;
  /** Point (px) sur un objet type : l'aire de sa composante devient la référence. */
  refPoint?: { x: number; y: number };
}

/** Garde-fou : au-delà, l'appelant doit réduire l'image. */
export const MAX_PIXELS = 2_500_000;

export interface Blob {
  id: number;
  x: number; y: number; w: number; h: number;
  cx: number; cy: number;
  area: number;
  /** Nombre estimé d'objets par l'aire (1 pour un objet seul). */
  k: number;
  /** Vrai si issu de la séparation d'un amas. */
  split: boolean;
  border: boolean;
}

export interface BlobResult {
  width: number; height: number;
  count: number;
  /** Somme des k : estimation qui compte aussi les amas non séparés. */
  estimate: number;
  /** Aire de référence d'un objet (px). */
  median: number;
  reference: "median" | "point" | "area";
  polarity: "dark" | "light";
  threshold: number;
  blobs: Blob[];
  /** Étiquette par pixel (0 = fond), pour un aperçu. */
  labels: Int32Array;
  ms: number;
}

const DEF: Required<Omit<BlobOptions, "refArea" | "refPoint">> = {
  polarity: "auto",
  flatten: 0.12,
  bias: 0,
  open: 1,
  minAreaFrac: 0.0002,
  minAreaRel: 0.3,
  split: true,
  splitRatio: 1.6,
  peakRel: 0.55,
  minPartRel: 0.6,
  dropBorder: false,
};

export function detectBlobs(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, opts: BlobOptions = {}): BlobResult {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const o = { ...DEF, ...opts };
  const W = width, H = height, N = W * H;
  if (!(W > 0 && H > 0) || N > MAX_PIXELS) throw new Error(`taille d'image invalide (${W}×${H})`);
  if (rgba.length < N * 4) throw new Error("données d'image incomplètes");

  // 1. luminance
  const gray = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) gray[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];

  // 2. aplatissement de l'éclairage : gray / flou large (image intégrale)
  const r = Math.max(2, Math.round(Math.min(W, H) * o.flatten));
  const bg = boxBlur(gray, W, H, r);
  const flat = new Float32Array(N);
  for (let i = 0; i < N; i++) flat[i] = gray[i] / Math.max(1, bg[i]);

  // 3. seuil d'Otsu sur l'image aplatie (histogramme 256 classes sur [min,max])
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < N; i++) { const v = flat[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const span = Math.max(1e-6, mx - mn);
  const hist = new Float64Array(256);
  for (let i = 0; i < N; i++) hist[Math.min(255, ((flat[i] - mn) / span * 255) | 0)]++;
  const tBin = otsu(hist, N);
  let mean = 0; for (let i = 0; i < N; i++) mean += flat[i]; mean /= N;
  let sd = 0; for (let i = 0; i < N; i++) sd += (flat[i] - mean) ** 2; sd = Math.sqrt(sd / N);
  const thr = mn + (tBin + 0.5) / 255 * span + o.bias * sd;

  let below = 0; for (let i = 0; i < N; i++) if (flat[i] < thr) below++;
  const polarity: "dark" | "light" = o.polarity === "auto" ? (below <= N - below ? "dark" : "light") : o.polarity;
  let mask: Uint8Array = new Uint8Array(N);
  for (let i = 0; i < N; i++) mask[i] = (polarity === "dark" ? flat[i] < thr : flat[i] > thr) ? 1 : 0;

  // 4. ouverture morphologique (érosion puis dilatation, carré 3×3, o.open fois)
  for (let k = 0; k < o.open; k++) mask = erode(mask, W, H);
  for (let k = 0; k < o.open; k++) mask = dilate(mask, W, H);

  // 5. composantes connexes (8-connexité)
  const { labels, comps } = components(mask, W, H);
  const minAbs = N * o.minAreaFrac;
  let kept = comps.filter((c) => c.area >= minAbs && !(o.dropBorder && c.border));
  let refFromPoint: number | undefined;
  if (o.refPoint) {
    const px = Math.round(o.refPoint.x), py = Math.round(o.refPoint.y);
    const l = px >= 0 && py >= 0 && px < W && py < H ? labels[py * W + px] : 0;
    const hit = l ? comps.find((c) => c.label === l && c.area >= minAbs) : undefined;
    if (hit) refFromPoint = hit.area;
  }
  // Référence = taille d'un objet seul. La médiane brute sert d'abord à écarter le bruit ; puis,
  // comme des amas peuvent être majoritaires, on prend la médiane des formes proches du 1er quartile.
  const rough = median(kept.map((c) => c.area));
  kept = kept.filter((c) => c.area >= o.minAreaRel * (o.refArea ?? refFromPoint ?? rough));
  const med = o.refArea ?? refFromPoint ?? typicalArea(kept.map((c) => c.area));
  kept = kept.filter((c) => c.area >= o.minAreaRel * med);

  // 6. séparation des amas
  const out: Blob[] = [];
  let nextId = 1;
  const refR = Math.sqrt(med / Math.PI);
  for (const c of kept) {
    const kEst = Math.max(1, Math.round(c.area / med));
    if (o.split && c.area > o.splitRatio * med) {
      const parts = splitComponent(labels, W, c, refR, o.peakRel, o.minPartRel);
      if (parts.length > 1) {
        for (const p of parts) out.push({ ...p, id: nextId++, k: Math.max(1, Math.round(p.area / med)), split: true, border: c.border });
        continue;
      }
    }
    out.push({ id: nextId++, x: c.x0, y: c.y0, w: c.x1 - c.x0 + 1, h: c.y1 - c.y0 + 1, cx: c.sx / c.area, cy: c.sy / c.area, area: c.area, k: kEst, split: false, border: c.border });
  }

  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    width: W, height: H,
    count: out.length,
    estimate: out.reduce((s, b) => s + b.k, 0),
    median: med,
    reference: refFromPoint !== undefined ? "point" : o.refArea !== undefined ? "area" : "median",
    polarity,
    threshold: thr,
    blobs: out,
    labels,
    ms: Math.round(t1 - t0),
  };
}

/* ---------- briques ---------- */

function boxBlur(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += src[y * W + x];
      I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      const s = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
      out[y * W + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

function otsu(hist: Float64Array, total: number): number {
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestT = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; bestT = t; }
  }
  return bestT;
}

function erode(m: Uint8Array, W: number, H: number): Uint8Array {
  const o = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    o[i] = m[i] & m[i - 1] & m[i + 1] & m[i - W] & m[i + W] & m[i - W - 1] & m[i - W + 1] & m[i + W - 1] & m[i + W + 1];
  }
  return o;
}

function dilate(m: Uint8Array, W: number, H: number): Uint8Array {
  const o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0;
    for (let dy = -1; dy <= 1 && !v; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx; if (xx < 0 || xx >= W) continue;
        if (m[yy * W + xx]) { v = 1; break; }
      }
    }
    o[y * W + x] = v;
  }
  return o;
}

interface Comp { label: number; area: number; x0: number; y0: number; x1: number; y1: number; sx: number; sy: number; border: boolean; }

function components(mask: Uint8Array, W: number, H: number): { labels: Int32Array; comps: Comp[] } {
  const labels = new Int32Array(W * H);
  const parent: number[] = [0];
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  let next = 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!mask[i]) continue;
    const n: number[] = [];
    if (x > 0 && labels[i - 1]) n.push(labels[i - 1]);
    if (y > 0) {
      if (labels[i - W]) n.push(labels[i - W]);
      if (x > 0 && labels[i - W - 1]) n.push(labels[i - W - 1]);
      if (x < W - 1 && labels[i - W + 1]) n.push(labels[i - W + 1]);
    }
    if (!n.length) { parent.push(next); labels[i] = next++; }
    else { const m = Math.min(...n); labels[i] = m; for (const l of n) union(m, l); }
  }
  const map = new Map<number, Comp>();
  const remap = new Int32Array(next);
  let k = 0;
  for (let l = 1; l < next; l++) { const r = find(l); if (!remap[r]) remap[r] = ++k; remap[l] = remap[r]; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!labels[i]) continue;
    const l = remap[labels[i]]; labels[i] = l;
    let c = map.get(l);
    if (!c) { c = { label: l, area: 0, x0: x, y0: y, x1: x, y1: y, sx: 0, sy: 0, border: false }; map.set(l, c); }
    c.area++; c.sx += x; c.sy += y;
    if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) c.border = true;
  }
  return { labels, comps: [...map.values()] };
}

/** Transformée de distance (chanfrein 3-4) puis graines = maxima, partage géodésique. */
function splitComponent(labels: Int32Array, W: number, c: Comp, refR: number, peakRel: number, minPartRel: number) {
  const bw = c.x1 - c.x0 + 3, bh = c.y1 - c.y0 + 3; // marge de 1 px
  const inC = new Uint8Array(bw * bh);
  for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++)
    if (labels[y * W + x] === c.label) inC[(y - c.y0 + 1) * bw + (x - c.x0 + 1)] = 1;

  const BIG = 1e9;
  const d = new Float32Array(bw * bh);
  for (let i = 0; i < d.length; i++) d[i] = inC[i] ? BIG : 0;
  for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
    const i = y * bw + x; if (!inC[i]) continue;
    d[i] = Math.min(d[i], d[i - 1] + 3, d[i - bw] + 3, d[i - bw - 1] + 4, d[i - bw + 1] + 4);
  }
  for (let y = bh - 2; y > 0; y--) for (let x = bw - 2; x > 0; x--) {
    const i = y * bw + x; if (!inC[i]) continue;
    d[i] = Math.min(d[i], d[i + 1] + 3, d[i + bw] + 3, d[i + bw + 1] + 4, d[i + bw - 1] + 4);
  }
  let dmax = 0; for (let i = 0; i < d.length; i++) if (d[i] > dmax) dmax = d[i];

  // maxima locaux au-dessus de peakRel·dmax, suppression des non-maxima dans un rayon ~ 0.8·refR
  const cand: { i: number; v: number }[] = [];
  for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
    const i = y * bw + x, v = d[i];
    if (!inC[i] || v < peakRel * dmax) continue;
    if (v >= d[i - 1] && v >= d[i + 1] && v >= d[i - bw] && v >= d[i + bw] && v >= d[i - bw - 1] && v >= d[i - bw + 1] && v >= d[i + bw - 1] && v >= d[i + bw + 1]) cand.push({ i, v });
  }
  cand.sort((a, b) => b.v - a.v);
  const sup = Math.max(2, 0.8 * refR);
  const seeds: number[] = [];
  for (const p of cand) {
    const px = p.i % bw, py = (p.i / bw) | 0;
    if (seeds.every((s) => Math.hypot((s % bw) - px, ((s / bw) | 0) - py) > sup)) seeds.push(p.i);
  }
  if (seeds.length < 2) return [];

  // partage : croissance depuis les graines par distance décroissante (ligne de partage des eaux simplifiée) ;
  // un morceau trop petit (faux pic au centre d'une grappe) est retiré et le partage recalculé
  const order: number[] = [];
  for (let i = 0; i < d.length; i++) if (inC[i]) order.push(i);
  order.sort((a, b) => d[b] - d[a]);
  const refArea = Math.PI * refR * refR;
  let parts = grow(seeds, order, d, bw, bh, c);
  while (seeds.length > 2) {
    let worst = -1;
    parts.forEach((p, k) => { if (p.area < minPartRel * refArea && (worst < 0 || p.area < parts[worst].area)) worst = k; });
    if (worst < 0) break;
    seeds.splice(worst, 1);
    parts = grow(seeds, order, d, bw, bh, c);
  }
  if (seeds.length === 2 && parts.some((p) => p.area < minPartRel * refArea)) return [];
  return parts.filter((p) => p.area > 0).map((p) => ({
    x: p.x0, y: p.y0, w: p.x1 - p.x0 + 1, h: p.y1 - p.y0 + 1, cx: p.sx / p.area, cy: p.sy / p.area, area: p.area,
  }));
}

function grow(seeds: number[], order: number[], d: Float32Array, bw: number, bh: number, c: Comp) {
  const own = new Int32Array(bw * bh);
  seeds.forEach((s, k) => (own[s] = k + 1));
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const i of order) {
      if (own[i]) continue;
      const nb = [i - 1, i + 1, i - bw, i + bw, i - bw - 1, i - bw + 1, i + bw - 1, i + bw + 1];
      let best = 0, bestD = -1;
      for (const j of nb) if (own[j] && d[j] > bestD) { bestD = d[j]; best = own[j]; }
      if (best) { own[i] = best; changed = true; }
    }
    if (!changed) break;
  }
  const parts = seeds.map(() => ({ area: 0, sx: 0, sy: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }));
  for (let i = 0; i < own.length; i++) {
    const k = own[i]; if (!k) continue;
    const p = parts[k - 1];
    const x = (i % bw) - 1 + c.x0, y = ((i / bw) | 0) - 1 + c.y0;
    p.area++; p.sx += x; p.sy += y;
    if (x < p.x0) p.x0 = x; if (x > p.x1) p.x1 = x; if (y < p.y0) p.y0 = y; if (y > p.y1) p.y1 = y;
  }
  return parts;
}

/** Aire typique d'un objet seul : médiane des aires comprises entre 0,6 et 1,6 fois le 1er quartile. */
function typicalArea(a: number[]): number {
  if (!a.length) return 1;
  const s = [...a].sort((x, y) => x - y);
  const q = s[Math.floor((s.length - 1) / 4)];
  return median(s.filter((v) => v >= 0.6 * q && v <= 1.6 * q));
}

function median(a: number[]): number {
  if (!a.length) return 1;
  const s = [...a].sort((x, y) => x - y);
  return s[(s.length / 2) | 0];
}

/** SVG autonome des marqueurs (cercles numérotés, « ×k » pour un amas estimé) : nombres seulement, aucun texte libre. */
export function toOverlaySvg(r: Pick<BlobResult, "width" | "height" | "blobs">, colors = { single: "#f5c400", split: "#ff7a00" }): string {
  const W = r.width, H = r.height;
  const sw = Math.max(1, +(Math.min(W, H) / 160).toFixed(2));
  const fs = Math.max(8, +(Math.min(W, H) / 22).toFixed(1));
  const safe = (c: string) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : "#f5c400");
  const marks = r.blobs.map((b, i) => {
    const rr = +(Math.max(b.w, b.h) / 2 + sw * 2).toFixed(1);
    const cx = +b.cx.toFixed(1), cy = +b.cy.toFixed(1);
    const label = b.k > 1 ? `×${b.k}` : String(i + 1);
    return `<circle cx="${cx}" cy="${cy}" r="${rr}" fill="none" stroke="${safe(b.split ? colors.split : colors.single)}" stroke-width="${sw}"/>` +
      `<text x="${cx}" y="${+(cy + fs * 0.35).toFixed(1)}" font-size="${fs}" text-anchor="middle" font-family="ui-monospace,monospace" font-weight="700" fill="#fff" stroke="#111" stroke-width="${+(sw * 0.9).toFixed(2)}" paint-order="stroke">${label}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${marks}</svg>`;
}
