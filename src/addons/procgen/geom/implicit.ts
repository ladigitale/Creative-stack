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
  return d;
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
      const prims = this.candidates([i * B, j * B, k * B], [(i + 1) * B, (j + 1) * B, (k + 1) * B], B * 0.75);
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
    const c = this.local(p);
    const f = (x: number, y: number, z: number) => this.evalXYZ(x, y, z, c).d;
    return norm([f(p[0] + h, p[1], p[2]) - f(p[0] - h, p[1], p[2]), f(p[0], p[1] + h, p[2]) - f(p[0], p[1] - h, p[2]), f(p[0], p[1], p[2] + h) - f(p[0], p[1], p[2] - h)]);
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
  const scratch = new Float64Array(field.prims.length);
  const far = cell * 3;
  field.setBlock(cell * 6);
  for (let bk = 0; bk < nz; bk += B)
    for (let bj = 0; bj < ny; bj += B)
      for (let bi = 0; bi < nx; bi += B) {
        const mn: V3 = [org[0] + bi * cell, org[1] + bj * cell, org[2] + bk * cell];
        const mx: V3 = [mn[0] + B * cell, mn[1] + B * cell, mn[2] + B * cell];
        const cp = field.candidates(mn, mx, far);
        const cs = new Set(cp);
        const cand = { prims: cp, blends: field.blends.filter((bl) => cs.has(bl.a) && cs.has(bl.b)) };
        for (let k = bk; k < Math.min(nz, bk + B); k++)
          for (let j = bj; j < Math.min(ny, bj + B); j++)
            for (let i = bi; i < Math.min(nx, bi + B); i++) {
              const n = id(i, j, k);
              if (!cp.length) {
                val[n] = far;
                own[n] = -1;
                continue;
              }
              const r = field.evalXYZ(org[0] + i * cell, org[1] + j * cell, org[2] + k * cell, cand, scratch);
              val[n] = Number.isFinite(r.d) ? r.d : far;
              own[n] = r.owner;
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
    if (opts.ao) mesh.ao[v] = fieldAO(field, p, n, cell);
  }
  return { mesh, owner, cells: nx * ny * nz };
}

/** Occlusion ambiante dans un champ : on remonte la normale et on mesure ce qui « manque » de distance. */
export function fieldAO(field: Field, p: V3, n: V3, cell: number): number {
  let occ = 0;
  let w = 1;
  for (let i = 1; i <= 5; i++) {
    const h = cell * 1.5 * i;
    const d = field.distance(madd(p, n, h));
    occ += w * Math.max(0, h - d);
    w *= 0.6;
  }
  return clamp(1 - (occ / (cell * 3)) * 0.9, 0.15, 1);
}

/** Lissage de Taubin (λ / μ) : lisse sans rétrécir. */
export function taubin(mesh: Mesh, iterations: number, lambda = 0.5, mu = -0.53, fixed?: (i: number) => boolean) {
  const adj = mesh.adjacency();
  const n = mesh.vertexCount;
  const tmp = new Float64Array(n * 3);
  const step = (f: number) => {
    for (let v = 0; v < n; v++) {
      const nb = adj[v];
      if (!nb.length || fixed?.(v)) {
        tmp[v * 3] = mesh.pos[v * 3];
        tmp[v * 3 + 1] = mesh.pos[v * 3 + 1];
        tmp[v * 3 + 2] = mesh.pos[v * 3 + 2];
        continue;
      }
      let x = 0, y = 0, z = 0;
      for (const u of nb) {
        x += mesh.pos[u * 3];
        y += mesh.pos[u * 3 + 1];
        z += mesh.pos[u * 3 + 2];
      }
      const k = 1 / nb.length;
      tmp[v * 3] = mesh.pos[v * 3] + f * (x * k - mesh.pos[v * 3]);
      tmp[v * 3 + 1] = mesh.pos[v * 3 + 1] + f * (y * k - mesh.pos[v * 3 + 1]);
      tmp[v * 3 + 2] = mesh.pos[v * 3 + 2] + f * (z * k - mesh.pos[v * 3 + 2]);
    }
    for (let i = 0; i < n * 3; i++) mesh.pos[i] = tmp[i];
  };
  for (let it = 0; it < iterations; it++) {
    step(lambda);
    step(mu);
  }
}
