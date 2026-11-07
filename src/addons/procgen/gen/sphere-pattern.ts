/**
 * Motifs sur la sphère unité (ballons, boules, billes) : des **régions** colorées (polygone sphérique convexe, fuseau,
 * calotte, bande) et des **coutures** (cercles, courbes). Un motif est décrit une seule fois ; le maillage 3D découpe
 * ses triangles aux frontières des régions (bords nets) et pose les coutures en tubes en relief, le mode vectoriel
 * découpe les mêmes régions par l'hémisphère visible et trace les coutures visibles.
 *
 * Tout est en « espace motif » : sphère unité, axe long des ballons ovales selon y. L'ellipsoïde, la taille et
 * l'orientation sont appliqués ensuite.
 */
import { type V3, cross, dot, norm } from "../core/math";

export type Region =
  /** Polygone sphérique **convexe** (sommets sur la sphère, dans un ordre quelconque de parcours). */
  | { k: "poly"; pts: V3[] }
  /** Fuseau entre deux méridiens autour de y (longitudes en radians, a0 < a1, a1 − a0 < π). */
  | { k: "lune"; a0: number; a1: number }
  /** Calotte : points dont le cosinus d'angle à `c` est ≥ `cos`. */
  | { k: "cap"; c: V3; cos: number }
  /** Bande : `lo ≤ p·n ≤ hi`. */
  | { k: "band"; n: V3; lo: number; hi: number };

export type Seam = {
  /** Points (sphère unité) ; `closed` relie le dernier au premier. */
  pts: V3[];
  closed: boolean;
  /** Emplacement de couleur (0, 1, 2 : couleurs du ballon) ou nom de rôle. */
  slot: number | string;
  /** Demi-largeur relative au rayon. */
  w: number;
  /** Seulement en vectoriel (alvéoles de golf : trop fines pour des tubes). */
  vectorOnly?: boolean;
  /** Ton en vectoriel (−1 : sillon). */
  tone?: number;
  alpha?: number;
};

export type Pattern = {
  /** Emplacement de couleur du fond (0, 1, 2 ou nom de rôle). */
  base: number | string;
  regions: { r: Region; slot: number | string }[];
  seams: Seam[];
};

/* ---------- appartenance ---------- */

const TAU = Math.PI * 2;
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;

/** Orientation d'un polygone convexe : arêtes telles que l'intérieur soit du côté positif de `cross(a, b)`. */
function orient(pts: V3[]): V3[] {
  const c = norm(pts.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]] as V3, [0, 0, 0] as V3));
  return dot(c, cross(pts[0], pts[1])) >= 0 ? pts : pts.slice().reverse();
}

export function inRegion(r: Region, p: V3): boolean {
  switch (r.k) {
    case "poly": {
      const q = orient(r.pts);
      for (let i = 0; i < q.length; i++) if (dot(p, cross(q[i], q[(i + 1) % q.length])) < 0) return false;
      return true;
    }
    case "lune": {
      if (Math.abs(p[1]) > 0.9999) return false;
      const a = wrap(Math.atan2(p[0], p[2]) - r.a0);
      return a <= r.a1 - r.a0;
    }
    case "cap":
      return dot(p, r.c) >= r.cos;
    case "band": {
      const d = dot(p, r.n);
      return d >= r.lo && d <= r.hi;
    }
  }
}

/** Étiquette d'un point : 0 = fond, i + 1 = région i (la première région qui le contient). */
export function labelAt(pat: Pattern, p: V3): number {
  for (let i = 0; i < pat.regions.length; i++) if (inRegion(pat.regions[i].r, p)) return i + 1;
  return 0;
}

/* ---------- contours (pour le dessin vectoriel) ---------- */

export function slerp(a: V3, b: V3, t: number): V3 {
  const d = Math.max(-1, Math.min(1, dot(a, b)));
  const th = Math.acos(d);
  if (th < 1e-5) return a;
  const s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s, kb = Math.sin(t * th) / s;
  return [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb];
}

/** Base orthonormée (u, v) perpendiculaire à n. */
function basis(n: V3): [V3, V3] {
  const u = norm(cross(Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], n));
  return [u, cross(n, u)];
}

/** Cercle `p·n = d` sur la sphère unité, échantillonné. */
export function circle(n: V3, d: number, steps = 48): V3[] {
  const [u, v] = basis(norm(n));
  const r = Math.sqrt(Math.max(0, 1 - d * d));
  const nn = norm(n);
  const out: V3[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * TAU;
    out.push([nn[0] * d + (u[0] * Math.cos(a) + v[0] * Math.sin(a)) * r, nn[1] * d + (u[1] * Math.cos(a) + v[1] * Math.sin(a)) * r, nn[2] * d + (u[2] * Math.cos(a) + v[2] * Math.sin(a)) * r]);
  }
  return out;
}

const meridian = (a: number, steps: number, down = true): V3[] => {
  const out: V3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, lat = (down ? 1 - 2 * t : -1 + 2 * t) * (Math.PI / 2);
    out.push([Math.cos(lat) * Math.sin(a), Math.sin(lat), Math.cos(lat) * Math.cos(a)]);
  }
  return out;
};

/** Contour(s) fermé(s) d'une région, chacun plus petit qu'un hémisphère (la bande est découpée en quartiers). */
export function regionOutlines(r: Region): V3[][] {
  switch (r.k) {
    case "poly": {
      const q = orient(r.pts);
      const out: V3[] = [];
      for (let i = 0; i < q.length; i++) for (let s = 0; s < 6; s++) out.push(slerp(q[i], q[(i + 1) % q.length], s / 6));
      return [out];
    }
    case "lune":
      return [[...meridian(r.a0, 16, true), ...meridian(r.a1, 16, false)]];
    case "cap": {
      const d = r.cos;
      return [circle(r.c, d, 36)];
    }
    case "band": {
      const [u, v] = basis(norm(r.n));
      const n = norm(r.n);
      const at = (d: number, a: number): V3 => {
        const rr = Math.sqrt(Math.max(0, 1 - d * d));
        return [n[0] * d + (u[0] * Math.cos(a) + v[0] * Math.sin(a)) * rr, n[1] * d + (u[1] * Math.cos(a) + v[1] * Math.sin(a)) * rr, n[2] * d + (u[2] * Math.cos(a) + v[2] * Math.sin(a)) * rr];
      };
      const out: V3[][] = [];
      for (let q = 0; q < 4; q++) {
        const a0 = (q / 4) * TAU, a1 = ((q + 1) / 4) * TAU;
        const poly: V3[] = [];
        for (let s = 0; s <= 8; s++) poly.push(at(r.hi, a0 + ((a1 - a0) * s) / 8));
        for (let s = 8; s >= 0; s--) poly.push(at(r.lo, a0 + ((a1 - a0) * s) / 8));
        out.push(poly);
      }
      return out;
    }
  }
}

/**
 * Découpe d'un contour fermé par l'hémisphère `p·v ≥ 0` (v : direction de l'observateur en espace motif). Les
 * portions coupées sont remplacées par l'arc de bord (grand cercle ⟂ v), pas par une corde.
 */
export function clipHemisphere(poly: V3[], v: V3): V3[] {
  const n = poly.length;
  const out: V3[] = [];
  let exit: V3 | null = null;
  const f = (p: V3) => dot(p, v);
  const cut = (a: V3, b: V3): V3 => {
    const fa = f(a), fb = f(b);
    const t = fa / (fa - fb);
    const p: V3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    // ramené sur le grand cercle de bord
    const pv = dot(p, v) / dot(v, v);
    return norm([p[0] - v[0] * pv, p[1] - v[1] * pv, p[2] - v[2] * pv]);
  };
  // départ sur un sommet visible pour que chaque sortie soit suivie de son entrée
  let s0 = -1;
  for (let i = 0; i < n; i++) if (f(poly[i]) >= 0) {
    s0 = i;
    break;
  }
  if (s0 < 0) return [];
  for (let k = 0; k < n; k++) {
    const a = poly[(s0 + k) % n], b = poly[(s0 + k + 1) % n];
    const ia = f(a) >= 0, ib = f(b) >= 0;
    if (ia) out.push(a);
    if (ia && !ib) {
      exit = cut(a, b);
      out.push(exit);
    } else if (!ia && ib) {
      const entry = cut(a, b);
      if (exit) for (let s = 1; s < 10; s++) out.push(slerp(exit, entry, s / 10));
      out.push(entry);
      exit = null;
    }
  }
  return out;
}

/** Morceaux visibles d'une polyligne (hémisphère `p·v ≥ 0`). */
export function clipPolyline(pts: V3[], closed: boolean, v: V3): V3[][] {
  const runs: V3[][] = [];
  let cur: V3[] = [];
  const all = closed ? [...pts, pts[0]] : pts;
  const f = (p: V3) => dot(p, v);
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    const vis = f(p) >= 0;
    if (i > 0) {
      const q = all[i - 1];
      const vq = f(q) >= 0;
      if (vq !== vis) {
        const t = f(q) / (f(q) - f(p));
        const m = norm([q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t, q[2] + (p[2] - q[2]) * t]);
        cur.push(m);
        if (!vis) {
          runs.push(cur);
          cur = [];
        }
      }
    }
    if (vis) cur.push(p);
  }
  if (cur.length) runs.push(cur);
  // une boucle fermée entièrement visible coupée en deux au point de départ : on recolle
  if (closed && runs.length > 1 && f(all[0]) >= 0) {
    const last = runs.pop()!;
    runs[0] = [...last, ...runs[0]];
  }
  return runs.filter((r) => r.length >= 2);
}

/* ---------- géométries de référence ---------- */

/** Icosaèdre : 12 sommets et voisins (5 par sommet), sur la sphère unité. */
export function icosahedron(): { v: V3[]; nb: number[][] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = ([[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]] as V3[]).map(norm);
  const edge = Math.acos(dot(v[0], v[11]));
  const nb = v.map((a, i) => v.map((b, j) => (j !== i && Math.abs(Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) - edge) < 1e-3 ? j : -1)).filter((j) => j >= 0));
  // voisins dans l'ordre de parcours autour du sommet
  for (let i = 0; i < v.length; i++) {
    const [u, w] = basis(v[i]);
    nb[i].sort((a, b) => Math.atan2(dot(v[a], w), dot(v[a], u)) - Math.atan2(dot(v[b], w), dot(v[b], u)));
  }
  return { v, nb };
}

/** Couture de balle de tennis / baseball (courbe fermée à deux lobes), `a + b = 1`. */
export function tennisSeam(b = 0.36, steps = 96): V3[] {
  const a = 1 - b;
  const c = 2 * Math.sqrt(a * b);
  const out: V3[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * TAU;
    out.push(norm([a * Math.cos(t) + b * Math.cos(3 * t), c * Math.sin(2 * t), a * Math.sin(t) - b * Math.sin(3 * t)]));
  }
  return out;
}
