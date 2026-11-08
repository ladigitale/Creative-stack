import polygonClipping from "polygon-clipping";
import { dedupe, multiArea, ringArea, ringsToMulti, signedArea, type Multi, type Pt, type Ring } from "./geometry";
import { flatten, parsePath, type Seg } from "./svgpath";

type Geom = [number, number][][][];

const closeRing = (r: Ring): Pt[] => [...r, r[0]];
const toGeom = (m: Multi): Geom => m.map((p) => p.map(closeRing));
const fromGeom = (g: Geom): Multi => g.map((p) => p.map((r) => dedupe(r as Ring))).filter((p) => p.length && p[0].length >= 3);

/** Chemin SVG → polygones à trous (courbes aplaties, sous-chemins ouverts ignorés). */
export function pathToMulti(d: string, tol = 0.25): Multi | null {
  const segs = parsePath(d);
  if (!segs) return null;
  return ringsToMulti(flatten(segs, tol).filter((s) => s.closed || s.ring.length >= 3).map((s) => s.ring));
}

export type BoolOp = "union" | "intersect" | "difference" | "xor";

/** Opération booléenne entre formes (a ⊕ b ⊕ …). Robuste aux quasi-colinéarités (prédicats exacts). */
export function boolean(op: BoolOp, a: Multi, ...others: Multi[]): Multi {
  if (!a.length && op !== "union") return op === "xor" ? others.reduce<Multi>((acc, m) => (acc.length ? boolean("union", acc, m) : m), []) : [];
  const ga = toGeom(a);
  const gs = others.filter((m) => m.length).map(toGeom);
  if (!gs.length) return op === "intersect" && others.length ? [] : a;
  const fn = op === "union" ? polygonClipping.union : op === "intersect" ? polygonClipping.intersection : op === "difference" ? polygonClipping.difference : polygonClipping.xor;
  return fromGeom(fn(ga as never, ...(gs as never[])) as Geom);
}

/** Approximation polygonale d'un disque de centre c et rayon r. */
function disc(c: Pt, r: number, n: number): Ring {
  const out: Ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return out;
}

/** Rectangle d'épaisseur 2r centré sur le segment [a, b]. */
function stroke(a: Pt, b: Pt, r: number): Ring | null {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const nx = (-dy / len) * r, ny = (dx / len) * r;
  return [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
}

/**
 * Extension (delta > 0) ou réduction (delta < 0) à joints arrondis : union de la forme et de son
 * « trait » d'épaisseur 2|delta| le long de tous ses contours (trous compris), ou différence.
 */
export function offset(m: Multi, delta: number, segments = 16): Multi {
  if (!m.length || !Number.isFinite(delta) || delta === 0) return m;
  const r = Math.abs(delta);
  const n = Math.max(6, Math.min(64, Math.round(segments)));
  const pieces: Ring[] = [];
  for (const p of m) {
    for (const ring of p) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const s = stroke(a, b, r);
        if (s) pieces.push(s);
        pieces.push(disc(a, r, n));
      }
    }
  }
  if (!pieces.length) return m;
  // Les sommets des disques et des rectangles coïncident presque : on les aligne sur une grille fine
  // pour que les prédicats du découpage voient des points identiques, avec un repli plus grossier.
  let lastErr: unknown;
  for (const step of [r * 1e-6, r * 1e-4, r * 1e-2]) {
    try {
      const snapped = pieces.map((q): Multi => [[q.map((p): Pt => [Math.round(p[0] / step) * step, Math.round(p[1] / step) * step])]]);
      const band = unionTree(snapped);
      return delta > 0 ? boolean("union", m, band) : boolean("difference", m, band);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("décalage impossible");
}

/** Union par fusions successives deux à deux (évite les très grosses files d'événements). */
function unionTree(list: Multi[]): Multi {
  let cur = list;
  while (cur.length > 1) {
    const next: Multi[] = [];
    for (let i = 0; i < cur.length; i += 8) next.push(boolean("union", cur[i], ...cur.slice(i + 1, i + 8)));
    cur = next;
  }
  return cur[0] ?? [];
}

/* ---------------------------------------------------------------- simplification */

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Ramer–Douglas–Peucker sur une polyligne (itératif : pas de dépassement de pile). */
export function simplifyLine(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 2 || !(tol > 0)) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let dmax = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(pts[i], pts[s], pts[e]);
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (idx >= 0 && dmax > tol) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Simplifie un contour fermé : coupe au point le plus éloigné du centroïde puis RDP des deux moitiés. */
export function simplifyRing(r: Ring, tol: number): Ring {
  if (r.length <= 4 || !(tol > 0)) return r;
  let i0 = 0, d0 = -1;
  for (let i = 0; i < r.length; i++) {
    const d = Math.hypot(r[i][0] - r[0][0], r[i][1] - r[0][1]);
    if (d > d0) { d0 = d; i0 = i; }
  }
  const a = simplifyLine(r.slice(0, i0 + 1), tol);
  const b = simplifyLine([...r.slice(i0), r[0]], tol);
  const out = dedupe([...a.slice(0, -1), ...b.slice(0, -1)]);
  return out.length >= 3 ? out : r;
}

export function simplifyMulti(m: Multi, tol: number): Multi {
  return m
    .map((p) => p.map((r) => simplifyRing(r, tol)).filter((r) => r.length >= 3 && ringArea(r) > tol * tol * 0.01))
    .filter((p) => p.length && p[0].length >= 3);
}

/** Visvalingam–Whyatt : retire les sommets dont le triangle formé avec leurs voisins est < minArea. */
export function visvalingam(r: Ring, minArea: number): Ring {
  const pts = r.slice();
  const tri = (i: number) => {
    const n = pts.length;
    const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
    return Math.abs((a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])) / 2);
  };
  while (pts.length > 3) {
    let mi = -1, ma = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = tri(i);
      if (a < ma) { ma = a; mi = i; }
    }
    if (ma >= minArea) break;
    pts.splice(mi, 1);
  }
  return pts;
}

/* ---------------------------------------------------------------- arrondi et ajustement de courbes */

const f3 = (n: number) => String(+n.toFixed(3));
const P = (p: Pt) => `${f3(p[0])},${f3(p[1])}`;

/** Contour fermé aux angles arrondis (rayon ≤ moitié des côtés voisins) : chemin à courbes quadratiques. */
export function roundedPath(r: Ring, radius: number): string {
  const n = r.length;
  if (n < 3) return "";
  if (!(radius > 0)) return `M${r.map(P).join("L")}Z`;
  let d = "";
  for (let i = 0; i < n; i++) {
    const a = r[(i + n - 1) % n], b = r[i], c = r[(i + 1) % n];
    const l1 = Math.hypot(a[0] - b[0], a[1] - b[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const k = Math.min(radius, l1 / 2, l2 / 2);
    const p1: Pt = [b[0] + ((a[0] - b[0]) / (l1 || 1)) * k, b[1] + ((a[1] - b[1]) / (l1 || 1)) * k];
    const p2: Pt = [b[0] + ((c[0] - b[0]) / (l2 || 1)) * k, b[1] + ((c[1] - b[1]) / (l2 || 1)) * k];
    d += `${i === 0 ? "M" : "L"}${P(p1)}Q${P(b)} ${P(p2)}`;
  }
  return d + "Z";
}

/* Ajustement de courbes de Bézier cubiques (Schneider, « An Algorithm for Automatically Fitting Digitized Curves »). */
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt, s: number): Pt => [a[0] * s, a[1] * s];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const norm = (a: Pt): Pt => {
  const l = Math.hypot(a[0], a[1]);
  return l === 0 ? [0, 0] : [a[0] / l, a[1] / l];
};
type Bez = [Pt, Pt, Pt, Pt];
const bez = (b: Bez, t: number): Pt => {
  const u = 1 - t;
  return [u * u * u * b[0][0] + 3 * u * u * t * b[1][0] + 3 * u * t * t * b[2][0] + t * t * t * b[3][0], u * u * u * b[0][1] + 3 * u * u * t * b[1][1] + 3 * u * t * t * b[2][1] + t * t * t * b[3][1]];
};
const bez1 = (b: Bez, t: number): Pt => {
  const u = 1 - t;
  return [3 * u * u * (b[1][0] - b[0][0]) + 6 * u * t * (b[2][0] - b[1][0]) + 3 * t * t * (b[3][0] - b[2][0]), 3 * u * u * (b[1][1] - b[0][1]) + 6 * u * t * (b[2][1] - b[1][1]) + 3 * t * t * (b[3][1] - b[2][1])];
};
const bez2 = (b: Bez, t: number): Pt => {
  const u = 1 - t;
  return [6 * u * (b[2][0] - 2 * b[1][0] + b[0][0]) + 6 * t * (b[3][0] - 2 * b[2][0] + b[1][0]), 6 * u * (b[2][1] - 2 * b[1][1] + b[0][1]) + 6 * t * (b[3][1] - 2 * b[2][1] + b[1][1])];
};

function chord(pts: Pt[]): number[] {
  const u = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const t = u[u.length - 1] || 1;
  return u.map((v) => v / t);
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Moindres carrés de Schneider pour les longueurs de poignées, puis bornage : une poignée négative,
 * nulle ou plus longue que la moitié de la corde est la cause des boucles et des pointes ; on se
 * replie alors sur l'heuristique corde / 3 (poignées le long des tangentes, sans dépassement).
 */
function generate(pts: Pt[], u: number[], t1: Pt, t2: Pt): Bez {
  const p0 = pts[0], p3 = pts[pts.length - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = u[i], b = 1 - t;
    const a1 = mul(t1, 3 * b * b * t), a2 = mul(t2, 3 * b * t * t);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(pts[i], add(mul(p0, b * b * b + 3 * b * b * t), mul(p3, 3 * b * t * t + t * t * t)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  const seg = dist(p0, p3);
  let al = Math.abs(det) > 1e-12 ? (x0 * c11 - x1 * c01) / det : NaN;
  let ar = Math.abs(det) > 1e-12 ? (c00 * x1 - c01 * x0) / det : NaN;
  const eps = 1e-6 * seg;
  if (!(al > eps) || !(ar > eps)) al = ar = seg / 3;
  else {
    al = Math.min(al, seg / 2);
    ar = Math.min(ar, seg / 2);
  }
  return [p0, add(p0, mul(t1, al)), add(p3, mul(t2, ar)), p3];
}

function reparam(b: Bez, pts: Pt[], u: number[]): number[] {
  return u.map((t, i) => {
    const d = sub(bez(b, t), pts[i]), d1 = bez1(b, t), d2 = bez2(b, t);
    const den = dot(d1, d1) + dot(d, d2);
    return den === 0 ? t : Math.min(1, Math.max(0, t - dot(d, d1) / den));
  });
}

/** Écart max (au carré) entre la courbe et les points denses, et l'indice du pire point intérieur. */
function maxErr(b: Bez, pts: Pt[], u: number[]): [number, number] {
  let m = 0, at = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const p = bez(b, u[i]);
    const d = (p[0] - pts[i][0]) ** 2 + (p[1] - pts[i][1]) ** 2;
    if (d > m) { m = d; at = i; }
  }
  return [m, at];
}

/** Point situé à la distance `r` le long de la polyligne depuis l'indice `i` (sens `dir`), borné aux extrémités. */
function walk(pts: Pt[], i: number, r: number, dir: 1 | -1): Pt {
  let acc = 0, j = i;
  while (true) {
    const k = j + dir;
    if (k < 0 || k >= pts.length) return pts[j];
    const l = dist(pts[j], pts[k]);
    if (acc + l >= r) {
      const t = l ? (r - acc) / l : 0;
      return [pts[j][0] + (pts[k][0] - pts[j][0]) * t, pts[j][1] + (pts[k][1] - pts[j][1]) * t];
    }
    acc += l;
    j = k;
  }
}

/** Tangente unilatérale en `i` (vers l'intérieur de la pièce), mesurée à l'échelle `r` : insensible au bruit. */
function sideTangent(pts: Pt[], i: number, r: number, dir: 1 | -1): Pt {
  return norm(sub(walk(pts, i, r, dir), pts[i]));
}

/** Rééchantillonne une polyligne : chaque segment est subdivisé à pas ≤ `step` (sommets d'origine conservés). */
function densify(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const k = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let j = 1; j <= k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
  }
  return out;
}

const lineLen = (pts: Pt[]) => pts.reduce((s, p, i) => (i ? s + dist(pts[i - 1], p) : 0), 0);

/** Tous les points à moins de `tol` de la corde : la pièce est un segment de droite. */
function isStraight(pts: Pt[], tol: number): boolean {
  const a = pts[0], b = pts[pts.length - 1];
  if (dist(a, b) < 1e-9) return false;
  return pts.every((p) => perpDist(p, a, b) <= tol);
}

const MAX_BEZ = 4000;

/** Ajustement récursif de Schneider sur des points denses ; `t1` / `t2` pointent vers l'intérieur. */
function fit(pts: Pt[], t1: Pt, t2: Pt, err2: number, r: number, out: Bez[], depth = 0): void {
  const n = pts.length;
  const p0 = pts[0], p3 = pts[n - 1];
  if (n <= 2 || out.length >= MAX_BEZ) {
    // Cas 2 points : les tangentes voisines n'ont pas de sens ici, on suit le segment lui-même.
    const s = norm(sub(p3, p0)), l = dist(p0, p3) / 3;
    out.push([p0, add(p0, mul(s, l)), sub(p3, mul(s, l)), p3]);
    return;
  }
  let u = chord(pts);
  let b = generate(pts, u, t1, t2);
  let [e, split] = maxErr(b, pts, u);
  if (e <= err2) return void out.push(b);
  if (e <= err2 * 16) {
    for (let k = 0; k < 6; k++) {
      u = reparam(b, pts, u);
      b = generate(pts, u, t1, t2);
      [e, split] = maxErr(b, pts, u);
      if (e <= err2) return void out.push(b);
    }
  }
  if (depth > 40) return void out.push(b);
  split = Math.min(n - 2, Math.max(1, split));
  // Tangente centrale au point de coupe, mesurée à l'échelle r (G1 entre les deux moitiés).
  const rr = Math.min(r, lineLen(pts) / 4);
  let tc = norm(sub(walk(pts, split, rr, -1), walk(pts, split, rr, 1)));
  if (tc[0] === 0 && tc[1] === 0) tc = norm(sub(pts[split - 1], pts[split + 1]));
  fit(pts.slice(0, split + 1), t1, tc, err2, r, out, depth + 1);
  fit(pts.slice(split), mul(tc, -1), t2, err2, r, out, depth + 1);
}

/** Angle de virage (radians, 0 = tout droit) en `at`, entre les directions prev → at et at → next. */
function turnAngle(prev: Pt, at: Pt, next: Pt): number {
  const a = norm(sub(at, prev)), b = norm(sub(next, at));
  if ((a[0] === 0 && a[1] === 0) || (b[0] === 0 && b[1] === 0)) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
}

export type FitOptions = {
  /** Angle de virage (degrés) à partir duquel un sommet est un coin vif. Défaut 55 ; ≥ 180 désactive. */
  cornerDeg?: number;
};

/** Indices des coins : virage (mesuré à l'échelle r, donc insensible au bruit) ≥ seuil ; un seul coin, le plus marqué, par voisinage r. */
function corners(pts: Pt[], closed: boolean, r: number, thr: number): number[] {
  const n = pts.length;
  const at = (i: number) => pts[((i % n) + n) % n];
  // Polyligne fermée : on travaille sur trois tours pour lire les voisins au-delà de la jonction.
  const ext = closed ? [...pts, ...pts, ...pts] : pts;
  const cand: { i: number; a: number }[] = [];
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
    const j = closed ? i + n : i;
    const a = turnAngle(walk(ext, j, r, -1), at(i), walk(ext, j, r, 1));
    if (a >= thr) cand.push({ i, a });
  }
  // Suppression des non-maxima : dans un voisinage r, seul le virage le plus fort compte.
  cand.sort((p, q) => q.a - p.a);
  const kept: number[] = [];
  for (const c of cand) if (kept.every((k) => dist(at(k), at(c.i)) > r)) kept.push(c.i);
  return kept.sort((p, q) => p - q);
}

/** Ajuste une pièce (entre deux coins ou extrémités) : segment de droite ou suite de cubiques. */
function fitPiece(piece: Pt[], tol: number, r: number, out: Bez[], t1?: Pt, t2?: Pt): void {
  if (piece.length < 2) return;
  if (piece.length === 2 || isStraight(piece, tol)) {
    fit([piece[0], piece[piece.length - 1]], [0, 0], [0, 0], 0, r, out);
    return;
  }
  const len = lineLen(piece);
  // Points denses : l'écart est mesuré tout le long de la polyligne, pas seulement à ses sommets.
  const dense = densify(piece, Math.max(tol, len / 800));
  const rr = Math.min(r, len / 4);
  fit(dense, t1 ?? sideTangent(dense, 0, rr, 1), t2 ?? sideTangent(dense, dense.length - 1, rr, -1), Math.max(tol, 1e-6) ** 2, r, out);
}

/**
 * Polyligne → courbes de Bézier cubiques (écart max `tol`) : chemin `d` lisse et compact.
 * Robuste aux contours clairsemés : rééchantillonnage dense avant ajustement, poignées bornées,
 * coins vifs détectés (virage ≥ `cornerDeg`) et conservés, segments droits rendus en `L`.
 */
export function fitCurve(pts: Pt[], tol: number, closed = false, opts: FitOptions = {}): string {
  let clean = dedupe(pts.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
  if (closed && clean.length > 1 && dist(clean[0], clean[clean.length - 1]) < 1e-9) clean = clean.slice(0, -1);
  if (clean.length < 2) return "";
  if (clean.length === 2) return `M${P(clean[0])}L${P(clean[1])}${closed ? "Z" : ""}`;
  tol = Math.max(tol, 1e-6);
  const total = lineLen(closed ? [...clean, clean[0]] : clean);
  // Échelle de lecture des directions : quelques tolérances, plafonnée par la taille du tracé.
  const r = Math.max(1e-9, Math.min(tol * 4, total / 16));
  const thr = ((opts.cornerDeg ?? 55) * Math.PI) / 180;
  const cs = opts.cornerDeg !== undefined && opts.cornerDeg >= 180 ? [] : corners(clean, closed, r, thr);
  const out: Bez[] = [];
  if (!closed) {
    const cuts = [0, ...cs, clean.length - 1];
    for (let k = 0; k + 1 < cuts.length; k++) fitPiece(clean.slice(cuts[k], cuts[k + 1] + 1), tol, r, out);
  } else if (cs.length) {
    // Fermé avec coins : on démarre au premier coin, chaque pièce va d'un coin au suivant.
    const n = clean.length;
    const ring = [...clean.slice(cs[0]), ...clean.slice(0, cs[0])];
    const cuts = [...cs.map((c) => (c - cs[0] + n) % n), n];
    const loop = [...ring, ring[0]];
    for (let k = 0; k + 1 < cuts.length; k++) fitPiece(loop.slice(cuts[k], cuts[k + 1] + 1), tol, r, out);
  } else {
    // Fermé et lisse : coupe en deux au point le plus éloigné du départ, tangentes centrales partagées.
    const n = clean.length;
    let far = 1, fd = -1;
    for (let i = 1; i < n; i++) {
      const d = dist(clean[i], clean[0]);
      if (d > fd) { fd = d; far = i; }
    }
    const ext = [...clean, ...clean, ...clean];
    const tAt = (i: number) => norm(sub(walk(ext, i + n, r, 1), walk(ext, i + n, r, -1)));
    const t0 = tAt(0), tf = tAt(far);
    fitPiece(clean.slice(0, far + 1), tol, r, out, t0, mul(tf, -1));
    fitPiece([...clean.slice(far), clean[0]], tol, r, out, tf, mul(t0, -1));
  }
  if (!out.length) return "";
  const straight = (b: Bez) => {
    const s = norm(sub(b[3], b[0]));
    const l = dist(b[0], b[3]) / 3;
    return dist(b[1], add(b[0], mul(s, l))) < 1e-9 && dist(b[2], sub(b[3], mul(s, l))) < 1e-9;
  };
  let d = `M${P(out[0][0])}`;
  for (const b of out) d += straight(b) ? `L${P(b[3])}` : `C${P(b[1])} ${P(b[2])} ${P(b[3])}`;
  return d + (closed ? "Z" : "");
}

/** Contours d'une forme → chemin de courbes ajustées. */
export function fitMulti(m: Multi, tol: number, opts: FitOptions = {}): string {
  return m.flatMap((p) => p.map((r) => fitCurve(r, tol, true, opts))).join("");
}

export { multiArea, signedArea };
export type { Seg };
