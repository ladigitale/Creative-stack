/** Couleurs : OKLCH ⇄ sRGB, hex, mélanges. Toutes les palettes sont pensées en OKLCH (luminosité perçue). */

export type RGB = [number, number, number];
export type LCH = [number, number, number];

const srgbToLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function hexToRgb(hex: string): RGB {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return [1, 0, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function rgbToHex(c: RGB): string {
  return "#" + c.map((x) => Math.round(clamp01(x) * 255).toString(16).padStart(2, "0")).join("");
}

/** sRGB (0..1) → OKLCH [L 0..1, C, h en degrés]. */
export function rgbToOklch(c: RGB): LCH {
  const [r, g, b] = c.map(srgbToLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}
/** OKLCH → sRGB (0..1), chroma réduite si hors gamut. */
export function oklchToRgb([L, C, h]: LCH): RGB {
  let c = C;
  for (let it = 0; it < 12; it++) {
    const A = c * Math.cos((h * Math.PI) / 180);
    const B = c * Math.sin((h * Math.PI) / 180);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
    if ((r >= -1e-4 && r <= 1.0001 && g >= -1e-4 && g <= 1.0001 && b >= -1e-4 && b <= 1.0001) || c < 1e-4) return [linToSrgb(clamp01(r)), linToSrgb(clamp01(g)), linToSrgb(clamp01(b))];
    c *= 0.85;
  }
  return [L, L, L];
}
export const hexToOklch = (h: string) => rgbToOklch(hexToRgb(h));
export const oklchToHex = (c: LCH) => rgbToHex(oklchToRgb(c));

/** sRGB → linéaire (pour le shader). */
export const toLinear = (c: RGB): RGB => [srgbToLin(c[0]), srgbToLin(c[1]), srgbToLin(c[2])];

/** Mélange en OKLCH (chemin de teinte le plus court). */
export function mixLch(a: LCH, b: LCH, t: number): LCH {
  let dh = b[2] - a[2];
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (a[2] + dh * t + 360) % 360];
}
