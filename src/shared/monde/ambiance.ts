/**
 * Ambiances : directions artistiques prêtes à l'emploi pour le format monde. Une ambiance règle d'un mot le rendu
 * (`look`, finis par défaut, reflets), le ciel et la brume, la palette, le style des modèles `gen`, la lumière et
 * l'étalonnage de l'image (couleurs, grain, vignette, pixels, silhouettes, contours, halo, aberration).
 *
 * Tout ce que le monde écrit lui-même l'emporte sur l'ambiance ; `lumiere` et `etalonnage` écrits complètent les
 * siens valeur par valeur. Noms génériques : une ambiance s'inspire d'un genre, sans reprendre d'éléments d'une œuvre.
 */

export type Grade = {
  /** Saturation (0 = gris, 1 = neutre), contraste, luminosité (1 = neutre). */
  saturation: number;
  contrast: number;
  brightness: number;
  /** Teinte multipliée (couleur), `""` : aucune. */
  tint: string;
  /** Noir et blanc, sépia (0 à 1). */
  bw: number;
  sepia: number;
  /** Grain de film, vignette (0 à 1). */
  grain: number;
  vignette: number;
  /** Taille des pixels (px, 0 ou 1 : aucun) et nombre de niveaux par couleur (0 : aucun). */
  pixel: number;
  posterize: number;
  /** Silhouettes : objets en aplat sombre, éclaircis par la distance vers la couleur du ciel (0 à 1). */
  silhouette: number;
  /** Contours dessinés aux ruptures de profondeur (0 à 1), couleur. */
  outline: number;
  outlineColor: string;
  /** Halo des zones lumineuses (0 à 1), seuil. */
  bloom: number;
  bloomThreshold: number;
  /** Aberration chromatique, lignes de balayage (0 à 1). */
  aberration: number;
  scanlines: number;
  /** Peinture : rayon des touches du filtre de Kuwahara anisotrope (px, 0 : aucun). */
  paint: number;
  /** Tramage ordonné avant la peinture (0 à 1), sur `posterize` niveaux (6 sans postérisation). */
  dither: number;
  /** Occlusion ambiante à l'écran (0 à 1) : coins, contacts et recoins assombris. */
  occlusion: number;
};

export type Lumiere = {
  /** Intensité de la lumière principale (soleil), couleur, hauteur et azimut (°). */
  intensite: number;
  couleur: string;
  hauteur: number;
  azimut: number;
  /** Lumière ambiante : intensité, couleur. */
  ambiante: number;
  couleurAmbiante: string;
};

export type AmbianceSpec = {
  name: string;
  look?: "doux" | "toon" | "brillant";
  environnement?: "studio" | "exterieur" | "aucun";
  ciel?: string;
  brume?: number;
  /** Fini des pièces qui n'en ont pas. */
  finish?: string;
  /** Couleurs par rôle (complètent la palette du monde). */
  palette?: Record<string, string>;
  /** Style des modèles `gen` (préréglage ou jetons procgen). */
  style?: unknown;
  texture?: string;
  /** Arrondi des arêtes (m) des boîtes sans arrondi écrit. */
  arrondi?: number;
  /** Ombrage à facettes (low-poly). */
  facettes?: boolean;
  lumiere: Partial<Lumiere>;
  grade: Partial<Grade>;
};

export const GRADE0: Grade = {
  saturation: 1,
  contrast: 1,
  brightness: 1,
  tint: "",
  bw: 0,
  sepia: 0,
  grain: 0,
  vignette: 0,
  pixel: 0,
  posterize: 0,
  silhouette: 0,
  outline: 0,
  outlineColor: "#111111",
  bloom: 0,
  bloomThreshold: 0.75,
  aberration: 0,
  scanlines: 0,
  paint: 0,
  dither: 0,
  occlusion: 0,
};

export const LUMIERE0: Lumiere = { intensite: 1.1, couleur: "#ffffff", hauteur: 55, azimut: 53, ambiante: 0.55, couleurAmbiante: "#ffffff" };

type Preset = Omit<AmbianceSpec, "name">;

export const AMBIANCES: Record<string, Preset> = {
  realiste: {
    arrondi: 0.006,
    look: "doux",
    environnement: "exterieur",
    ciel: "#c9d6df",
    brume: 0.12,
    style: { shading: "lit", outline: 0, outlineStrength: 0, brush: 0, grain: 0, paper: 0, vignette: 0, texture: 0.5, matieres: { metal: "metal", leather: "cuir" } },
    lumiere: { intensite: 2.2, couleur: "#fff4e6", hauteur: 42, ambiante: 0.35, couleurAmbiante: "#c8d6e6" },
    grade: { occlusion: 0.6, saturation: 0.92, contrast: 1.08, vignette: 0.2, grain: 0.03, bloom: 0.1 },
  },
  militaire: {
    arrondi: 0.005,
    look: "doux",
    environnement: "exterieur",
    ciel: "#b9bfb6",
    brume: 0.25,
    palette: { sol: "#8a7d62", metal: "#4a4f52", accent: "#5c6640", maillot: "#5d6448", short: "#6b6a55", chaussure: "#3b342b", pierre: "#8e8a80", bois: "#6d5a44", feuillage: "#5a6340" },
    style: { shading: "lit", outline: 0, outlineStrength: 0, brush: 0, grain: 0.05, paper: 0, vignette: 0.2, texture: 0.7, chroma: 0.6, matieres: { metal: "brosse", leather: "cuir" } },
    lumiere: { intensite: 2.4, couleur: "#fff0dc", hauteur: 35, azimut: 120, ambiante: 0.3, couleurAmbiante: "#b8c2c8" },
    grade: { occlusion: 0.7, saturation: 0.62, contrast: 1.18, tint: "#e6e0c8", vignette: 0.38, grain: 0.08, bloom: 0.12, bloomThreshold: 0.8 },
  },
  cartoon: {
    arrondi: 0.02,
    look: "toon",
    environnement: "aucun",
    ciel: "#7fc8ff",
    brume: 0,
    palette: { sol: "#62c26a", accent: "#ff5a36", maillot: "#ff3d3d", short: "#2f6bff", pierre: "#b8b2a8", bois: "#b0703a", feuillage: "#3fb84a", eau: "#2fb4ff" },
    // aplats de BD sans contours (sur demande : `contours`)
    style: { preset: "bd", outline: 0, outlineStrength: 0 },
    lumiere: { intensite: 1.5, hauteur: 60, ambiante: 0.75 },
    grade: { occlusion: 0.3, saturation: 1.3, contrast: 1.05, outlineColor: "#1c1c28", bloom: 0.08 },
  },
  jouet: {
    arrondi: 0.035,
    look: "brillant",
    environnement: "studio",
    ciel: "#bfe3ff",
    brume: 0,
    finish: "plastique",
    palette: { sol: "#7ccf6a", accent: "#ffcf2e", maillot: "#ff4a4a", short: "#3b7bff" },
    style: { preset: "doux", matieres: { cloth1: "plastique", cloth2: "plastique", cloth3: "plastique", leather: "plastique", skin: "plastique", hair: "plastique" } },
    lumiere: { intensite: 1.6, hauteur: 58, ambiante: 0.65 },
    grade: { occlusion: 0.4, saturation: 1.22, contrast: 1.04, brightness: 1.03, vignette: 0.12 },
  },
  cyber: {
    arrondi: 0.004,
    look: "brillant",
    environnement: "exterieur",
    ciel: "#07060f",
    brume: 0.35,
    finish: "laque",
    palette: { sol: "#1b1a2a", metal: "#3a3d55", accent: "#ff2fb4", eau: "#26e0ff", pierre: "#2c2b3d", blanc: "#d8e6ff" },
    style: { preset: "neon", matieres: { metal: "chrome", cloth1: "laque", leather: "cuir" } },
    lumiere: { intensite: 1.4, couleur: "#ff5fd0", hauteur: 25, azimut: -60, ambiante: 0.55, couleurAmbiante: "#5a4ab0" },
    grade: { occlusion: 0.4, saturation: 1.25, contrast: 1.15, tint: "#e0d4ff", outlineColor: "#36e6ff", bloom: 0.9, bloomThreshold: 0.5, aberration: 0.35, scanlines: 0.2, vignette: 0.4, grain: 0.04 },
  },
  alien: {
    arrondi: 0.02,
    look: "doux",
    environnement: "exterieur",
    ciel: "#3a2466",
    brume: 0.22,
    palette: { sol: "#2b2040", feuillage: "#36e0b0", accent: "#ff4fd8", pierre: "#4a3a66", eau: "#5af0ff", peau: "#8de6c0", bois: "#5a3d70" },
    style: { preset: "neon", palette: "abysses" },
    lumiere: { intensite: 1.5, couleur: "#7affd4", hauteur: 28, ambiante: 0.65, couleurAmbiante: "#8a5acc" },
    grade: { occlusion: 0.4, saturation: 1.2, contrast: 1.1, tint: "#d8fff0", bloom: 0.7, bloomThreshold: 0.6, aberration: 0.18, vignette: 0.4 },
  },
  silhouette: {
    arrondi: 0,
    look: "toon",
    environnement: "aucun",
    ciel: "#d9d7cf",
    brume: 0.5,
    style: { shading: "flat", outline: 0, outlineStrength: 0, chroma: 0 },
    lumiere: { intensite: 0.6, ambiante: 0.9 },
    grade: { silhouette: 1, saturation: 0, grain: 0.14, vignette: 0.65, contrast: 1.1, bloom: 0.25, bloomThreshold: 0.7 },
  },
  noir: {
    arrondi: 0.006,
    look: "doux",
    environnement: "aucun",
    ciel: "#2b2b2b",
    brume: 0.2,
    style: { shading: "lit", outline: 0, outlineStrength: 0, chroma: 0, grain: 0.2, vignette: 0.5 },
    lumiere: { intensite: 3, couleur: "#ffffff", hauteur: 22, azimut: 70, ambiante: 0.22 },
    grade: { occlusion: 0.5, bw: 1, contrast: 1.35, grain: 0.1, vignette: 0.5, bloom: 0.2, bloomThreshold: 0.8 },
  },
  voxel: {
    arrondi: 0,
    look: "toon",
    environnement: "aucun",
    ciel: "#9fd8ff",
    brume: 0,
    palette: { sol: "#6fbf52", accent: "#ffb43a", pierre: "#a8a29a", bois: "#9c6a3c", feuillage: "#4fae3c", eau: "#3aa0ff" },
    style: "pixel",
    lumiere: { intensite: 1.3, hauteur: 65, azimut: 30, ambiante: 0.8 },
    grade: { occlusion: 0.5, pixel: 4, posterize: 7, saturation: 1.18 },
  },
  retro: {
    arrondi: 0,
    facettes: true,
    look: "doux",
    environnement: "aucun",
    ciel: "#5a6a8a",
    brume: 0.45,
    style: "lowpoly",
    lumiere: { intensite: 1.4, ambiante: 0.45 },
    grade: { occlusion: 0.3, pixel: 3, posterize: 12, saturation: 1, contrast: 1.08, scanlines: 0.12, vignette: 0.25 },
  },
  horreur: {
    arrondi: 0.006,
    look: "doux",
    environnement: "aucun",
    ciel: "#5e6a5c",
    brume: 0.4,
    palette: { sol: "#3a3a30", bois: "#4a3a2c", feuillage: "#3c4a34", pierre: "#555449" },
    style: { preset: "brume", chroma: 0.4 },
    lumiere: { intensite: 0.9, couleur: "#d8e0ff", hauteur: 18, ambiante: 0.3 },
    grade: { occlusion: 0.6, saturation: 0.35, contrast: 1.05, brightness: 1.2, tint: "#c4d2b6", grain: 0.16, vignette: 0.7, aberration: 0.1 },
  },
  western: {
    arrondi: 0.008,
    look: "doux",
    environnement: "exterieur",
    ciel: "#f2c890",
    brume: 0.2,
    palette: { sol: "#c49a62", bois: "#8a5a34", pierre: "#b88f68", feuillage: "#8a8a4a" },
    style: "desert",
    lumiere: { intensite: 2.4, couleur: "#ffd6a0", hauteur: 30, azimut: 80, ambiante: 0.35, couleurAmbiante: "#e8c8a0" },
    grade: { occlusion: 0.5, sepia: 0.45, contrast: 1.12, grain: 0.1, vignette: 0.35 },
  },
  pastel: {
    arrondi: 0.025,
    look: "doux",
    environnement: "studio",
    ciel: "#f5e6ef",
    brume: 0.1,
    style: "doux",
    lumiere: { intensite: 1.2, ambiante: 0.8 },
    grade: { occlusion: 0.3, saturation: 0.75, contrast: 0.9, brightness: 1.06, vignette: 0.1 },
  },
  tableau: {
    arrondi: 0.015,
    look: "doux",
    environnement: "exterieur",
    ciel: "#e9d9b8",
    brume: 0.15,
    style: "gouache",
    lumiere: { intensite: 1.8, couleur: "#fff0d8", hauteur: 38, ambiante: 0.55, couleurAmbiante: "#d8d0e8" },
    grade: { occlusion: 0.4, paint: 5, dither: 0.35, posterize: 8, saturation: 1.12, contrast: 1.05, vignette: 0.22 },
  },
  onirique: {
    arrondi: 0.025,
    look: "doux",
    environnement: "exterieur",
    ciel: "#c8b8f0",
    brume: 0.45,
    style: "aquarelle",
    lumiere: { intensite: 1.3, couleur: "#ffe6f2", hauteur: 35, ambiante: 0.7, couleurAmbiante: "#d8c8ff" },
    grade: { occlusion: 0.3, saturation: 0.9, brightness: 1.05, bloom: 0.55, bloomThreshold: 0.6, vignette: 0.3, aberration: 0.08 },
  },
};

/** Mots qui désignent une ambiance (demandes en langage courant, sans noms d'œuvres). */
const ALIASES: Record<string, string> = {
  realistic: "realiste",
  "réaliste": "realiste",
  fps: "militaire",
  guerre: "militaire",
  military: "militaire",
  cartoon: "cartoon",
  dessin: "cartoon",
  karting: "cartoon",
  toy: "jouet",
  plastique: "jouet",
  neon: "cyber",
  "néon": "cyber",
  cyberpunk: "cyber",
  "extraterrestre": "alien",
  extraterrestres: "alien",
  "contre-jour": "silhouette",
  ombre: "silhouette",
  "film-noir": "noir",
  polar: "noir",
  pixel: "voxel",
  cubes: "voxel",
  "32bits": "retro",
  "rétro": "retro",
  horror: "horreur",
  "far-west": "western",
  reve: "onirique",
  "rêve": "onirique",
  peinture: "tableau",
  painting: "tableau",
};

const isColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const num = (x: unknown, d: number, lo: number, hi: number) => (typeof x === "number" && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d);

/** Valeurs d'étalonnage bornées (écrites par l'agent ou venues d'une ambiance). */
export function readGrade(v: unknown, base: Partial<Grade> = {}): Grade {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const b = { ...GRADE0, ...base };
  return {
    saturation: num(o.saturation, b.saturation, 0, 3),
    contrast: num(o.contraste ?? o.contrast, b.contrast, 0.2, 3),
    brightness: num(o.luminosite ?? o.brightness, b.brightness, 0.2, 3),
    tint: isColor(o.teinte ?? o.tint) ? ((o.teinte ?? o.tint) as string) : b.tint,
    bw: num(o.noirEtBlanc ?? o.bw, b.bw, 0, 1),
    sepia: num(o.sepia, b.sepia, 0, 1),
    grain: num(o.grain, b.grain, 0, 1),
    vignette: num(o.vignette, b.vignette, 0, 1),
    pixel: num(o.pixel, b.pixel, 0, 32),
    posterize: num(o.niveaux ?? o.posterize, b.posterize, 0, 64),
    silhouette: num(o.silhouette, b.silhouette, 0, 1),
    outline: num(o.contours ?? o.outline, b.outline, 0, 1),
    outlineColor: isColor(o.couleurContours ?? o.outlineColor) ? ((o.couleurContours ?? o.outlineColor) as string) : b.outlineColor,
    bloom: num(o.halo ?? o.bloom, b.bloom, 0, 2),
    bloomThreshold: num(o.seuilHalo ?? o.bloomThreshold, b.bloomThreshold, 0, 1),
    aberration: num(o.aberration, b.aberration, 0, 1),
    scanlines: num(o.lignes ?? o.scanlines, b.scanlines, 0, 1),
    paint: num(o.peinture ?? o.paint, b.paint, 0, 12),
    dither: o.tramage === true ? 0.6 : num(o.tramage ?? o.dither, b.dither, 0, 1),
    occlusion: num(o.occlusion ?? o.ssao, b.occlusion, 0, 1),
  };
}

export function readLumiere(v: unknown, base: Partial<Lumiere> = {}): Lumiere {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const b = { ...LUMIERE0, ...base };
  return {
    intensite: num(o.intensite, b.intensite, 0, 20),
    couleur: isColor(o.couleur) ? (o.couleur as string) : b.couleur,
    hauteur: num(o.hauteur, b.hauteur, -10, 90),
    azimut: num(o.azimut, b.azimut, -360, 360),
    ambiante: num(o.ambiante, b.ambiante, 0, 5),
    couleurAmbiante: isColor(o.couleurAmbiante) ? (o.couleurAmbiante as string) : b.couleurAmbiante,
  };
}

/** Ambiance : nom (ou alias), ou `{base, …}` qui part d'une ambiance et en change des valeurs ; null si absente. */
export function readAmbiance(v: unknown, issue: (msg: string) => void): AmbianceSpec | null {
  if (v === undefined || v === null || v === "" || v === false) return null;
  const o: Record<string, unknown> = typeof v === "string" ? { base: v } : v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const raw = String(o.base ?? o.nom ?? "").trim().toLowerCase();
  const name = raw ? (AMBIANCES[raw] ? raw : ALIASES[raw] ?? "") : "";
  if (raw && !name) {
    issue(`ambiance « ${raw} » inconnue (${Object.keys(AMBIANCES).join(", ")})`);
    if (typeof v === "string") return null;
  }
  const p: Preset = name ? AMBIANCES[name] : { lumiere: {}, grade: {} };
  const looks = ["doux", "toon", "brillant"];
  const envs = ["studio", "exterieur", "aucun"];
  return {
    name: name || "perso",
    look: looks.includes(String(o.look)) ? (o.look as AmbianceSpec["look"]) : p.look,
    environnement: envs.includes(String(o.environnement)) ? (o.environnement as AmbianceSpec["environnement"]) : p.environnement,
    ciel: isColor(o.ciel) ? (o.ciel as string) : p.ciel,
    brume: typeof o.brume === "number" ? num(o.brume, 0, 0, 1) : p.brume,
    finish: typeof o.finish === "string" ? o.finish : p.finish,
    palette: { ...(p.palette ?? {}), ...(o.palette && typeof o.palette === "object" ? Object.fromEntries(Object.entries(o.palette as Record<string, unknown>).filter(([, c]) => isColor(c))) as Record<string, string> : {}) },
    style: o.style ?? p.style,
    texture: typeof o.texture === "string" ? o.texture : p.texture,
    arrondi: typeof o.arrondi === "number" ? Math.max(0, Math.min(0.5, o.arrondi)) : p.arrondi,
    facettes: typeof o.facettes === "boolean" ? o.facettes : p.facettes,
    lumiere: o.lumiere && typeof o.lumiere === "object" ? readLumiere(o.lumiere, p.lumiere) : p.lumiere,
    grade: o.etalonnage && typeof o.etalonnage === "object" ? readGrade(o.etalonnage, p.grade) : p.grade,
  };
}
