/** Addon color : palettes d'harmonie (théorie des couleurs) calculées en OKLCH, pastilles cliquables. */
export { SonicPalette, type PaletteRule, type PaletteState } from "./palette";
export { SonicPaletteEditor, type PaletteEditorState } from "./editor";
export {
  HARMONY_RULES, MAX_COLORS, customPalette, harmony, oklchToSrgb, suggestPalette, parseColorList, hueOffsets, oklchToHex, parseHex, rgbToOklch, sanitizeRule, toHex,
  type HarmonyRule, type Oklch, type PaletteColor, type PaletteOptions, type SuggestOptions,
} from "./core";
