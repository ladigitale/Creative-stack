/**
 * Primitives et constructeurs de géométrie. Tous les maillages sortent centrés sur l'origine (sauf indication) avec des
 * normales correctes et un rôle par défaut.
 */
import { type V3, add, cross, dot, len, madd, norm, scale, sub, clamp } from "../core/math";
import { Mesh } from "./mesh";

/**
 * Boîte de demi-côtés `hx, hy, hz`, arêtes arrondies de rayon `r` (0 = arêtes vives, normales par face).
 * `seg` subdivisions de l'arrondi par face.
 */
export function box(hx: number, hy: number, hz: number, role: number, r = 0, seg = 2): Mesh {
  const m = new Mesh();
  // petits arrondis : arêtes vives (le contour et l'AO suffisent à cette échelle) ; sinon une seule subdivision
  const rr = r < 0.025 ? 0 : Math.min(r, hx, hy, hz);
  const n = rr > 0 ? Math.max(1, Math.min(seg, 1)) * 2 + 1 : 1;
  const faces: [V3, V3, V3][] = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const h: V3 = [hx, hy, hz];
  const inner: V3 = [hx - rr, hy - rr, hz - rr];
  for (const [nn, u, v] of faces) {
    const base = m.vertexCount;
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * 2 - 1;
        const b = (j / n) * 2 - 1;
        // point du cube [-1,1]^3 puis mise à l'échelle
        const c = add(add(nn, scale(u, a)), scale(v, b));
        let p: V3 = [c[0] * h[0], c[1] * h[1], c[2] * h[2]];
        let normal: V3 = nn;
        if (rr > 0) {
          const q: V3 = [clamp(p[0], -inner[0], inner[0]), clamp(p[1], -inner[1], inner[1]), clamp(p[2], -inner[2], inner[2])];
          const d = sub(p, q);
          normal = len(d) > 1e-9 ? norm(d) : nn;
          p = madd(q, normal, rr);
        }
        m.vertex(p, normal, role);
      }
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = base + j * (n + 1) + i;
        m.quad(a, a + 1, a + n + 2, a + n + 1);
      }
  }
  return m;
}

/** Ellipsoïde (sphère UV) de rayons `rx, ry, rz`. */
export function ellipsoid(rx: number, ry: number, rz: number, role: number, seg = 12, rings = 8): Mesh {
  const m = new Mesh();
  for (let j = 0; j <= rings; j++) {
    const v = j / rings;
    const th = v * Math.PI;
    for (let i = 0; i <= seg; i++) {
      const ph = (i / seg) * Math.PI * 2;
      const s: V3 = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      m.vertex([s[0] * rx, s[1] * ry, s[2] * rz], norm([s[0] / rx, s[1] / ry, s[2] / rz]), role);
    }
  }
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i;
      m.quad(a, a + 1, a + seg + 2, a + seg + 1);
    }
  return m;
}

/** Icosphère de rayon 1, `sub` subdivisions (0 → 20 faces, 2 → 320). */
export function icosphere(sub = 2, role = 0): Mesh {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: V3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => norm(v as V3));
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < sub; s++) {
    const mid = new Map<string, number>();
    const m = (a: number, b: number) => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      let i = mid.get(k);
      if (i === undefined) {
        i = verts.length;
        verts.push(norm(scale(add(verts[a], verts[b]), 0.5)));
        mid.set(k, i);
      }
      return i;
    };
    const nf: number[][] = [];
    for (const [a, b, c] of faces) {
      const ab = m(a, b), bc = m(b, c), ca = m(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = nf;
  }
  verts = verts.slice();
  const out = new Mesh();
  for (const v of verts) out.vertex(v, v, role);
  for (const [a, b, c] of faces) out.tri(a, b, c);
  return out;
}

/**
 * Tour (profil tourné autour de y) : `profile` = [[rayon, y], …] du bas vers le haut. `caps` ferme les extrémités
 * dont le rayon n'est pas nul.
 */
export function lathe(profile: [number, number][], role: number, seg = 16, caps = true): Mesh {
  const m = new Mesh();
  const np = profile.length;
  // normales de profil (2D) par différence centrée
  const pn: [number, number][] = profile.map((_, k) => {
    const a = profile[Math.max(0, k - 1)];
    const b = profile[Math.min(np - 1, k + 1)];
    const dr = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dr, dy) || 1;
    return [dy / l, -dr / l];
  });
  for (let k = 0; k < np; k++)
    for (let i = 0; i <= seg; i++) {
      const ph = (i / seg) * Math.PI * 2;
      const c = Math.cos(ph), s = Math.sin(ph);
      m.vertex([profile[k][0] * c, profile[k][1], profile[k][0] * s], norm([pn[k][0] * c, pn[k][1], pn[k][0] * s]), role);
    }
  for (let k = 0; k < np - 1; k++)
    for (let i = 0; i < seg; i++) {
      const a = k * (seg + 1) + i;
      m.quad(a, a + seg + 1, a + seg + 2, a + 1);
    }
  if (caps) {
    for (const [k, up] of [[0, -1], [np - 1, 1]] as const) {
      if (profile[k][0] < 1e-6) continue;
      const c = m.vertex([0, profile[k][1], 0], [0, up, 0], role);
      const ring: number[] = [];
      for (let i = 0; i <= seg; i++) {
        const ph = (i / seg) * Math.PI * 2;
        ring.push(m.vertex([profile[k][0] * Math.cos(ph), profile[k][1], profile[k][0] * Math.sin(ph)], [0, up, 0], role));
      }
      for (let i = 0; i < seg; i++) (up > 0 ? m.tri(c, ring[i + 1], ring[i]) : m.tri(c, ring[i], ring[i + 1]));
    }
  }
  return m;
}

/** Cylindre (ou cône si `r1 ≠ r0`) de hauteur `h`, base à y = 0. */
export function cylinder(r0: number, r1: number, h: number, role: number, seg = 12): Mesh {
  return lathe([[r0, 0], [r1, h]], role, seg, true);
}

/**
 * Tube balayé le long d'une polyligne 3D, rayon variable, repères par transport parallèle (pas de vrille).
 * `radii` : un rayon par point. `capEnd` ferme le bout (branche) ; le départ reste ouvert (soudé dans le parent).
 */
export function tube(points: V3[], radii: number[], role: number, seg = 8, capStart = false, capEnd = true): Mesh {
  const m = new Mesh();
  const n = points.length;
  if (n < 2) return m;
  const tang: V3[] = points.map((_, k) => norm(sub(points[Math.min(n - 1, k + 1)], points[Math.max(0, k - 1)])));
  let ref: V3 = Math.abs(tang[0][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let nrm = norm(cross(tang[0], ref));
  for (let k = 0; k < n; k++) {
    if (k > 0) {
      // transport parallèle : projeter la normale précédente sur le plan de la nouvelle tangente
      nrm = norm(sub(nrm, scale(tang[k], dot(nrm, tang[k]))));
    }
    const bin = cross(tang[k], nrm);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const d = add(scale(nrm, Math.cos(a)), scale(bin, Math.sin(a)));
      m.vertex(madd(points[k], d, radii[k]), d, role);
    }
  }
  ref = nrm;
  for (let k = 0; k < n - 1; k++)
    for (let i = 0; i < seg; i++) {
      const a = k * (seg + 1) + i;
      m.quad(a, a + 1, a + seg + 2, a + seg + 1);
    }
  const cap = (k: number, dirSign: number) => {
    const c = m.vertex(points[k], scale(tang[k], dirSign), role);
    const start = k * (seg + 1);
    for (let i = 0; i < seg; i++) (dirSign > 0 ? m.tri(c, start + i, start + i + 1) : m.tri(c, start + i + 1, start + i));
  };
  if (capEnd) cap(n - 1, 1);
  if (capStart) cap(0, -1);
  return m;
}

/* ---------- extrusion de profils 2D ---------- */

function area2(p: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Triangulation par oreilles d'un polygone simple (sens indifférent). Renvoie des triplets d'indices. */
export function triangulate(poly: [number, number][]): number[] {
  const n = poly.length;
  if (n < 3) return [];
  const ccw = area2(poly) > 0;
  const V = Array.from({ length: n }, (_, i) => (ccw ? i : n - 1 - i));
  const out: number[] = [];
  const inside = (p: [number, number], a: [number, number], b: [number, number], c: [number, number]) => {
    const s = (u: [number, number], v: [number, number], w: [number, number]) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
    return s(a, b, p) >= 0 && s(b, c, p) >= 0 && s(c, a, p) >= 0;
  };
  let guard = n * n;
  while (V.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < V.length; i++) {
      const a = poly[V[(i + V.length - 1) % V.length]], b = poly[V[i]], c = poly[V[(i + 1) % V.length]];
      const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cr <= 1e-12) continue;
      let ok = true;
      for (const k of V) {
        const p = poly[k];
        if (p === a || p === b || p === c) continue;
        if (inside(p, a, b, c)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      out.push(V[(i + V.length - 1) % V.length], V[i], V[(i + 1) % V.length]);
      V.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (V.length === 3) out.push(V[0], V[1], V[2]);
  return out;
}

/**
 * Extrusion d'un profil 2D (plan x/y) sur z ∈ [0, depth], biseau `bevel` (0 = vif). Face avant en +z.
 */
export function extrude(poly: [number, number][], depth: number, role: number, bevel = 0, backRole = role): Mesh {
  const m = new Mesh();
  const ccw = area2(poly) > 0;
  const P = ccw ? poly : [...poly].reverse();
  const n = P.length;
  // décalage vers l'intérieur pour le biseau (approximation par bissectrices)
  const inset = (d: number): [number, number][] =>
    P.map((p, i) => {
      if (d === 0) return p;
      const a = P[(i + n - 1) % n], c = P[(i + 1) % n];
      const e1 = norm([p[0] - a[0], p[1] - a[1], 0]), e2 = norm([c[0] - p[0], c[1] - p[1], 0]);
      const n1: V3 = [-e1[1], e1[0], 0], n2: V3 = [-e2[1], e2[0], 0];
      const bis = norm(add(n1, n2));
      const k = d / Math.max(0.3, dot(bis, n1));
      return [p[0] + bis[0] * k, p[1] + bis[1] * k];
    });
  const b = Math.min(bevel, depth / 2);
  const front = inset(b);
  const tris = triangulate(P);
  const face = (pts: [number, number][], z: number, nz: number, r: number) => {
    const base = m.vertexCount;
    for (const p of pts) m.vertex([p[0], p[1], z], [0, 0, nz], r);
    for (let t = 0; t < tris.length; t += 3) (nz > 0 ? m.tri(base + tris[t], base + tris[t + 1], base + tris[t + 2]) : m.tri(base + tris[t], base + tris[t + 2], base + tris[t + 1]));
  };
  face(front, depth, 1, role);
  face(P, 0, -1, backRole);
  const ring = (a: [number, number][], za: number, c: [number, number][], zc: number) => {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const p0: V3 = [a[i][0], a[i][1], za], p1: V3 = [a[j][0], a[j][1], za], p2: V3 = [c[j][0], c[j][1], zc], p3: V3 = [c[i][0], c[i][1], zc];
      const nn = norm(cross(sub(p1, p0), sub(p3, p0)));
      const s = m.vertexCount;
      for (const p of [p0, p1, p2, p3]) m.vertex(p, scale(nn, -1), role);
      m.tri(s, s + 2, s + 1);
      m.tri(s, s + 3, s + 2);
    }
  };
  ring(P, 0, P, depth - b);
  if (b > 0) ring(P, depth - b, front, depth);
  return m;
}

/** Grille plane (x, z) de `w × d`, centrée, `nx × nz` cellules, normale +y. */
export function grid(w: number, d: number, nx: number, nz: number, role: number): Mesh {
  const m = new Mesh();
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= nx; i++) m.vertex([(i / nx - 0.5) * w, 0, (j / nz - 0.5) * d], [0, 1, 0], role);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      m.quad(a, a + nx + 1, a + nx + 2, a + 1);
    }
  return m;
}

/** Polygone régulier (profil 2D) de `n` côtés, rayon `r`. */
export function ngon(n: number, r: number, rot = 0): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = rot + (i / n) * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r] as [number, number];
  });
}
