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
