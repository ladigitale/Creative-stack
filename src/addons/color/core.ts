/**
 * Harmonies de couleurs calculées en OKLCH (espace perceptif : à clarté L égale, les teintes paraissent
 * aussi claires). Fonctions pures.
 */

export type Oklch = { l: number; c: number; h: number };

/** Règles d'harmonie : décalages de teinte (°) autour de la teinte de base. */
export const HARMONY_RULES = ["mono", "analogous", "complementary", "split", "triadic", "tetradic", "square"] as const;
export type HarmonyRule = (typeof HARMONY_RULES)[number];

export const MAX_COLORS = 12;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const mod360 = (h: number) => ((h % 360) + 360) % 360;

/* ------------------------------------------------------------ conversions sRGB ↔ OKLab ↔ OKLCH */

const toLinear = (u: number) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
const toGamma = (u: number) => (u <= 0.0031308 ? 12.92 * u : 1.055 * u ** (1 / 2.4) - 0.055);

/** `#rgb` ou `#rrggbb` → [r, g, b] 0..1, sinon `null`. */
export function parseHex(hex: unknown): [number, number, number] | null {
  if (typeof hex !== "string") return null;
  let s = hex.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255) as [number, number, number];
}

export function toHex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((u) => Math.round(clamp(u, 0, 1) * 255).toString(16).padStart(2, "0")).join("");
}

export function rgbToOklch([r, g, b]: [number, number, number]): Oklch {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  return { l: L, c: Math.hypot(A, B), h: mod360((Math.atan2(B, A) * 180) / Math.PI) };
}

/** OKLCH → sRGB linéaire non borné (peut sortir de [0, 1] : hors gamut). */
function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180), b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: number[]) => rgb.every((u) => u >= -1e-4 && u <= 1 + 1e-4);

/** OKLCH → hex sRGB ; hors gamut, la saturation (chroma) baisse jusqu'à rentrer, teinte et clarté gardées. */
export function oklchToHex(o: Oklch): string {
  const l = clamp(o.l, 0, 1);
  let lo = 0, hi = Math.max(0, o.c);
  if (inGamut(oklchToLinear({ l, c: hi, h: o.h }))) lo = hi;
  else for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inGamut(oklchToLinear({ l, c: mid, h: o.h }))) lo = mid; else hi = mid; }
  return toHex(oklchToLinear({ l, c: lo, h: o.h }).map(toGamma) as [number, number, number]);
}

/* ------------------------------------------------------------ harmonies */

/** Décalages de teinte d'une règle (`spread` : écart de l'analogue et de la complémentaire divisée, °). */
export function hueOffsets(rule: HarmonyRule, spread = 30): number[] {
  const s = clamp(spread, 5, 90);
  switch (rule) {
    case "mono": return [0];
    case "analogous": return [0, -s, s, -2 * s, 2 * s];
    case "complementary": return [0, 180];
    case "split": return [0, 180 - s, 180 + s];
    case "triadic": return [0, 120, 240];
    case "tetradic": return [0, 2 * s, 180, 180 + 2 * s];
    case "square": return [0, 90, 180, 270];
  }
}

export function sanitizeRule(v: unknown, fallback: HarmonyRule = "complementary"): HarmonyRule {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  const alias: Record<string, HarmonyRule> = { monochrome: "mono", analogue: "analogous", complementaire: "complementary", "split-complementary": "split", triad: "triadic", triade: "triadic", rectangle: "tetradic", carre: "square" };
  if ((HARMONY_RULES as readonly string[]).includes(s)) return s as HarmonyRule;
  return alias[s] ?? fallback;
}

export type PaletteOptions = {
  base: string;
  rule: HarmonyRule;
  /** Nombre de couleurs (1..12). Défaut : le nombre de teintes de la règle (5 en monochrome). */
  count?: number;
  /** Écart des teintes voisines (analogue, divisée, rectangle), en degrés. */
  spread?: number;
  /** Écart de clarté entre les nuances d'une même teinte (0,04..0,4). */
  step?: number;
};

export type PaletteColor = { hex: string; hue: number; l: number; c: number; role: "base" | "harmony" | "shade" | "custom" };

/** Couleurs d'une palette libre (`#rrggbb`), dédoublonnées, au plus `MAX_COLORS` : liste JSON, tableau ou `a, b, c`. */
export function parseColorList(v: unknown): string[] {
  let list: unknown = v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("[")) { try { list = JSON.parse(t); } catch { list = []; } } else list = t.split(/[\s,;]+/);
  }
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const x of list) {
    const rgb = parseHex(x);
    if (!rgb) continue;
    const hex = toHex(rgb);
    if (!out.includes(hex)) out.push(hex);
    if (out.length >= MAX_COLORS) break;
  }
  return out;
}

/** Palette libre : les couleurs données telles quelles, éventuellement tournées de `shift` degrés de teinte (OKLCH). */
export function customPalette(colors: string[], shift = 0): PaletteColor[] {
  return parseColorList(colors).map((hex) => {
    const o = rgbToOklch(parseHex(hex)!);
    const t = shift ? { ...o, h: mod360(o.h + shift) } : o;
    return { hex: shift ? oklchToHex(t) : hex, hue: Math.round(t.h * 10) / 10, l: Math.round(t.l * 1000) / 1000, c: Math.round(t.c * 1000) / 1000, role: "custom" as const };
  });
}

/**
 * Palette d'une harmonie : d'abord les teintes de la règle à la clarté et à la saturation de la base, puis,
 * si l'on veut plus de couleurs, des nuances plus claires et plus sombres de ces teintes, en alternance.
 * Monochrome : uniquement des nuances de la teinte de base, réparties autour de sa clarté.
 */
export function harmony(opts: PaletteOptions): PaletteColor[] {
  const rgb = parseHex(opts.base) ?? [0.16, 0.36, 0.86];
  const base = rgbToOklch(rgb);
  // Gris : sans saturation, toutes les teintes se confondent ; on en garde un peu pour que la règle se voie.
  const c = Math.max(base.c, 0.04);
  const offsets = hueOffsets(opts.rule, opts.spread);
  const count = clamp(Math.round(opts.count ?? (opts.rule === "mono" ? 5 : offsets.length)), 1, MAX_COLORS);
  // Assez serré pour loger toutes les nuances d'une teinte entre le noir et le blanc.
  const perHue = Math.ceil(count / offsets.length);
  const step = Math.min(clamp(opts.step ?? 0.14, 0.04, 0.4), 0.8 / perHue);
  const out: PaletteColor[] = [];
  const push = (h: number, l: number, role: PaletteColor["role"]) => {
    const o = { l: clamp(l, 0.12, 0.97), c, h: mod360(h) };
    const hex = oklchToHex(o);
    out.push({ hex, hue: Math.round(o.h * 10) / 10, l: Math.round(o.l * 1000) / 1000, c: Math.round(o.c * 1000) / 1000, role });
  };
  for (let i = 0; i < Math.min(count, offsets.length); i++) push(base.h + offsets[i], base.l, i === 0 ? "base" : "harmony");
  // Nuances : ±1 pas, puis ±2 pas…, teinte après teinte ; la direction qui s'éloigne du bord passe d'abord.
  for (let k = 1; out.length < count && k < 40; k++) {
    for (const sign of base.l > 0.55 ? [-1, 1] : [1, -1]) {
      for (const off of offsets) {
        if (out.length >= count) break;
        const l = base.l + sign * k * step;
        if (l < 0.12 || l > 0.97) continue;
        push(base.h + off, l, "shade");
      }
    }
  }
  return out;
}
