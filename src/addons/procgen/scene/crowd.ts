/**
 * Foule : personne ne se traverse. Évitement local (un marcheur contourne ceux qui sont devant lui, du côté libre)
 * et séparation (deux acteurs qui se chevauchent sont écartés, sans jamais être poussés dans un obstacle). Commun aux
 * rendus 3D et vectoriel.
 */
import type { V3 } from "../core/math";

export type CrowdActor = { pos: V3; mo: { legLength: number }; model: { id: string; seed: number }; hidden?: boolean };

/** Rayon d'encombrement d'un acteur au sol (m) : épaules et coudes, d'après la longueur de jambe. */
export const actorRadius = (a: { mo: { legLength: number } }) => 0.18 * a.mo.legLength + 0.08;

/**
 * Direction de marche corrigée pour contourner les acteurs proches devant soi, et facteur de vitesse (ralentit au
 * contact). `vx`, `vz` : direction voulue (unitaire).
 */
export function steerAround(a: CrowdActor, others: Iterable<CrowdActor>, vx: number, vz: number, skip?: (b: CrowdActor) => boolean): { vx: number; vz: number; slow: number } {
  const ra = actorRadius(a);
  let ax = 0, az = 0, slow = 1;
  for (const b of others) {
    if (b === a || b.hidden || skip?.(b)) continue;
    const ex = b.pos[0] - a.pos[0], ez = b.pos[2] - a.pos[2];
    const d = Math.hypot(ex, ez);
    const R = ra + actorRadius(b), look = R + 1.3;
    if (d > look || d < 1e-4) continue;
    const ahead = (ex * vx + ez * vz) / d;
    if (ahead <= 0.05) continue;
    const k = ahead * (1 - Math.max(0, d - R) / (look - R));
    // côté libre : on passe du côté opposé à l'autre
    const cr = ex * vz - ez * vx;
    ax += (cr >= 0 ? -vz : vz) * k;
    az += (cr >= 0 ? vx : -vx) * k;
    if (d < R + 0.2 && ahead > 0.75) slow = Math.min(slow, Math.max(0.2, (d - R) / 0.2));
  }
  if (!ax && !az) return { vx, vz, slow };
  const nx = vx + ax * 1.5, nz = vz + az * 1.5;
  const l = Math.hypot(nx, nz) || 1;
  return { vx: nx / l, vz: nz / l, slow };
}

/**
 * Écarte les acteurs qui se chevauchent. `pinned` : acteurs immobiles (assis, suspendus, tenus au doigt) ; `free` :
 * le sol est-il praticable ; `moved` : après un déplacement (recaler la hauteur). Grille de 1 m : coût linéaire.
 */
export function separate<A extends CrowdActor>(list: A[], free: (x: number, z: number) => boolean, pinned: (a: A) => boolean, moved: (a: A) => void): void {
  const push = (a: A, dx: number, dz: number) => {
    const x = a.pos[0] + dx, z = a.pos[2] + dz;
    if (free(x, z) || !free(a.pos[0], a.pos[2])) {
      a.pos[0] = x;
      a.pos[2] = z;
    } else if (free(x, a.pos[2])) a.pos[0] = x;
    else if (free(a.pos[0], z)) a.pos[2] = z;
    else return;
    moved(a);
  };
  if (list.length < 2) return;
  const grid = new Map<string, A[]>();
  for (const a of list) {
    const k = `${Math.floor(a.pos[0])},${Math.floor(a.pos[2])}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(a);
  }
  for (const a of list) {
    const cx = Math.floor(a.pos[0]), cz = Math.floor(a.pos[2]);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const b of grid.get(`${cx + i},${cz + j}`) ?? []) {
          if (b.model.id <= a.model.id) continue;
          let ex = b.pos[0] - a.pos[0], ez = b.pos[2] - a.pos[2];
          let d = Math.hypot(ex, ez);
          const R = actorRadius(a) + actorRadius(b);
          if (d >= R) continue;
          if (d < 1e-4) [ex, ez, d] = [Math.sin(a.model.seed * 9.1), Math.cos(a.model.seed * 9.1), 1];
          const wa = pinned(a) ? 0 : 1, wb = pinned(b) ? 0 : 1;
          if (!wa && !wb) continue;
          const o = (R - d) / (wa + wb);
          push(a, (-ex / d) * o * wa, (-ez / d) * o * wa);
          push(b, (ex / d) * o * wb, (ez / d) * o * wb);
        }
  }
}

/** Pas libre : avance, ou glisse le long d'un obstacle (un axe à la fois) ; false si bloqué. */
export function slideStep(pos: V3, nx: number, nz: number, free: (x: number, z: number) => boolean): boolean {
  if (free(nx, nz) || !free(pos[0], pos[2])) {
    pos[0] = nx;
    pos[2] = nz;
  } else if (free(nx, pos[2])) pos[0] = nx;
  else if (free(pos[0], nz)) pos[2] = nz;
  else return false;
  return true;
}
