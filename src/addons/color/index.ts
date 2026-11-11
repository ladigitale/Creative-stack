/** Addon color : palettes d'harmonie (théorie des couleurs) calculées en OKLCH, pastilles cliquables. */
export { SonicPalette, type PaletteRule, type PaletteState } from "./palette";
export {
  HARMONY_RULES, MAX_COLORS, customPalette, harmony, parseColorList, hueOffsets, oklchToHex, parseHex, rgbToOklch, sanitizeRule, toHex,
  type HarmonyRule, type Oklch, type PaletteColor, type PaletteOptions,
} from "./core";
