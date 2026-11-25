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
import { readRoleFinishes, type RoleFinishes } from "./finishes";
import { MAX_POST, POST_QUALITIES, type PostFx, type PostQuality, resolvePost } from "../render/post";
import { METEO_PRESETS, ambianceStyle } from "./ambiance";

export const BASE_ROLES: Record<Role, string> = {
  ground: "#8b7a5f", grass: "#7b8752", path: "#b39b74", road: "#6c6865", stone: "#9a9387", wall: "#ded2bb", trim: "#c4ad8a", roof: "#9c5640",
  wood: "#88603f", bark: "#5c4838", leaf: "#6c7d47", leaf2: "#879050", flower: "#d38a5c", water: "#4c7a87", metal: "#7a8188", glass: "#5f7d91",
  lamp: "#ffd18a", cloth1: "#8a6a4f", cloth2: "#4d4a44", cloth3: "#c9b48f", leather: "#4a3427", skin: "#ddaa86", hair: "#45302a", eye: "#2a2422",
  eyeWhite: "#f2ede4", mouth: "#7a3934", accent: "#bf5a40", ink: "#2c2a2f", paper: "#ece3cf", snow: "#eceff1", fire: "#ffad47", sky: "#b9cfdc",
  red: "#c8443a", orange: "#e07a2e", yellow: "#e9c33f", green: "#4f9a4c", blue: "#3f6fb5", purple: "#7a4f9e", white: "#f1efe9", black: "#25252a",
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
  /** Occlusion ambiante en espace écran (0 aucune … 1) : plis, creux, jonctions. */
  ssao: number;
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
  /** Finis par rôle (`matieres`) : métal, rugosité, tissu, vernis. */
  finishes: RoleFinishes;
  sky: boolean;
  /** Détail de surface : relief procédural et usure des arêtes (0 = lisse). */
  detail: number;
  /** Pile d'effets de post-traitement (validée, voir `render/post.ts`) ; vide = aucun coût. */
  post: PostFx[];
  /**
   * Pixels accrochés au monde en caméra orthographique (rendu `pixel` et effets de grille de `post`) ; `pixel: {size,
   * snap: false}` ou `pixelSnap: false` pour l'ancien comportement (grille fixée à l'écran).
   */
  pixelSnap: boolean;
  /** Qualité de la pile : `auto` (basse sur mobile), `low` (passes lourdes à demi-résolution), `high`. */
  postQuality: PostQuality;
  /** Ciel écrit (horizon, haut ; `""` : celui de la palette), couleur du soleil, couleur du ciel ambiant. */
  skyHorizon: string;
  skyTop: string;
  sunColor: string;
  ambientColor: string;
  /** Force de la lumière ambiante (1 = celle de la palette). */
  ambient: number;
  /** Reflets des finis : `exterieur` (ciel et sol, défaut), `studio` (pièce claire, boîtes à lumière), `aucun`. */
  environment: "exterieur" | "studio" | "aucun";
  /** Météo : préréglages de particules (pluie, neige, brume…), posés par une ambiance ; dessinés si procgen rend des particules. */
  meteo: string[];
  /** Nom de l'ambiance appliquée (`""` : aucune). */
  ambiance: string;
};

const COLOR_TOKENS = ["skyHorizon", "skyTop", "sunColor", "ambientColor"] as const;
export const ENVIRONMENTS = ["exterieur", "studio", "aucun"] as const;

export const DEFAULT_STYLE: StyleTokens = {
  palette: "gouache", hue: 0, chroma: 1, contrast: 1, shading: "toon", bands: 3, bandSoftness: 0.08, brush: 0.35, outline: 0, outlineStrength: 0, ssao: 0.6,
  lightAzimuth: 35, lightElevation: 48, lightIntensity: 1, shadows: true, shadowStrength: 0.75, ao: 0.8, texture: 0.6, fog: 0.5, fogHeight: 0.3,
  night: 0, lamps: 0.6, rim: 0.25, grain: 0.15, paper: 0, vignette: 0.25, pixel: 0, saturation: 1, roles: {}, finishes: {}, sky: true, detail: 1,
  post: [], postQuality: "auto", pixelSnap: true,
  skyHorizon: "", skyTop: "", sunColor: "", ambientColor: "", ambient: 1, environment: "exterieur", meteo: [], ambiance: "",
};

export const STYLE_PRESETS: Record<string, Partial<StyleTokens>> = {
  gouache: {},
  doux: { shading: "soft", brush: 0.15, grain: 0.08 },
  encre: { palette: "papier", shading: "toon", bands: 2, outline: 2.2, outlineStrength: 1, texture: 0.8, paper: 0.6, grain: 0.2, fog: 0.25, chroma: 0.3 },
  bd: { shading: "toon", bands: 2, bandSoftness: 0.02, outline: 2.4, outlineStrength: 1, brush: 0.1, grain: 0.05, chroma: 1.15, texture: 0.3 },
  pixel: { detail: 0.3, shading: "toon", bands: 3, bandSoftness: 0, pixel: 4, grain: 0, vignette: 0.1, brush: 0, chroma: 1.15 },
  lowpoly: { shading: "flat", outline: 0, outlineStrength: 0, texture: 0.2, brush: 0, detail: 0 },
  brume: { palette: "brume", fog: 1.1, fogHeight: 0.6, shadowStrength: 0.45 },
  nuit: { palette: "nuit", night: 1, lamps: 1, fog: 0.7, shadowStrength: 0.5, rim: 0.4 },
  neon: { palette: "neon", night: 1, lamps: 1.4, fog: 0.8, rim: 0.6, saturation: 1.2 },
  crepuscule: { palette: "crepuscule", lightElevation: 14, lightAzimuth: 70, fog: 0.8, rim: 0.5 },
  automne: { palette: "automne" },
  printemps: { palette: "printemps", fog: 0.4 },
  desert: { palette: "desert", lightElevation: 62, fog: 0.6, shadowStrength: 0.85 },
  neige: { palette: "neige", fog: 0.7, shadowStrength: 0.5, lightElevation: 30 },
  papier: { palette: "papier", shading: "toon", bands: 2, paper: 0.9, grain: 0.25, chroma: 0.4 },
  abysses: { palette: "abysses", fog: 1.4, fogHeight: 0.2, lightElevation: 70, shadowStrength: 0.4, rim: 0.5 },
  aquarelle: { shading: "soft", brush: 0.6, paper: 0.7, grain: 0.1, chroma: 0.8, texture: 0.9 },
};

/**
 * Résout un style : nom de préréglage, ou jetons (avec `preset` et `ambiance` facultatifs comme bases). Une ambiance
 * (`style/ambiance.ts`) donne la première couche ; le préréglage écrit puis les jetons écrits la complètent ; sa pile
 * `post` (étalonnage) passe avant celle écrite.
 */
export function resolveStyle(input: unknown, issues?: Issues): StyleTokens {
  if (input && typeof input === "object" && !Array.isArray(input) && (input as Record<string, unknown>).ambiance !== undefined) {
    const { ambiance, ...rest } = input as Record<string, unknown>;
    const amb = ambianceStyle(ambiance, (message) => issues?.add({ path: "style.ambiance", code: "unknown", message }));
    if (amb) {
      const base = resolveStyle(amb.style, issues);
      base.ambiance = amb.name;
      base.meteo = amb.meteo;
      return applyTokens(base, rest, issues, true);
    }
    return resolveStyle(rest, issues);
  }
  return applyTokens({ ...DEFAULT_STYLE, roles: {}, finishes: {}, post: [], meteo: [] }, input, issues, false);
}

function applyTokens(start: StyleTokens, input: unknown, issues: Issues | undefined, layered: boolean): StyleTokens {
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
  const s: StyleTokens = { ...start, ...base, roles: { ...start.roles, ...(base.roles ?? {}) }, finishes: { ...start.finishes, ...(base.finishes ?? {}) }, post: [...start.post, ...(base.post ?? [])], meteo: [...start.meteo] };
  // contours : sur demande seulement ; donner l'épaisseur (`outline`) ou l'intensité (`outlineStrength`) suffit
  const wantsOutline = over.outline !== undefined || over.outlineStrength !== undefined;
  for (const [k, v] of Object.entries(over)) {
    if (k === "ambiance" && !layered) continue;
    if (!(k in DEFAULT_STYLE) && k !== "matieres") {
      issues?.add({ path: `style.${k}`, code: "unknown", message: `jeton de style « ${k} » inconnu`, didYouMean: suggest(k, Object.keys(DEFAULT_STYLE)) });
      continue;
    }
    const d = (DEFAULT_STYLE as Record<string, unknown>)[k];
    if (k === "pixel" && v && typeof v === "object") {
      // `pixel: {size, snap}`
      const o = v as Record<string, unknown>;
      if (Number.isFinite(Number(o.size))) s.pixel = Number(o.size);
      if (o.snap !== undefined) s.pixelSnap = o.snap !== false && o.snap !== "false";
      for (const kk of Object.keys(o)) if (kk !== "size" && kk !== "snap") issues?.add({ path: `style.pixel.${kk}`, code: "unknown", message: `clé « ${kk} » inconnue`, hint: "size, snap" });
    } else if (k === "post") {
      // sur une ambiance : la pile écrite suit l'étalonnage de l'ambiance
      const mine = resolvePost(v, issues);
      if (layered && start.post.length) {
        if (start.post.length + mine.length > MAX_POST) issues?.add({ path: "style.post", code: "limit", message: `${MAX_POST} effets au plus, étalonnage de l'ambiance (${start.post.length}) compris`, got: start.post.length + mine.length, used: MAX_POST });
        s.post = [...start.post, ...mine].slice(0, MAX_POST);
      } else s.post = mine;
    } else if ((COLOR_TOKENS as readonly string[]).includes(k)) {
      if (v === "" || v === null) (s as Record<string, unknown>)[k] = "";
      else if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) (s as Record<string, unknown>)[k] = v.toLowerCase();
      else if (typeof v === "string" && /^#[0-9a-f]{3}$/i.test(v)) (s as Record<string, unknown>)[k] = "#" + v.slice(1).split("").map((c) => c + c).join("").toLowerCase();
      else issues?.add({ path: `style.${k}`, code: "type", message: "couleur attendue (#rrggbb)", got: v });
    } else if (k === "environment") {
      if ((ENVIRONMENTS as readonly string[]).includes(String(v))) s.environment = v as StyleTokens["environment"];
      else issues?.add({ path: "style.environment", code: "unknown", message: `environnement « ${String(v)} » inconnu`, hint: ENVIRONMENTS.join(", ") });
    } else if (k === "meteo") {
      const list = v === false || v === null || v === "" ? [] : (Array.isArray(v) ? v : [v]).map(String);
      s.meteo = list.filter((x) => (METEO_PRESETS as readonly string[]).includes(x)).slice(0, 2);
      for (const x of list) if (!s.meteo.includes(x)) issues?.add({ path: "style.meteo", code: "unknown", message: `météo « ${x} » inconnue`, hint: METEO_PRESETS.join(", "), didYouMean: suggest(x, METEO_PRESETS) });
    } else if (k === "postQuality") {
      if ((POST_QUALITIES as readonly string[]).includes(String(v))) s.postQuality = v as PostQuality;
      else issues?.add({ path: "style.postQuality", code: "unknown", message: `qualité « ${String(v)} » inconnue`, hint: POST_QUALITIES.join(", ") });
    } else if (k === "matieres" || k === "finishes") {
      Object.assign(s.finishes, readRoleFinishes(v, (r, message) => issues?.add({ path: `style.matieres.${r}`, code: "type", message })));
    } else if (k === "roles" && v && typeof v === "object") {
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
  s.ambient = Math.max(0, Math.min(4, s.ambient));
  if (wantsOutline) {
    if (s.outline > 0 && !(s.outlineStrength > 0)) s.outlineStrength = 0.75;
    if (s.outlineStrength > 0 && !(s.outline > 0)) s.outline = 1.6;
  }
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
  /** Rôles (`ROLES.length`) × RGB linéaire. */
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
  const k = s.ambient;
  const sc = (c: RGB): RGB => [c[0] * k, c[1] * k, c[2] * k];
  // ciel ambiant écrit : teinte la lumière venue d'en haut ; le sol renvoie un peu de sa couleur
  const ambSky = s.ambientColor ? lin(s.ambientColor) : lin(pal.ambientSky);
  const ambGround = s.ambientColor ? mixRgb(lin(pal.ambientGround), ambSky, 0.35) : lin(pal.ambientGround);
  return {
    roles,
    skyTop: lin(s.skyTop || (s.skyHorizon ? s.skyHorizon : pal.skyTop)),
    skyHorizon: lin(s.skyHorizon || pal.skyHorizon),
    sun: lin(s.sunColor || pal.sun),
    ambientSky: sc(ambSky),
    ambientGround: sc(ambGround),
  };
}

/**
 * Couleur libre (`#rrggbb`) accordée au style comme un rôle (contraste, chroma, teinte de la palette, nuit) : RGB
 * linéaire. Sert aux couleurs données hors rôles (prairies).
 */
export function styleColor(s: StyleTokens, hex: string): RGB {
  const pal = PALETTES[s.palette] ?? PALETTES.gouache;
  let c = transform(hexToOklch(hex), s, pal);
  if (s.night > 0) c = mixLch(c, [c[0] * 0.62, c[1] * 0.5, 250], s.night * 0.85);
  return toLinear(oklchToRgb(c));
}

/** Herbe de la palette du style rapportée à l'herbe de base (RGB linéaire, par canal) : saison, neige, désert… */
export function grassShift(s: StyleTokens): RGB {
  const pal = PALETTES[s.palette] ?? PALETTES.gouache;
  const ref = toLinear(oklchToRgb(hexToOklch(BASE_ROLES.grass)));
  const cur = toLinear(oklchToRgb(hexToOklch(s.roles.grass ?? pal.roles?.grass ?? BASE_ROLES.grass)));
  return [0, 1, 2].map((i) => Math.max(0.35, Math.min(2.6, cur[i] / Math.max(1e-4, ref[i])))) as RGB;
}

const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export { hexToRgb };
