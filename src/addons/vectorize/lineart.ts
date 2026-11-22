/**
 * Tracé d'un dessin au trait (plan, gravure, pochoir photographié) : image → contours lisses à précision sous-pixel.
 *
 * Luminance → flou gaussien (grain du papier) → seuil global (Otsu, ou valeur donnée) ou local (moyenne d'une
 * fenêtre, pour une photo à l'éclairage inégal) → carrés marchants sur l'écart au seuil, interpolé entre les centres
 * de pixels : les contours suivent le bord réel du trait, sans escalier → taches et petits trous retirés →
 * simplification → courbes (Catmull-Rom en cubiques) avec coins vifs au-delà d'un angle.
 */
import { inRing, signedArea, type Pt, type Ring } from "../vector/geometry";
import { simplifyRing } from "../vector/ops";

export type LineArtOptions = {
  /** Seuil 0..255 ; `-1` (défaut) : automatique (Otsu). */
  threshold?: number;
  /** Rayon (px de l'image analysée) de la fenêtre du seuil local ; 0 = seuil global. */
  adaptive?: number;
  /** Seuil local : un pixel est encre s'il est plus sombre que la moyenne locale de ce pourcentage (0..50, défaut 12). */
  sensitivity?: number;
  /** Flou gaussien avant seuil, écart-type en px (0..4, défaut 1). */
  blur?: number;
  /** Taches d'encre plus petites ignorées (px²). */
  minArea?: number;
  /** Trous plus petits bouchés (px²). */
  minHole?: number;
  /** Simplification en px (défaut 0,5). */
  tolerance?: number;
  /** Courbes lisses (sinon polygones). */
  curves?: boolean;
  /** Virage (degrés) à partir duquel un sommet reste un coin vif (défaut 55). */
  corner?: number;
  /** Encre claire sur fond sombre. */
  invert?: boolean;
  /** Couleur de l'encre dans le résultat. */
  ink?: string;
  /** Retire les taches qui touchent le bord de l'image (table, ombre, bord de la feuille autour du dessin). */
  clearBorder?: boolean;
};

export type LineArtResult = { width: number; height: number; d: string; area: number; rings: number; threshold: number };

/** Seuil d'Otsu d'un histogramme 256 niveaux. */
export function otsu(hist: ArrayLike<number>): number {
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  let wB = 0, sumB = 0, best = 0, at = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; at = t; }
  }
  return at;
}

/** Flou gaussien séparable, en place (bords répétés). */
export function gaussian(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (!(sigma > 0.05)) return src;
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += (k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += k[i + r] * src[row + Math.min(w - 1, Math.max(0, x + i))];
      tmp[row + x] = a;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      src[y * w + x] = a;
    }
  }
  return src;
}

/**
 * Écart au seuil par pixel : négatif = encre. Seuil local : moyenne d'une fenêtre (image intégrale) diminuée de
 * `sensitivity` %, bornée autour du seuil d'Otsu pour qu'un grand aplat sombre reste de l'encre et qu'un papier
 * dans l'ombre reste du papier.
 */
export function inkField(lum: Float32Array, w: number, h: number, o: { threshold: number; adaptive: number; sensitivity: number }): { field: Float32Array; threshold: number } {
  const hist = new Float64Array(256);
  for (let i = 0; i < lum.length; i++) hist[Math.max(0, Math.min(255, Math.round(lum[i])))]++;
  const global = o.threshold >= 0 ? o.threshold : otsu(hist);
  const field = new Float32Array(w * h);
  if (!(o.adaptive > 0)) {
    for (let i = 0; i < lum.length; i++) field[i] = lum[i] - global;
    return { field, threshold: global };
  }
  const W = w + 1;
  const integral = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += lum[y * w + x];
      integral[(y + 1) * W + x + 1] = integral[y * W + x + 1] + row;
    }
  }
  const r = Math.max(1, Math.round(o.adaptive));
  const k = Math.max(0, Math.min(0.5, o.sensitivity / 100));
  const lo = global * 0.55, hi = global + (255 - global) * 0.6;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * W + x1] - integral[y0 * W + x1] - integral[y1 * W + x0] + integral[y0 * W + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const t = Math.min(hi, Math.max(lo, mean * (1 - k)));
      field[y * w + x] = lum[y * w + x] - t;
    }
  }
  return { field, threshold: global };
}

/**
 * Carrés marchants : contours fermés de la région `field < 0`, sommets interpolés entre centres de pixels
 * (coordonnées : centre du pixel x = x + 0,5). L'encre est toujours à gauche du sens de parcours : les contours
 * extérieurs et les trous tournent en sens opposés.
 */
export function marchingSquares(field: Float32Array, w: number, h: number): Ring[] {
  // Bord ajouté tout autour, hors encre : tous les contours se ferment.
  const W = w + 2, H = h + 2;
  const v = (x: number, y: number): number => (x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1 ? 1 : field[(y - 1) * w + (x - 1)]);
  const P = (x: number, y: number): Pt => [x - 0.5, y - 0.5];
  // Identifiant d'une arête de la grille de nœuds : horizontale (x,y)-(x+1,y) → 2i, verticale (x,y)-(x,y+1) → 2i+1.
  const eid = (x: number, y: number, vert: boolean): number => (y * W + x) * 2 + (vert ? 1 : 0);
  const next = new Map<number, number>();
  const point = new Map<number, Pt>();
  const lerp = (a: Pt, b: Pt, fa: number, fb: number): Pt => {
    const t = fa === fb ? 0.5 : Math.max(0, Math.min(1, fa / (fa - fb)));
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const f = [v(x, y), v(x + 1, y), v(x + 1, y + 1), v(x, y + 1)];
      const ins = f.map((t) => t < 0);
      const code = (ins[0] ? 1 : 0) | (ins[1] ? 2 : 0) | (ins[2] ? 4 : 0) | (ins[3] ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const c: Pt[] = [P(x, y), P(x + 1, y), P(x + 1, y + 1), P(x, y + 1)];
      // Arêtes : 0 haut (0-1), 1 droite (1-2), 2 bas (3-2), 3 gauche (0-3).
      const ends: [number, number][] = [[0, 1], [1, 2], [3, 2], [0, 3]];
      const ids = [eid(x, y, false), eid(x + 1, y, true), eid(x, y + 1, false), eid(x, y, true)];
      const pt = (e: number): Pt => lerp(c[ends[e][0]], c[ends[e][1]], f[ends[e][0]], f[ends[e][1]]);
      // Segments : [arête, arête, coin de référence].
      let segs: [number, number, number][];
      const corner = (k: number): [number, number, number] => [[0, 3], [0, 1], [1, 2], [2, 3]][k].concat(k) as [number, number, number];
      const count = ins.filter(Boolean).length;
      if (count === 1 || count === 3) {
        const k = ins.findIndex((b) => b === (count === 1));
        segs = [corner(k)];
      } else if (code === 5 || code === 10) {
        const centerIn = (f[0] + f[1] + f[2] + f[3]) / 4 < 0;
        // Centre encre : les deux coins hors encre sont coupés ; sinon les deux coins d'encre.
        const cut = [0, 1, 2, 3].filter((k) => ins[k] !== centerIn);
        segs = cut.map(corner);
      } else {
        // Deux coins voisins : une coupe droite.
        segs = ins[0] === ins[1] ? [[3, 1, 0]] : [[0, 2, 0]];
      }
      for (const [e1, e2, k] of segs) {
        let a = e1, b = e2;
        const pa = pt(a), pb = pt(b), r = c[k];
        const cross = (pb[0] - pa[0]) * (r[1] - pa[1]) - (pb[1] - pa[1]) * (r[0] - pa[0]);
        // Encre à gauche dans le repère écran (y vers le bas) : produit vectoriel négatif.
        if ((cross < 0) !== ins[k]) [a, b] = [b, a];
        next.set(ids[a], ids[b]);
        if (!point.has(ids[a])) point.set(ids[a], pt(a));
        if (!point.has(ids[b])) point.set(ids[b], pt(b));
      }
    }
  }
  const rings: Ring[] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const ring: Pt[] = [];
    let e: number | undefined = start;
    while (e !== undefined && !seen.has(e)) {
      seen.add(e);
      ring.push(point.get(e) as Pt);
      e = next.get(e);
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Tracé lisse d'un contour : cubiques de Catmull-Rom entre les sommets, tangentes droites aux coins vifs. */
export function smoothPath(r: Ring, cornerDeg: number): string {
  const n = r.length;
  // Dixième de pixel : bien en dessous de la précision du laser, et un tracé deux fois moins lourd.
  const f = (v: number): string => (Math.round(v * 10) / 10).toString();
  if (n < 3) return "";
  const turn = (i: number): number => {
    const a = r[(i - 1 + n) % n], b = r[i], c = r[(i + 1) % n];
    const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
    const lu = Math.hypot(u[0], u[1]), lv = Math.hypot(v[0], v[1]);
    if (!lu || !lv) return 0;
    return (Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (lu * lv)))) * 180) / Math.PI;
  };
  const sharp = r.map((_, i) => turn(i) >= cornerDeg);
  let d = `M${f(r[0][0])} ${f(r[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = r[(i - 1 + n) % n], p1 = r[i], p2 = r[(i + 1) % n], p3 = r[(i + 2) % n];
    const c1: Pt = sharp[i] ? [p1[0] + (p2[0] - p1[0]) / 3, p1[1] + (p2[1] - p1[1]) / 3] : [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const j = (i + 1) % n;
    const c2: Pt = sharp[j] ? [p2[0] - (p2[0] - p1[0]) / 3, p2[1] - (p2[1] - p1[1]) / 3] : [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += sharp[i] && sharp[j] ? `L${f(p2[0])} ${f(p2[1])}` : `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + "Z";
}

const polyPath = (r: Ring): string => `M${r.map((p) => `${Math.round(p[0] * 10) / 10} ${Math.round(p[1] * 10) / 10}`).join("L")}Z`;

/** Image RGBA → contours de l'encre (règle pair-impair). */
export function traceLineArt(img: { data: ArrayLike<number>; width: number; height: number }, o: LineArtOptions = {}): LineArtResult {
  const { width: w, height: h, data } = img;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] / 255;
    const l = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    // Transparent = papier blanc.
    const v = l * a + 255 * (1 - a);
    lum[i] = o.invert ? 255 - v : v;
  }
  gaussian(lum, w, h, Math.max(0, Math.min(4, o.blur ?? 1)));
  const { field, threshold } = inkField(lum, w, h, { threshold: o.threshold ?? -1, adaptive: Math.max(0, o.adaptive ?? 0), sensitivity: o.sensitivity ?? 12 });
  const raw = marchingSquares(field, w, h);
  const minArea = Math.max(0, o.minArea ?? 8), minHole = Math.max(0, o.minHole ?? o.minArea ?? 8);
  // Encre à gauche en repère écran : un contour extérieur a une aire signée négative (`signedArea`), un trou positive.
  const outers: { r: Ring; a: number; box: number[] }[] = [];
  const holes: { r: Ring; a: number }[] = [];
  for (const r of raw) {
    const a = signedArea(r);
    if (a < 0) {
      if (-a < minArea) continue;
      const box = bbox(r);
      // Bord : le contour passe à moins d'un pixel du cadre (coordonnées des centres de pixels, de 0,5 à w − 0,5).
      if (o.clearBorder && (box[0] <= 1 || box[1] <= 1 || box[2] >= w - 1 || box[3] >= h - 1)) continue;
      outers.push({ r, a: -a, box });
    }
    else if (a >= minHole) holes.push({ r, a });
  }
  // Un trou n'est gardé que dans une tache gardée (sinon il deviendrait une tache en pair-impair).
  const keptHoles = holes.filter((hole) => {
    const p = hole.r[0];
    return outers.some((o2) => o2.a > hole.a && p[0] >= o2.box[0] && p[0] <= o2.box[2] && p[1] >= o2.box[1] && p[1] <= o2.box[3] && inRing(p, o2.r));
  });
  const tol = Math.max(0.05, o.tolerance ?? 0.5);
  const corner = Math.max(10, Math.min(175, o.corner ?? 55));
  const rings = [...outers.map((x) => x.r), ...keptHoles.map((x) => x.r)].map((r) => simplifyRing(r, tol)).filter((r) => r.length >= 3);
  const d = rings.map((r) => (o.curves === false ? polyPath(r) : smoothPath(r, corner))).join("");
  const area = outers.reduce((s, x) => s + x.a, 0) - keptHoles.reduce((s, x) => s + x.a, 0);
  return { width: w, height: h, d, area, rings: rings.length, threshold };
}

function bbox(r: Ring): number[] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of r) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  return [x0, y0, x1, y1];
}
