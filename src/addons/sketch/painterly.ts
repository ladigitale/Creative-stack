/**
 * Peinture d'une image en gestes de pinceau (« stroke-based rendering », d'après Hertzmann 1998, avec
 * raffinement sur l'erreur) : l'image est peinte du gros au fin. Pour chaque taille de pinceau, du plus grand
 * au plus petit, on compare la toile simulée à l'image floutée à l'échelle du pinceau ; là où l'écart dépasse
 * un seuil, un trait part du point le plus faux, prend la couleur de l'image et suit les formes (perpendiculaire
 * au gradient de clarté) jusqu'à ce que la couleur change. Les grandes touches posent les masses, les petites
 * les détails, seulement là où il en manque.
 *
 * Le résultat est un jeu de gestes (`gestures.ts`) que `sonic-sketch` rejoue avec ses vrais pinceaux.
 * Fonction pure (tableaux de pixels), utilisable dans le navigateur comme dans Node.
 */

export type PaintSource = { width: number; height: number; data: ArrayLike<number> };

export type PainterlyOptions = {
  /** Côté maximal de l'analyse (px), défaut 360 : plus grand = plus de détails et plus de traits. */
  maxSide?: number;
  /** Détail 0..1 (défaut 0.6) : pinceau le plus fin et seuil d'erreur. */
  detail?: number;
  /** Nombre de tailles de pinceau (défaut 6). */
  layers?: number;
  /** Seuil d'erreur moyen d'une cellule (0..1, défaut selon `detail`). */
  threshold?: number;
  /** Longueur maximale d'un trait, en pas de pinceau (défaut 10). */
  maxLength?: number;
  /** Inertie de la direction (0 : suit le gradient, 1 : droit ; défaut 0.5). */
  curvature?: number;
  /** Opacité des traits (défaut 0.92). */
  opacity?: number;
  /** Variation de couleur par trait (0..0.2, défaut 0.025) : la touche vibre comme une vraie peinture. */
  jitter?: number;
  /** Plafond de traits (défaut 12000). */
  maxStrokes?: number;
  /** Côté long du cadre des gestes (défaut 1000). */
  frame?: number;
  /** Graine du hasard. */
  seed?: number;
  /** Fond de départ (#rrggbb) ; défaut : couleur moyenne de l'image. */
  background?: string;
  /** Joindre l'aperçu de la toile simulée (RGBA, taille d'analyse) au résultat. */
  preview?: boolean;
};

export type PainterlyStroke = {
  color: string; size: number; hardness: number; opacity: number; pts: number[];
};

export type PainterlyResult = {
  width: number; height: number; strokes: Record<string, unknown>[];
  /** Erreur moyenne finale (0..1) de la toile simulée par rapport à l'image. */
  error: number;
  layers: { radius: number; strokes: number }[];
  /** Toile simulée (si `preview`) : RGBA à la taille d'analyse. */
  preview?: { width: number; height: number; data: Uint8ClampedArray };
};

type Img = { w: number; h: number; r: Float32Array; g: Float32Array; b: Float32Array };

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Réduction (moyenne par boîte) à `maxSide`, en flottants 0..1. */
export function toFloat(src: PaintSource, maxSide: number): Img {
  const k = Math.min(1, maxSide / Math.max(src.width, src.height));
  const w = Math.max(2, Math.round(src.width * k)), h = Math.max(2, Math.round(src.height * k));
  const r = new Float32Array(w * h), g = new Float32Array(w * h), b = new Float32Array(w * h);
  const n = new Float32Array(w * h);
  const d = src.data;
  for (let y = 0; y < src.height; y++) {
    const ty = Math.min(h - 1, Math.floor((y * h) / src.height));
    for (let x = 0; x < src.width; x++) {
      const tx = Math.min(w - 1, Math.floor((x * w) / src.width));
      const i = (y * src.width + x) * 4, t = ty * w + tx;
      const a = (d[i + 3] ?? 255) / 255;
      // Transparent : vu sur blanc.
      r[t] += (d[i] / 255) * a + (1 - a); g[t] += (d[i + 1] / 255) * a + (1 - a); b[t] += (d[i + 2] / 255) * a + (1 - a);
      n[t]++;
    }
  }
  for (let t = 0; t < w * h; t++) { const m = n[t] || 1; r[t] /= m; g[t] /= m; b[t] /= m; }
  return { w, h, r, g, b };
}

function blur1(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return src.slice();
  const rad = Math.ceil(sigma * 2.5);
  const k: number[] = [];
  let sum = 0;
  for (let i = -rad; i <= rad; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -rad; i <= rad; i++) s += src[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + rad];
    tmp[y * w + x] = s;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -rad; i <= rad; i++) s += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + rad];
    out[y * w + x] = s;
  }
  return out;
}

function blurImg(im: Img, sigma: number): Img {
  return { w: im.w, h: im.h, r: blur1(im.r, im.w, im.h, sigma), g: blur1(im.g, im.w, im.h, sigma), b: blur1(im.b, im.w, im.h, sigma) };
}

const hex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");

/** Peint l'image en gestes. */
export function paintImage(src: PaintSource, opts: PainterlyOptions = {}): PainterlyResult {
  const detail = Math.max(0, Math.min(1, opts.detail ?? 0.6));
  const im = toFloat(src, Math.max(32, Math.min(1200, opts.maxSide ?? 360)));
  const { w, h } = im;
  const N = w * h;
  const rand = rng(opts.seed ?? 7);
  const maxStrokes = Math.max(1, Math.min(20000, opts.maxStrokes ?? 12000));
  const opacity = Math.max(0.05, Math.min(1, opts.opacity ?? 0.92));
  const jitter = Math.max(0, Math.min(0.2, opts.jitter ?? 0.025));
  const fc = Math.max(0, Math.min(1, opts.curvature ?? 0.5));
  const maxLen = Math.max(1, Math.min(40, opts.maxLength ?? 10));
  const T = opts.threshold ?? 0.09 - 0.06 * detail;
  // Tailles de pinceau (rayons, px d'analyse), du plus grand au plus fin.
  const side = Math.max(w, h);
  const nLayers = Math.max(2, Math.min(9, opts.layers ?? 6));
  const rMax = side / 14, rMin = Math.max(0.9, 2.4 - 1.6 * detail);
  const radii: number[] = [];
  for (let i = 0; i < nLayers; i++) radii.push(rMax * Math.pow(rMin / rMax, i / (nLayers - 1)));

  // Toile simulée : fond uni.
  const cr = new Float32Array(N), cg = new Float32Array(N), cb = new Float32Array(N);
  let br = 0, bg = 0, bb = 0;
  for (let i = 0; i < N; i++) { br += im.r[i]; bg += im.g[i]; bb += im.b[i]; }
  br /= N; bg /= N; bb /= N;
  const bgm = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(opts.background ?? "");
  if (bgm) { br = parseInt(bgm[1], 16) / 255; bg = parseInt(bgm[2], 16) / 255; bb = parseInt(bgm[3], 16) / 255; }
  cr.fill(br); cg.fill(bg); cb.fill(bb);

  const scale = (opts.frame ?? 1000) / side;
  const out: Record<string, unknown>[] = [];
  const layersInfo: { radius: number; strokes: number }[] = [];
  let held: Record<string, unknown> = {};
  const emit = (brush: Record<string, unknown>, pts: number[]) => {
    const s: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(brush)) if (held[k] !== v) s[k] = v;
    held = { ...held, ...brush };
    s.pts = pts;
    out.push(s);
  };
  // Réglages communs (pinceau rond, pression qui module la taille), donnés avec le premier trait (le fond).
  const common = { reset: true, tool: "paint", blend: "normal", tip: "", angle: 0, angleFollow: false, angleJitter: 0, scatter: 0, roundness: 1, spacing: 0.15, pressure: true, sizeJitter: 0, tremble: 0 };
  {
    const R = side / 6;
    let first = true;
    for (let y = R * 0.6; y < h + R * 0.6; y += R * 1.2) {
      emit({ ...(first ? common : {}), color: hex(br, bg, bb), size: Math.round(2 * R * scale), hardness: 0.5, opacity: 1 },
        [Math.round(-R * 0.3 * scale), Math.round(y * scale), 1, Math.round((w + R * 0.3) * scale), Math.round(y * scale), 1]);
      first = false;
    }
  }

  const coverage = (pts: number[], R: number, hard: number, x0: number, y0: number, x1: number, y1: number, fn: (i: number, a: number) => void) => {
    const segs = pts.length / 3;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      let best = 0;
      for (let s = 0; s < segs; s++) {
        const ax = pts[s * 3], ay = pts[s * 3 + 1], ap = pts[s * 3 + 2];
        const bx = s + 1 < segs ? pts[s * 3 + 3] : ax, by = s + 1 < segs ? pts[s * 3 + 4] : ay, bp = s + 1 < segs ? pts[s * 3 + 5] : ap;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        let t = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
        t = Math.max(0, Math.min(1, t));
        const px = ax + dx * t, py = ay + dy * t, p = ap + (bp - ap) * t;
        const rr = R * (0.2 + 0.8 * p);
        const d = Math.hypot(x - px, y - py) / Math.max(0.5, rr);
        const a = d <= hard ? 1 : d >= 1 ? 0 : 1 - (d - hard) / (1 - hard);
        if (a > best) best = a;
        if (best >= 1) break;
      }
      if (best > 0) fn(y * w + x, best);
    }
  };

  for (let li = 0; li < radii.length && out.length < maxStrokes; li++) {
    const R = radii[li];
    const ref = blurImg(im, Math.max(0.4, R * 0.5));
    // Gradient de clarté de la référence.
    const L = new Float32Array(N);
    for (let i = 0; i < N; i++) L[i] = 0.3 * ref.r[i] + 0.59 * ref.g[i] + 0.11 * ref.b[i];
    const at = (x: number, y: number) => Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)));
    const grad = (x: number, y: number): [number, number] => {
      const xi = Math.min(w - 2, Math.max(1, Math.round(x))), yi = Math.min(h - 2, Math.max(1, Math.round(y)));
      const g = (xx: number, yy: number) => L[yy * w + xx];
      const gx = (g(xi + 1, yi - 1) + 2 * g(xi + 1, yi) + g(xi + 1, yi + 1)) - (g(xi - 1, yi - 1) + 2 * g(xi - 1, yi) + g(xi - 1, yi + 1));
      const gy = (g(xi - 1, yi + 1) + 2 * g(xi, yi + 1) + g(xi + 1, yi + 1)) - (g(xi - 1, yi - 1) + 2 * g(xi, yi - 1) + g(xi + 1, yi - 1));
      return [gx, gy];
    };
    const diff = (i: number, r: number, g: number, b: number) => Math.hypot(ref.r[i] - r, ref.g[i] - g, ref.b[i] - b);
    const step = Math.max(1, Math.round(R));
    const hard = Math.max(0.15, Math.min(0.85, 0.25 + 0.6 * (li / Math.max(1, radii.length - 1))));
    const layer: { pts: number[]; color: [number, number, number] }[] = [];
    for (let gy0 = 0; gy0 < h; gy0 += step) for (let gx0 = 0; gx0 < w; gx0 += step) {
      let sum = 0, cnt = 0, worst = -1, wi = 0;
      for (let y = gy0; y < Math.min(h, gy0 + step); y++) for (let x = gx0; x < Math.min(w, gx0 + step); x++) {
        const i = y * w + x;
        const e = diff(i, cr[i], cg[i], cb[i]);
        sum += e; cnt++;
        if (e > worst) { worst = e; wi = i; }
      }
      if (!cnt || sum / cnt <= T) continue;
      // Trait : part du point le plus faux, suit les formes.
      let x = wi % w, y = Math.floor(wi / w);
      const i0 = at(x, y);
      const col: [number, number, number] = [ref.r[i0], ref.g[i0], ref.b[i0]];
      const pts = [x, y, 0.65];
      let dx = 0, dy = 0;
      for (let k = 1; k <= maxLen; k++) {
        const i = at(x, y);
        if (k > 1 && diff(i, cr[i], cg[i], cb[i]) < diff(i, col[0], col[1], col[2])) break;
        const [gx, gy] = grad(x, y);
        const gm = Math.hypot(gx, gy);
        if (gm < 1e-4) break;
        let nx = -gy / gm, ny = gx / gm;
        if (dx * nx + dy * ny < 0) { nx = -nx; ny = -ny; }
        if (k > 1) { nx = fc * dx + (1 - fc) * nx; ny = fc * dy + (1 - fc) * ny; const m = Math.hypot(nx, ny) || 1; nx /= m; ny /= m; }
        const xn = x + R * nx, yn = y + R * ny;
        if (xn < 0 || yn < 0 || xn > w - 1 || yn > h - 1) break;
        const j = at(xn, yn);
        // La couleur change franchement : le trait s'arrête au bord de la forme.
        if (diff(j, col[0], col[1], col[2]) > 0.18 + 0.1 * (1 - detail)) break;
        x = xn; y = yn; dx = nx; dy = ny;
        pts.push(x, y, 1);
      }
      pts[pts.length - 1] = pts.length > 3 ? 0.55 : 0.8;
      if (jitter > 0) { const j = (rand() - 0.5) * 2 * jitter; col[0] += j + (rand() - 0.5) * jitter; col[1] += j + (rand() - 0.5) * jitter; col[2] += j + (rand() - 0.5) * jitter; }
      layer.push({ pts, color: col });
    }
    // Ordre mélangé dans la couche, comme des touches posées à la main.
    for (let i = layer.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [layer[i], layer[j]] = [layer[j], layer[i]]; }
    let n = 0;
    for (const s of layer) {
      if (out.length >= maxStrokes) break;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < s.pts.length; k += 3) { x0 = Math.min(x0, s.pts[k]); y0 = Math.min(y0, s.pts[k + 1]); x1 = Math.max(x1, s.pts[k]); y1 = Math.max(y1, s.pts[k + 1]); }
      const X0 = Math.max(0, Math.floor(x0 - R)), Y0 = Math.max(0, Math.floor(y0 - R)), X1 = Math.min(w - 1, Math.ceil(x1 + R)), Y1 = Math.min(h - 1, Math.ceil(y1 + R));
      const [r, g, b] = s.color;
      coverage(s.pts, R, hard, X0, Y0, X1, Y1, (i, a) => {
        const k = a * opacity;
        cr[i] += (r - cr[i]) * k; cg[i] += (g - cg[i]) * k; cb[i] += (b - cb[i]) * k;
      });
      const pts: number[] = [];
      for (let k = 0; k < s.pts.length; k += 3) pts.push(Math.round(s.pts[k] * scale), Math.round(s.pts[k + 1] * scale), Math.round(s.pts[k + 2] * 100) / 100);
      emit({ color: hex(r, g, b), size: Math.max(1, Math.round(2 * R * scale)), hardness: Math.round(hard * 100) / 100, opacity }, pts);
      n++;
    }
    layersInfo.push({ radius: Math.round(R * scale * 10) / 10, strokes: n });
  }
  let err = 0;
  for (let i = 0; i < N; i++) err += Math.hypot(im.r[i] - cr[i], im.g[i] - cg[i], im.b[i] - cb[i]);
  let preview: PainterlyResult["preview"];
  if (opts.preview) {
    const data = new Uint8ClampedArray(N * 4);
    for (let i = 0; i < N; i++) { data[i * 4] = cr[i] * 255; data[i * 4 + 1] = cg[i] * 255; data[i * 4 + 2] = cb[i] * 255; data[i * 4 + 3] = 255; }
    preview = { width: w, height: h, data };
  }
  return { width: Math.round(w * scale), height: Math.round(h * scale), strokes: out, error: err / N / Math.sqrt(3), layers: layersInfo, preview };
}
