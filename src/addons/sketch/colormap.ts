import { quantize, type Rgba } from "./flat-color";
import { oklab } from "./select";

/**
 * Conversion des couleurs d'un dessin vers une palette. Fonctions pures, calculs en OKLab (perceptuel) :
 * - `nearest` : chaque couleur devient la couleur de la palette la plus proche (restreindre à la palette) ;
 * - `levels` : les couleurs sont rangées par clarté et réparties sur la palette rangée de même (carte de
 *   dégradé en paliers : l'ordre des valeurs est gardé, chaque palier prend une couleur de la palette) ;
 * - `gradient` : la clarté relative choisit une position sur le dégradé continu de la palette (interpolée en
 *   OKLab), d'où des couleurs intermédiaires ;
 * `amount` (0..1) mélange la couleur d'origine et la cible (1 = cible pleine).
 */
export type ColorMapMode = "nearest" | "levels" | "gradient";
export const COLOR_MAP_MODES: readonly ColorMapMode[] = ["nearest", "levels", "gradient"];

type Lab = [number, number, number];

const fromLinear = (u: number) => (u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055);

/** OKLab → sRGB (0..1, borné). */
export function fromOklab([L, a, b]: Lab, alpha = 1): Rgba {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const c = (v: number) => Math.min(1, Math.max(0, fromLinear(v)));
  return [c(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), c(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), c(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s), alpha];
}

const mixLab = (p: Lab, q: Lab, t: number): Lab => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
const dist2 = (p: Lab, q: Lab) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;

/**
 * Table de conversion pour un ensemble de couleurs (clé = `rgba.join(",")`) : calcule la cible de chaque
 * couleur selon le mode. Les modes par clarté s'appuient sur l'étendue de clarté des couleurs données.
 */
export function colorMap(colors: Rgba[], palette: Rgba[], mode: ColorMapMode, amount = 1): Map<string, Rgba> {
  const out = new Map<string, Rgba>();
  const pal = palette.filter((c) => c[3] > 0).map((c) => ({ c, lab: oklab(c) as Lab }));
  if (!pal.length || !colors.length) return out;
  const k = Math.min(1, Math.max(0, amount));
  const uniq = new Map<string, Rgba>();
  for (const c of colors) uniq.set(c.join(","), c);
  const labs = [...uniq.entries()].map(([key, c]) => ({ key, c, lab: oklab(c) as Lab }));
  const sortedPal = [...pal].sort((x, y) => x.lab[0] - y.lab[0]);
  let lo = Infinity, hi = -Infinity;
  for (const x of labs) { lo = Math.min(lo, x.lab[0]); hi = Math.max(hi, x.lab[0]); }
  const span = hi - lo;
  // Rang de clarté (paliers) : l'ordre des couleurs distinctes, réparti sur la palette.
  const byL = [...labs].sort((x, y) => x.lab[0] - y.lab[0]);
  const rank = new Map(byL.map((x, i) => [x.key, byL.length > 1 ? i / (byL.length - 1) : 0.5]));
  for (const x of labs) {
    let target: Lab;
    let exact: Rgba | null = null;
    if (mode === "nearest") {
      let best = pal[0], bd = Infinity;
      for (const p of pal) { const d = dist2(x.lab, p.lab); if (d < bd) { bd = d; best = p; } }
      target = best.lab;
      exact = best.c;
    } else {
      const t = mode === "levels" ? rank.get(x.key)! : span > 1e-6 ? (x.lab[0] - lo) / span : 0.5;
      if (mode === "levels" || sortedPal.length === 1) {
        const p = sortedPal[Math.min(sortedPal.length - 1, Math.round(t * (sortedPal.length - 1)))];
        target = p.lab;
        exact = p.c;
      } else {
        const f = t * (sortedPal.length - 1), i = Math.min(sortedPal.length - 2, Math.floor(f));
        target = mixLab(sortedPal[i].lab, sortedPal[i + 1].lab, f - i);
      }
    }
    // Cible pleine et couleur de la palette : la vraie couleur, sans aller-retour OKLab.
    if (k >= 1 && exact) { out.set(x.key, quantize([exact[0], exact[1], exact[2], x.c[3]])); continue; }
    const lab = k >= 1 ? target : mixLab(x.lab, target, k);
    out.set(x.key, quantize(fromOklab(lab, x.c[3])));
  }
  return out;
}

/**
 * Couleurs dominantes d'un dessin (échantillonnage pour une palette) : `entries` = couleurs pondérées (surface
 * des aplats, encre des traits). Les couleurs proches de `exclude` (le papier) sont écartées ; les autres sont
 * regroupées en OKLab (fusion de Ward : on réunit à chaque pas les deux groupes qu'il coûte le moins de
 * confondre) jusqu'à `n` groupes. Chaque groupe garde sa couleur réelle la plus présente (pas une moyenne :
 * la palette reprend des couleurs du dessin). Résultat rangé du groupe le plus présent au moins présent.
 */
export function samplePalette(entries: { rgba: Rgba; weight: number }[], n: number, exclude: Rgba[] = []): Rgba[] {
  const count = Math.max(1, Math.min(12, Math.round(n) || 1));
  const ex = exclude.map((c) => oklab(c));
  type Group = { lab: Lab; w: number; best: { rgba: Rgba; w: number } };
  const byKey = new Map<string, { rgba: Rgba; w: number }>();
  for (const { rgba, weight } of entries) {
    if (!(weight > 0) || rgba[3] < 0.05) continue;
    const c = quantize([rgba[0], rgba[1], rgba[2], 1]);
    const k = c.join(",");
    const e = byKey.get(k);
    if (e) e.w += weight * rgba[3];
    else byKey.set(k, { rgba: c, w: weight * rgba[3] });
  }
  let groups: Group[] = [...byKey.values()]
    .filter((e) => !ex.some((x) => dist2(x, oklab(e.rgba)) < 0.02 ** 2))
    .sort((a, b) => b.w - a.w)
    .map((e) => ({ lab: oklab(e.rgba), w: e.w, best: { rgba: e.rgba, w: e.w } }));
  if (!groups.length) return [];
  // Beaucoup de couleurs (nuances de fusion, dégradés) : les moins présentes rejoignent d'abord la plus proche.
  const MAX = 96;
  if (groups.length > MAX) {
    const head = groups.slice(0, MAX);
    for (const g of groups.slice(MAX)) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < head.length; i++) { const d = dist2(head[i].lab, g.lab); if (d < bd) { bd = d; bi = i; } }
      const h = head[bi], w = h.w + g.w;
      h.lab = mixLab(h.lab, g.lab, g.w / w);
      h.w = w;
    }
    groups = head;
  }
  while (groups.length > count) {
    let bi = 0, bj = 1, bc = Infinity;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i], b = groups[j];
        const cost = ((a.w * b.w) / (a.w + b.w)) * dist2(a.lab, b.lab);
        if (cost < bc) { bc = cost; bi = i; bj = j; }
      }
    }
    const a = groups[bi], b = groups[bj], w = a.w + b.w;
    groups[bi] = { lab: mixLab(a.lab, b.lab, b.w / w), w, best: a.best.w >= b.best.w ? a.best : b.best };
    groups.splice(bj, 1);
  }
  return groups.sort((a, b) => b.w - a.w).map((g) => g.best.rgba);
}
