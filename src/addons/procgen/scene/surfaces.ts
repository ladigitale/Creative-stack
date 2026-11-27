/**
 * Surfaces praticables au-dessus du sol : le sommet des objets (rocher, caisse, mur, banc, ouvrage…) porte un acteur
 * qui y grimpe, s'y tient debout et y marche ; il en tombe en passant le bord, et peut se rattraper au rebord.
 * L'emprise est le rectangle orienté de l'objet ; un rocher a un sommet bombé, les autres un sommet plat.
 */
import type { V3 } from "../core/math";
import type { Mesh } from "../geom/mesh";
import type { ObjectInfo } from "./compose";

/**
 * Dessus d'un modèle vu d'en haut : hauteur maximale de ses triangles par case (repère du modèle, sans échelle),
 * NaN là où il n'y a rien. Calculée une fois par modèle : marches d'une falaise, plateau d'une caisse, assise d'un banc.
 */
export type TopGrid = { cell: number; nx: number; nz: number; x0: number; z0: number; h: Float32Array };

const gridCache = new WeakMap<Mesh, TopGrid>();

export function topGridOf(mesh: Mesh, hx: number, hz: number): TopGrid {
  const hit = gridCache.get(mesh);
  if (hit) return hit;
  const cell = Math.min(0.25, Math.max(0.05, Math.max(hx, hz) / 40));
  const nx = Math.max(1, Math.ceil((2 * hx) / cell)), nz = Math.max(1, Math.ceil((2 * hz) / cell));
  const x0 = -hx, z0 = -hz;
  const h = new Float32Array(nx * nz).fill(NaN);
  const P = mesh.pos, I = mesh.idx;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ax = P[a], ay = P[a + 1], az = P[a + 2], bx = P[b], by = P[b + 1], bz = P[b + 2], cx = P[c], cy = P[c + 1], cz = P[c + 2];
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-9) continue; // triangle vertical : ses arêtes sont couvertes par ses voisins
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / cell)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / cell)), j1 = Math.min(nz - 1, Math.floor((Math.max(az, bz, cz) - z0) / cell));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * cell, pz = z0 + (j + 0.5) * cell;
        const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / det;
        const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -0.02 || l2 < -0.02 || l3 < -0.02) continue;
        const y = l1 * ay + l2 * by + l3 * cy;
        const k = j * nx + i;
        if (!(h[k] >= y)) h[k] = y;
      }
  }
  const g = { cell, nx, nz, x0, z0, h };
  gridCache.set(mesh, g);
  return g;
}

/** Ce qui ne porte pas un acteur : feuillage, eau, êtres vivants, véhicules, toitures, tissus. */
const SOFT = new Set(["tree", "bush", "grass", "plant", "flowers", "character", "animal", "vehicle", "water", "textile", "building", "ball", "emblem", "meadow"]);

export function standable(o: ObjectInfo): boolean {
  const g = o.generator.split(".")[0];
  return !SOFT.has(g) && o.mode !== "actor" && o.height > 0.15 && o.footprint.hx > 0.12 && o.footprint.hz > 0.12;
}

/** Coordonnées locales (dans le repère de l'objet) d'un point du monde. */
function local(o: ObjectInfo, x: number, z: number): [number, number] {
  const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
  const dx = x - o.pos[0], dz = z - o.pos[2];
  return [dx * c - dz * s, dx * s + dz * c];
}

/** Hauteur du sommet de l'objet en (x, z), ou null hors de l'emprise (rétrécie de `margin`) ou dans un vide du modèle. */
export function topAt(o: ObjectInfo, x: number, z: number, margin = 0): number | null {
  const [lx, lz] = local(o, x, z);
  const hx = o.footprint.hx - margin, hz = o.footprint.hz - margin;
  if (hx <= 0 || hz <= 0 || Math.abs(lx) > hx || Math.abs(lz) > hz) return null;
  const g = o.top;
  if (g) {
    // dessus réel du modèle (sans échelle) : la case la plus haute sous le pied (moyenne des voisines pour lisser)
    const sx = lx / o.scale, sz = lz / o.scale;
    const i = Math.floor((sx - g.x0) / g.cell), j = Math.floor((sz - g.z0) / g.cell);
    let best = NaN;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= g.nx || jj >= g.nz) continue;
        const v = g.h[jj * g.nx + ii];
        if (!(best >= v)) best = Number.isNaN(best) ? v : Math.max(best, v);
      }
    return Number.isNaN(best) ? null : o.pos[1] + best * o.scale;
  }
  const top = o.pos[1] + o.height;
  if (o.generator.split(".")[0] !== "rock") return top;
  // rocher : sommet bombé (le bord est plus bas que le centre)
  const q = Math.max(Math.abs(lx) / o.footprint.hx, Math.abs(lz) / o.footprint.hz);
  return top - o.height * 0.35 * q * q;
}

/** Point du bord le plus proche (monde), normale sortante et distance horizontale (négative à l'intérieur). */
export function nearestEdge(o: ObjectInfo, x: number, z: number): { p: V3; n: [number, number]; d: number } {
  const [lx, lz] = local(o, x, z);
  const hx = o.footprint.hx, hz = o.footprint.hz;
  const ex = Math.abs(lx) - hx, ez = Math.abs(lz) - hz;
  // face la plus proche du point
  const onX = ex > ez;
  const px = onX ? Math.sign(lx || 1) * hx : Math.max(-hx, Math.min(hx, lx));
  const pz = onX ? Math.max(-hz, Math.min(hz, lz)) : Math.sign(lz || 1) * hz;
  const nl: [number, number] = onX ? [Math.sign(lx || 1), 0] : [0, Math.sign(lz || 1)];
  const inside = ex <= 0 && ez <= 0;
  const d = inside ? Math.max(ex, ez) : Math.hypot(Math.max(ex, 0), Math.max(ez, 0));
  const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
  // repère local → monde : rotation inverse
  const wx = px * c + pz * s, wz = -px * s + pz * c;
  const n: [number, number] = [nl[0] * c + nl[1] * s, -nl[0] * s + nl[1] * c];
  const top = topAt(o, o.pos[0] + wx * 0.999, o.pos[2] + wz * 0.999) ?? o.pos[1] + o.height;
  return { p: [o.pos[0] + wx, top, o.pos[2] + wz], n, d };
}

/**
 * Appui sous un acteur : le plus haut des sommets qu'il peut atteindre (au plus `stepUp` au-dessus de ses pieds,
 * on ne se téléporte pas sur un objet haut) et du sol.
 */
export function supportAt(objects: readonly ObjectInfo[], ground: number, x: number, z: number, feetY: number, stepUp: number): { y: number; obj: ObjectInfo | null } {
  let y = ground, obj: ObjectInfo | null = null;
  for (const o of objects) {
    if (Math.abs(x - o.pos[0]) > o.footprint.r + 0.5 || Math.abs(z - o.pos[2]) > o.footprint.r + 0.5) continue;
    if (!standable(o)) continue;
    const t = topAt(o, x, z, 0.02);
    if (t !== null && t > y && t <= feetY + stepUp) [y, obj] = [t, o];
  }
  return { y, obj };
}

/** Plus haut sommet d'objet en (x, z) (−∞ si aucun). */
export function maxTopAt(objects: readonly ObjectInfo[], x: number, z: number): number {
  let y = -Infinity;
  for (const o of objects) {
    if (Math.abs(x - o.pos[0]) > o.footprint.r + 0.5 || Math.abs(z - o.pos[2]) > o.footprint.r + 0.5 || !standable(o)) continue;
    const t = topAt(o, x, z, 0.02);
    if (t !== null && t > y) y = t;
  }
  return y;
}

/**
 * Paroi devant soi (direction `dx`, `dz` unitaire) : premier point où le dessus des objets monte de plus de `stepUp`
 * au-dessus des pieds, et hauteur du rebord juste derrière (le plus haut sur 60 cm). null si rien à moins de `maxD`.
 */
export function wallAhead(objects: readonly ObjectInfo[], x: number, z: number, dx: number, dz: number, feetY: number, stepUp: number, maxD = 2.5): { d: number; p: V3; top: number } | null {
  for (let d = 0.05; d <= maxD; d += 0.05) {
    const t = maxTopAt(objects, x + dx * d, z + dz * d);
    if (t > feetY + stepUp) {
      let top = t;
      for (let e = 0.05; e <= 0.6; e += 0.05) top = Math.max(top, Math.min(t + 0.6, maxTopAt(objects, x + dx * (d + e), z + dz * (d + e))));
      return { d, p: [x + dx * d, top, z + dz * d], top };
    }
  }
  return null;
}
