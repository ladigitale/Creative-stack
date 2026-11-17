/**
 * Ambiances de procgen : les directions artistiques du format monde (`shared/monde/ambiance.ts`, mêmes noms, mêmes
 * alias, même lecture `{base, …surcharges}`) traduites en jetons de style procgen.
 *
 * Une ambiance règle d'un mot : lumière (soleil, ciel ambiant), ciel et brume, palette par rôle, finis par défaut,
 * style des modèles (préréglage procgen de l'ambiance), étalonnage de l'image (pile `post` : couleur, sépia,
 * niveaux, silhouettes, halo, néon, aberration, balayage, grain, peinture), et la météo (`meteo` : préréglages de
 * particules, rendus seulement si procgen dessine des particules).
 *
 * Ordre de priorité (du plus faible au plus fort) : défauts → ambiance → `preset` écrit → jetons écrits. La pile
 * `post` écrite s'ajoute après l'étalonnage de l'ambiance (8 effets au plus en tout).
 */
import { type AmbianceSpec, AMBIANCES, GRADE0, readAmbiance } from "../../../shared/monde/ambiance";
import { hexToOklch, oklchToHex } from "./color";

/** Météo par défaut des ambiances (préréglages de particules de `shared/sim/particles.ts`). */
export const AMBIANCE_METEO: Record<string, string[]> = {
  cyber: ["pluie"],
  horreur: ["brume"],
};

/**
 * Météos d'ambiance : celles des particules de procgen (`weather` : pluie, neige, feuilles, pétales, qui suivent la
 * vue ; `brume` : brume au sol de la scène, `fx.mist`).
 */
export const METEO_PRESETS = ["pluie", "neige", "feuilles", "petales", "brume"] as const;

/**
 * Entrées de particules que l'ambiance ajoute à la scène (contrat avec le rendu des particules) : `weather` si ni la
 * recette ni le DataProvider n'en écrivent, `fx.mist` si la recette n'en écrit pas. Rien sans météo.
 */
export function ambianceFx(meteo: string[], written: { weather?: unknown; mist?: unknown }): { weather?: string; mist?: number } {
  const out: { weather?: string; mist?: number } = {};
  const w = meteo.find((m) => m !== "brume");
  if (w && written.weather === undefined) out.weather = w;
  if (meteo.includes("brume") && written.mist === undefined) out.mist = 1;
  return out;
}

/** Rôles du format monde (palette d'ambiance) → rôles procgen ; `sol` vaut aussi pour l'herbe s'il est vert. */
const PALETTE_ROLES: Record<string, string[]> = {
  sol: ["ground"],
  pierre: ["stone"],
  bois: ["wood"],
  feuillage: ["leaf"],
  eau: ["water"],
  peau: ["skin"],
  blanc: ["white"],
  metal: ["metal"],
  accent: ["accent"],
  maillot: ["cloth1"],
  short: ["cloth2"],
  chaussure: ["leather"],
};

/** Rôles « fabriqués » qui reçoivent le fini par défaut de l'ambiance (`finish`), sauf fini écrit. */
const FINISH_ROLES = ["wall", "trim", "roof", "wood", "metal", "cloth1", "cloth2", "cloth3", "leather", "accent", "red", "orange", "yellow", "green", "blue", "purple", "white", "black"];

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Haut du ciel dérivé de sa couleur d'horizon : un peu plus sombre et plus coloré, même teinte. */
export function skyTopFrom(horizon: string): string {
  const [L, C, h] = hexToOklch(horizon);
  return oklchToHex([Math.max(0.04, L * 0.8), Math.min(0.2, C * 1.25 + 0.01), h]);
}

const greenish = (h: string) => {
  const [, C, hue] = hexToOklch(h);
  return C > 0.04 && hue > 95 && hue < 175;
};
const bright = (h: string) => hexToOklch(h)[0] > 0.6 && hexToOklch(h)[1] > 0.08;

export type ProcgenAmbiance = {
  name: string;
  /** Jetons de style procgen (avec `preset` et `post`), à résoudre comme un style écrit. */
  style: Record<string, unknown>;
  /** Préréglages de particules de la météo (vide : aucune). */
  meteo: string[];
};

/**
 * Traduit une ambiance du format monde en jetons procgen. `v` : nom (ou alias), ou `{base, look, ciel, brume, finish,
 * palette, style, lumiere, etalonnage, meteo}`. `null` si absente ou inconnue (signalée).
 */
export function ambianceStyle(v: unknown, issue: (msg: string) => void): ProcgenAmbiance | null {
  const a = readAmbiance(v, issue);
  if (!a) return null;
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return { name: a.name, style: ambianceTokens(a), meteo: readMeteo(o.meteo, AMBIANCE_METEO[a.name] ?? [], issue) };
}

function readMeteo(v: unknown, def: string[], issue: (msg: string) => void): string[] {
  if (v === undefined || v === null) return [...def];
  if (v === false || v === "" || v === "aucune") return [];
  const list = (Array.isArray(v) ? v : [v]).map(String);
  const out = list.filter((x) => (METEO_PRESETS as readonly string[]).includes(x));
  for (const x of list) if (!out.includes(x)) issue(`météo « ${x} » inconnue (${METEO_PRESETS.join(", ")})`);
  return out.slice(0, 2);
}

/** Jetons procgen d'une ambiance lue (pur : testable sans rendu). */
export function ambianceTokens(a: AmbianceSpec): Record<string, unknown> {
  const st: Record<string, unknown> = typeof a.style === "string" ? { preset: a.style } : a.style && typeof a.style === "object" ? { ...(a.style as Record<string, unknown>) } : {};
  const L = a.lumiere ?? {};
  // lumière : l'intensité du format est physique (three) ; 1,6 y vaut le soleil neutre de procgen
  if (typeof L.intensite === "number") st.lightIntensity = r3(Math.max(0.2, Math.min(3, L.intensite / 1.6)));
  if (typeof L.hauteur === "number") st.lightElevation = L.hauteur;
  if (typeof L.azimut === "number") st.lightAzimuth = L.azimut;
  if (L.couleur && L.couleur !== "#ffffff") st.sunColor = L.couleur;
  if (typeof L.ambiante === "number") st.ambient = r3(Math.max(0.2, Math.min(3, L.ambiante / 0.55)));
  if (L.couleurAmbiante && L.couleurAmbiante !== "#ffffff") st.ambientColor = L.couleurAmbiante;
  // ciel, brume
  if (a.ciel) {
    st.skyHorizon = a.ciel;
    st.skyTop = skyTopFrom(a.ciel);
  }
  if (typeof a.brume === "number") st.fog = r3(0.1 + a.brume * 2.1);
  // rendu : le look ne remplace pas l'ombrage choisi par le style de l'ambiance
  if (st.shading === undefined && st.preset === undefined) st.shading = a.look === "toon" ? "toon" : a.look === "brillant" ? "lit" : "soft";
  if (a.environnement) st.environment = a.environnement;
  // couleurs par rôle
  const roles: Record<string, string> = { ...((st.roles as Record<string, string>) ?? {}) };
  for (const [k, c] of Object.entries(a.palette ?? {})) {
    for (const r of PALETTE_ROLES[k] ?? []) roles[r] = c;
    if (k === "sol" && greenish(c)) roles.grass = c;
    if (k === "feuillage") roles.leaf2 = c;
  }
  // finis : celui de l'ambiance pour les pièces fabriquées qui n'en ont pas
  const mat: Record<string, unknown> = { ...((st.matieres as Record<string, unknown>) ?? {}) };
  if (a.finish) for (const r of FINISH_ROLES) if (mat[r] === undefined) mat[r] = a.finish;
  if (Object.keys(mat).length) st.matieres = mat;
  // étalonnage : jetons de l'image de base (vignette, pixels, occlusion) et pile d'effets
  const g = { ...GRADE0, ...a.grade };
  st.grain = 0; // le grain de l'ambiance est figé (pile), pas animé : rendu à la demande
  st.vignette = r3(g.vignette);
  if (g.pixel > 1) st.pixel = Math.round(g.pixel);
  if (g.occlusion > 0) st.ao = r3(0.55 + g.occlusion * 0.45);
  const post: Record<string, unknown>[] = [];
  if (g.paint > 0) post.push({ fx: "kuwahara-aniso", radius: Math.max(2, Math.min(12, g.paint)), dither: g.dither, levels: g.posterize > 1 ? Math.min(32, Math.round(g.posterize)) : 6, pattern: "bruit-bleu" });
  if (g.silhouette > 0) post.push({ fx: "silhouette", color: a.ciel ?? "#d9d7cf", mix: g.silhouette });
  const sat = g.saturation * (1 - g.bw);
  if (Math.abs(sat - 1) > 0.01 || Math.abs(g.contrast - 1) > 0.01 || Math.abs(g.brightness - 1) > 0.01 || g.tint)
    post.push({ fx: "couleur", saturation: r3(sat), contrast: r3(g.contrast), exposure: r3(Math.log2(g.brightness)), ...(g.tint ? { tint: g.tint } : {}) });
  if (g.sepia > 0) post.push({ fx: "sepia", mix: r3(g.sepia) });
  if (g.posterize > 1 && g.paint <= 0) post.push({ fx: "niveaux", levels: Math.min(32, Math.round(g.posterize)), dither: g.dither || 0.2, cell: g.pixel > 1 ? Math.round(g.pixel) : 1 });
  if (g.bloom >= 0.15) post.push({ fx: "bloom", intensity: r3(Math.min(3, g.bloom * 1.5)), threshold: g.bloomThreshold });
  if (g.outline > 0) {
    // contour clair et coloré : tubes de néon ; sombre : encre des contours du style
    if (bright(g.outlineColor)) post.push({ fx: "neon", color: g.outlineColor, color2: g.outlineColor, width: 1.2, glow: 0.6, dark: 0.1, image: 1, mix: r3(g.outline) });
    else {
      st.outline = r3(1.2 + g.outline);
      st.outlineStrength = r3(g.outline);
      roles.ink = g.outlineColor;
    }
  }
  if (g.aberration > 0) post.push({ fx: "aberration", amount: r3(g.aberration * 6) });
  if (g.scanlines > 0) post.push({ fx: "crt", curvature: 0, scanlines: r3(g.scanlines * 1.5), grille: 0, bleed: 0 });
  if (g.grain > 0) post.push({ fx: "grain", amount: r3(Math.min(1, g.grain * 3)), chroma: 0.15 });
  if (Object.keys(roles).length) st.roles = roles;
  st.post = post;
  return st;
}

export const AMBIANCE_NAMES = Object.keys(AMBIANCES);
