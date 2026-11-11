import type { BlendMode } from "../paint/brush";

/**
 * Couleurs d'aplat : calcul exact d'un mode de fusion entre deux couleurs unies (W3C Compositing and Blending
 * Level 1), pour qu'une zone fusionnée devienne une vraie couleur. Fonctions pures.
 */

/** r, g, b, a dans 0..1. */
export type Rgba = [number, number, number, number];
type Rgb = [number, number, number];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Arrondi au 1/255 : deux calculs qui donnent la même couleur à l'écran donnent la même valeur (fusion des régions). */
const q = (v: number) => Math.round(clamp01(v) * 255) / 255;
export const quantize = (c: Rgba): Rgba => [q(c[0]), q(c[1]), q(c[2]), q(c[3])];

/** Couleur CSS → Rgba : #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba(), hsl()/hsla() ; autre chose → null. */
export function parseColor(input: unknown): Rgba | null {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
  }
  m = /^(rgb|hsl)a?\(([^)]*)\)$/.exec(s);
  if (!m) return null;
  const parts = m[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const num = (p: string, scale: number) => (p.endsWith("%") ? (parseFloat(p) / 100) * scale : parseFloat(p));
  const alpha = parts[3] !== undefined ? clamp01(num(parts[3], 1)) : 1;
  if (m[1] === "rgb") {
    const [r, g, b] = parts.slice(0, 3).map((p) => clamp01(num(p, 255) / 255));
    return [r, g, b, alpha].some((v) => Number.isNaN(v)) ? null : [r, g, b, alpha];
  }
  const h = (((parseFloat(parts[0]) % 360) + 360) % 360) / 360;
  const sat = clamp01(num(parts[1], 1)), l = clamp01(num(parts[2], 1));
  if ([h, sat, l, alpha].some((v) => Number.isNaN(v))) return null;
  const k = (n: number) => (n + h * 12) % 12;
  const a2 = sat * Math.min(l, 1 - l);
  const f = (n: number) => l - a2 * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4), alpha];
}

export function toCss([r, g, b, a]: Rgba): string {
  const h = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b) + (a < 0.999 ? h(a) : "");
}

/* ------------------------------------------------------------ modes séparables */

function sep(mode: BlendMode, b: number, s: number): number {
  switch (mode) {
    case "multiply": return b * s;
    case "screen": return b + s - b * s;
    case "overlay": return sep("hard-light", s, b);
    case "darken": return Math.min(b, s);
    case "lighten": return Math.max(b, s);
    case "color-dodge": return b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s));
    case "color-burn": return b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
    case "hard-light": return s <= 0.5 ? b * 2 * s : sep("screen", b, 2 * s - 1);
    case "soft-light": {
      if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
      const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
      return b + (2 * s - 1) * (d - b);
    }
    case "difference": return Math.abs(b - s);
    case "exclusion": return b + s - 2 * b * s;
    default: return s;
  }
}

/* ------------------------------------------------------------ modes non séparables */

const lum = ([r, g, b]: Rgb) => 0.3 * r + 0.59 * g + 0.11 * b;
function clipColor(c: Rgb): Rgb {
  const l = lum(c), n = Math.min(...c), x = Math.max(...c);
  let o = c.slice() as Rgb;
  if (n < 0) o = o.map((v) => l + ((v - l) * l) / (l - n)) as Rgb;
  if (x > 1) o = o.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as Rgb;
  return o;
}
const setLum = (c: Rgb, l: number): Rgb => { const d = l - lum(c); return clipColor([c[0] + d, c[1] + d, c[2] + d]); };
const satOf = (c: Rgb) => Math.max(...c) - Math.min(...c);
function setSat(c: Rgb, s: number): Rgb {
  const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const [lo, mid, hi] = idx;
  const o: Rgb = [0, 0, 0];
  if (c[hi] > c[lo]) {
    o[mid] = ((c[mid] - c[lo]) * s) / (c[hi] - c[lo]);
    o[hi] = s;
  }
  return o;
}

/** B(Cb, Cs) d'un mode de fusion. */
export function blendRgb(mode: BlendMode, cb: Rgb, cs: Rgb): Rgb {
  switch (mode) {
    case "hue": return setLum(setSat(cs, satOf(cb)), lum(cb));
    case "saturation": return setLum(setSat(cb, satOf(cs)), lum(cb));
    case "color": return setLum(cs, lum(cb));
    case "luminosity": return setLum(cb, lum(cs));
    default: return [sep(mode, cb[0], cs[0]), sep(mode, cb[1], cs[1]), sep(mode, cb[2], cs[2])];
  }
}

/**
 * Couleur posée `src` (opacité `alpha`, mode `mode`) sur un fond uni `back` (null : transparent).
 * Formule source-over avec fusion : Cm = (1 − ab)·Cs + ab·B(Cb, Cs) ; co = as·Cm + (1 − as)·ab·Cb ; ao = as + ab·(1 − as).
 */
export function composite(back: Rgba | null, src: Rgba, alpha: number, mode: BlendMode): Rgba {
  const as = clamp01(src[3] * alpha);
  const cs: Rgb = [src[0], src[1], src[2]];
  if (!back || back[3] <= 0) return quantize([cs[0], cs[1], cs[2], as]);
  const ab = back[3];
  const cb: Rgb = [back[0], back[1], back[2]];
  const B = blendRgb(mode, cb, cs);
  const ao = as + ab * (1 - as);
  if (ao <= 0) return [0, 0, 0, 0];
  const out = [0, 1, 2].map((i) => {
    const cm = (1 - ab) * cs[i] + ab * B[i];
    return (as * cm + (1 - as) * ab * cb[i]) / ao;
  });
  return quantize([out[0], out[1], out[2], ao]);
}

export const sameColor = (a: Rgba, b: Rgba): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

const hsl = ([r, g, b]: Rgba): [number, number, number] => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
};
const fromHsl = (h: number, s: number, l: number, a: number): Rgba => {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return quantize([r + m, g + m, b + m, a]);
};

/** Mots-clés de couleurs déduites d'une couleur de base (contours, accents). */
export const DERIVED_COLORS = ["darker", "lighter", "complement", "muted", "vivid", "black", "white"] as const;

/**
 * Couleur CSS, ou mot-clé déduit de `base` : `darker` / `lighter` (même teinte, plus sombre / plus claire),
 * `complement` (teinte opposée), `muted` (désaturée), `vivid` (saturée), `black`, `white`. Sinon `null`.
 */
export function deriveColor(spec: unknown, base: Rgba): Rgba | null {
  if (typeof spec !== "string") return null;
  const k = spec.trim().toLowerCase();
  const [h, s, l] = hsl(base);
  switch (k) {
    case "darker": return fromHsl(h, s, Math.max(0, l * 0.45), 1);
    case "lighter": return fromHsl(h, s, l + (1 - l) * 0.6, 1);
    case "complement": return fromHsl((h + 180) % 360, Math.max(s, 0.35), Math.min(0.75, Math.max(0.3, l)), 1);
    case "muted": return fromHsl(h, s * 0.3, l, 1);
    case "vivid": return fromHsl(h, Math.min(1, s * 1.6 + 0.2), Math.min(0.65, Math.max(0.35, l)), 1);
    case "black": return [0, 0, 0, 1];
    case "white": return [1, 1, 1, 1];
    default: return parseColor(k);
  }
}
