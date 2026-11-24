/** Addon color : palettes d'harmonie (théorie des couleurs) calculées en OKLCH, pastilles cliquables. */
export { SonicPalette, type PaletteRule, type PaletteState } from "./palette";
export { SonicPaletteEditor, type PaletteEditorState } from "./editor";
export { SonicThemeColors } from "./theme-colors";
export { deriveTheme, contrastRatio, luminance, sanitizeMode, sanitizeThemeRule, THEME_RULES, type Theme, type ThemeMode, type ThemeOptions, type ThemeRule } from "./theme";
export {
  HARMONY_RULES, MAX_COLORS, customPalette, harmony, oklchToSrgb, suggestPalette, parseColorList, hueOffsets, oklchToHex, parseHex, rgbToOklch, sanitizeRule, toHex,
  type HarmonyRule, type Oklch, type PaletteColor, type PaletteOptions, type SuggestOptions,
} from "./core";
