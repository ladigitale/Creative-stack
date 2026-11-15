/**
 * Stabilité de l'affichage, en fonctions pures (testables sans WebGL) :
 * - `syncView` : quand ré-appliquer la vue (la vue de l'utilisateur survit aux recompositions) ;
 * - `governDpr` : densité de pixels adaptée à la charge, avec hystérésis (pas d'oscillation, donc pas de
 *   redimensionnements à répétition) ;
 * - `keepFrame` : cadrage conservé tant qu'une recomposition ne change pas beaucoup la taille de la scène.
 */

type Json = Record<string, unknown>;

export type ViewSync = { key: string; modelKey: string };

/**
 * Entrée de vue = `model.view` (recette) + attribut `camera` + `d.view` (DataProvider). Rien n'est ré-appliqué tant
 * que cette entrée ne change pas : orbite, pan et zoom de l'utilisateur sont conservés quand la recette est recomposée
 * (objet déplacé, paramètre changé). `reset` : la vue de la recette (ou la caméra imposée) a changé, on repart de la
 * vue par défaut au lieu de fusionner avec la vue courante.
 */
export function syncView(prev: ViewSync, modelView: unknown, camera: string | null, dView: unknown): { next: ViewSync; apply: Json | null; reset: boolean } {
  const mv = modelView && typeof modelView === "object" ? (modelView as Json) : {};
  const dv = dView && typeof dView === "object" ? (dView as Json) : {};
  const vIn: Json = { ...mv, ...(camera ? { camera } : {}), ...dv };
  const key = JSON.stringify(vIn);
  const modelKey = JSON.stringify([mv, camera ?? null]);
  if (key === prev.key) return { next: prev, apply: null, reset: false };
  return { next: { key, modelKey }, apply: vIn, reset: prev.key !== "" && modelKey !== prev.modelKey };
}

export type Governor = { times: number[]; lastChange: number; lastDrop: number; goodSince: number };

export const newGovernor = (): Governor => ({ times: [], lastChange: -Infinity, lastDrop: -Infinity, goodSince: -Infinity });

/** Réglages du régulateur (secondes). */
export const GOV = { window: 30, low: 1 / 40, high: 1 / 58, msHigh: 8, gap: 3, holdAfterDrop: 10, stable: 4, step: 0.25, min: 0.75 };

/**
 * Densité de pixels suivante (modifie `g`). `dt` : durée de l'image (s), `ms` : temps de rendu (ms), `now` : horloge (s).
 * Baisse si la moyenne sur 30 images passe sous 40 i/s ; remonte seulement si tout est fluide depuis `stable` s,
 * jamais dans les `holdAfterDrop` s qui suivent une baisse, et au plus un changement toutes les `gap` s.
 */
export function governDpr(g: Governor, dpr: number, maxDpr: number, dt: number, ms: number, now: number): number {
  g.times.push(dt);
  if (g.times.length > GOV.window) g.times.shift();
  const good = dt < 1 / 50 && ms < GOV.msHigh;
  if (!good) g.goodSince = Infinity;
  else if (!Number.isFinite(g.goodSince)) g.goodSince = now;
  if (g.times.length < GOV.window || now - g.lastChange < GOV.gap) return dpr;
  const avg = g.times.reduce((s, x) => s + x, 0) / g.times.length;
  if (avg > GOV.low && dpr > GOV.min) {
    g.times = [];
    g.lastChange = g.lastDrop = now;
    g.goodSince = Infinity;
    return Math.max(GOV.min, dpr - GOV.step);
  }
  if (avg < GOV.high && ms < GOV.msHigh && dpr < maxDpr && now - g.lastDrop >= GOV.holdAfterDrop && now - g.goodSince >= GOV.stable) {
    g.times = [];
    g.lastChange = now;
    g.goodSince = now;
    return Math.min(maxDpr, dpr + GOV.step);
  }
  return dpr;
}

/** Garde l'ancienne taille de cadrage tant que la nouvelle reste proche (±50 %) : pas de saut de zoom à la recomposition. */
export function keepFrame(prev: number | null, next: number): number {
  if (prev === null || !(prev > 0) || !(next > 0)) return next;
  const r = next / prev;
  return r > 1 / 1.5 && r < 1.5 ? prev : next;
}
