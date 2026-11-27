/**
 * Texte en relief : les polylignes de la police (`core/font.ts`) deviennent des rubans extrudés (face avant, face
 * arrière, flancs, bouts carrés), à facettes franches comme le reste de procgen. Un virage serré coupe le ruban en deux
 * (bouts prolongés d'une demi-épaisseur qui se recouvrent) : pas d'onglet démesuré au sommet d'un A ou d'un M.
 */
import { type V3, cross, dot, norm, sub } from "../core/math";
import { type LayoutOptions, type P2, layoutText } from "../core/font";
import { Mesh } from "./mesh";
import { orientRings, triangulateWithHoles } from "./triangulate";

/**
 * Contours pleins (lettres d'une police) extrudés de 0 à `depth` : face avant (+z), face arrière si `back`, flancs
 * sauf `flat` (lettres peintes à fleur d'un panneau).
 */
export function fillMesh(rings: P2[][], depth: number, role: number, back = true, flat = false): Mesh {
  const m = new Mesh();
  for (const { outer, holes } of orientRings(rings)) {
    const { pts, tris } = triangulateWithHoles(outer, holes);
    if (!tris.length) continue;
    const face = (z: number, nz: number) => {
      const b = m.vertexCount;
      for (const p of pts) m.vertex([p[0], p[1], z], [0, 0, nz], role);
      for (let t = 0; t < tris.length; t += 3) nz > 0 ? m.tri(b + tris[t], b + tris[t + 1], b + tris[t + 2]) : m.tri(b + tris[t], b + tris[t + 2], b + tris[t + 1]);
    };
    face(depth, 1);
    if (back && !flat) face(0, -1);
    if (flat) continue;
    for (const r of [outer, ...holes])
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
        if (l < 1e-9) continue;
        quad(m, [a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], depth], [a[0], a[1], depth], [dy / l, -dx / l, 0], role);
      }
  }
  return m;
}

const SHARP = Math.cos(100 * (Math.PI / 180));

/** Découpe une polyligne aux virages serrés ; `closed` si elle se referme. */
function pieces(pl: P2[]): { pts: P2[]; closed: boolean }[] {
  const pts: P2[] = [];
  for (const p of pl) if (!pts.length || Math.hypot(p[0] - pts[pts.length - 1][0], p[1] - pts[pts.length - 1][1]) > 1e-6) pts.push(p);
  if (pts.length < 2) return pl.length ? [{ pts: [pl[0], [pl[0][0], pl[0][1] + 1e-4]], closed: false }] : [];
  const closed = pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6;
  if (closed) return [{ pts: pts.slice(0, -1), closed: true }];
  const out: { pts: P2[]; closed: boolean }[] = [];
  let cur: P2[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    cur.push(pts[i]);
    if (i < pts.length - 1) {
      const a = dir(pts[i - 1], pts[i]), b = dir(pts[i], pts[i + 1]);
      if (a[0] * b[0] + a[1] * b[1] < SHARP) {
        out.push({ pts: cur, closed: false });
        cur = [pts[i]];
      }
    }
  }
  out.push({ pts: cur, closed: false });
  return out;
}
const dir = (a: P2, b: P2): P2 => {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
};

/** Quadrilatère orienté selon la normale voulue (sommets propres : arêtes franches). */
function quad(m: Mesh, a: V3, b: V3, c: V3, d: V3, n: V3, role: number) {
  const s = m.vertexCount;
  for (const p of [a, b, c, d]) m.vertex(p, n, role);
  if (dot(cross(sub(b, a), sub(c, a)), n) >= 0) m.quad(s, s + 1, s + 2, s + 3);
  else m.quad(s, s + 3, s + 2, s + 1);
}

/**
 * Rubans extrudés le long des polylignes (plan xy, épaisseur selon +z de 0 à `depth`). `hw` : demi-largeur du trait.
 * `back: false` omet la face arrière (lettres posées contre un panneau).
 */
export function strokeMesh(polys: P2[][], hw: number, depth: number, role: number, back = true, flat = false): Mesh {
  const m = new Mesh();
  for (const pl of polys)
    for (const { pts: raw, closed } of pieces(pl)) {
      let pts = raw;
      if (!closed) {
        // bouts carrés : prolongés d'une demi-épaisseur
        const d0 = dir(pts[1], pts[0]), d1 = dir(pts[pts.length - 2], pts[pts.length - 1]);
        pts = [[pts[0][0] + d0[0] * hw, pts[0][1] + d0[1] * hw], ...pts.slice(1, -1), [pts[pts.length - 1][0] + d1[0] * hw, pts[pts.length - 1][1] + d1[1] * hw]];
      }
      const n = pts.length;
      const L: P2[] = [], R: P2[] = [];
      for (let i = 0; i < n; i++) {
        const prev = closed ? pts[(i + n - 1) % n] : pts[Math.max(0, i - 1)];
        const next = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
        const a = i === 0 && !closed ? dir(pts[0], pts[1]) : dir(prev, pts[i]);
        const b = i === n - 1 && !closed ? dir(pts[n - 2], pts[n - 1]) : dir(pts[i], next);
        const na: P2 = [-a[1], a[0]], nb: P2 = [-b[1], b[0]];
        let mx = na[0] + nb[0], my = na[1] + nb[1];
        const ml = Math.hypot(mx, my) || 1;
        mx /= ml;
        my /= ml;
        const k = Math.min(2, 1 / Math.max(0.2, mx * na[0] + my * na[1])) * hw;
        L.push([pts[i][0] + mx * k, pts[i][1] + my * k]);
        R.push([pts[i][0] - mx * k, pts[i][1] - my * k]);
      }
      const segs = closed ? n : n - 1;
      const z1 = depth, z0 = 0;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        const v = (p: P2, z: number): V3 => [p[0], p[1], z];
        quad(m, v(R[i], z1), v(R[j], z1), v(L[j], z1), v(L[i], z1), [0, 0, 1], role);
        if (flat) continue;
        if (back) quad(m, v(R[i], z0), v(L[i], z0), v(L[j], z0), v(R[j], z0), [0, 0, -1], role);
        const dl = dir(L[i], L[j]), dr = dir(R[i], R[j]);
        quad(m, v(L[i], z0), v(L[j], z0), v(L[j], z1), v(L[i], z1), norm([-dl[1], dl[0], 0]), role);
        quad(m, v(R[i], z0), v(R[i], z1), v(R[j], z1), v(R[j], z0), norm([dr[1], -dr[0], 0]), role);
      }
      if (!closed && !flat) {
        const e0 = dir(pts[1], pts[0]), e1 = dir(pts[n - 2], pts[n - 1]);
        quad(m, [L[0][0], L[0][1], z0], [R[0][0], R[0][1], z0], [R[0][0], R[0][1], z1], [L[0][0], L[0][1], z1], [e0[0], e0[1], 0], role);
        quad(m, [L[n - 1][0], L[n - 1][1], z0], [R[n - 1][0], R[n - 1][1], z0], [R[n - 1][0], R[n - 1][1], z1], [L[n - 1][0], L[n - 1][1], z1], [e1[0], e1[1], 0], role);
      }
    }
  return m;
}

export type TextMeshOptions = LayoutOptions & {
  /** Hauteur de capitale (m). */
  height: number;
  /** Largeur maximale (m) : le texte est réduit pour tenir. */
  maxWidth?: number;
  /** Hauteur maximale de l'ensemble des lignes (m). */
  maxHeight?: number;
  /** Relief (m, défaut 0,15 × hauteur). */
  depth?: number;
  role: number;
  back?: boolean;
  /** Face avant seule (lettres peintes à fleur d'un panneau, triangles divisés par trois). */
  flat?: boolean;
};

/**
 * Texte en relief centré en (0, 0) dans le plan xy (lecture vers +z), relief de 0 à `depth`. Rend aussi la taille
 * finale (le texte se réduit pour tenir dans `maxWidth` × `maxHeight`).
 */
export function textMesh(text: string, o: TextMeshOptions): { mesh: Mesh; width: number; height: number; cap: number } {
  const wgt = o.weight ?? 0.09;
  const lay = layoutText(text, { ...o, weight: wgt });
  const fullW = lay.width + wgt * 2, fullH = lay.height + wgt * 2;
  let cap = o.height;
  if (o.maxWidth && fullW * cap > o.maxWidth) cap = o.maxWidth / fullW;
  if (o.maxHeight && fullH * cap > o.maxHeight) cap = o.maxHeight / fullH;
  // centré verticalement sur l'ensemble des lignes
  const oy = (lay.height - 1) / 2 - 0.5;
  const tr = (l: P2[][]) => l.map((pl) => pl.map(([x, y]) => [x * cap, (y + oy) * cap] as P2));
  const depth = o.depth ?? cap * 0.15, back = o.back ?? true, flat = o.flat ?? false;
  const mesh = strokeMesh(tr(lay.polys), wgt * cap, depth, o.role, back, flat);
  if (lay.fills.length) mesh.append(fillMesh(tr(lay.fills), depth, o.role, back, flat));
  if (lay.icons.length) mesh.append(strokeMesh(tr(lay.icons), lay.iconHW * cap, depth, o.role, back, flat));
  // onglets et bouts carrés peuvent déborder d'un rien : ramené dans la largeur demandée
  const b = mesh.bounds();
  const w = b.max[0] - b.min[0];
  if (o.maxWidth && w > o.maxWidth) {
    const k = o.maxWidth / w;
    mesh.mapPos(([x, y, z]) => [x * k, y * k, z]);
    cap *= k;
  }
  return { mesh, width: Math.min(o.maxWidth ?? Infinity, Math.max(w, fullW * cap)), height: fullH * cap, cap };
}

/** Point du plan du texte projeté sur une surface : position (déjà décollée) et normale, ou null hors surface. */
export type SurfacePoint = { p: V3; n: V3 } | null;

/**
 * Lettres imprimées sur une surface courbe (vêtement) : rubans plats sans épaisseur, face visible seulement (aucun
 * contour toon), les segments recoupés tous les `maxSeg` pour épouser la courbure. `project` place un point du plan
 * du texte sur la surface ; un quadrilatère dont un coin tombe hors surface est omis.
 */
export function printMesh(polys: P2[][], hw: number, project: (q: P2) => SurfacePoint, role: number, maxSeg: number): Mesh {
  const m = new Mesh();
  for (const pl of polys)
    for (const { pts: raw, closed } of pieces(pl)) {
      let pts = raw;
      if (!closed) {
        const d0 = dir(pts[1], pts[0]), d1 = dir(pts[pts.length - 2], pts[pts.length - 1]);
        pts = [[pts[0][0] + d0[0] * hw, pts[0][1] + d0[1] * hw], ...pts.slice(1, -1), [pts[pts.length - 1][0] + d1[0] * hw, pts[pts.length - 1][1] + d1[1] * hw]];
      }
      // recoupe
      const fine: P2[] = [];
      const segs0 = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < segs0; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxSeg));
        for (let j = 0; j < k; j++) fine.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
      }
      if (!closed) fine.push(pts[pts.length - 1]);
      const n = fine.length;
      const L: SurfacePoint[] = [], R: SurfacePoint[] = [];
      for (let i = 0; i < n; i++) {
        const prev = closed ? fine[(i + n - 1) % n] : fine[Math.max(0, i - 1)];
        const next = closed ? fine[(i + 1) % n] : fine[Math.min(n - 1, i + 1)];
        const a = dir(prev, fine[i] === prev ? next : fine[i]), b = dir(fine[i] === next ? prev : fine[i], next);
        const na: P2 = [-a[1], a[0]], nb: P2 = [-b[1], b[0]];
        let mx = na[0] + nb[0], my = na[1] + nb[1];
        const ml = Math.hypot(mx, my) || 1;
        mx /= ml;
        my /= ml;
        const k = Math.min(2, 1 / Math.max(0.2, mx * na[0] + my * na[1])) * hw;
        L.push(project([fine[i][0] + mx * k, fine[i][1] + my * k]));
        R.push(project([fine[i][0] - mx * k, fine[i][1] - my * k]));
      }
      const segs = closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        const c = [R[i], R[j], L[j], L[i]];
        if (c.some((x) => !x)) continue;
        const s = m.vertexCount;
        for (const x of c as { p: V3; n: V3 }[]) m.vertex(x.p, x.n, role);
        // orientation : vers la normale de la surface
        const ok = dot(cross(sub(c[1]!.p, c[0]!.p), sub(c[2]!.p, c[0]!.p)), c[0]!.n) >= 0;
        if (ok) m.quad(s, s + 1, s + 2, s + 3);
        else m.quad(s, s + 3, s + 2, s + 1);
      }
    }
  return m;
}

/**
 * Lettres pleines imprimées sur une surface courbe : triangles du glyphe recoupés (arêtes de `maxSeg` au plus) puis
 * projetés sommet par sommet ; un triangle dont un sommet tombe hors surface est omis.
 */
export function printFills(rings: P2[][], project: (q: P2) => SurfacePoint, role: number, maxSeg: number): Mesh {
  const m = new Mesh();
  const cache = new Map<string, number>();
  const vert = (q: P2): number => {
    const k = `${q[0].toFixed(6)},${q[1].toFixed(6)}`;
    let v = cache.get(k);
    if (v === undefined) {
      const s = project(q);
      v = s ? m.vertex(s.p, s.n, role) : -1;
      cache.set(k, v);
    }
    return v;
  };
  const mid = (a: P2, b: P2): P2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const emit = (a: P2, b: P2, c: P2, depth: number) => {
    const la = Math.hypot(b[0] - a[0], b[1] - a[1]), lb = Math.hypot(c[0] - b[0], c[1] - b[1]), lc = Math.hypot(a[0] - c[0], a[1] - c[1]);
    if (depth < 6 && Math.max(la, lb, lc) > maxSeg) {
      // coupe de l'arête la plus longue (pas de fissure : un point milieu est partagé par ses deux triangles)
      if (la >= lb && la >= lc) {
        const m0 = mid(a, b);
        emit(a, m0, c, depth + 1);
        emit(m0, b, c, depth + 1);
      } else if (lb >= lc) {
        const m0 = mid(b, c);
        emit(a, b, m0, depth + 1);
        emit(a, m0, c, depth + 1);
      } else {
        const m0 = mid(c, a);
        emit(a, b, m0, depth + 1);
        emit(m0, b, c, depth + 1);
      }
      return;
    }
    const ia = vert(a), ib = vert(b), ic = vert(c);
    if (ia < 0 || ib < 0 || ic < 0) return;
    const A = m.getPos(ia), B = m.getPos(ib), C = m.getPos(ic);
    const ok = dot(cross(sub(B, A), sub(C, A)), m.getNrm(ia)) >= 0;
    if (ok) m.tri(ia, ib, ic);
    else m.tri(ia, ic, ib);
  };
  for (const { outer, holes } of orientRings(rings)) {
    const { pts, tris } = triangulateWithHoles(outer, holes);
    for (let t = 0; t < tris.length; t += 3) emit(pts[tris[t]], pts[tris[t + 1]], pts[tris[t + 2]], 0);
  }
  return m;
}

/**
 * Contours pleins des traits (dessin vectoriel) : un anneau par morceau de trait, bouts carrés. Les anneaux pleins
 * tournent dans le sens trigonométrique, les trous (intérieur d'un O, d'un 8) dans l'autre : remplissage « nonzero »
 * sans trou aux croisements.
 */
export function strokeOutlines(polys: P2[][], hw: number): P2[][] {
  const out: P2[][] = [];
  const area = (r: P2[]) => {
    let a = 0;
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  };
  const ccw = (r: P2[], want: boolean) => ((area(r) > 0) === want ? r : r.slice().reverse());
  for (const pl of polys)
    for (const { pts: raw, closed } of pieces(pl)) {
      let pts = raw;
      if (!closed) {
        const d0 = dir(pts[1], pts[0]), d1 = dir(pts[pts.length - 2], pts[pts.length - 1]);
        pts = [[pts[0][0] + d0[0] * hw, pts[0][1] + d0[1] * hw], ...pts.slice(1, -1), [pts[pts.length - 1][0] + d1[0] * hw, pts[pts.length - 1][1] + d1[1] * hw]];
      }
      const n = pts.length;
      const L: P2[] = [], R: P2[] = [];
      for (let i = 0; i < n; i++) {
        const prev = closed ? pts[(i + n - 1) % n] : pts[Math.max(0, i - 1)];
        const next = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
        const a = i === 0 && !closed ? dir(pts[0], pts[1]) : dir(prev, pts[i]);
        const b = i === n - 1 && !closed ? dir(pts[n - 2], pts[n - 1]) : dir(pts[i], next);
        const na: P2 = [-a[1], a[0]], nb: P2 = [-b[1], b[0]];
        let mx = na[0] + nb[0], my = na[1] + nb[1];
        const ml = Math.hypot(mx, my) || 1;
        mx /= ml;
        my /= ml;
        const k = Math.min(2, 1 / Math.max(0.2, mx * na[0] + my * na[1])) * hw;
        L.push([pts[i][0] + mx * k, pts[i][1] + my * k]);
        R.push([pts[i][0] - mx * k, pts[i][1] - my * k]);
      }
      if (closed) {
        const [outer, inner] = Math.abs(area(L)) > Math.abs(area(R)) ? [L, R] : [R, L];
        out.push(ccw(outer, true), ccw(inner, false));
      } else out.push(ccw([...L, ...R.reverse()], true));
    }
  return out;
}
