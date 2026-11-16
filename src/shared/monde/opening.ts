/**
 * Glisser d'une ouverture (porte, fenêtre) le long des bords de l'espace : seules celles de `monde.ouvertures` bougent
 * (voir espace.ts). Le point visé est ramené sur le bord le plus proche (ou celui donné), au pas de la grille, sans
 * dépasser du bord ni chevaucher une autre ouverture. Fonctions pures, en mètres (sauf `at` : unité du document).
 */
import type { EspaceEdge, EspaceOpening } from "./espace";

type V3 = [number, number, number];

export type OpeningSlide = {
  /** Position (mètres) et cap (radians) de la menuiserie, `y` inchangé. */
  x: number;
  z: number;
  ry: number;
  /** Ce que `$mondePlace` recopie dans `monde.ouvertures[index]`. */
  ouverture: { index: number; bord: number; at: number };
};

type Ctx = { edges: EspaceEdge[]; openings: Record<string, EspaceOpening>; unit: number };

/** Distance du point (x, z) au segment du bord (mètres). */
function distTo(e: EspaceEdge, x: number, z: number): number {
  const c = Math.max(-e.L / 2, Math.min(e.L / 2, (x - e.m[0]) * e.l[0] + (z - e.m[1]) * e.l[1]));
  return Math.hypot(x - (e.m[0] + e.l[0] * c), z - (e.m[1] + e.l[1] * c));
}

/**
 * Pose de l'ouverture `name` au point (x, z) ; `bord` : bord imposé (rayon qui touche ce mur). `null` : ouverture
 * fixe ou inconnue, ou aucune place sur ce bord.
 */
export function slideOpening(m: Ctx, name: string, x: number, z: number, bord?: number, grid = 0.05): OpeningSlide | null {
  const me = Object.prototype.hasOwnProperty.call(m.openings, name) ? m.openings[name] : null;
  if (!me || me.index < 0 || !m.edges.length) return null;
  const e = bord !== undefined ? m.edges.find((q) => q.bord === bord) : m.edges.reduce((a, q) => (distTo(q, x, z) < distTo(a, x, z) ? q : a));
  if (!e) return null;
  const u = m.unit;
  const L = e.L / u, w = me.w, step = grid > 0 ? grid / u : 0;
  if (w > L) return null;
  const snap = (v: number) => (step ? Math.round(v / step) * step : v);
  const clamp = (v: number) => Math.max(w / 2, Math.min(L - w / 2, v));
  const others = Object.entries(m.openings).filter(([n, o]) => n !== name && o.bord === e.bord);
  const free = (at: number) => at >= w / 2 - 1e-6 && at <= L - w / 2 + 1e-6 && !others.some(([, o]) => Math.abs(o.at - at) < (o.w + w) / 2 - 1e-6);
  let at = clamp(snap(((x - e.m[0]) * e.l[0] + (z - e.m[1]) * e.l[1] + e.L / 2) / u));
  // dans une autre ouverture : contre elle, du côté le plus proche
  if (!free(at)) {
    const cands = others.flatMap(([, o]) => [o.at - (o.w + w) / 2, o.at + (o.w + w) / 2]).filter(free);
    if (!cands.length) return null;
    at = cands.reduce((a, c) => (Math.abs(c - at) < Math.abs(a - at) ? c : a));
  }
  const c = at * u - e.L / 2;
  return {
    x: e.m[0] + e.l[0] * c + e.n[0] * e.inset,
    z: e.m[1] + e.l[1] * c + e.n[1] * e.inset,
    ry: e.yaw + (me.reversed ? Math.PI : 0),
    ouverture: { index: me.index, bord: e.bord, at: Math.round(at * 1e4) / 1e4 },
  };
}

/**
 * Bord touché par un rayon (mètres), vu de l'intérieur : les murs dont on voit le dos (de dehors, transparents) sont
 * traversés. `null` : aucun mur sous le rayon.
 */
export function edgeUnderRay(edges: EspaceEdge[], o: V3, d: V3): { x: number; z: number; bord: number } | null {
  let best: { x: number; z: number; bord: number; t: number } | null = null;
  for (const e of edges) {
    const den = d[0] * e.n[0] + d[2] * e.n[1];
    if (den >= -1e-6) continue;
    const px = e.m[0] + e.n[0] * e.inset, pz = e.m[1] + e.n[1] * e.inset;
    const t = ((px - o[0]) * e.n[0] + (pz - o[2]) * e.n[1]) / den;
    if (t <= 0 || (best && t >= best.t)) continue;
    const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
    if (Math.abs((x - px) * e.l[0] + (z - pz) * e.l[1]) > e.L / 2 || y < -0.05 || y > e.height + 0.05) continue;
    best = { x, z, bord: e.bord, t };
  }
  return best && { x: best.x, z: best.z, bord: best.bord };
}
