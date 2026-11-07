/**
 * Surfaces implicites : champs de distance signée combinés, polygonisés par « surface nets ».
 *
 * Union **dure** par défaut ; l'union **douce** (rayon `k`) n'est appliquée qu'entre les paires déclarées (os parent-
 * enfant d'un personnage, tronc-branche d'un arbre) : deux membres voisins dans l'espace mais pas dans la hiérarchie
 * (bras et torse, cuisse et cuisse) ne se soudent jamais.
 *
 * La polygonisation note pour chaque sommet la primitive dominante (`owner`) : c'est une segmentation exacte du
 * maillage (os dominant pour le skinning, rôle de couleur).
 */
import { type V3, add, clamp, dot, len, madd, mix, norm, scale, sub } from "../core/math";
import { adjacencyCSR } from "./adjacency";
import { Mesh } from "./mesh";

export type Prim =
  | { kind: "capsule"; a: V3; b: V3; ra: number; rb: number }
  | { kind: "ellipsoid"; c: V3; r: V3 }
  | { kind: "box"; c: V3; h: V3; round: number }
  | { kind: "sphere"; c: V3; r: number }
  /** Cône tronqué à fond plat (étages de conifère, chapeau pointu), arêtes adoucies de `round`. */
  | { kind: "cone"; a: V3; b: V3; ra: number; rb: number; round: number }
  /** Polyèdre convexe : intersection de demi-espaces `dot(p - c, n) <= d`, arêtes arrondies de `round`. */
  | { kind: "planes"; c: V3; planes: [V3, number][]; round: number; reach: number };

export type FieldPrim = Prim & {
  /** Rôle de couleur. */
  role: number;
  /** Étiquette libre (os, pièce) recopiée dans `owner`. */
  tag: number;
  /** Bosses : amplitude et fréquence d'un bruit ajouté (feuillage, roche). */
  bump?: { amp: number; freq: number; seed: number };
  /**
   * Demi-espaces de découpe : la primitive est coupée où `dot(p, n) > d` (intersection, arête adoucie de `k`).
   * Sert aux lignes nettes : implantation des cheveux, bord d'une capuche, encolure.
   */
  clip?: { n: V3; d: number; k?: number }[];
};

export type Blend = { a: number; b: number; k: number };

/* ---------- distances ---------- */

function sdRoundCone(px: number, py: number, pz: number, a: V3, b: V3, r1: number, r2: number): number {
  // Inigo Quilez, cône arrondi entre deux sphères (version scalaire, sans allocation)
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const l2 = bx * bx + by * by + bz * bz;
  const qx = px - a[0], qy = py - a[1], qz = pz - a[2];
  if (l2 < 1e-12) return Math.sqrt(qx * qx + qy * qy + qz * qz) - Math.max(r1, r2);
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const y = qx * bx + qy * by + qz * bz;
  const z = y - l2;
  const xx = qx * l2 - bx * y, xy = qy * l2 - by * y, xz = qz * l2 - bz * y;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

function sdCappedCone(px: number, py: number, pz: number, a: V3, b: V3, ra: number, rb: number): number {
  // Inigo Quilez, cône tronqué d'orientation quelconque
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const qx = px - a[0], qy = py - a[1], qz = pz - a[2];
  const rba = rb - ra;
  const baba = bx * bx + by * by + bz * bz;
  const papa = qx * qx + qy * qy + qz * qz;
  const paba = (qx * bx + qy * by + qz * bz) / baba;
  const x = Math.sqrt(Math.max(0, papa - paba * paba * baba));
  const cax = Math.max(0, x - (paba < 0.5 ? ra : rb));
  const cay = Math.abs(paba - 0.5) - 0.5;
  const k = rba * rba + baba;
  const f = clamp((rba * (x - ra) + paba * baba) / k, 0, 1);
  const cbx = x - ra - f * rba;
  const cby = paba - f;
  const s = cbx < 0 && cay < 0 ? -1 : 1;
  return s * Math.sqrt(Math.min(cax * cax + cay * cay * baba, cbx * cbx + cby * cby * baba));
}

function sdEllipsoid(px: number, py: number, pz: number, c: V3, r: V3): number {
  const qx = px - c[0], qy = py - c[1], qz = pz - c[2];
  const ax = qx / r[0], ay = qy / r[1], az = qz / r[2];
  const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
  const bx = ax / r[0], by = ay / r[1], bz = az / r[2];
  const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
  return k1 > 1e-12 ? (k0 * (k0 - 1)) / k1 : -Math.min(r[0], r[1], r[2]);
}

function sdBox(px: number, py: number, pz: number, c: V3, h: V3, round: number): number {
  const qx = Math.abs(px - c[0]) - h[0] + round, qy = Math.abs(py - c[1]) - h[1] + round, qz = Math.abs(pz - c[2]) - h[2] + round;
  const mx = Math.max(qx, 0), my = Math.max(qy, 0), mz = Math.max(qz, 0);
  return Math.sqrt(mx * mx + my * my + mz * mz) + Math.min(Math.max(qx, qy, qz), 0) - round;
}

import { noise3 } from "./noise";

export function primDistance(p: V3, f: FieldPrim): number {
  return primDist(p[0], p[1], p[2], f);
}

export function primDist(px: number, py: number, pz: number, f: FieldPrim): number {
  let d: number;
  switch (f.kind) {
    case "capsule":
      d = sdRoundCone(px, py, pz, f.a, f.b, f.ra, f.rb);
      break;
    case "ellipsoid":
      d = sdEllipsoid(px, py, pz, f.c, f.r);
      break;
    case "cone":
      d = sdCappedCone(px, py, pz, f.a, f.b, f.ra + f.round, f.rb + f.round) - f.round;
      break;
    case "box":
      d = sdBox(px, py, pz, f.c, f.h, f.round);
      break;
    case "planes": {
      const qx = px - f.c[0], qy = py - f.c[1], qz = pz - f.c[2];
      let m = -Infinity, acc = 0;
      const k = Math.max(f.round, 1e-4);
      for (const [n, dd] of f.planes) {
        const v = qx * n[0] + qy * n[1] + qz * n[2] - dd;
        if (v > m) m = v;
      }
      for (const [n, dd] of f.planes) acc += Math.exp((qx * n[0] + qy * n[1] + qz * n[2] - dd - m) / k);
      d = m + k * Math.log(acc) - k * 0.7;
      break;
    }
    default: {
      const s = f as { c: V3; r: number };
      d = Math.hypot(px - s.c[0], py - s.c[1], pz - s.c[2]) - s.r;
    }
  }
  if (f.bump) d += f.bump.amp * noise3(px * f.bump.freq + f.bump.seed, py * f.bump.freq, pz * f.bump.freq - f.bump.seed);
  if (f.clip)
    for (const c of f.clip) {
      const e = px * c.n[0] + py * c.n[1] + pz * c.n[2] - c.d;
      d = c.k ? smax(d, e, c.k) : Math.max(d, e);
    }
  return d;
}

/** Intersection douce (max adouci). */
function smax(a: number, b: number, k: number): number {
  const h = clamp(0.5 - (0.5 * (b - a)) / k, 0, 1);
  return mix(b, a, h) + k * h * (1 - h);
}

function primBounds(f: FieldPrim): { min: V3; max: V3 } {
  const pad = f.bump ? Math.abs(f.bump.amp) : 0;
  switch (f.kind) {
    case "cone":
    case "capsule": {
      const r = Math.max(f.ra, f.rb) + pad + (f.kind === "cone" ? f.round : 0);
      return { min: [Math.min(f.a[0], f.b[0]) - r, Math.min(f.a[1], f.b[1]) - r, Math.min(f.a[2], f.b[2]) - r], max: [Math.max(f.a[0], f.b[0]) + r, Math.max(f.a[1], f.b[1]) + r, Math.max(f.a[2], f.b[2]) + r] };
    }
    case "ellipsoid":
      return { min: sub(f.c, add(f.r, [pad, pad, pad])), max: add(f.c, add(f.r, [pad, pad, pad])) };
    case "box":
      return { min: sub(f.c, add(f.h, [pad, pad, pad])), max: add(f.c, add(f.h, [pad, pad, pad])) };
    case "planes":
      return { min: sub(f.c, [f.reach + pad, f.reach + pad, f.reach + pad]), max: add(f.c, [f.reach + pad, f.reach + pad, f.reach + pad]) };
    case "sphere":
    default:
      return { min: sub(f.c, [(f as { r: number }).r + pad, f.r + pad, f.r + pad]), max: add(f.c, [(f as { r: number }).r + pad, (f as { r: number }).r + pad, (f as { r: number }).r + pad]) };
  }
}

const smin = (a: number, b: number, k: number) => {
  if (k <= 0) return Math.min(a, b);
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return mix(b, a, h) - k * h * (1 - h);
};

/** Champ combiné, évaluable en tout point. */
export class Field {
  readonly prims: FieldPrim[];
  readonly blends: Blend[];
  private boxes: { min: V3; max: V3 }[];
  constructor(prims: FieldPrim[], blends: Blend[] = []) {
    this.prims = prims;
    this.blends = blends.filter((b) => b.a !== b.b && b.a < prims.length && b.b < prims.length);
    this.boxes = prims.map(primBounds);
  }
  bounds(): { min: V3; max: V3 } {
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const b of this.boxes)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], b.min[k]);
        max[k] = Math.max(max[k], b.max[k]);
      }
    return { min, max };
  }
  private block = 0.1;
  private blockCache = new Map<number, { prims: number[]; blends: Blend[] }>();
  /** Taille des blocs d'accélération (m) : chaque bloc garde ses primitives et soudures candidates. */
  setBlock(size: number) {
    this.block = size;
    this.blockCache.clear();
  }
  /** Primitives et soudures qui peuvent influencer le bloc contenant `p`. */
  local(p: V3): { prims: number[]; blends: Blend[] } {
    const B = this.block;
    const i = Math.floor(p[0] / B), j = Math.floor(p[1] / B), k = Math.floor(p[2] / B);
    const key = (i + 512) * 1048576 + (j + 512) * 1024 + (k + 512);
    let c = this.blockCache.get(key);
    if (!c) {
      let prims = this.candidates([i * B, j * B, k * B], [(i + 1) * B, (j + 1) * B, (k + 1) * B], B * 0.75);
      // élagage par la distance au centre du bloc (champ 1-lipschitzien) : seules restent les primitives qui peuvent
      // dominer ou peser dans une soudure quelque part dans le bloc élargi
      if (prims.length > 4) {
        const cx = (i + 0.5) * B, cy = (j + 0.5) * B, cz = (k + 0.5) * B;
        const R = Math.sqrt(3) * B * 1.25 * 1.3;
        let dmin = Infinity, bump = 0, maxK = 0;
        const ds = prims.map((q) => {
          const f = this.prims[q];
          if (f.bump) bump = Math.max(bump, Math.abs(f.bump.amp));
          const d = primDist(cx, cy, cz, f);
          if (d < dmin) dmin = d;
          return d;
        });
        for (const b of this.blends) maxK = Math.max(maxK, b.k);
        const lim = dmin + 2 * R + 1.5 * maxK + 2 * bump;
        prims = prims.filter((_, n) => ds[n] <= lim);
      }
      const set = new Set(prims);
      c = { prims, blends: this.blends.filter((b) => set.has(b.a) && set.has(b.b)) };
      this.blockCache.set(key, c);
    }
    return c;
  }
  /** Distance et primitive dominante ; `cand` limite les primitives évaluées (accélération par blocs). */
  private scratch = new Float64Array(0);
  eval(p: V3, cand?: { prims: number[]; blends: Blend[] }, out?: Float64Array): { d: number; owner: number } {
    return this.evalXYZ(p[0], p[1], p[2], cand, out);
  }
  evalXYZ(px: number, py: number, pz: number, cand?: { prims: number[]; blends: Blend[] }, out?: Float64Array): { d: number; owner: number } {
    const c = cand ?? this.local([px, py, pz]);
    if (this.scratch.length < this.prims.length) this.scratch = new Float64Array(this.prims.length);
    const ds = out ?? this.scratch;
    let d = Infinity;
    let owner = -1;
    for (const i of c.prims) {
      const v = primDist(px, py, pz, this.prims[i]);
      ds[i] = v;
      if (v < d) {
        d = v;
        owner = i;
      }
    }
    if (owner < 0) return { d: this.block, owner: -1 };
    for (const b of c.blends) {
      const da = ds[b.a], db = ds[b.b];
      if (Math.min(da, db) - b.k * 0.25 >= d) continue;
      const s = smin(da, db, b.k);
      if (s < d) d = s;
    }
    return { d, owner };
  }
  distance(p: V3): number {
    return this.evalXYZ(p[0], p[1], p[2]).d;
  }
  gradient(p: V3, h = 1e-3): V3 {
    // différences tétraédriques : 4 évaluations au lieu de 6
    const c = this.local(p);
    const a = this.evalXYZ(p[0] + h, p[1] - h, p[2] - h, c).d;
    const b = this.evalXYZ(p[0] - h, p[1] - h, p[2] + h, c).d;
    const d = this.evalXYZ(p[0] - h, p[1] + h, p[2] - h, c).d;
    const e = this.evalXYZ(p[0] + h, p[1] + h, p[2] + h, c).d;
    return norm([a - b - d + e, -a - b + d + e, -a + b - d + e]);
  }
  /** Ramène un point sur la surface (pas de Newton le long du gradient). */
  project(p: V3, iters = 2, h = 1e-3): V3 {
    let q = p;
    for (let i = 0; i < iters; i++) {
      const d = this.distance(q);
      if (Math.abs(d) < 1e-5) break;
      q = madd(q, this.gradient(q, h), -d);
    }
    return q;
  }
  /** Lancer de rayon (pas de sphère) : premier point de surface depuis `o` dans la direction `dir`, ou null. */
  raycast(o: V3, dir: V3, maxT: number, eps = 1e-4): V3 | null {
    const d0 = norm(dir);
    let t = 0;
    for (let i = 0; i < 160 && t < maxT; i++) {
      const p = madd(o, d0, t);
      const d = this.distance(p);
      if (d < eps) return p;
      t += Math.max(d * 0.9, eps);
    }
    return null;
  }
  /** Primitives susceptibles d'influencer une boîte (avec marge). */
  candidates(min: V3, max: V3, margin: number): number[] {
    const out: number[] = [];
    this.boxes.forEach((b, i) => {
      if (b.max[0] + margin < min[0] || b.min[0] - margin > max[0] || b.max[1] + margin < min[1] || b.min[1] - margin > max[1] || b.max[2] + margin < min[2] || b.min[2] - margin > max[2]) return;
      out.push(i);
    });
    // une primitive mêlée à une candidate doit être évaluée aussi
    const set = new Set(out);
    for (const bl of this.blends) {
      if (set.has(bl.a) && !set.has(bl.b)) set.add(bl.b);
      if (set.has(bl.b) && !set.has(bl.a)) set.add(bl.a);
    }
    return [...set];
  }
}

export type PolygonizeOptions = {
  /** Taille de cellule (m). */
  cell: number;
  /** Passes de lissage de Taubin (0 = aucune). */
  smooth?: number;
  /** Occlusion ambiante calculée dans le champ. */
  ao?: boolean;
  /** Marge autour des bornes du champ (m). */
  margin?: number;
  /** Plafond de cellules (sécurité). */
  maxCells?: number;
  /** Propriétaire recalculé à la position finale du sommet (après lissage) : frontières de rôles exactes. */
  exactOwner?: boolean;
  /** Échantillons d'occlusion le long de la normale (défaut 5). */
  aoSteps?: number;
};

export type Polygonized = { mesh: Mesh; owner: Int32Array; cells: number };

/** Polygonisation par surface nets (une face quadrangulaire par arête traversée). */
export function polygonize(field: Field, opts: PolygonizeOptions): Polygonized {
  const b = field.bounds();
  const margin = opts.margin ?? opts.cell * 2;
  let cell = opts.cell;
  const maxCells = opts.maxCells ?? 1_500_000;
  const ext = sub(add(b.max, [margin, margin, margin]), sub(b.min, [margin, margin, margin]));
  while ((ext[0] / cell) * (ext[1] / cell) * (ext[2] / cell) > maxCells) cell *= 1.15;
  const org: V3 = sub(b.min, [margin, margin, margin]);
  const nx = Math.ceil(ext[0] / cell) + 1, ny = Math.ceil(ext[1] / cell) + 1, nz = Math.ceil(ext[2] / cell) + 1;
  const val = new Float32Array(nx * ny * nz);
  const own = new Int16Array(nx * ny * nz);
  const id = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  // évaluation par blocs de 8³ avec liste de candidates
  const B = 8;
  const S = 4;
  // rayon de garde d'un sous-bloc : demi-diagonale + marge (les ellipsoïdes approchés ne sont pas exactement lipschitziens)
  const subR = Math.sqrt(3) * ((S - 1) / 2) * cell * 1.3;
  const skipR2 = (Math.sqrt(3) * 0.5 * cell + cell * 1.5) * 1.35;
  const skipR = (Math.sqrt(3) * ((S - 1) / 2) * cell + cell * 1.5) * 1.35;
  const scratch = new Float64Array(field.prims.length);
  const mark = new Uint8Array(field.prims.length);
  const far = cell * 3;
  field.setBlock(cell * 3);
  for (let bk = 0; bk < nz; bk += B)
    for (let bj = 0; bj < ny; bj += B)
      for (let bi = 0; bi < nx; bi += B) {
        const mn: V3 = [org[0] + bi * cell, org[1] + bj * cell, org[2] + bk * cell];
        const mx: V3 = [mn[0] + B * cell, mn[1] + B * cell, mn[2] + B * cell];
        const cp = field.candidates(mn, mx, far);
        const cs = new Set(cp);
        const cand = { prims: cp, blends: field.blends.filter((bl) => cs.has(bl.a) && cs.has(bl.b)) };
        if (!cp.length) {
          for (let k = bk; k < Math.min(nz, bk + B); k++)
            for (let j = bj; j < Math.min(ny, bj + B); j++)
              for (let i = bi; i < Math.min(nx, bi + B); i++) {
                val[id(i, j, k)] = far;
                own[id(i, j, k)] = -1;
              }
          continue;
        }
        let bumpPad = 0, maxK = 0;
        for (const q of cp) if (field.prims[q].bump) bumpPad = Math.max(bumpPad, Math.abs(field.prims[q].bump!.amp));
        for (const bl of cand.blends) maxK = Math.max(maxK, bl.k);
        // sous-blocs de 4³ : si le centre est loin de la surface (champ 1-lipschitzien), aucun nœud n'est traversé
        for (let sk = bk; sk < Math.min(nz, bk + B); sk += S)
          for (let sj = bj; sj < Math.min(ny, bj + B); sj += S)
            for (let si = bi; si < Math.min(nx, bi + B); si += S) {
              const ek = Math.min(nz, sk + S), ej = Math.min(ny, sj + S), ei = Math.min(nx, si + S);
              const cx = org[0] + ((si + ei - 1) / 2) * cell, cy = org[1] + ((sj + ej - 1) / 2) * cell, cz = org[2] + ((sk + ek - 1) / 2) * cell;
              const rc = field.evalXYZ(cx, cy, cz, cand, scratch);
              if (Number.isFinite(rc.d) && Math.abs(rc.d) > skipR + bumpPad) {
                for (let k = sk; k < ek; k++)
                  for (let j = sj; j < ej; j++)
                    for (let i = si; i < ei; i++) {
                      val[id(i, j, k)] = rc.d;
                      own[id(i, j, k)] = rc.owner;
                    }
                continue;
              }
              // élagage : une primitive trop loin du centre ne peut ni dominer ni peser dans une soudure du sous-bloc
              let dmin = Infinity;
              for (const q of cp) if (scratch[q] < dmin) dmin = scratch[q];
              const lim = dmin + 2 * subR + 1.5 * maxK + 2 * bumpPad;
              const sp: number[] = [];
              for (const q of cp) if (scratch[q] <= lim) sp.push(q);
              let sub = cand;
              if (sp.length < cp.length) {
                for (const q of sp) mark[q] = 1;
                sub = { prims: sp, blends: cand.blends.filter((bl) => mark[bl.a] === 1 && mark[bl.b] === 1) };
                for (const q of sp) mark[q] = 0;
              }
              // second niveau : cubes de 2³ nœuds, sautés s'ils sont loin de la surface
              for (let tk = sk; tk < ek; tk += 2)
                for (let tj = sj; tj < ej; tj += 2)
                  for (let ti = si; ti < ei; ti += 2) {
                    const fk = Math.min(ek, tk + 2), fj = Math.min(ej, tj + 2), fi = Math.min(ei, ti + 2);
                    if (fk - tk === 2 && fj - tj === 2 && fi - ti === 2) {
                      const r0 = field.evalXYZ(org[0] + (ti + 0.5) * cell, org[1] + (tj + 0.5) * cell, org[2] + (tk + 0.5) * cell, sub, scratch);
                      if (Number.isFinite(r0.d) && Math.abs(r0.d) > skipR2 + bumpPad) {
                        for (let k = tk; k < fk; k++)
                          for (let j = tj; j < fj; j++)
                            for (let i = ti; i < fi; i++) {
                              val[id(i, j, k)] = r0.d;
                              own[id(i, j, k)] = r0.owner;
                            }
                        continue;
                      }
                    }
                    for (let k = tk; k < fk; k++)
                      for (let j = tj; j < fj; j++)
                        for (let i = ti; i < fi; i++) {
                          const n = id(i, j, k);
                          const r = field.evalXYZ(org[0] + i * cell, org[1] + j * cell, org[2] + k * cell, sub, scratch);
                          val[n] = Number.isFinite(r.d) ? r.d : far;
                          own[n] = r.owner;
                        }
                  }
            }
      }
  // un sommet par cellule traversée
  const vidx = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cid = (i: number, j: number, k: number) => i + (nx - 1) * (j + (ny - 1) * k);
  const mesh = new Mesh();
  const owners: number[] = [];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float64Array(8);
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const [a, bb, cc] = corners[c];
          cv[c] = val[id(i + a, j + bb, k + cc)];
          if (cv[c] < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (const [e0, e1] of edges) {
          const v0 = cv[e0], v1 = cv[e1];
          if (v0 < 0 === v1 < 0) continue;
          const t = v0 / (v0 - v1);
          const c0 = corners[e0], c1 = corners[e1];
          sx += c0[0] + (c1[0] - c0[0]) * t;
          sy += c0[1] + (c1[1] - c0[1]) * t;
          sz += c0[2] + (c1[2] - c0[2]) * t;
          cnt++;
        }
        const p: V3 = [org[0] + (i + sx / cnt) * cell, org[1] + (j + sy / cnt) * cell, org[2] + (k + sz / cnt) * cell];
        // propriétaire : celui du coin intérieur le plus profond
        let best = Infinity, ow = -1;
        for (let c = 0; c < 8; c++) {
          if (cv[c] < best) {
            best = cv[c];
            const [a, bb, cc] = corners[c];
            ow = own[id(i + a, j + bb, k + cc)];
          }
        }
        vidx[cid(i, j, k)] = mesh.vertex(p, [0, 1, 0], ow >= 0 ? field.prims[ow].role : 0);
        owners.push(ow);
      }
  // faces : pour chaque arête de grille traversée, un quad des 4 cellules qui la partagent
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const v0 = val[id(i, j, k)];
        const s0 = v0 < 0;
        // arête x : (i,j,k)-(i+1,j,k), cellules (i, j-1..j, k-1..k)
        if (i < nx - 1 && s0 !== val[id(i + 1, j, k)] < 0) {
          const a = vidx[cid(i, j - 1, k - 1)], b2 = vidx[cid(i, j, k - 1)], c = vidx[cid(i, j, k)], d = vidx[cid(i, j - 1, k)];
          if (a >= 0 && b2 >= 0 && c >= 0 && d >= 0) (s0 ? mesh.quad(a, b2, c, d) : mesh.quad(a, d, c, b2));
        }
        if (j < ny - 1 && s0 !== val[id(i, j + 1, k)] < 0) {
          const a = vidx[cid(i - 1, j, k - 1)], b2 = vidx[cid(i - 1, j, k)], c = vidx[cid(i, j, k)], d = vidx[cid(i, j, k - 1)];
          if (a >= 0 && b2 >= 0 && c >= 0 && d >= 0) (s0 ? mesh.quad(a, b2, c, d) : mesh.quad(a, d, c, b2));
        }
        if (k < nz - 1 && s0 !== val[id(i, j, k + 1)] < 0) {
          const a = vidx[cid(i - 1, j - 1, k)], b2 = vidx[cid(i, j - 1, k)], c = vidx[cid(i, j, k)], d = vidx[cid(i - 1, j, k)];
          if (a >= 0 && b2 >= 0 && c >= 0 && d >= 0) (s0 ? mesh.quad(a, b2, c, d) : mesh.quad(a, d, c, b2));
        }
      }
  const owner = Int32Array.from(owners);
  if (opts.smooth) taubin(mesh, opts.smooth);
  // normales du gradient du champ (exactes), AO dans le champ
  for (let v = 0; v < mesh.vertexCount; v++) {
    const p = mesh.getPos(v);
    const n = field.gradient(p, cell * 0.5);
    mesh.setNrm(v, n);
    if (opts.ao) mesh.ao[v] = fieldAO(field, p, n, cell, opts.aoSteps);
    if (opts.exactOwner) {
      const o = field.evalXYZ(p[0], p[1], p[2]).owner;
      if (o >= 0) {
        owner[v] = o;
        mesh.role[v] = field.prims[o].role;
      }
    }
  }
  return { mesh, owner, cells: nx * ny * nz };
}

/** Occlusion ambiante dans un champ : on remonte la normale et on mesure ce qui « manque » de distance. */
export function fieldAO(field: Field, p: V3, n: V3, cell: number, steps = 5): number {
  let occ = 0;
  let w = 1;
  // moins d'échantillons : pas plus longs, même portée
  const st = 1.5 * (5 / steps);
  let norm0 = 0;
  for (let i = 1; i <= steps; i++) {
    const h = cell * st * i;
    const d = field.distance(madd(p, n, h));
    occ += w * Math.max(0, h - d);
    norm0 += w;
    w *= 0.6;
  }
  const ref = 2.306; // somme des poids pour 5 échantillons
  return clamp(1 - ((occ * (ref / norm0)) / (cell * 3)) * 0.9, 0.15, 1);
}

/** Lissage de Taubin (λ / μ) : lisse sans rétrécir. */
export function taubin(mesh: Mesh, iterations: number, lambda = 0.5, mu = -0.53, fixed?: (i: number) => boolean) {
  const { off, nbr } = adjacencyCSR(mesh);
  const n = mesh.vertexCount;
  const tmp = new Float64Array(n * 3);
  const pos = mesh.pos;
  const step = (f: number) => {
    for (let v = 0; v < n; v++) {
      const n0 = off[v], n1 = off[v + 1];
      if (n1 === n0 || fixed?.(v)) {
        tmp[v * 3] = pos[v * 3];
        tmp[v * 3 + 1] = pos[v * 3 + 1];
        tmp[v * 3 + 2] = pos[v * 3 + 2];
        continue;
      }
      let x = 0, y = 0, z = 0;
      for (let q = n0; q < n1; q++) {
        const u = nbr[q];
        x += pos[u * 3];
        y += pos[u * 3 + 1];
        z += pos[u * 3 + 2];
      }
      const k = 1 / (n1 - n0);
      tmp[v * 3] = pos[v * 3] + f * (x * k - pos[v * 3]);
      tmp[v * 3 + 1] = pos[v * 3 + 1] + f * (y * k - pos[v * 3 + 1]);
      tmp[v * 3 + 2] = pos[v * 3 + 2] + f * (z * k - pos[v * 3 + 2]);
    }
    for (let i = 0; i < n * 3; i++) pos[i] = tmp[i];
  };
  for (let it = 0; it < iterations; it++) {
    step(lambda);
    step(mu);
  }
}
