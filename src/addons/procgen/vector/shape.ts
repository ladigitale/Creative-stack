/**
 * Modèle de dessin vectoriel : une `Shape` est un chemin (commandes M L C Q Z, coordonnées monde 2D en mètres,
 * v vers le haut) avec un remplissage (rôle de palette ou couleur), un contour éventuel, un ordre de dessin et un plan.
 *
 * Utilitaires de construction : stylo affine (`Pen`), Catmull-Rom → Bézier, **trait à épaisseur variable** (contour
 * décalé d'une polyligne lissée, bouts ronds : un seul chemin fermé, aucune jointure), blobs organiques (contour bruité
 * lissé), masses festonnées (touffes en bord), enveloppe convexe.
 */

export type P2 = [number, number];
/** Couleur : nom de rôle (`wall`, `leaf`…), `#rrggbb`, ou `none`. */
export type Paint = string;

export type ShapeKind = "fill" | "shadow" | "glow" | "line";

export type Shape = {
  d: string;
  fill: Paint;
  stroke?: Paint;
  /** Épaisseur relative du contour (1 = contour principal, 0,5 = trait intérieur). */
  width?: number;
  /** Ordre de dessin (croissant = devant). */
  z: number;
  /** Plan de profondeur (0 ciel … 9 premier plan) : parallaxe, papier découpé. */
  layer: number;
  /** Objet porteur (0 = décor non sélectionnable). */
  objId: number;
  /** Ton : −2 ombre profonde, −1 ombre, 0 base, 1 lumière, 2 reflet. */
  tone?: number;
  kind?: ShapeKind;
  alpha?: number;
  /** Profondeur normalisée 0 (près) … 1 (loin) : perspective atmosphérique. */
  depth?: number;
  /** Couleurs propres de l'objet (rôle → #hex, ex. carnation d'un personnage), passées par la palette au rendu. */
  pal?: Record<string, string>;
  /** Gabarit instancié : le chemin est en coordonnées du gabarit, placé par (x, y) → (k·x + u, k·y + v). */
  t?: [number, number, number];
};

/** Transformation affine 2D : [a, b, c, d, e, f] → (a·x + c·y + e, b·x + d·y + f). */
export type Affine = [number, number, number, number, number, number];
export const IDENT: Affine = [1, 0, 0, 1, 0, 0];
export const apply = (m: Affine, x: number, y: number): P2 => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export function compose(m: Affine, n: Affine): Affine {
  // m ∘ n
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}
export const translate = (x: number, y: number): Affine => [1, 0, 0, 1, x, y];
export const scaling = (sx: number, sy = sx): Affine => [sx, 0, 0, sy, 0, 0];
export const rotation = (a: number): Affine => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];

/** Unité des chemins : le millimètre (entiers, chaînes courtes et rapides). Coordonnées monde = d / PATH_UNIT. */
export const PATH_UNIT = 1000;
const f = (n: number) => String(Math.round(n * PATH_UNIT));

/** Stylo : accumule des commandes de chemin en coordonnées locales, transformées par une affine. */
export class Pen {
  private parts: string[] = [];
  constructor(public m: Affine = IDENT) {}
  private p(x: number, y: number) {
    const m = this.m;
    return f(m[0] * x + m[2] * y + m[4]) + " " + f(m[1] * x + m[3] * y + m[5]);
  }
  M(x: number, y: number) {
    this.parts.push(`M${this.p(x, y)}`);
    return this;
  }
  L(x: number, y: number) {
    this.parts.push(`L${this.p(x, y)}`);
    return this;
  }
  C(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
    this.parts.push(`C${this.p(x1, y1)} ${this.p(x2, y2)} ${this.p(x, y)}`);
    return this;
  }
  Q(x1: number, y1: number, x: number, y: number) {
    this.parts.push(`Q${this.p(x1, y1)} ${this.p(x, y)}`);
    return this;
  }
  Z() {
    this.parts.push("Z");
    return this;
  }
  poly(pts: P2[], close = true) {
    pts.forEach((q, i) => (i ? this.L(q[0], q[1]) : this.M(q[0], q[1])));
    if (close) this.Z();
    return this;
  }
  rect(x: number, y: number, w: number, h: number) {
    return this.M(x, y).L(x + w, y).L(x + w, y + h).L(x, y + h).Z();
  }
  /** Rectangle à coins arrondis (r en unités locales). */
  rrect(x: number, y: number, w: number, h: number, r: number) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    const k = r * 0.5523;
    return this.M(x + r, y).L(x + w - r, y).C(x + w - r + k, y, x + w, y + r - k, x + w, y + r).L(x + w, y + h - r).C(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h).L(x + r, y + h).C(x + r - k, y + h, x, y + h - r + k, x, y + h - r).L(x, y + r).C(x, y + r - k, x + r - k, y, x + r, y).Z();
  }
  ellipse(cx: number, cy: number, rx: number, ry: number) {
    const k = 0.5523;
    return this.M(cx + rx, cy).C(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry).C(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy).C(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry).C(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy).Z();
  }
  /** Courbe lisse passant par les points (Catmull-Rom uniforme convertie en Bézier cubiques). */
  smooth(pts: P2[], closed: boolean, start = true) {
    const n = pts.length;
    if (n < 2) return this;
    if (start) this.M(pts[0][0], pts[0][1]);
    const P = (i: number) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
      this.C(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
    }
    if (closed) this.Z();
    return this;
  }
  /** Ajoute un chemin déjà écrit (en coordonnées monde, non transformé). */
  raw(d: string) {
    if (d) this.parts.push(d);
    return this;
  }
  get d() {
    return this.parts.join("");
  }
  get empty() {
    return this.parts.length === 0;
  }
}

/* ---------------- géométrie ---------------- */

export const lerp2 = (a: P2, b: P2, t: number): P2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const dist2 = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Échantillonne une Catmull-Rom (ouverte) : `per` points par segment. */
export function sampleSpline(pts: P2[], per = 6): P2[] {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const out: P2[] = [];
  const P = (i: number) => pts[Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < n - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      const c = (a: number, b: number, cc: number, d: number) => 0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
      out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[n - 1]);
  return out;
}

/**
 * Trait à épaisseur variable : contour fermé d'une polyligne lissée, demi-largeurs `hw` (une par point, interpolées),
 * bouts ronds. Un seul sous-chemin (M … Z) : un membre dessiné ainsi n'a aucune jointure possible.
 */
export function strokeVar(pen: Pen, pts: P2[], hw: number[], opts: { per?: number; capStart?: boolean; capEnd?: boolean } = {}) {
  if (pts.length < 2) return pen;
  const per = opts.per ?? 5;
  // largeurs interpolées le long de la spline (même paramétrage que sampleSpline)
  const sp = sampleSpline(pts, per);
  const W: number[] = [];
  if (pts.length < 3) {
    W.push(hw[0], hw[1] ?? hw[0]);
  } else {
    for (let i = 0; i < pts.length - 1; i++) for (let k = 0; k < per; k++) W.push(hw[i] + ((hw[i + 1] ?? hw[i]) - hw[i]) * (k / per));
    W.push(hw[pts.length - 1] ?? hw[hw.length - 1]);
  }
  // nettoyage des points confondus
  const P: P2[] = [], R: number[] = [];
  sp.forEach((q, i) => {
    if (!P.length || dist2(P[P.length - 1], q) > 1e-5) {
      P.push(q);
      R.push(Math.max(1e-4, W[i]));
    }
  });
  if (P.length < 2) return pen;
  const n = P.length;
  const N: P2[] = P.map((_, i) => {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  });
  const left = P.map((q, i): P2 => [q[0] + N[i][0] * R[i], q[1] + N[i][1] * R[i]]);
  const right = P.map((q, i): P2 => [q[0] - N[i][0] * R[i], q[1] - N[i][1] * R[i]]).reverse();
  const cap = (c: P2, r: number, from: P2, dir: P2, to: P2) => {
    // demi-cercle de `from` à `to` passant par c + dir·r (deux cubiques)
    const k = 0.5523 * r;
    const tip: P2 = [c[0] + dir[0] * r, c[1] + dir[1] * r];
    const nx = (from[0] - c[0]) / r, ny = (from[1] - c[1]) / r;
    pen.C(from[0] + dir[0] * k, from[1] + dir[1] * k, tip[0] + nx * k, tip[1] + ny * k, tip[0], tip[1]);
    pen.C(tip[0] - nx * k, tip[1] - ny * k, to[0] + dir[0] * k, to[1] + dir[1] * k, to[0], to[1]);
  };
  pen.smooth(left, false, true);
  const de = norm2([P[n - 1][0] - P[n - 2][0], P[n - 1][1] - P[n - 2][1]]);
  if (opts.capEnd !== false) cap(P[n - 1], R[n - 1], left[n - 1], de, right[0]);
  else pen.L(right[0][0], right[0][1]);
  pen.smooth(right, false, false);
  const ds = norm2([P[0][0] - P[1][0], P[0][1] - P[1][1]]);
  if (opts.capStart !== false) cap(P[0], R[0], right[n - 1], ds, left[0]);
  pen.Z();
  return pen;
}

export function norm2(v: P2): P2 {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

/** Bruit 1D périodique lisse (somme de sinus à phases tirées) pour les contours organiques. */
export function wobble(seed: number, k: number): (t: number) => number {
  const ph = [0, 1, 2, 3].map((i) => frac(Math.sin(seed * 91.17 + i * 17.3) * 43758.5) * Math.PI * 2);
  return (t) => (Math.sin(t * Math.PI * 2 * k + ph[0]) * 0.5 + Math.sin(t * Math.PI * 2 * (k * 2 + 1) + ph[1]) * 0.3 + Math.sin(t * Math.PI * 2 * (k * 3 + 2) + ph[2]) * 0.2);
}
export const frac = (x: number) => x - Math.floor(x);

/** Blob organique : contour d'ellipse bruité puis lissé. */
export function blob(pen: Pen, cx: number, cy: number, rx: number, ry: number, seed: number, amp = 0.12, n = 12) {
  const w = wobble(seed, 2);
  const pts: P2[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / n, a = t * Math.PI * 2;
    const r = 1 + amp * w(t);
    pts.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
  }
  return pen.smooth(pts, true);
}

/**
 * Masse festonnée (canopée, buisson, nuage) : contour en lobes (quadratiques poussées vers l'extérieur) dont la taille
 * varie ; `flatBottom` aplatit la base (nuages, buissons posés).
 */
export function scallop(pen: Pen, cx: number, cy: number, rx: number, ry: number, seed: number, lobes = 9, depth = 0.22, flatBottom = 0) {
  const w = wobble(seed, 1);
  const base: P2[] = [];
  for (let i = 0; i < lobes; i++) {
    const t = (i + 0.5 * frac(seed * 0.37)) / lobes, a = t * Math.PI * 2 - Math.PI / 2;
    const r = 1 + 0.1 * w(t);
    let y = Math.sin(a) * ry * r;
    if (flatBottom && y < 0) y *= 1 - flatBottom;
    base.push([cx + Math.cos(a) * rx * r, cy + y]);
  }
  pen.M(base[0][0], base[0][1]);
  for (let i = 0; i < lobes; i++) {
    const a = base[i], b = base[(i + 1) % lobes];
    const m = lerp2(a, b, 0.5);
    let ox = m[0] - cx, oy = m[1] - cy;
    const l = Math.hypot(ox / rx, oy / ry) || 1;
    ox /= l;
    oy /= l;
    const bottom = flatBottom && m[1] < cy - ry * 0.2;
    const d = bottom ? depth * 0.25 : depth * (0.7 + 0.6 * frac(seed * 1.7 + i * 0.618));
    pen.Q(m[0] + ox * d * 1.6, m[1] + oy * d * 1.6, b[0], b[1]);
  }
  return pen.Z();
}

/** Enveloppe convexe (chaîne monotone d'Andrew). */
export function hull(pts: P2[]): P2[] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: P2[] = [], up: P2[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Rectangle englobant d'un chemin (mètres). */
export function pathBounds(d: string): [number, number, number, number] {
  const nums = d.match(/-?\d*\.?\d+(e-?\d+)?/g);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  if (nums)
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = +nums[i] / PATH_UNIT, y = +nums[i + 1] / PATH_UNIT;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  return [x0, y0, x1, y1];
}

/** Vérifie qu'un `d` ne contient que des commandes M L C Q Z et des nombres finis (tests, export). */
export function validPath(d: string): boolean {
  if (!d || !/^M/.test(d)) return false;
  if (/[^MLCQZ0-9.\-e ]/.test(d)) return false;
  const re = /([MLCQZ])([^MLCQZ]*)/g;
  const arity: Record<string, number> = { M: 2, L: 2, C: 6, Q: 4, Z: 0 };
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    const nums = m[2].trim() ? m[2].trim().split(/\s+/).map(Number) : [];
    if (nums.length !== arity[m[1]] || nums.some((x) => !Number.isFinite(x))) return false;
  }
  return true;
}

