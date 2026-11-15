/**
 * Préparation de l'image avant la peinture : filtres qui lissent sans effacer les bords, pour que les touches
 * aillent au sujet plutôt qu'au bruit (grain, points isolés, texture fine).
 * - `median` : efface les points isolés (poussières, trous, bruit) et garde les bords nets ;
 * - `bilateral` : lisse les surfaces sans franchir les contours (moyenne pondérée par la ressemblance de couleur) ;
 * - `kuwahara` : petites plages de couleur aux bords francs, l'image est déjà « peinte » ;
 * - `kuwahara-aniso` : Kuwahara anisotrope (Kyprianidis, Kang et Döllner, 2009) — fenêtre en ellipse orientée le
 *   long des formes (tenseur de structure), 8 secteurs à poids doux : les plages suivent les contours, sans
 *   l'effet de petits carrés ;
 * - `aplats` : grandes zones de couleur (Kuwahara puis réduction à une palette par k-moyennes, puis médian) ;
 * - contraste automatique : étirement des niveaux (1 % et 99 % de la luminance) quand l'image est terne.
 * Les rayons sont relatifs au côté de l'image (même aspect à toute résolution d'analyse). `force` 0..1.
 */
import { blurImg, type Img } from "./painterly";

export type PrepareFilter = "auto" | "aucun" | "median" | "bilateral" | "kuwahara" | "kuwahara-aniso" | "aplats";
export const PREPARE_FILTERS: readonly PrepareFilter[] = ["auto", "aucun", "median", "bilateral", "kuwahara", "kuwahara-aniso", "aplats"];

export type PrepareOptions = {
  /** Filtre (défaut `auto` : selon le style). */
  prepare?: PrepareFilter;
  /** Force 0..1 (défaut 0,4). */
  prepareForce?: number;
  /** Contraste automatique (défaut : non). */
  contrast?: boolean;
  /** Aplats : tramage (Floyd–Steinberg) à la réduction de palette (défaut : non). */
  dither?: boolean;
};

/** Unité de rayon : 1 px pour une image de 360 px de côté. */
const unit = (im: Img) => Math.max(im.w, im.h) / 360;
const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Médian par canal sur une fenêtre carrée de rayon `r` (px). */
export function median(im: Img, r: number): Img {
  const { w, h } = im;
  r = Math.max(1, Math.round(r));
  const win = new Float32Array((2 * r + 1) * (2 * r + 1));
  const one = (src: Float32Array) => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let n = 0;
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r), x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let yy = y0; yy <= y1; yy++) { const o = yy * w; for (let xx = x0; xx <= x1; xx++) win[n++] = src[o + xx]; }
      out[y * w + x] = select(win, n, n >> 1);
    }
    return out;
  };
  return { w, h, r: one(im.r), g: one(im.g), b: one(im.b) };
}

/** k-ième plus petit des `n` premiers éléments (sélection rapide, modifie le tableau). */
function select(a: Float32Array, n: number, k: number): number {
  let lo = 0, hi = n - 1;
  while (hi > lo) {
    const p = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < p) i++;
      while (a[j] > p) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}

/** Filtre bilatéral : poids spatial gaussien (σs, px) × poids de ressemblance de couleur (σr, 0..1). */
export function bilateral(im: Img, sigmaS: number, sigmaR: number): Img {
  const { w, h } = im;
  const R = Math.max(1, Math.ceil(2 * sigmaS));
  const ws = new Float32Array((2 * R + 1) * (2 * R + 1));
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) ws[(dy + R) * (2 * R + 1) + dx + R] = Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS));
  const k = 1 / (2 * sigmaR * sigmaR);
  // Poids de couleur tabulé (distance² de 0 à 3).
  const LUT = 1024, lut = new Float32Array(LUT + 1);
  for (let i = 0; i <= LUT; i++) lut[i] = Math.exp(-(3 * i / LUT) * k);
  const or = new Float32Array(w * h), og = new Float32Array(w * h), ob = new Float32Array(w * h);
  const { r: sr, g: sg, b: sb } = im;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const cr = sr[i], cg = sg[i], cb = sb[i];
    let ar = 0, ag = 0, ab = 0, aw = 0;
    const y0 = Math.max(0, y - R), y1 = Math.min(h - 1, y + R), x0 = Math.max(0, x - R), x1 = Math.min(w - 1, x + R);
    for (let yy = y0; yy <= y1; yy++) {
      const row = yy * w, wrow = (yy - y + R) * (2 * R + 1) - x + R;
      for (let xx = x0; xx <= x1; xx++) {
        const j = row + xx;
        const dr = sr[j] - cr, dg = sg[j] - cg, db = sb[j] - cb;
        const d2 = dr * dr + dg * dg + db * db;
        const wt = ws[wrow + xx] * lut[Math.min(LUT, (d2 * LUT / 3) | 0)];
        ar += sr[j] * wt; ag += sg[j] * wt; ab += sb[j] * wt; aw += wt;
      }
    }
    or[i] = ar / aw; og[i] = ag / aw; ob[i] = ab / aw;
  }
  return { w, h, r: or, g: og, b: ob };
}

/** Kuwahara : pour chaque pixel, moyenne du quadrant (parmi 4, côté r + 1) dont la couleur varie le moins. */
export function kuwahara(im: Img, r: number): Img {
  const { w, h } = im;
  r = Math.max(1, Math.round(r));
  const W = w + 1;
  // Images intégrales des canaux et de la somme des carrés.
  const S = [new Float64Array(W * (h + 1)), new Float64Array(W * (h + 1)), new Float64Array(W * (h + 1))];
  const Q = new Float64Array(W * (h + 1));
  const ch = [im.r, im.g, im.b];
  for (let y = 0; y < h; y++) {
    let a0 = 0, a1 = 0, a2 = 0, aq = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v0 = ch[0][i], v1 = ch[1][i], v2 = ch[2][i];
      a0 += v0; a1 += v1; a2 += v2; aq += v0 * v0 + v1 * v1 + v2 * v2;
      const o = (y + 1) * W + x + 1, u = y * W + x + 1;
      S[0][o] = S[0][u] + a0; S[1][o] = S[1][u] + a1; S[2][o] = S[2][u] + a2; Q[o] = Q[u] + aq;
    }
  }
  const box = (A: Float64Array, x0: number, y0: number, x1: number, y1: number) => A[(y1 + 1) * W + x1 + 1] - A[y0 * W + x1 + 1] - A[(y1 + 1) * W + x0] + A[y0 * W + x0];
  const out = { w, h, r: new Float32Array(w * h), g: new Float32Array(w * h), b: new Float32Array(w * h) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let best = Infinity, m0 = 0, m1 = 0, m2 = 0;
    for (let q = 0; q < 4; q++) {
      const x0 = Math.max(0, q & 1 ? x : x - r), x1 = Math.min(w - 1, q & 1 ? x + r : x);
      const y0 = Math.max(0, q & 2 ? y : y - r), y1 = Math.min(h - 1, q & 2 ? y + r : y);
      const n = (x1 - x0 + 1) * (y1 - y0 + 1);
      const s0 = box(S[0], x0, y0, x1, y1) / n, s1 = box(S[1], x0, y0, x1, y1) / n, s2 = box(S[2], x0, y0, x1, y1) / n;
      const v = box(Q, x0, y0, x1, y1) / n - (s0 * s0 + s1 * s1 + s2 * s2);
      if (v < best) { best = v; m0 = s0; m1 = s1; m2 = s2; }
    }
    const i = y * w + x;
    out.r[i] = m0; out.g[i] = m1; out.b[i] = m2;
  }
  return out;
}

/**
 * Kuwahara anisotrope. 1) Tenseur de structure (gradients de Sobel des trois canaux, lissé) : orientation locale φ
 * et anisotropie A = (λ1 − λ2) / (λ1 + λ2). 2) Fenêtre en ellipse de demi-axes r·(α / (α + A)) et r·((α + A) / α),
 * tournée de φ (allongée le long des formes, ronde dans les zones sans direction). 3) 8 secteurs à poids
 * polynomiaux doux (pas de bord dur entre secteurs) sous une enveloppe gaussienne ; chaque secteur donne sa
 * moyenne et sa variance, combinées par des poids 1 / (1 + σ^q) : le secteur le plus homogène l'emporte, sans
 * choix brutal. `r` : rayon (px) ; `q` : netteté (8).
 */
export function kuwaharaAniso(im: Img, r: number, q = 8): Img {
  const { w, h } = im;
  const N = w * h;
  r = Math.max(2, r);
  // 1) Tenseur de structure.
  const E = new Float32Array(N), F = new Float32Array(N), G = new Float32Array(N);
  const ch = [im.r, im.g, im.b];
  const at = (c: Float32Array, x: number, y: number) => c[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let e = 0, f = 0, g = 0;
    for (const c of ch) {
      const gx = (at(c, x + 1, y - 1) + 2 * at(c, x + 1, y) + at(c, x + 1, y + 1) - at(c, x - 1, y - 1) - 2 * at(c, x - 1, y) - at(c, x - 1, y + 1)) / 4;
      const gy = (at(c, x - 1, y + 1) + 2 * at(c, x, y + 1) + at(c, x + 1, y + 1) - at(c, x - 1, y - 1) - 2 * at(c, x, y - 1) - at(c, x + 1, y - 1)) / 4;
      e += gx * gx; f += gx * gy; g += gy * gy;
    }
    const i = y * w + x;
    E[i] = e; F[i] = f; G[i] = g;
  }
  const sig = Math.max(1, r / 3);
  const T = blurImg({ w, h, r: E, g: F, b: G }, sig);
  // 2–3) Filtre.
  const NS = 8;
  const alpha = 1;
  const zeta = 0.33;
  const eta = (zeta + Math.cos(Math.PI / NS)) / Math.sin(Math.PI / NS) ** 2;
  const cosk = new Float32Array(NS), sink = new Float32Array(NS);
  for (let k = 0; k < NS; k++) { cosk[k] = Math.cos((2 * Math.PI * k) / NS); sink[k] = Math.sin((2 * Math.PI * k) / NS); }
  const out = { w, h, r: new Float32Array(N), g: new Float32Array(N), b: new Float32Array(N) };
  const m = new Float64Array(NS * 3), s2 = new Float64Array(NS * 3), ws = new Float64Array(NS);
  const R = Math.ceil(r * (1 + alpha) / alpha);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const e = T.r[i], f = T.g[i], g = T.b[i];
    const disc = Math.sqrt((e - g) * (e - g) + 4 * f * f);
    const l1 = (e + g + disc) / 2, l2 = (e + g - disc) / 2;
    // Direction des formes : vecteur propre de la plus petite valeur propre (perpendiculaire au gradient).
    let tx = l1 - e, ty = -f;
    const tl = Math.hypot(tx, ty);
    if (tl > 1e-12) { tx /= tl; ty /= tl; } else { tx = 0; ty = 1; }
    const A = l1 + l2 > 1e-12 ? (l1 - l2) / (l1 + l2) : 0;
    const a = r * (alpha + A) / alpha, b = r * alpha / (alpha + A); // grand axe le long des formes
    m.fill(0); s2.fill(0); ws.fill(0);
    const ex = Math.ceil(Math.min(R, Math.sqrt(a * a * tx * tx + b * b * ty * ty))) ;
    const ey = Math.ceil(Math.min(R, Math.sqrt(a * a * ty * ty + b * b * tx * tx)));
    for (let dy = -ey; dy <= ey; dy++) {
      const yy = Math.min(h - 1, Math.max(0, y + dy));
      for (let dx = -ex; dx <= ex; dx++) {
        // Coordonnées dans l'ellipse ramenée au disque unité.
        const u = (dx * tx + dy * ty) / a, v = (-dx * ty + dy * tx) / b;
        const d2 = u * u + v * v;
        if (d2 > 1) continue;
        const j = yy * w + Math.min(w - 1, Math.max(0, x + dx));
        const c0 = im.r[j], c1 = im.g[j], c2 = im.b[j];
        const gauss = Math.exp(-3.125 * d2);
        for (let k = 0; k < NS; k++) {
          // Repère du secteur k : le poids polynomial vaut (z)² devant le centre, 0 derrière.
          const px = u * cosk[k] + v * sink[k], py = -u * sink[k] + v * cosk[k];
          const z = px + zeta - eta * py * py;
          if (z <= 0) continue;
          const wt = z * z * gauss;
          ws[k] += wt;
          m[k * 3] += c0 * wt; m[k * 3 + 1] += c1 * wt; m[k * 3 + 2] += c2 * wt;
          s2[k * 3] += c0 * c0 * wt; s2[k * 3 + 1] += c1 * c1 * wt; s2[k * 3 + 2] += c2 * c2 * wt;
        }
      }
    }
    let o0 = 0, o1 = 0, o2 = 0, ow = 0;
    for (let k = 0; k < NS; k++) {
      if (ws[k] <= 0) continue;
      const a0 = m[k * 3] / ws[k], a1 = m[k * 3 + 1] / ws[k], a2 = m[k * 3 + 2] / ws[k];
      const v = Math.max(0, s2[k * 3] / ws[k] - a0 * a0) + Math.max(0, s2[k * 3 + 1] / ws[k] - a1 * a1) + Math.max(0, s2[k * 3 + 2] / ws[k] - a2 * a2);
      const wk = 1 / (1 + Math.pow(255 * Math.sqrt(v), q / 2));
      o0 += a0 * wk; o1 += a1 * wk; o2 += a2 * wk; ow += wk;
    }
    if (ow > 0) { out.r[i] = o0 / ow; out.g[i] = o1 / ow; out.b[i] = o2 / ow; }
    else { out.r[i] = im.r[i]; out.g[i] = im.g[i]; out.b[i] = im.b[i]; }
  }
  return out;
}

/**
 * Réduction à `k` couleurs (k-moyennes sur un échantillon, graine fixe), chaque pixel prenant la plus proche ;
 * avec `dither`, tramage de Floyd–Steinberg (parcours en serpentin) : l'erreur de chaque pixel est reportée sur
 * ses voisins, les dégradés restent continus à l'œil au lieu de faire des marches.
 */
export function quantize(im: Img, k: number, dither = false): Img {
  const { w, h } = im;
  const N = w * h;
  const step = Math.max(1, Math.floor(N / 20000));
  const idx: number[] = [];
  for (let i = 0; i < N; i += step) idx.push(i);
  // Départ : couleurs réparties le long de la luminance.
  const sorted = idx.slice().sort((a, b) => lum(im.r[a], im.g[a], im.b[a]) - lum(im.r[b], im.g[b], im.b[b]));
  const C = new Float64Array(k * 3);
  for (let c = 0; c < k; c++) { const i = sorted[Math.min(sorted.length - 1, Math.floor((c + 0.5) * sorted.length / k))]; C[c * 3] = im.r[i]; C[c * 3 + 1] = im.g[i]; C[c * 3 + 2] = im.b[i]; }
  const near = (r: number, g: number, b: number) => {
    let bi = 0, bd = Infinity;
    for (let c = 0; c < k; c++) { const d = (r - C[c * 3]) ** 2 + (g - C[c * 3 + 1]) ** 2 + (b - C[c * 3 + 2]) ** 2; if (d < bd) { bd = d; bi = c; } }
    return bi;
  };
  for (let it = 0; it < 10; it++) {
    const acc = new Float64Array(k * 4);
    for (const i of idx) { const c = near(im.r[i], im.g[i], im.b[i]); acc[c * 4] += im.r[i]; acc[c * 4 + 1] += im.g[i]; acc[c * 4 + 2] += im.b[i]; acc[c * 4 + 3]++; }
    for (let c = 0; c < k; c++) if (acc[c * 4 + 3]) for (let j = 0; j < 3; j++) C[c * 3 + j] = acc[c * 4 + j] / acc[c * 4 + 3];
  }
  const out = { w, h, r: new Float32Array(N), g: new Float32Array(N), b: new Float32Array(N) };
  if (!dither) {
    for (let i = 0; i < N; i++) { const c = near(im.r[i], im.g[i], im.b[i]); out.r[i] = C[c * 3]; out.g[i] = C[c * 3 + 1]; out.b[i] = C[c * 3 + 2]; }
    return out;
  }
  const er = Float32Array.from(im.r), eg = Float32Array.from(im.g), eb = Float32Array.from(im.b);
  const push = (x: number, y: number, k2: number, dr: number, dg: number, db: number) => {
    if (x < 0 || x >= w || y >= h) return;
    const j = y * w + x;
    er[j] += dr * k2; eg[j] += dg * k2; eb[j] += db * k2;
  };
  for (let y = 0; y < h; y++) {
    const ltr = (y & 1) === 0, sx = ltr ? 1 : -1;
    for (let n = 0; n < w; n++) {
      const x = ltr ? n : w - 1 - n, i = y * w + x;
      const c = near(er[i], eg[i], eb[i]);
      out.r[i] = C[c * 3]; out.g[i] = C[c * 3 + 1]; out.b[i] = C[c * 3 + 2];
      const dr = er[i] - out.r[i], dg = eg[i] - out.g[i], db = eb[i] - out.b[i];
      push(x + sx, y, 7 / 16, dr, dg, db);
      push(x - sx, y + 1, 3 / 16, dr, dg, db);
      push(x, y + 1, 5 / 16, dr, dg, db);
      push(x + sx, y + 1, 1 / 16, dr, dg, db);
    }
  }
  return out;
}

/** Contraste automatique : niveaux étirés entre 1 % et 99 % de la luminance (rien si l'image est déjà contrastée). */
export function autoContrast(im: Img): Img {
  const N = im.w * im.h;
  const hist = new Uint32Array(256);
  for (let i = 0; i < N; i++) hist[Math.min(255, (lum(im.r[i], im.g[i], im.b[i]) * 255) | 0)]++;
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= N * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= N * 0.01) { hi = v; break; } }
  const a = lo / 255, b = hi / 255;
  if (b - a > 0.92 || b - a < 0.05) return im;
  const s = 1 / (b - a);
  const f = (src: Float32Array) => { const o = new Float32Array(N); for (let i = 0; i < N; i++) o[i] = clamp01((src[i] - a) * s); return o; };
  return { w: im.w, h: im.h, r: f(im.r), g: f(im.g), b: f(im.b) };
}

/** Filtre retenu pour un style quand `prepare` vaut `auto`. */
export function autoFilter(style: string | undefined): PrepareFilter {
  // Réaliste : la fidélité prime (un filtre l'éloigne un peu de la photo) ; au choix de l'utilisateur.
  if (style === "illustration") return "kuwahara-aniso";
  return "aucun";
}

/** Prépare l'image selon les options (et le style pour `auto`). */
export function prepareImage(im: Img, opts: PrepareOptions & { style?: string }): Img {
  const f = opts.prepare && PREPARE_FILTERS.includes(opts.prepare) ? opts.prepare : "auto";
  const filter = f === "auto" ? autoFilter(opts.style) : f;
  const force = clamp01(opts.prepareForce ?? 0.4);
  const u = unit(im);
  let out = opts.contrast ? autoContrast(im) : im;
  switch (filter) {
    case "median":
      out = median(out, u * (1 + 2 * force));
      break;
    case "bilateral":
      // Un médian fin d'abord (points isolés), puis le lissage qui garde les bords.
      out = median(out, u);
      out = bilateral(out, u * (1 + 3 * force), 0.05 + 0.12 * force);
      break;
    case "kuwahara":
      out = kuwahara(out, u * (2 + 4 * force));
      break;
    case "kuwahara-aniso":
      out = kuwaharaAniso(out, u * (2 + 4 * force));
      break;
    case "aplats":
      out = kuwahara(out, u * (2 + 3 * force));
      out = quantize(out, Math.round(24 - 16 * force), !!opts.dither);
      // Le médian effacerait la trame : seulement sans tramage.
      if (!opts.dither) out = median(out, u * 1.5);
      break;
  }
  return out;
}
