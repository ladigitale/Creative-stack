/**
 * Thème d'interface dérivé d'une seule couleur de fond (fonctions pures, OKLCH + contraste WCAG).
 *
 * Le fond choisi est ramené dans la plage de son mode (sombre : clarté 0,12..0,30 ; clair : 0,92..0,975) et
 * sa saturation est plafonnée, pour qu'aucun fond ne rende le texte illisible. Tout le reste en découle :
 * - texte : teinte du fond, clarté poussée jusqu'à un contraste d'au moins 7:1 (AAA) ;
 * - accents : harmonie de la teinte du fond (`split` par défaut : ±150°), clarté poussée jusqu'à 4,5:1 sur le
 *   fond, et texte des boutons choisi pour au moins 4,5:1 sur l'accent ;
 * - états (info, succès, alerte, danger) : teintes fixes, mêmes contrôles de contraste ;
 * - échelle `--sc-base-50..900` : du fond vers le texte, interpolée en OKLCH.
 */
import { oklchToHex, parseHex, rgbToOklch, type Oklch } from "./core";

export type ThemeMode = "dark" | "light";
export type ThemeRule = "split" | "complementary" | "analogous" | "triadic";
export const THEME_RULES: readonly ThemeRule[] = ["split", "complementary", "analogous", "triadic"];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const mod360 = (h: number) => ((h % 360) + 360) % 360;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lin = (u: number) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);

/** Luminance relative WCAG d'un `#rrggbb` (0 si invalide). */
export function luminance(hex: string): number {
  const c = parseHex(hex);
  if (!c) return 0;
  const [r, g, b] = c.map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Rapport de contraste WCAG entre deux couleurs (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** La couleur, éclaircie (`dir` 1) ou assombrie (`dir` −1) par pas de 0,01 de clarté jusqu'au contraste voulu sur `bg`. */
function reach(o: Oklch, bg: string, min: number, dir: 1 | -1): string {
  let l = o.l;
  for (let i = 0; i < 100 && l >= 0 && l <= 1; i++, l += dir * 0.01) {
    const hex = oklchToHex({ ...o, l });
    if (contrastRatio(hex, bg) >= min) return hex;
  }
  return dir > 0 ? "#ffffff" : "#000000";
}

/** Texte lisible (au moins `min`) sur `bg` : un presque noir ou un presque blanc teinté, sinon noir ou blanc. */
function readable(bg: string, hue: number, min: number): string {
  const dark = oklchToHex({ l: 0.16, c: 0.02, h: hue });
  const light = oklchToHex({ l: 0.98, c: 0.01, h: hue });
  const best = contrastRatio(dark, bg) >= contrastRatio(light, bg) ? dark : light;
  if (contrastRatio(best, bg) >= min) return best;
  return contrastRatio("#000000", bg) >= contrastRatio("#ffffff", bg) ? "#000000" : "#ffffff";
}

const HUE_OFFSETS: Record<ThemeRule, [number, number]> = { split: [150, -150], complementary: [180, 150], analogous: [30, -30], triadic: [120, 240] };
const STATUS_HUES = { info: 230, success: 145, warning: 85, danger: 25 } as const;
const SCALE: [number, number][] = [[50, 6], [100, 12], [200, 22], [300, 35], [400, 50], [500, 62], [600, 74], [700, 84], [800, 92], [900, 96]];

export function sanitizeMode(v: unknown): ThemeMode | undefined {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "light" || s === "clair") return "light";
  if (s === "dark" || s === "sombre") return "dark";
  return undefined;
}

export function sanitizeThemeRule(v: unknown, fallback: ThemeRule = "split"): ThemeRule {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (THEME_RULES as readonly string[]).includes(s) ? (s as ThemeRule) : fallback;
}

export type ThemeOptions = { base?: unknown; mode?: unknown; rule?: unknown };

export type Theme = {
  mode: ThemeMode;
  /** Fond effectif (le choix, ramené dans la plage du mode). */
  base: string;
  /** Variables `--sc-*` et `color-scheme`, valeurs `#rrggbb`. */
  vars: Record<string, string>;
  /** Contrastes obtenus : texte / fond, accent / fond, texte d'accent / accent. */
  ratios: { text: number; primary: number; onPrimary: number };
};

/** Thème complet depuis un fond (`#rrggbb`, sinon un fond par défaut du mode), un mode (`dark` | `light`, sinon selon la clarté du fond) et une règle d'harmonie. */
export function deriveTheme(opts: ThemeOptions = {}): Theme {
  const given = parseHex(opts.base) ? rgbToOklch(parseHex(opts.base)!) : null;
  const mode: ThemeMode = sanitizeMode(opts.mode) ?? (given && given.l > 0.6 ? "light" : "dark");
  const dark = mode === "dark";
  const dir: 1 | -1 = dark ? 1 : -1;
  const src: Oklch = given ?? { l: dark ? 0.2 : 0.96, c: 0.05, h: 300 };
  const grey = src.c < 0.015;
  const hue = grey ? 270 : src.h;
  const bo: Oklch = { l: dark ? clamp(src.l, 0.12, 0.3) : clamp(src.l, 0.92, 0.975), c: Math.min(src.c, dark ? 0.09 : 0.05), h: hue };
  const base = oklchToHex(bo);
  const co: Oklch = { l: dark ? 0.97 : 0.2, c: Math.min(bo.c, 0.03), h: hue };
  const content = reach(co, base, 7, dir);
  const cOk = rgbToOklch(parseHex(content)!);

  const [o1, o2] = HUE_OFFSETS[sanitizeThemeRule(opts.rule)];
  const accent = (h: number) => reach({ l: dark ? 0.74 : 0.5, c: 0.17, h }, base, 4.5, dir);
  const primary = accent(mod360(hue + o1));
  const secondary = accent(mod360(hue + o2));
  const vars: Record<string, string> = {
    "color-scheme": mode,
    "--sc-base": base,
    "--sc-base-content": content,
    "--sc-primary": primary,
    "--sc-primary-content": readable(primary, hue, 4.5),
    "--sc-secondary": secondary,
    "--sc-secondary-content": readable(secondary, hue, 4.5),
  };
  for (const [name, h] of Object.entries(STATUS_HUES)) {
    const c = reach({ l: dark ? 0.78 : 0.5, c: 0.15, h }, base, 3, dir);
    vars[`--sc-${name}`] = c;
    vars[`--sc-${name}-content`] = readable(c, h, 4.5);
  }
  for (const [n, pct] of SCALE) {
    const t = pct / 100;
    vars[`--sc-base-${n}`] = oklchToHex({ l: lerp(bo.l, cOk.l, t), c: lerp(bo.c, cOk.c, t), h: hue });
  }
  return {
    mode, base, vars,
    ratios: {
      text: contrastRatio(content, base),
      primary: contrastRatio(primary, base),
      onPrimary: contrastRatio(vars["--sc-primary-content"], primary),
    },
  };
}
