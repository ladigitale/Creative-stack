/**
 * Recherche de la place libre la plus proche, commune aux rangements de `sonic-3d` (format monde, shared/monde/arrange)
 * et de `sonic-procgen` (procgen/edit/arrange) : géométrie pure, sans rendu.
 *
 * - `searchFree` parcourt des « sources » de déplacement (glisser au sol, le long d'un mur, autres murs…) par anneaux
 *   croissants (`step` jusqu'à `max`) et 16 directions, et rend la première pose acceptée par `ok`.
 * - `Rect2` est une emprise au sol (rectangle orienté) ; `rectPenetration` mesure le recouvrement de deux emprises
 *   (axes séparateurs en 2D).
 */

/** Déplacement candidat : distance `d` dans la direction `dir` (0…dirs-1) ; `null` si la source ne sait pas. */
export type SlideSource<P> = (d: number, dir: number) => P | null;

export type SearchOptions = {
  /** Pas des anneaux (défaut 0,05). */
  step?: number;
  /** Distance maximale (défaut 1,5). */
  max?: number;
  /** Nombre de directions par anneau (défaut 16). */
  dirs?: number;
};

/** Première pose libre, source par source puis anneau par anneau ; `null` si aucune. `index` : rang de la source. */
export function searchFree<P>(sources: SlideSource<P>[], ok: (p: P) => boolean, opt: SearchOptions = {}): { pose: P; index: number; d: number } | null {
  const step = opt.step ?? 0.05, max = opt.max ?? 1.5, dirs = opt.dirs ?? 16;
  for (let i = 0; i < sources.length; i++)
    for (let d = step; d <= max + 1e-9; d += step)
      for (let dir = 0; dir < dirs; dir++) {
        const cand = sources[i](d, dir);
        if (cand && ok(cand)) return { pose: cand, index: i, d };
      }
  return null;
}

/** Emprise au sol : centre, demi-largeur (axe x local), demi-profondeur (axe z local), cap (radians, avant = +z local). */
export type Rect2 = { x: number; z: number; hx: number; hz: number; yaw: number };

/** Axes du rectangle dans le monde : x local → (cos, -sin), z local → (sin, cos) (rotation autour de y). */
export function rectAxes(r: Rect2): [[number, number], [number, number]] {
  const c = Math.cos(r.yaw), s = Math.sin(r.yaw);
  return [
    [c, -s],
    [s, c],
  ];
}

/** Quatre coins (monde). */
export function rectCorners(r: Rect2): [number, number][] {
  const [ax, az] = rectAxes(r);
  return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => [r.x + ax[0] * a * r.hx + az[0] * b * r.hz, r.z + ax[1] * a * r.hx + az[1] * b * r.hz] as [number, number]);
}

/** Rayon englobant. */
export function rectRadius(r: Rect2): number {
  return Math.hypot(r.hx, r.hz);
}

/** Recouvrement de deux emprises (mètres) : 0 si un axe les sépare, sinon la plus petite profondeur sur les 4 axes. */
export function rectPenetration(a: Rect2, b: Rect2): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  if (Math.hypot(dx, dz) > rectRadius(a) + rectRadius(b)) return 0;
  const A = rectAxes(a), B = rectAxes(b);
  let min = Infinity;
  for (const l of [A[0], A[1], B[0], B[1]]) {
    const ra = Math.abs(A[0][0] * l[0] + A[0][1] * l[1]) * a.hx + Math.abs(A[1][0] * l[0] + A[1][1] * l[1]) * a.hz;
    const rb = Math.abs(B[0][0] * l[0] + B[0][1] * l[1]) * b.hx + Math.abs(B[1][0] * l[0] + B[1][1] * l[1]) * b.hz;
    const d = ra + rb - Math.abs(dx * l[0] + dz * l[1]);
    if (d <= 0) return 0;
    if (d < min) min = d;
  }
  return min;
}

/** Point dans le repère du rectangle (x local, z local). */
export function toRect(r: Rect2, x: number, z: number): [number, number] {
  const [ax, az] = rectAxes(r);
  const dx = x - r.x, dz = z - r.z;
  return [dx * ax[0] + dz * ax[1], dx * az[0] + dz * az[1]];
}

/** Point du repère du rectangle vers le monde. */
export function fromRect(r: Rect2, lx: number, lz: number): [number, number] {
  const [ax, az] = rectAxes(r);
  return [r.x + ax[0] * lx + az[0] * lz, r.z + ax[1] * lx + az[1] * lz];
}

/** Écart de deux caps ramené à [0, π/4] modulo le quart de tour : 0 = côtés parallèles. */
export function quarterGap(a: number, b: number): number {
  const q = Math.PI / 2;
  const d = (((a - b) % q) + q) % q;
  return Math.min(d, q - d);
}
