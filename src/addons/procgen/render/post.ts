/**
 * Post-traitement de procgen : **pile d'effets** paramétriques, cumulables, appliqués dans l'ordre donné.
 *
 * Jeton de style `post` : liste `{fx, mix?, mask?, ...réglages}` (8 effets au plus après expansion des préréglages),
 * un nom de préréglage (`"riso"`), ou un objet `{preset, ...surcharges}`. Chaque effet a son intensité `mix` (0..1)
 * et un masque facultatif par profondeur (`near`, `far`, `{from, to, soft, invert}`) ou avant / arrière-plan
 * (`objects`, `sky`) lu dans la cible de données de la scène (profondeur, normales, identifiant).
 *
 * Ce module est pur (aucun three.js) : schémas, préréglages, validation, et découpe en passes GPU (voir
 * `postglsl.ts` pour le code GLSL, `poststack.ts` pour l'exécution). Les réglages deviennent des uniformes : changer
 * un réglage ne recompile rien ; changer la liste d'effets recompose les passes (shaders mis en cache).
 */
import { type Issues, suggest } from "../core/schema";
import { hexToRgb, rgbToOklch } from "../style/color";

/* ---------------- réglages ---------------- */

export type PostParam =
  | { t: "num"; def: number; min: number; max: number; doc: string; int?: boolean }
  | { t: "enum"; def: string; options: readonly string[]; doc: string }
  | { t: "color"; def: string; doc: string }
  | { t: "colors"; def: string[]; min: number; max: number; doc: string; named?: Record<string, string[]> }
  | { t: "bool"; def: boolean; doc: string };

export type ParamValue = number | string | boolean | string[];
export type PostParams = Record<string, ParamValue>;

/** Masque normalisé : 0 aucun, 1 plus près que `a`, 2 plus loin que `a`, 3 entre `a` et `b`, 4 objets, 5 ciel. */
export type PostMask = { mode: 0 | 1 | 2 | 3 | 4 | 5; a: number; b: number; soft: number; invert: boolean };

export type PostFx = { fx: string; mix: number; mask: PostMask; params: PostParams };

export type PostQuality = "auto" | "low" | "high";
export const POST_QUALITIES: readonly PostQuality[] = ["auto", "low", "high"];
export const MAX_POST = 8;

/** Structure d'une passe : `point` (couleur d'un pixel seul, fusionnable), `source` (lit le voisinage ou déplace l'image). */
export type FxKind = "point" | "source";
/** Passes annexes : tenseur de structure lissé (Kuwahara anisotrope), image floutée basse résolution (bloom, halo, miniature). */
export type AuxKind = "tensor" | "blur";

export type FxDef = {
  /** Nom français (documentation). */
  label: string;
  family: "peinture" | "impression" | "trame" | "lumiere" | "excentrique" | "base";
  doc: string;
  kind: FxKind;
  aux?: AuxKind;
  /** Passe coûteuse : à demi-résolution en qualité basse. */
  heavy?: boolean;
  params: Record<string, PostParam>;
  /** Nombre de vec4 d'uniformes de l'effet. */
  slots: number;
  /** Réglages → flottants (slots × 4). */
  pack: (p: PostParams) => number[];
  /** Réglages de la passe annexe : seuil (0..1) et rayon (fraction du petit côté de l'écran). */
  auxPack?: (p: PostParams) => { threshold: number; radius: number };
  animated?: (p: PostParams) => boolean;
};

const num = (def: number, min: number, max: number, doc: string, int = false): PostParam => ({ t: "num", def, min, max, doc, int });
const col = (def: string, doc: string): PostParam => ({ t: "color", def, doc });
const D = Math.PI / 180;

/** Couleur sRGB 0..1 d'un hexadécimal déjà validé. */
const rgb = (h: unknown) => hexToRgb(String(h));
const n = (p: PostParams, k: string) => Number(p[k]);

/** Palettes nommées (postérisation, carte de dégradé). */
export const POST_PALETTES: Record<string, string[]> = {
  gameboy: ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"],
  pico8: ["#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8", "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa"],
  cga: ["#000000", "#55ffff", "#ff55ff", "#ffffff"],
  mac: ["#1b1b1b", "#f2f0e6"],
  zx: ["#000000", "#0000d7", "#d70000", "#d700d7", "#00d700", "#00d7d7", "#d7d700", "#d7d7d7", "#0000ff", "#ff0000", "#ff00ff", "#00ff00", "#00ffff", "#ffff00", "#ffffff"],
  nord: ["#2e3440", "#3b4252", "#4c566a", "#d8dee9", "#eceff4", "#8fbcbb", "#88c0d0", "#5e81ac", "#bf616a", "#d08770", "#ebcb8b", "#a3be8c", "#b48ead"],
  pastel: ["#3d3a4b", "#7d84b2", "#8fa6cb", "#dbf4a7", "#d5f9de", "#f7d6e0", "#f2b5d4", "#fdf6ec"],
  terre: ["#2b1d14", "#5b3a29", "#8c5a3c", "#b9824f", "#d9b48f", "#efe0c8", "#6b705c", "#a5a58d"],
  ocean: ["#03045e", "#023e8a", "#0077b6", "#0096c7", "#48cae4", "#ade8f4", "#f1faee"],
  braise: ["#120d1a", "#3d1530", "#7a1f2b", "#c2412d", "#f08a24", "#ffd166", "#fff3d6"],
  // cartes de dégradé
  coucher: ["#1a1033", "#5b2a6e", "#c8445c", "#f59c5b", "#ffe3a3"],
  menthe: ["#0b2027", "#40798c", "#70a9a1", "#cfd7c7", "#f6f1d1"],
  encre: ["#1c1b22", "#4a4458", "#b8ac9a", "#f2ead8"],
  pop: ["#2d00f7", "#f20089", "#ffbd00", "#fff4e0"],
  nuit: ["#05070f", "#1b2a49", "#3e5c8a", "#9fb7d9", "#f5f7ff"],
};

/** Encres Riso usuelles. */
export const RISO_INKS: Record<string, string> = {
  rose: "#ff48b0", bleu: "#0078bf", jaune: "#ffe800", vert: "#00a95c", rouge: "#ff665e", orange: "#ff6c2f", violet: "#765ba7", noir: "#000000", turquoise: "#00838a", marine: "#2f4a8a",
};

/* ---------------- séparation par projection sur les encres ---------------- */

/**
 * Séparation d'encres (modèle soustractif de Beer–Lambert) : l'absorbance du pixel A = −ln(c / papier) est projetée
 * sur les absorbances des encres a_i = −ln(encre_i) par moindres carrés régularisés : k = (MᵀM + λI)⁻¹ Mᵀ A.
 * Rend les 3 lignes de la matrice (3 × 3, lignes nulles au-delà du nombre d'encres) et les absorbances.
 */
export function inkSeparation(inks: string[], paper: string): { rows: number[][]; absorb: number[][] } {
  const P = rgb(paper);
  const a = inks.slice(0, 3).map((h) => {
    const c = rgb(h);
    return [0, 1, 2].map((j) => -Math.log(Math.max(c[j], 0.02) / Math.max(P[j], 0.05)));
  });
  const k = a.length;
  // N = MᵀM + λI (k × k), M = colonnes a_i (3 × k)
  const G: number[][] = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => a[i][0] * a[j][0] + a[i][1] * a[j][1] + a[i][2] * a[j][2]));
  // régularisation relative (encres presque colinéaires : solution bornée plutôt qu'explosive)
  const lam = 1e-6 * (G.reduce((s, r, i) => s + r[i], 0) / k + 1e-6);
  const N = G.map((r, i) => r.map((v, j) => v + (i === j ? lam : 0)));
  const inv = invert(N);
  const rows = [0, 1, 2].map((i) => (i < k ? [0, 1, 2].map((c) => inv[i].reduce((s, v, j) => s + v * a[j][c], 0)) : [0, 0, 0]));
  const absorb = [0, 1, 2].map((i) => (i < k ? a[i] : [0, 0, 0]));
  return { rows, absorb };
}

/** Inverse de Gauss–Jordan (petites matrices, pivot partiel). */
export function invert(m: number[][]): number[][] {
  const k = m.length;
  const A = m.map((r, i) => [...r, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c] || 1e-9;
    for (let j = 0; j < 2 * k; j++) A[c][j] /= d;
    for (let r = 0; r < k; r++) if (r !== c) {
      const f = A[r][c];
      for (let j = 0; j < 2 * k; j++) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((r) => r.slice(k));
}

/** OKLab (L, a, b) d'un hexadécimal. */
export function hexToOklab(h: string): [number, number, number] {
  const [L, C, hd] = rgbToOklch(rgb(h));
  return [L, C * Math.cos(hd * D), C * Math.sin(hd * D)];
}

const flat = (...vs: (number | number[])[]) => vs.flat();
const pad = (a: number[], len: number) => (a.length >= len ? a.slice(0, len) : [...a, ...new Array(len - a.length).fill(0)]);

/* ---------------- effets ---------------- */

const PAT = ["bayer", "bruit-bleu"] as const;
const pat = (p: PostParams, k = "pattern") => (p[k] === "bruit-bleu" ? 1 : 0);

export const POST_FX: Record<string, FxDef> = {
  /* --- Peinture --- */
  "kuwahara-aniso": {
    label: "Kuwahara anisotrope", family: "peinture", kind: "source", aux: "tensor", heavy: true,
    doc: "Peinture aux aplats étirés le long des formes (Kyprianidis, Kang, Döllner 2009) : tenseur de structure lissé, fenêtre elliptique orientée, secteurs pondérés. Pré-tramage ordonné facultatif (la trame fondue par le filtre donne des transitions douces).",
    params: {
      radius: num(5, 2, 12, "rayon (px)"), sectors: num(8, 4, 8, "secteurs (4 ou 8)", true), sharpness: num(8, 1, 16, "netteté q"), alpha: num(1, 0.3, 4, "étirement (petit = plus étiré)"),
      dither: num(0, 0, 1, "force du pré-tramage (0 = aucun)"), levels: num(8, 2, 32, "niveaux par canal du pré-tramage", true), pattern: { t: "enum", def: "bayer", options: PAT, doc: "motif du pré-tramage" }, cell: num(1, 1, 4, "taille de la cellule de trame (px)"),
    },
    slots: 2,
    pack: (p) => flat(n(p, "radius"), n(p, "sectors") >= 6 ? 8 : 4, n(p, "sharpness"), n(p, "alpha"), n(p, "dither"), n(p, "levels"), pat(p), n(p, "cell")),
    auxPack: (p) => ({ threshold: 0, radius: n(p, "radius") }),
  },
  kuwahara: {
    label: "Kuwahara", family: "peinture", kind: "source", heavy: true,
    doc: "Kuwahara isotrope (4 quadrants, garde la moyenne du plus homogène) : petites plages de couleur aux bords francs.",
    params: { radius: num(4, 2, 10, "rayon (px)") },
    slots: 1,
    pack: (p) => [n(p, "radius"), 0, 0, 0],
  },
  huile: {
    label: "Huile (empâtement)", family: "peinture", kind: "source",
    doc: "Empâtement en relief éclairé : la luminance devient une hauteur de pâte, striée de coups de brosse dans le sens des formes, éclairée en rasant.",
    params: { relief: num(0.8, 0, 2, "hauteur de pâte"), size: num(2, 1, 6, "échelle du relief (px)"), light: num(135, 0, 360, "direction de la lumière (°)"), brush: num(0.45, 0, 1, "stries de brosse"), shine: num(0.35, 0, 1, "brillant du vernis") },
    slots: 2,
    pack: (p) => [n(p, "relief"), n(p, "size"), n(p, "light") * D, n(p, "brush"), n(p, "shine"), 0, 0, 0],
  },
  aquarelle: {
    label: "Aquarelle", family: "peinture", kind: "source",
    doc: "Lavis transparents : diffusion, bords foncés où le pigment s'accumule, granulation dans le grain du papier, contours qui ondulent.",
    params: { bleed: num(0.45, 0, 1, "diffusion"), edges: num(0.6, 0, 1, "bords foncés"), granulation: num(0.5, 0, 1, "granulation"), paper: num(0.6, 0, 1, "papier"), scale: num(1.5, 0.5, 4, "échelle (px)"), wobble: num(0.5, 0, 1, "ondulation") },
    slots: 2,
    pack: (p) => [n(p, "bleed"), n(p, "edges"), n(p, "granulation"), n(p, "paper"), n(p, "scale"), n(p, "wobble"), 0, 0],
  },

  /* --- Encres et impression --- */
  bichromie: {
    label: "Bichromie", family: "impression", kind: "point",
    doc: "Deux encres sur papier : l'encre sombre dans les ombres, la seconde dans les demi-tons, en surimpression.",
    params: { ink: col("#1d3557", "encre sombre"), ink2: col("#e76f51", "seconde encre"), paper: col("#f4ede0", "papier"), contrast: num(1.2, 0.3, 3, "contraste"), balance: num(0, -0.5, 0.5, "équilibre (− sombre, + clair)") },
    slots: 3,
    pack: (p) => flat(rgb(p.ink), n(p, "balance"), rgb(p.ink2), n(p, "contrast"), rgb(p.paper), 0),
  },
  trichromie: {
    label: "Trichromie", family: "impression", kind: "point",
    doc: "Trois encres : séparation par projection de chaque couleur sur les encres (modèle soustractif), recombinées en surimpression ; `levels` postérise chaque plaque (tramage ordonné).",
    params: { inks: { t: "colors", def: ["#1f9bd1", "#ef476f", "#ffd166"], min: 2, max: 3, doc: "encres (2 ou 3)" }, paper: col("#f5efe3", "papier"), levels: num(0, 0, 8, "niveaux par plaque (0 = continu)", true), dither: num(0.7, 0, 1, "tramage des plaques"), pattern: { t: "enum", def: "bayer", options: PAT, doc: "motif" } },
    slots: 8,
    pack: (p) => {
      const s = inkSeparation(p.inks as string[], String(p.paper));
      return flat(...s.rows.map((r) => [...r, 0]), rgb(p.paper), n(p, "levels"), ...s.absorb.map((r) => [...r, 0]), n(p, "dither"), pat(p), 0, 0);
    },
  },
  riso: {
    label: "Risographie", family: "impression", kind: "source",
    doc: "2 ou 3 encres Riso (noms : rose, bleu, jaune, vert, rouge, orange, violet, noir, turquoise, marine, ou hexadécimal) décalées de registre, grain stochastique ou trame de points, surimpression, densité d'encre irrégulière.",
    params: {
      inks: { t: "colors", def: ["#ff48b0", "#0078bf"], min: 2, max: 3, doc: "encres", named: Object.fromEntries(Object.entries(RISO_INKS).map(([k, v]) => [k, [v]])) },
      paper: col("#f7f2e8", "papier"), misregister: num(1.5, 0, 8, "décalage de registre (px)"), grain: num(0.7, 0, 1, "grain"), dot: num(0, 0, 12, "trame de points (px, 0 = grain)"), seed: num(1, 0, 99, "graine du registre", true),
    },
    slots: 10,
    pack: (p) => {
      const inks = p.inks as string[];
      const s = inkSeparation(inks, String(p.paper));
      const m = n(p, "misregister"), sd = n(p, "seed");
      const off = [0, 1, 2].map((i) => {
        const a = (sd * 2.39996 + i * 2.1) % (Math.PI * 2);
        return i === 0 ? [0, 0] : [Math.cos(a) * m, Math.sin(a) * m];
      });
      return flat(...s.rows.map((r) => [...r, 0]), rgb(p.paper), n(p, "grain"), ...s.absorb.map((r) => [...r, 0]), off[0], off[1], off[2], n(p, "dot"), inks.length, pad([], 4));
    },
  },
  cmjn: {
    label: "Demi-teinte CMJN", family: "impression", kind: "source",
    doc: "Quadrichromie tramée : cyan 15°, magenta 75°, jaune 0°, noir 45° (plus `angle`), points ronds proportionnels à l'encre, génération du noir réglable.",
    params: { size: num(6, 3, 20, "pas de trame (px)"), angle: num(0, -45, 45, "rotation des trames (°)"), gcr: num(0.5, 0, 1, "génération du noir"), paper: col("#fbf8f1", "papier") },
    slots: 2,
    pack: (p) => flat(n(p, "size"), n(p, "angle") * D, n(p, "gcr"), 0, rgb(p.paper), 0),
  },
  degrade: {
    label: "Carte de dégradé", family: "impression", kind: "point",
    doc: "La luminance parcourt un dégradé de 2 à 8 couleurs (mélange en OKLab) ; palette nommée ou liste.",
    params: { stops: { t: "colors", def: POST_PALETTES.coucher, min: 2, max: 8, doc: "couleurs, de l'ombre à la lumière", named: POST_PALETTES }, contrast: num(1, 0.3, 3, "contraste"), offset: num(0, -0.5, 0.5, "décalage") },
    slots: 9,
    pack: (p) => {
      const st = p.stops as string[];
      return flat(...pad(st.map((h, i) => [...hexToOklab(h), i / (st.length - 1)]).flat(), 32), st.length, n(p, "contrast"), n(p, "offset"), 0);
    },
  },
  palette: {
    label: "Postérisation par palette", family: "impression", kind: "point",
    doc: "Chaque pixel prend la couleur la plus proche (OKLab) d'une palette nommée (gameboy, pico8, cga, mac, zx, nord, pastel, terre, ocean, braise…) ou libre (16 couleurs au plus), avec tramage ordonné entre les deux plus proches ; `match: luminance` range la palette de la plus sombre à la plus claire et y projette la luminance (palettes monochromes : gameboy).",
    params: { colors: { t: "colors", def: POST_PALETTES.pico8, min: 2, max: 16, doc: "palette", named: POST_PALETTES }, match: { t: "enum", def: "couleur", options: ["couleur", "luminance"], doc: "correspondance" }, dither: num(0.6, 0, 1, "tramage"), pattern: { t: "enum", def: "bayer", options: PAT, doc: "motif" }, cell: num(1, 1, 8, "taille de la cellule de trame (px)") },
    slots: 33,
    pack: (p) => {
      let cs = p.colors as string[];
      const lum = p.match === "luminance";
      if (lum) cs = [...cs].sort((a, b) => hexToOklab(a)[0] - hexToOklab(b)[0]);
      return flat(...pad(cs.map((h) => [...hexToOklab(h), 0]).flat(), 64), ...pad(cs.map((h) => [...rgb(h), 0]).flat(), 64), cs.length * (lum ? -1 : 1), n(p, "dither"), pat(p), n(p, "cell"));
    },
  },
  cyanotype: {
    label: "Cyanotype", family: "impression", kind: "point",
    doc: "Tirage au ferro-prussiate : bleu de Prusse profond, blancs de papier, léger voile.",
    params: { contrast: num(1.15, 0.3, 3, "contraste"), tone: num(0.5, 0, 1, "chaleur du papier"), depth: num(0.6, 0, 1, "profondeur du bleu") },
    slots: 1,
    pack: (p) => [n(p, "contrast"), n(p, "tone"), n(p, "depth"), 0],
  },
  sepia: {
    label: "Sépia", family: "impression", kind: "point",
    doc: "Virage sépia : bruns chauds, noirs relevés, hautes lumières crème.",
    params: { tone: num(0.6, 0, 1, "chaleur"), contrast: num(1.05, 0.3, 3, "contraste"), fade: num(0.15, 0, 0.6, "noirs relevés") },
    slots: 1,
    pack: (p) => [n(p, "tone"), n(p, "contrast"), n(p, "fade"), 0],
  },

  /* --- Trames et gravure --- */
  points: {
    label: "Trame de points", family: "trame", kind: "source",
    doc: "Similigravure : points ronds dont la taille suit l'ombre, sur une grille tournée ; `color` garde la couleur de l'image (points Ben-Day).",
    params: { size: num(6, 3, 24, "pas (px)"), angle: num(45, -90, 90, "angle (°)"), color: { t: "bool", def: false, doc: "points de la couleur de l'image" }, ink: col("#1a1a1f", "encre"), paper: col("#f5f1e8", "papier") },
    slots: 3,
    pack: (p) => flat(n(p, "size"), n(p, "angle") * D, p.color ? 1 : 0, 0, rgb(p.ink), 0, rgb(p.paper), 0),
  },
  lignes: {
    label: "Trame de lignes", family: "trame", kind: "point",
    doc: "Lignes parallèles dont l'épaisseur suit l'ombre (gravure en taille-douce), légèrement ondulées.",
    params: { size: num(5, 2, 20, "pas (px)"), angle: num(30, -90, 90, "angle (°)"), wobble: num(0.3, 0, 1, "ondulation"), ink: col("#1d1b22", "encre"), paper: col("#f3eddf", "papier") },
    slots: 3,
    pack: (p) => flat(n(p, "size"), n(p, "angle") * D, n(p, "wobble"), 0, rgb(p.ink), 0, rgb(p.paper), 0),
  },
  hachures: {
    label: "Hachures croisées", family: "trame", kind: "point",
    doc: "Hachures superposées par paliers de luminance (1 à 4 directions), trait vibré.",
    params: { size: num(5, 2, 16, "pas (px)"), angle: num(40, -90, 90, "angle de la première passe (°)"), layers: num(4, 1, 4, "directions", true), wobble: num(0.4, 0, 1, "vibration du trait"), ink: col("#2b2118", "encre"), paper: col("#efe6d2", "papier") },
    slots: 3,
    pack: (p) => flat(n(p, "size"), n(p, "angle") * D, n(p, "layers"), n(p, "wobble"), rgb(p.ink), 0, rgb(p.paper), 0),
  },
  "1bit": {
    label: "Tramage ordonné 1 bit", family: "trame", kind: "point",
    doc: "Deux couleurs seulement, tramage ordonné (Bayer 8×8) ou bruit bleu procédural.",
    params: { ink: col("#1b1b1b", "encre"), paper: col("#f2f0e6", "papier"), pattern: { t: "enum", def: "bayer", options: PAT, doc: "motif" }, cell: num(1, 1, 6, "taille de la cellule (px)"), contrast: num(1.1, 0.3, 3, "contraste"), bias: num(0, -0.5, 0.5, "seuil (− plus clair)") },
    slots: 3,
    pack: (p) => flat(n(p, "cell"), pat(p), n(p, "contrast"), n(p, "bias"), rgb(p.ink), 0, rgb(p.paper), 0),
  },
  lino: {
    label: "Linogravure", family: "trame", kind: "source",
    doc: "Encre pleine dans les ombres, papier dans les lumières, gouges blanches dans les demi-tons qui suivent les formes (orientation du gradient), bords mâchés.",
    params: { threshold: num(0.5, 0.1, 0.9, "seuil"), size: num(5, 2, 14, "pas des gouges (px)"), angle: num(20, -90, 90, "angle des gouges sans forme (°)"), rough: num(0.5, 0, 1, "bords irréguliers"), ink: col("#16131a", "encre"), paper: col("#efe7d6", "papier") },
    slots: 3,
    pack: (p) => flat(n(p, "threshold"), n(p, "size"), n(p, "angle") * D, n(p, "rough"), rgb(p.ink), 0, rgb(p.paper), 0),
  },
  pointillisme: {
    label: "Pointillisme", family: "trame", kind: "source",
    doc: "Touches rondes juxtaposées, couleurs vibrées (petits écarts de teinte), papier entre les points.",
    params: { size: num(5, 2, 16, "taille des touches (px)"), jitter: num(0.6, 0, 1, "vibration des couleurs"), saturation: num(1.25, 0.5, 2, "saturation"), paper: col("#f4eee2", "papier") },
    slots: 2,
    pack: (p) => flat(n(p, "size"), n(p, "jitter"), n(p, "saturation"), 0, rgb(p.paper), 0),
  },
  vitrail: {
    label: "Vitrail", family: "trame", kind: "source",
    doc: "Mosaïque de Voronoï : chaque verre prend la couleur de son centre, lumière qui traverse, plomb entre les verres.",
    params: { size: num(22, 6, 80, "taille des verres (px)"), lead: num(0.12, 0, 0.4, "épaisseur du plomb"), glow: num(0.5, 0, 1, "lumière traversante"), lead_color: col("#1c1a1f", "couleur du plomb") },
    slots: 2,
    pack: (p) => flat(n(p, "size"), n(p, "lead"), n(p, "glow"), 0, rgb(p.lead_color), 0),
  },

  /* --- Lumière et optique --- */
  bloom: {
    label: "Bloom doux", family: "lumiere", kind: "source", aux: "blur",
    doc: "Les hautes lumières débordent en un halo doux (seuil à genou, flou séparable à basse résolution).",
    params: { intensity: num(0.8, 0, 3, "intensité"), threshold: num(0.65, 0, 1, "seuil"), radius: num(1, 0.2, 3, "rayon"), tint: col("#fff2e0", "teinte") },
    slots: 2,
    pack: (p) => flat(n(p, "intensity"), 0, 0, 0, rgb(p.tint), 0),
    auxPack: (p) => ({ threshold: n(p, "threshold"), radius: n(p, "radius") * 0.025 }),
  },
  halo: {
    label: "Halo (effet Orton)", family: "lumiere", kind: "source", aux: "blur",
    doc: "Toute l'image floutée en écran par-dessus elle-même : lumière diffuse, rêveuse.",
    params: { intensity: num(0.45, 0, 1.5, "intensité"), radius: num(1.2, 0.2, 3, "rayon"), tint: col("#ffe9d6", "teinte") },
    slots: 2,
    pack: (p) => flat(n(p, "intensity"), 0, 0, 0, rgb(p.tint), 0),
    auxPack: (p) => ({ threshold: 0, radius: n(p, "radius") * 0.03 }),
  },
  aberration: {
    label: "Aberration chromatique", family: "lumiere", kind: "source",
    doc: "Rouge et bleu décalés, du centre vers les bords (radial) ou en travers.",
    params: { amount: num(2, 0, 20, "décalage (px)"), radial: { t: "bool", def: true, doc: "radial (sinon horizontal)" } },
    slots: 1,
    pack: (p) => [n(p, "amount"), p.radial ? 1 : 0, 0, 0],
  },
  miniature: {
    label: "Effet miniature", family: "lumiere", kind: "source", aux: "blur",
    doc: "Bascule-décentrement : net à la distance du point visé, flou devant et derrière (profondeur réelle de la scène), couleurs vives : la scène devient une maquette.",
    params: { focus: num(1, 0.3, 3, "distance nette (1 = point visé)"), range: num(0.25, 0.02, 2, "profondeur de champ"), blur: num(1, 0, 1, "flou"), radius: num(1, 0.3, 3, "rayon du flou"), saturation: num(1.25, 0.5, 2, "saturation") },
    slots: 2,
    pack: (p) => [n(p, "focus"), n(p, "range"), n(p, "blur"), n(p, "saturation"), 0, 0, 0, 0],
    auxPack: (p) => ({ threshold: 0, radius: n(p, "radius") * 0.006 }),
  },
  brume: {
    label: "Brume colorée", family: "lumiere", kind: "point",
    doc: "Brume de profondeur teintée, posée sur l'image finie (en plus de la brume du style).",
    params: { color: col("#c9b7e8", "couleur"), start: num(0.8, 0, 3, "début (1 = point visé)"), density: num(0.8, 0, 3, "densité"), sky: num(0.7, 0, 1, "sur le ciel") },
    slots: 2,
    pack: (p) => flat(n(p, "start"), n(p, "density"), n(p, "sky"), 0, rgb(p.color), 0),
  },
  grain: {
    label: "Grain argentique", family: "lumiere", kind: "point",
    doc: "Grain de film, plus marqué dans les demi-tons, chromatique ou non, animé ou figé.",
    params: { amount: num(0.4, 0, 1, "quantité"), size: num(1.5, 1, 4, "taille (px)"), chroma: num(0.3, 0, 1, "grain coloré"), animated: { t: "bool", def: false, doc: "grain animé" } },
    slots: 1,
    pack: (p) => [n(p, "amount"), n(p, "size"), n(p, "chroma"), p.animated ? 1 : 0],
    animated: (p) => !!p.animated,
  },
  vignette: {
    label: "Vignette", family: "lumiere", kind: "point",
    doc: "Assombrit (ou colore) les bords du cadre.",
    params: { amount: num(0.5, 0, 1, "force"), roundness: num(0.7, 0, 1, "rondeur"), softness: num(0.6, 0.05, 1, "douceur"), color: col("#0d0b10", "couleur") },
    slots: 2,
    pack: (p) => flat(n(p, "amount"), n(p, "roundness"), n(p, "softness"), 0, rgb(p.color), 0),
  },
  fuite: {
    label: "Fuite de lumière", family: "lumiere", kind: "point",
    doc: "Voile chaud entré par un bord de la pellicule, en lueur d'écran.",
    params: { amount: num(0.5, 0, 1, "force"), angle: num(35, 0, 360, "bord d'entrée (°)"), color: col("#ff7a3d", "couleur"), color2: col("#ffd27a", "seconde couleur"), speed: num(0, 0, 2, "dérive animée") },
    slots: 3,
    pack: (p) => flat(n(p, "amount"), n(p, "angle") * D, n(p, "speed"), 0, rgb(p.color), 0, rgb(p.color2), 0),
    animated: (p) => n(p, "speed") > 0,
  },

  /* --- Excentriques --- */
  neon: {
    label: "Néon des contours", family: "excentrique", kind: "source",
    doc: "Les arêtes de la géométrie (profondeur, normales, objets) et de l'image deviennent des tubes de néon lumineux sur fond assombri.",
    params: { color: col("#ff3fd2", "couleur"), color2: col("#38e8ff", "couleur des plis"), width: num(1.5, 0.5, 4, "épaisseur (px)"), glow: num(0.8, 0, 2, "lueur"), dark: num(0.85, 0, 1, "fond éteint"), image: num(0.3, 0, 1, "couleur de l'image dans les tubes") },
    slots: 3,
    pack: (p) => flat(n(p, "width"), n(p, "glow"), n(p, "dark"), n(p, "image"), rgb(p.color), 0, rgb(p.color2), 0),
  },
  thermique: {
    label: "Caméra thermique", family: "excentrique", kind: "point",
    doc: "Palette « fer chaud » ; les objets proches sont plus chauds, le ciel froid.",
    params: { contrast: num(1.8, 0.3, 4, "contraste"), depth: num(0.4, 0, 1, "chaleur des objets proches") },
    slots: 1,
    pack: (p) => [n(p, "contrast"), n(p, "depth"), 0, 0],
  },
  glitch: {
    label: "Glitch", family: "excentrique", kind: "source",
    doc: "Bandes décalées, canaux RVB séparés, blocs corrompus ; figé (graine) ou animé (`speed`).",
    params: { amount: num(0.35, 0, 1, "quantité"), bands: num(24, 4, 80, "bandes", true), shift: num(6, 0, 40, "décalage RVB (px)"), speed: num(0, 0, 3, "animation"), seed: num(3, 0, 99, "graine", true) },
    slots: 2,
    pack: (p) => [n(p, "amount"), n(p, "bands"), n(p, "shift"), n(p, "speed"), n(p, "seed"), 0, 0, 0],
    animated: (p) => n(p, "speed") > 0,
  },
  crt: {
    label: "Écran cathodique", family: "excentrique", kind: "source",
    doc: "Courbure du verre, lignes de balayage, grille de luminophores RVB, bavure lumineuse, coins sombres.",
    params: { curvature: num(0.35, 0, 1, "courbure"), scanlines: num(0.5, 0, 1, "balayage"), grille: num(0.35, 0, 1, "grille RVB"), bleed: num(0.4, 0, 1, "bavure"), flicker: num(0, 0, 1, "scintillement") },
    slots: 2,
    pack: (p) => [n(p, "curvature"), n(p, "scanlines"), n(p, "grille"), n(p, "bleed"), n(p, "flicker"), 0, 0, 0],
    animated: (p) => n(p, "flicker") > 0,
  },
  decoupe: {
    label: "Papier découpé", family: "excentrique", kind: "source",
    doc: "Postérisation en couches de papier superposées, chaque couche portant son ombre sur la suivante.",
    params: { layers: num(5, 2, 10, "couches", true), shadow: num(4, 0, 16, "ombre (px)"), angle: num(135, 0, 360, "direction de l'ombre (°)"), texture: num(0.5, 0, 1, "fibres du papier"), saturation: num(1.1, 0.3, 2, "saturation") },
    slots: 2,
    pack: (p) => [n(p, "layers"), n(p, "shadow"), n(p, "angle") * D, n(p, "texture"), n(p, "saturation"), 0, 0, 0],
  },
  kaleido: {
    label: "Kaléidoscope", family: "excentrique", kind: "source",
    doc: "Symétrie en miroirs autour du centre.",
    params: { segments: num(6, 2, 16, "branches", true), rotation: num(0, 0, 360, "rotation (°)"), zoom: num(1, 0.3, 3, "zoom"), x: num(0.5, 0, 1, "centre x"), y: num(0.5, 0, 1, "centre y") },
    slots: 2,
    pack: (p) => [n(p, "segments"), n(p, "rotation") * D, n(p, "zoom"), 0, n(p, "x"), n(p, "y"), 0, 0],
  },
  pixel: {
    label: "Pixels", family: "base", kind: "source",
    doc: "Gros pixels (après le rendu, contrairement au jeton `pixel` qui rend la scène en basse résolution).",
    params: { size: num(4, 2, 32, "taille (px)") },
    slots: 1,
    pack: (p) => [n(p, "size"), 0, 0, 0],
  },
  couleur: {
    label: "Réglages de couleur", family: "base", kind: "point",
    doc: "Exposition, contraste, saturation, rotation de teinte, température, gamma.",
    params: { exposure: num(0, -2, 2, "exposition (IL)"), contrast: num(1, 0.3, 3, "contraste"), saturation: num(1, 0, 3, "saturation"), hue: num(0, -180, 180, "teinte (°)"), temperature: num(0, -1, 1, "température (− froid, + chaud)"), gamma: num(1, 0.3, 3, "gamma") },
    slots: 2,
    pack: (p) => [n(p, "exposure"), n(p, "contrast"), n(p, "saturation"), n(p, "hue") * D, n(p, "temperature"), n(p, "gamma"), 0, 0],
  },
};

export const POST_FX_IDS = Object.keys(POST_FX);

/* ---------------- préréglages ---------------- */

type RawFx = Record<string, unknown> & { fx: string };

/** Préréglages combinés (utilisables par nom : `post: "riso"`, ou dans une liste : `{preset: "riso", mix: 0.8}`). */
export const POST_PRESETS: Record<string, { doc: string; fx: RawFx[] }> = {
  riso: { doc: "Risographie deux encres rose et bleu, registre décalé, grain", fx: [{ fx: "couleur", contrast: 1.1 }, { fx: "riso", inks: ["rose", "bleu"] }] },
  "riso-3": { doc: "Risographie trois encres (rose, jaune, bleu)", fx: [{ fx: "riso", inks: ["rose", "jaune", "bleu"], misregister: 2 }] },
  "trame-aniso": { doc: "Kuwahara anisotrope avec pré-tramage (l'effet de l'outil de vectorisation)", fx: [{ fx: "kuwahara-aniso", radius: 5, dither: 0.8, levels: 6, pattern: "bruit-bleu" }] },
  huile: { doc: "Peinture à l'huile : aplats orientés puis empâtement éclairé", fx: [{ fx: "kuwahara-aniso", radius: 6 }, { fx: "huile" }, { fx: "vignette", amount: 0.3 }] },
  aquarelle: { doc: "Aquarelle : aplats doux, lavis, bords foncés, papier", fx: [{ fx: "kuwahara", radius: 3 }, { fx: "aquarelle" }] },
  gravure: { doc: "Gravure en taille-douce : hachures croisées brun-noir sur papier crème", fx: [{ fx: "couleur", contrast: 1.15, exposure: 0.2 }, { fx: "hachures" }, { fx: "vignette", amount: 0.3, color: "#2b2118" }] },
  lino: { doc: "Linogravure noir et crème, gouges dans les demi-tons", fx: [{ fx: "lino" }] },
  "bd-tramee": { doc: "Bande dessinée imprimée : couleurs vives en points Ben-Day", fx: [{ fx: "couleur", saturation: 1.3, contrast: 1.1 }, { fx: "points", color: true, size: 5 }] },
  pop: { doc: "Quadrichromie CMJN à gros points", fx: [{ fx: "couleur", saturation: 1.15, exposure: 0.15 }, { fx: "cmjn", size: 6 }] },
  miniature: { doc: "Effet maquette : flou de profondeur de champ et couleurs vives", fx: [{ fx: "miniature" }, { fx: "couleur", contrast: 1.1 }] },
  cyanotype: { doc: "Cyanotype sur papier, grain et vignette", fx: [{ fx: "cyanotype" }, { fx: "grain", amount: 0.3, chroma: 0 }, { fx: "vignette", amount: 0.35, color: "#081a33" }] },
  sepia: { doc: "Vieille photographie sépia", fx: [{ fx: "sepia" }, { fx: "grain", amount: 0.45, chroma: 0 }, { fx: "vignette", amount: 0.45, color: "#2a1a0e" }] },
  vitrail: { doc: "Vitrail de verres colorés sertis de plomb, lumière diffuse", fx: [{ fx: "couleur", saturation: 1.3 }, { fx: "vitrail" }, { fx: "bloom", intensity: 0.5, threshold: 0.55 }] },
  "1bit": { doc: "Écran 1 bit des premiers Macintosh (noir et blanc tramé)", fx: [{ fx: "couleur", contrast: 1.2, exposure: 0.25 }, { fx: "1bit", cell: 1 }] },
  gameboy: { doc: "Console de poche : gros pixels, 4 verts tramés", fx: [{ fx: "couleur", contrast: 1.35, exposure: -0.2 }, { fx: "pixel", size: 3 }, { fx: "palette", colors: "gameboy", match: "luminance", dither: 0.8, cell: 3 }] },
  pico8: { doc: "Console fantaisie : pixels et palette de 16 couleurs", fx: [{ fx: "pixel", size: 3 }, { fx: "palette", colors: "pico8", dither: 0.4, cell: 3 }] },
  neon: { doc: "Contours en tubes de néon sur fond nocturne", fx: [{ fx: "neon" }, { fx: "bloom", intensity: 0.7, threshold: 0.55 }] },
  vhs: { doc: "Cassette vidéo sur écran cathodique : glitch léger, aberration, balayage", fx: [{ fx: "glitch", amount: 0.12, shift: 3 }, { fx: "aberration", amount: 2.5 }, { fx: "crt" }] },
  argentique: { doc: "Pellicule couleur : tons chauds, halo, grain, vignette, fuite de lumière", fx: [{ fx: "couleur", temperature: 0.25, contrast: 1.08, saturation: 0.9 }, { fx: "halo", intensity: 0.3 }, { fx: "fuite", amount: 0.35 }, { fx: "grain", amount: 0.35 }, { fx: "vignette", amount: 0.35 }] },
  thermique: { doc: "Caméra thermique", fx: [{ fx: "thermique" }] },
  bichromie: { doc: "Bichromie bleu nuit et corail sur papier, grain", fx: [{ fx: "bichromie" }, { fx: "grain", amount: 0.25, chroma: 0 }] },
  trichromie: { doc: "Trichromie bleu, rose, jaune, plaques tramées", fx: [{ fx: "trichromie", levels: 3 }] },
  pointillisme: { doc: "Pointillisme à la Seurat", fx: [{ fx: "pointillisme" }] },
  decoupe: { doc: "Papier découpé en couches avec ombres portées", fx: [{ fx: "decoupe" }] },
  coucher: { doc: "Carte de dégradé coucher de soleil, halo", fx: [{ fx: "degrade", stops: "coucher" }, { fx: "halo", intensity: 0.25 }] },
};

/* ---------------- validation ---------------- */

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const NO_MASK: PostMask = { mode: 0, a: 1, b: 1, soft: 0.15, invert: false };

function color(v: unknown, path: string, def: string, issues?: Issues, named?: Record<string, string>): string {
  if (typeof v === "string") {
    if (HEX.test(v)) return v.length === 4 ? "#" + v.slice(1).split("").map((c) => c + c).join("") : v.toLowerCase();
    if (named?.[v]) return named[v];
  }
  issues?.add({ path, code: "type", message: `couleur attendue (#rrggbb)${named ? " ou nom : " + Object.keys(named).join(", ") : ""}`, got: v, used: def });
  return def;
}

function parseMask(v: unknown, path: string, issues?: Issues): PostMask {
  if (v === undefined || v === null || v === false || v === "none") return { ...NO_MASK };
  if (typeof v === "string") {
    const m: Record<string, PostMask["mode"]> = { near: 1, proche: 1, far: 2, loin: 2, objects: 4, objets: 4, fg: 4, sky: 5, ciel: 5, bg: 5, fond: 5 };
    if (m[v]) return { ...NO_MASK, mode: m[v] };
    issues?.add({ path, code: "unknown", message: `masque « ${v} » inconnu`, hint: "near, far, objects, sky ou {from, to, soft, invert}", didYouMean: suggest(v, Object.keys(m)) });
    return { ...NO_MASK };
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const f = (k: string) => (Number.isFinite(Number(o[k])) && o[k] !== null && o[k] !== "" ? Math.max(0, Math.min(50, Number(o[k]))) : undefined);
    const from = f("from"), to = f("to");
    const soft = f("soft") ?? 0.15;
    const invert = o.invert === true;
    for (const k of Object.keys(o)) if (!["from", "to", "soft", "invert"].includes(k)) issues?.add({ path: `${path}.${k}`, code: "unknown", message: `clé de masque « ${k} » inconnue`, hint: "from, to, soft, invert" });
    if (from !== undefined && to !== undefined) return { mode: 3, a: Math.min(from, to), b: Math.max(from, to), soft, invert };
    if (from !== undefined) return { mode: 2, a: from, b: from, soft, invert };
    if (to !== undefined) return { mode: 1, a: to, b: to, soft, invert };
    return { ...NO_MASK, invert };
  }
  issues?.add({ path, code: "type", message: "masque : chaîne ou objet {from, to}", got: v });
  return { ...NO_MASK };
}

/** Un effet validé (réglages bornés, inconnus signalés). */
export function normalizeFx(raw: Record<string, unknown>, path: string, issues?: Issues): PostFx | null {
  const id = String(raw.fx ?? "");
  const def = POST_FX[id];
  if (!def) {
    issues?.add({ path: `${path}.fx`, code: "unknown", message: `effet « ${id} » inconnu`, didYouMean: suggest(id, POST_FX_IDS), hint: POST_FX_IDS.join(", ") });
    return null;
  }
  const params: PostParams = {};
  for (const [k, spec] of Object.entries(def.params)) {
    const v = raw[k];
    const pp = `${path}.${k}`;
    if (v === undefined) {
      params[k] = spec.t === "colors" ? [...spec.def] : spec.def;
      continue;
    }
    if (spec.t === "num") {
      const x = Number(v);
      if (typeof v === "boolean" || !Number.isFinite(x)) {
        issues?.add({ path: pp, code: "type", message: "nombre attendu", got: v, used: spec.def });
        params[k] = spec.def;
        continue;
      }
      let y = Math.max(spec.min, Math.min(spec.max, x));
      if (spec.int) y = Math.round(y);
      if (y !== x) issues?.add({ path: pp, code: "clamped", message: `ramené dans [${spec.min}, ${spec.max}]`, got: x, used: y });
      params[k] = y;
    } else if (spec.t === "bool") params[k] = v === true || v === "true" || v === 1;
    else if (spec.t === "enum") {
      if (spec.options.includes(String(v))) params[k] = String(v);
      else {
        issues?.add({ path: pp, code: "unknown", message: `valeur « ${String(v)} » inconnue`, hint: spec.options.join(", "), didYouMean: suggest(String(v), spec.options) });
        params[k] = spec.def;
      }
    } else if (spec.t === "color") params[k] = color(v, pp, spec.def, issues);
    else {
      // liste de couleurs : nom de palette, ou liste (noms d'encre admis)
      if (typeof v === "string" && spec.named?.[v] && spec.named[v].length >= spec.min) {
        params[k] = [...spec.named[v]].slice(0, spec.max);
        continue;
      }
      const flatNamed: Record<string, string> = {};
      for (const [nm, cs] of Object.entries(spec.named ?? {})) if (cs.length === 1) flatNamed[nm] = cs[0];
      if (!Array.isArray(v)) {
        issues?.add({ path: pp, code: "type", message: `liste de couleurs attendue${spec.named ? " ou nom : " + Object.keys(spec.named).filter((x) => spec.named![x].length >= spec.min).join(", ") : ""}`, got: v, didYouMean: typeof v === "string" ? suggest(v, Object.keys(spec.named ?? {})) : undefined });
        params[k] = [...spec.def];
        continue;
      }
      let cs = v.map((c, i) => color(c, `${pp}.${i}`, spec.def[i % spec.def.length], issues, flatNamed));
      if (cs.length > spec.max) {
        issues?.add({ path: pp, code: "limit", message: `${spec.max} couleurs au plus`, got: cs.length, used: spec.max });
        cs = cs.slice(0, spec.max);
      }
      if (cs.length < spec.min) {
        issues?.add({ path: pp, code: "limit", message: `${spec.min} couleurs au moins`, got: cs.length });
        cs = [...cs, ...spec.def.slice(cs.length, spec.min)];
      }
      params[k] = cs;
    }
  }
  for (const k of Object.keys(raw)) if (k !== "fx" && k !== "mix" && k !== "mask" && !(k in def.params)) issues?.add({ path: `${path}.${k}`, code: "unknown", message: `réglage « ${k} » inconnu pour ${id}`, didYouMean: suggest(k, Object.keys(def.params)), hint: Object.keys(def.params).join(", ") });
  let mix = 1;
  if (raw.mix !== undefined) {
    const x = Number(raw.mix);
    mix = Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 1;
    if (mix !== x) issues?.add({ path: `${path}.mix`, code: Number.isFinite(x) ? "clamped" : "type", message: "mix : 0..1", got: raw.mix, used: mix });
  }
  return { fx: id, mix, mask: parseMask(raw.mask, `${path}.mask`, issues), params };
}

/** Développe un préréglage ; les surcharges (`mix`, `mask`, réglages) s'appliquent aux effets qui les connaissent. */
function expandPreset(name: string, over: Record<string, unknown>, path: string, issues?: Issues): RawFx[] | null {
  const pr = POST_PRESETS[name];
  if (!pr) {
    issues?.add({ path, code: "unknown", message: `préréglage de post-traitement « ${name} » inconnu`, didYouMean: suggest(name, Object.keys(POST_PRESETS)), hint: Object.keys(POST_PRESETS).join(", ") });
    return null;
  }
  const used = new Set<string>();
  const out = pr.fx.map((f) => {
    const o: RawFx = { ...f };
    for (const [k, v] of Object.entries(over)) {
      if (k === "mix") o.mix = Math.max(0, Math.min(1, Number(v))) * (f.mix === undefined ? 1 : Number(f.mix));
      else if (k === "mask") o.mask = v;
      else if (k in POST_FX[f.fx].params) o[k] = v;
      else continue;
      used.add(k);
    }
    return o;
  });
  for (const k of Object.keys(over)) if (!used.has(k)) issues?.add({ path: `${path}.${k}`, code: "unknown", message: `réglage « ${k} » sans effet dans le préréglage ${name}` });
  return out;
}

/**
 * Normalise le jeton `post` : nom de préréglage, objet `{preset, …}`, ou liste d'effets (chaînes = effet ou
 * préréglage, objets `{fx, …}` ou `{preset, …}`). 8 effets au plus ; tout écart est signalé dans `issues`.
 */
export function resolvePost(input: unknown, issues?: Issues, path = "style.post"): PostFx[] {
  if (input === undefined || input === null || input === false || input === "" || input === "none") return [];
  const items: { raw: Record<string, unknown>; path: string }[] = [];
  const push = (v: unknown, p: string) => {
    if (typeof v === "string") {
      if (POST_FX[v] && !POST_PRESETS[v]) items.push({ raw: { fx: v }, path: p });
      else if (POST_PRESETS[v]) expandPreset(v, {}, p, issues)?.forEach((f) => items.push({ raw: f, path: p }));
      else issues?.add({ path: p, code: "unknown", message: `effet ou préréglage « ${v} » inconnu`, didYouMean: suggest(v, [...POST_FX_IDS, ...Object.keys(POST_PRESETS)]), hint: `préréglages : ${Object.keys(POST_PRESETS).join(", ")}` });
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (typeof o.preset === "string" && o.fx === undefined) {
        const { preset, ...over } = o;
        expandPreset(String(preset), over, `${p}.preset`, issues)?.forEach((f) => items.push({ raw: f, path: p }));
      } else items.push({ raw: o, path: p });
    } else issues?.add({ path: p, code: "type", message: "effet attendu : {fx, …}, nom d'effet ou de préréglage", got: v });
  };
  if (Array.isArray(input)) input.forEach((v, i) => push(v, `${path}.${i}`));
  else push(input, path);
  if (items.length > MAX_POST) issues?.add({ path, code: "limit", message: `${MAX_POST} effets au plus (préréglages développés)`, got: items.length, used: MAX_POST });
  const out: PostFx[] = [];
  for (const it of items.slice(0, MAX_POST)) {
    const f = normalizeFx(it.raw, it.path, issues);
    if (f) out.push(f);
  }
  return out;
}

/* ---------------- découpe en passes ---------------- */

export type PlanStage = { index: number; fx: string };
export type PlanPass = {
  stages: PlanStage[];
  /** Échelle de la cible de sortie (1 = plein écran, 0.5 = demi-résolution en qualité basse). */
  scale: number;
  aux?: { kind: AuxKind; index: number };
  /** Signature du shader (cache) : suite des effets. */
  key: string;
};

/** Budget d'uniformes vec4 par passe (WebGL 2 garantit 224 vecteurs de fragment ; marge pour les communs). */
export const PASS_SLOT_BUDGET = 180;

/**
 * Découpe une pile en passes : un effet `source` (voisinage, déplacement, passe annexe) ouvre une passe ; les effets
 * `point` qui le suivent y sont fusionnés. Qualité basse : les passes lourdes à demi-résolution.
 */
export function planPasses(list: PostFx[], low: boolean): PlanPass[] {
  const passes: PlanPass[] = [];
  let cur: PlanPass | null = null;
  let slots = 0;
  list.forEach((f, index) => {
    const def = POST_FX[f.fx];
    const cost = def.slots + 2;
    if (!cur || def.kind === "source" || def.aux || slots + cost > PASS_SLOT_BUDGET) {
      cur = { stages: [], scale: 1, key: "" };
      if (def.aux) cur.aux = { kind: def.aux, index };
      if (def.heavy && low) cur.scale = 0.5;
      passes.push(cur);
      slots = 0;
    }
    cur.stages.push({ index, fx: f.fx });
    slots += cost;
  });
  for (const p of passes) p.key = p.stages.map((s) => s.fx).join("+") + (p.aux ? `|${p.aux.kind}@${p.stages.findIndex((s) => s.index === p.aux!.index)}` : "");
  return passes;
}

/** Une pile animée (grain animé, glitch, scintillement) impose un rendu continu. */
export const postAnimated = (list: PostFx[]) => list.some((f) => POST_FX[f.fx].animated?.(f.params) ?? false);

/** Uniformes d'un effet : réglages (slots × vec4) et masque (2 vec4 : mix, mode, a, b | soft, invert). */
export function packFx(f: PostFx): { F: number[]; M: number[] } {
  const def = POST_FX[f.fx];
  const F = pad(def.pack(f.params), def.slots * 4);
  return { F, M: [f.mix, f.mask.mode, f.mask.a, f.mask.b, f.mask.soft, f.mask.invert ? 1 : 0, 0, 0] };
}
