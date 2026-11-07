/**
 * Styles : jetons de rendu + palettes clés en OKLCH.
 *
 * Une palette fixe d'abord la **structure de valeurs** (ciel > façades > sol > encre), garde une chroma basse sur les
 * grandes surfaces et réserve la saturation à l'accent. Lumière chaude, ambiance froide venue du ciel, brouillard
 * couleur d'horizon. Les jetons sont tous des uniformes du shader : changer de style ne recompile rien.
 */
import { Issues, suggest } from "../core/schema";
import { type LCH, type RGB, hexToOklch, hexToRgb, mixLch, oklchToRgb, toLinear } from "./color";
import { ROLES, type Role } from "./roles";

export const BASE_ROLES: Record<Role, string> = {
  ground: "#8b7a5f", grass: "#7b8752", path: "#b39b74", road: "#6c6865", stone: "#9a9387", wall: "#ded2bb", trim: "#c4ad8a", roof: "#9c5640",
  wood: "#88603f", bark: "#5c4838", leaf: "#6c7d47", leaf2: "#879050", flower: "#d38a5c", water: "#4c7a87", metal: "#7a8188", glass: "#5f7d91",
  lamp: "#ffd18a", cloth1: "#8a6a4f", cloth2: "#4d4a44", cloth3: "#c9b48f", leather: "#4a3427", skin: "#ddaa86", hair: "#45302a", eye: "#2a2422",
  eyeWhite: "#f2ede4", mouth: "#7a3934", accent: "#bf5a40", ink: "#2c2a2f", paper: "#ece3cf", snow: "#eceff1", fire: "#ffad47", sky: "#b9cfdc",
};

export type Palette = {
  roles?: Partial<Record<Role, string>>;
  skyTop: string;
  skyHorizon: string;
  sun: string;
  ambientSky: string;
  ambientGround: string;
  /** Décalage global de teinte (°), multiplicateur de chroma, de contraste de valeur. */
  hue?: number;
  chroma?: number;
  contrast?: number;
};

export const PALETTES: Record<string, Palette> = {
  gouache: { skyTop: "#8fb3cc", skyHorizon: "#e6dcc8", sun: "#fff0d6", ambientSky: "#9fb6cf", ambientGround: "#8c7d68" },
  brume: { skyTop: "#a9b8c2", skyHorizon: "#dfe2df", sun: "#f3efe6", ambientSky: "#b4c1cb", ambientGround: "#8f8f88", chroma: 0.6, contrast: 0.85 },
  automne: { skyTop: "#9fb0c0", skyHorizon: "#efd9b8", sun: "#ffe0b0", ambientSky: "#a8b4c4", ambientGround: "#8f7258", roles: { leaf: "#b0703a", leaf2: "#c49a45", grass: "#8f8a4e", flower: "#b8463a" } },
  printemps: { skyTop: "#86b2d6", skyHorizon: "#e9ecdc", sun: "#fff6e0", ambientSky: "#9cc0dc", ambientGround: "#7f8a62", roles: { leaf: "#6f9150", leaf2: "#9db05f", grass: "#7e9a55", flower: "#e0a1b3" }, chroma: 1.1 },
  desert: { skyTop: "#7fa7c7", skyHorizon: "#f1dcb6", sun: "#fff1d0", ambientSky: "#a6b7c6", ambientGround: "#b08e66", roles: { ground: "#c09a6c", grass: "#a39a63", path: "#d4b588", wall: "#e3c9a2", stone: "#b48f6c", leaf: "#7f8a50" } },
  neige: { skyTop: "#9cb4c9", skyHorizon: "#eef0ef", sun: "#fff6ea", ambientSky: "#b6c7d8", ambientGround: "#c9cdd2", roles: { ground: "#e4e8ea", grass: "#dfe4e6", path: "#cfc8bf", roof: "#e9ecee", leaf: "#4f6650", leaf2: "#5d7259" } },
  crepuscule: { skyTop: "#5d6a93", skyHorizon: "#f0a978", sun: "#ffb98a", ambientSky: "#7d7fa6", ambientGround: "#7a5b55", contrast: 1.05 },
  nuit: { skyTop: "#141d33", skyHorizon: "#34466b", sun: "#a9bde6", ambientSky: "#5a6f9c", ambientGround: "#2a3043", contrast: 0.95 },
  neon: { skyTop: "#0d0b1f", skyHorizon: "#3a1f4f", sun: "#c49cff", ambientSky: "#3b2f6b", ambientGround: "#1d1830", roles: { lamp: "#ff5fb8", glass: "#56e0ff", accent: "#ff4f9a", wall: "#4a4a63", road: "#2e2d3c" } },
  papier: { skyTop: "#efe7d6", skyHorizon: "#f3ecdd", sun: "#fffaf0", ambientSky: "#d9d2c3", ambientGround: "#b9b0a0", chroma: 0.35 },
  abysses: { skyTop: "#0c2c3c", skyHorizon: "#2c6c7a", sun: "#bfeef0", ambientSky: "#2d6372", ambientGround: "#123540", chroma: 0.9, roles: { ground: "#5c7a6c", stone: "#5d7480", leaf: "#3f8a74", leaf2: "#6aa07a", flower: "#e08870" } },
};

export const SHADINGS = ["flat", "toon", "soft", "lit"] as const;

export type StyleTokens = {
  palette: string;
  hue: number;
  chroma: number;
  contrast: number;
  shading: (typeof SHADINGS)[number];
  bands: number;
  /** Douceur des transitions de bande (0 = net) et bruit de pinceau sur le seuil. */
  bandSoftness: number;
  brush: number;
  /** Épaisseur du contour (px à l'écran) et force (0 = aucun). */
  outline: number;
  outlineStrength: number;
  /** Lumière : azimut et hauteur (°), intensité. */
  lightAzimuth: number;
  lightElevation: number;
  lightIntensity: number;
  shadows: boolean;
  shadowStrength: number;
  ao: number;
  /** Texture procédurale (variation de valeur selon le rôle). */
  texture: number;
  fog: number;
  fogHeight: number;
  night: number;
  lamps: number;
  rim: number;
  grain: number;
  paper: number;
  vignette: number;
  pixel: number;
  saturation: number;
  roles: Partial<Record<Role, string>>;
  sky: boolean;
};

export const DEFAULT_STYLE: StyleTokens = {
  palette: "gouache", hue: 0, chroma: 1, contrast: 1, shading: "toon", bands: 3, bandSoftness: 0.08, brush: 0.35, outline: 1.6, outlineStrength: 0.75,
  lightAzimuth: 35, lightElevation: 48, lightIntensity: 1, shadows: true, shadowStrength: 0.75, ao: 0.8, texture: 0.6, fog: 0.5, fogHeight: 0.3,
  night: 0, lamps: 0.6, rim: 0.25, grain: 0.15, paper: 0, vignette: 0.25, pixel: 0, saturation: 1, roles: {}, sky: true,
};

export const STYLE_PRESETS: Record<string, Partial<StyleTokens>> = {
  gouache: {},
  doux: { shading: "soft", outline: 1, outlineStrength: 0.4, brush: 0.15, grain: 0.08 },
  encre: { palette: "papier", shading: "toon", bands: 2, outline: 2.2, outlineStrength: 1, texture: 0.8, paper: 0.6, grain: 0.2, fog: 0.25, chroma: 0.3 },
  bd: { shading: "toon", bands: 2, bandSoftness: 0.02, outline: 2.4, outlineStrength: 1, brush: 0.1, grain: 0.05, chroma: 1.15, texture: 0.3 },
  pixel: { shading: "toon", bands: 3, bandSoftness: 0, outline: 1, outlineStrength: 0.8, pixel: 4, grain: 0, vignette: 0.1, brush: 0, chroma: 1.15 },
  lowpoly: { shading: "flat", outline: 0, outlineStrength: 0, texture: 0.2, brush: 0 },
  brume: { palette: "brume", fog: 1.1, fogHeight: 0.6, shadowStrength: 0.45, outlineStrength: 0.5 },
  nuit: { palette: "nuit", night: 1, lamps: 1, fog: 0.7, shadowStrength: 0.5, rim: 0.4 },
  neon: { palette: "neon", night: 1, lamps: 1.4, fog: 0.8, rim: 0.6, outline: 1.4, saturation: 1.2 },
  crepuscule: { palette: "crepuscule", lightElevation: 14, lightAzimuth: 70, fog: 0.8, rim: 0.5 },
  automne: { palette: "automne" },
  printemps: { palette: "printemps", fog: 0.4 },
  desert: { palette: "desert", lightElevation: 62, fog: 0.6, shadowStrength: 0.85 },
  neige: { palette: "neige", fog: 0.7, shadowStrength: 0.5, lightElevation: 30 },
  papier: { palette: "papier", shading: "toon", bands: 2, paper: 0.9, grain: 0.25, outline: 1.8, outlineStrength: 0.9, chroma: 0.4 },
  abysses: { palette: "abysses", fog: 1.4, fogHeight: 0.2, lightElevation: 70, shadowStrength: 0.4, rim: 0.5 },
  aquarelle: { shading: "soft", outline: 0.8, outlineStrength: 0.35, brush: 0.6, paper: 0.7, grain: 0.1, chroma: 0.8, texture: 0.9 },
};

/** Résout un style : nom de préréglage, ou jetons (avec `preset` facultatif comme base). */
export function resolveStyle(input: unknown, issues?: Issues): StyleTokens {
  let base: Partial<StyleTokens> = {};
  let over: Record<string, unknown> = {};
  if (typeof input === "string" && input) {
    if (STYLE_PRESETS[input]) base = STYLE_PRESETS[input];
    else issues?.add({ path: "style", code: "unknown", message: `style « ${input} » inconnu`, didYouMean: suggest(input, Object.keys(STYLE_PRESETS)), hint: Object.keys(STYLE_PRESETS).join(", ") });
  } else if (input && typeof input === "object") {
    over = { ...(input as Record<string, unknown>) };
    const pr = over.preset;
    if (typeof pr === "string") {
      if (STYLE_PRESETS[pr]) base = STYLE_PRESETS[pr];
      else issues?.add({ path: "style.preset", code: "unknown", message: `préréglage « ${pr} » inconnu`, didYouMean: suggest(pr, Object.keys(STYLE_PRESETS)) });
      delete over.preset;
    }
  }
  const s: StyleTokens = { ...DEFAULT_STYLE, ...base, roles: { ...(base.roles ?? {}) } };
  for (const [k, v] of Object.entries(over)) {
    if (!(k in DEFAULT_STYLE)) {
      issues?.add({ path: `style.${k}`, code: "unknown", message: `jeton de style « ${k} » inconnu`, didYouMean: suggest(k, Object.keys(DEFAULT_STYLE)) });
      continue;
    }
    const d = (DEFAULT_STYLE as Record<string, unknown>)[k];
    if (k === "roles" && v && typeof v === "object") {
      for (const [r, c] of Object.entries(v as Record<string, unknown>)) {
        if (!(ROLES as readonly string[]).includes(r)) issues?.add({ path: `style.roles.${r}`, code: "unknown", message: `rôle « ${r} » inconnu`, didYouMean: suggest(r, ROLES) });
        else if (typeof c === "string" && /^#[0-9a-f]{3,6}$/i.test(c)) (s.roles as Record<string, string>)[r] = c;
      }
    } else if (typeof d === "number") {
      const n = Number(v);
      if (Number.isFinite(n)) (s as Record<string, unknown>)[k] = n;
    } else if (typeof d === "boolean") (s as Record<string, unknown>)[k] = v === true || v === "true" || v === 1;
    else if (k === "palette") {
      if (typeof v === "string" && PALETTES[v]) s.palette = v;
      else issues?.add({ path: "style.palette", code: "unknown", message: `palette « ${String(v)} » inconnue`, didYouMean: suggest(String(v), Object.keys(PALETTES)), hint: Object.keys(PALETTES).join(", ") });
    } else if (k === "shading") {
      if ((SHADINGS as readonly string[]).includes(String(v))) s.shading = v as StyleTokens["shading"];
      else issues?.add({ path: "style.shading", code: "unknown", message: `ombrage « ${String(v)} » inconnu`, hint: SHADINGS.join(", ") });
    }
  }
  s.bands = Math.max(2, Math.min(4, Math.round(s.bands)));
  s.pixel = Math.max(0, Math.min(12, Math.round(s.pixel)));
  return s;
}

/** Rôles qui gardent leur couleur propre (pas de décalage de palette) : peau, yeux, bouche. */
const KEEP = new Set<Role>(["skin", "eye", "eyeWhite", "mouth"]);

function transform(c: LCH, s: StyleTokens, pal: Palette, role?: Role): LCH {
  if (role && KEEP.has(role)) return c;
  const contrast = s.contrast * (pal.contrast ?? 1);
  const L = 0.6 + (c[0] - 0.6) * contrast;
  return [Math.max(0.05, Math.min(0.98, L)), c[1] * s.chroma * (pal.chroma ?? 1) * s.saturation, (c[2] + s.hue + (pal.hue ?? 0) + 360) % 360];
}

export type ResolvedColors = {
  /** 32 rôles × RGB linéaire. */
  roles: Float32Array;
  skyTop: RGB;
  skyHorizon: RGB;
  sun: RGB;
  ambientSky: RGB;
  ambientGround: RGB;
};

/** Couleurs finales (linéaires) d'un style, avec surcharges d'objet (couleurs propres d'un personnage). */
export function resolveColors(s: StyleTokens, objectColors?: Partial<Record<Role, string>>): ResolvedColors {
  const pal = PALETTES[s.palette] ?? PALETTES.gouache;
  const roles = new Float32Array(ROLES.length * 3);
  const night = s.night;
  ROLES.forEach((r, i) => {
    const hex = objectColors?.[r] ?? s.roles[r] ?? pal.roles?.[r] ?? BASE_ROLES[r];
    let c = transform(hexToOklch(hex), s, pal, objectColors?.[r] ? r : undefined);
    if (night > 0 && r !== "lamp" && r !== "fire") {
      const n: LCH = [c[0] * 0.62, c[1] * 0.5, 250];
      c = mixLch(c, n, night * 0.85);
    }
    const rgb = toLinear(oklchToRgb(c));
    roles.set(rgb, i * 3);
  });
  const lin = (h: string): RGB => toLinear(oklchToRgb(transform(hexToOklch(h), s, pal)));
  return { roles, skyTop: lin(pal.skyTop), skyHorizon: lin(pal.skyHorizon), sun: lin(pal.sun), ambientSky: lin(pal.ambientSky), ambientGround: lin(pal.ambientGround) };
}

export { hexToRgb };
