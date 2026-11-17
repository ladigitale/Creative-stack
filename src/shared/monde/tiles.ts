/**
 * Mécanique commune des mondes infinis (format monde de `sonic-3d` / `sonic-2d` et recettes de `sonic-procgen`) :
 *
 * - **anneau** de tuiles à charger autour d'un point (les plus proches d'abord) et tuiles à relâcher derrière lui
 *   (hystérésis d'une tuile et demie : un aller-retour sur une frontière ne recharge rien) ;
 * - **candidats par cellule du monde** : une graine par cellule (indépendante de la tuile qui la génère), un candidat
 *   à désordre borné ; la cellule appartient à la tuile qui contient son candidat. Deux tuiles voisines ne se
 *   chevauchent donc jamais et l'écart minimal tient sans regarder les voisines ;
 * - **persistance bornée** : les retouches du joueur sont rangées par tuile (`"cx,cz"`) et leur nombre total est
 *   borné ; au-delà, les tuiles les plus éloignées du point suivi sont oubliées d'abord (la tuile retouchée en dernier
 *   jamais), ce qui répartit le total entre les tuiles proches.
 *
 * Sans dépendance au rendu ni au DOM.
 */
import { Rng, hash32 } from "../rng";

export type TileAxes = "xz" | "x";
export type TileWant = { cx: number; cz: number; d: number; key: string };

export const tileKey = (cx: number, cz: number) => `${cx},${cz}`;

/** Tuile qui contient (x, z) ; en défilement (`x`), toujours la rangée 0. */
export function tileOf(tile: number, x: number, z: number, axes: TileAxes = "xz"): [number, number] {
  return [Math.floor(x / tile), axes === "x" ? 0 : Math.floor(z / tile)];
}

/** Coordonnées d'une clé `"cx,cz"` (null si invalide). */
export function parseTileKey(k: string): [number, number] | null {
  const m = /^(-?\d+),(-?\d+)$/.exec(k);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Tuiles à charger autour de la tuile (ccx, ccz), dans un disque de rayon `radius` (tuiles), les plus proches d'abord. */
export function ringTiles(ccx: number, ccz: number, radius: number, axes: TileAxes = "xz"): TileWant[] {
  const R = Math.max(0, Math.floor(radius));
  const want: TileWant[] = [];
  for (let dx = -R; dx <= R; dx++)
    for (let dz = axes === "x" ? 0 : -R; dz <= (axes === "x" ? 0 : R); dz++) {
      const d = Math.hypot(dx, dz);
      if (d <= R + 0.5) want.push({ cx: ccx + dx, cz: ccz + dz, d, key: tileKey(ccx + dx, ccz + dz) });
    }
  return want.sort((a, b) => a.d - b.d);
}

/** Une tuile chargée est-elle à relâcher (au-delà de `radius + 1,5`) ? */
export function tileTooFar(cx: number, cz: number, ccx: number, ccz: number, radius: number): boolean {
  return Math.hypot(cx - ccx, cz - ccz) > radius + 1.5;
}

/**
 * Candidats d'une couche dans une tuile : un par cellule du monde de côté `cell`, désordre `jitter` (0 : centre,
 * 1 : n'importe où dans la cellule), graine `"<seed>/<layer>/<i>/<j>"`. `rng` sert à la suite des tirages de la
 * cellule (densité, modèle, cap…), toujours les mêmes pour une même cellule.
 */
export function* cellCandidates(seed: string, layer: string | number, cell: number, jitter: number, x0: number, z0: number, tile: number, axes: TileAxes = "xz"): Generator<{ i: number; j: number; x: number; z: number; rng: Rng }> {
  const c = Math.max(1e-3, cell);
  const i0 = Math.floor(x0 / c), i1 = Math.ceil((x0 + tile) / c);
  const j0 = axes === "x" ? 0 : Math.floor(z0 / c), j1 = axes === "x" ? 1 : Math.ceil((z0 + tile) / c);
  for (let i = i0; i < i1; i++)
    for (let j = j0; j < j1; j++) {
      const r = new Rng(hash32(`${seed}/${layer}/${i}/${j}`));
      const x = (i + 0.5 + (r.next() - 0.5) * jitter) * c;
      const z = axes === "x" ? z0 + (r.next() - 0.5) * jitter * c : (j + 0.5 + (r.next() - 0.5) * jitter) * c;
      if (x < x0 || x >= x0 + tile || (axes !== "x" && (z < z0 || z >= z0 + tile))) continue;
      yield { i, j, x, z, rng: r };
    }
}

/** Retouches d'une tuile : objets retirés, ajoutés, déplacés ; `t` = instant de la dernière retouche (ordre d'oubli). */
export type TileEditsLike = { remove?: unknown[]; add?: unknown[]; move?: Record<string, unknown>; t?: number };

/** Nombre de retouches d'une tuile (chaque retrait, ajout ou déplacement compte pour un). */
export function editCount(e: TileEditsLike | undefined | null): number {
  if (!e || typeof e !== "object") return 0;
  return (Array.isArray(e.remove) ? e.remove.length : 0) + (Array.isArray(e.add) ? e.add.length : 0) + (e.move && typeof e.move === "object" ? Object.keys(e.move).length : 0);
}

/**
 * Borne le total des retouches à `total` : les tuiles les plus éloignées de (ccx, ccz) sont oubliées d'abord (à
 * distance égale, la plus anciennement retouchée) ; `keep` (la tuile qu'on vient de retoucher) n'est jamais oubliée,
 * quitte à être tronquée à `total` (ses retouches les plus anciennes partent). Renvoie un nouvel objet et les clés
 * oubliées.
 */
export function boundEdits<E extends TileEditsLike>(edits: Record<string, E>, total: number, ccx: number, ccz: number, keep?: string): { edits: Record<string, E>; dropped: string[]; count: number } {
  const T = Math.max(0, Math.floor(total));
  const keys = Object.keys(edits).filter((k) => editCount(edits[k]) > 0 && parseTileKey(k));
  const dist = (k: string) => {
    const p = parseTileKey(k)!;
    return Math.hypot(p[0] - ccx, p[1] - ccz);
  };
  // les plus précieuses d'abord : la tuile gardée, puis les plus proches, puis les plus récentes
  keys.sort((a, b) => (a === keep ? -1 : b === keep ? 1 : dist(a) - dist(b) || (Number(edits[b].t) || 0) - (Number(edits[a].t) || 0)));
  const out: Record<string, E> = {};
  const dropped: string[] = [];
  let count = 0;
  for (const k of keys) {
    const n = editCount(edits[k]);
    if (count + n <= T) {
      out[k] = edits[k];
      count += n;
    } else if (k === keep && T > 0) {
      out[k] = truncateEdits(edits[k], T - count);
      count += editCount(out[k]);
    } else dropped.push(k);
  }
  return { edits: out, dropped, count };
}

/** Garde au plus `n` retouches d'une tuile (les plus récentes : fin des listes). */
function truncateEdits<E extends TileEditsLike>(e: E, n: number): E {
  let left = Math.max(0, n);
  const out = { ...e };
  const moveKeys = e.move ? Object.keys(e.move) : [];
  const take = <T>(a: T[]): T[] => {
    const k = Math.min(a.length, left);
    left -= k;
    return k ? a.slice(a.length - k) : [];
  };
  if (e.move) {
    const keep = take(moveKeys);
    out.move = Object.fromEntries(keep.map((k) => [k, e.move![k]]));
  }
  if (Array.isArray(e.add)) out.add = take(e.add);
  if (Array.isArray(e.remove)) out.remove = take(e.remove);
  return out;
}
