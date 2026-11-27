/**
 * Polices et icônes de procgen. Les contours viennent de Google Fonts et de Lucide, convertis par
 * `scripts/build-procgen-fonts.mjs` (licences dans `data/NOTICE.md`). Chaque fichier n'est chargé qu'à la demande
 * (`loadTextAssets`, appelé avant la composition par `sonic-procgen` et par les workers) ; la composition reste
 * synchrone et se replie sur la police à traits de procgen si une police n'est pas chargée.
 */
import type { P2 } from "../core/font";

export type FontData = {
  id: string;
  family: string;
  weight: number;
  license: string;
  copyright: string;
  upm: number;
  cap: number;
  xh: number;
  asc: number;
  desc: number;
  glyphs: Record<string, (number | number[])[]>;
  kern: Record<string, number>;
};
export type IconData = { source: string; license: string; size: number; stroke: number; icons: Record<string, number[][]> };

/** Polices disponibles (`procgen` : police à traits intégrée, toujours là). */
export const FONTS: Record<string, string> = {
  procgen: "police à traits de procgen (capitales, toujours disponible)",
  inter: "Inter gras : linéale moderne, signalétique",
  playfair: "Playfair Display gras : didone élégante, enseignes chic",
  slab: "Roboto Slab gras : égyptienne, enseignes et panneaux",
  pacifico: "Pacifico : script arrondi, néons, plage",
  lobster: "Lobster : script d'enseigne rétro",
  fraktur: "UnifrakturMaguntia : gothique (fraktur), châteaux, tavernes",
  rye: "Rye : western, saloons, affiches anciennes",
  stencil: "Black Ops One : pochoir militaire",
  pixel: "Press Start 2P : pixel, jeux rétro",
  bebas: "Bebas Neue : capitales condensées, maillots, stades",
  caveat: "Caveat gras : écriture manuscrite, ardoises",
  bangers: "Bangers : bande dessinée, affiches",
};
export const FONT_IDS = Object.keys(FONTS);

const LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  inter: () => import("./data/inter.json"),
  playfair: () => import("./data/playfair.json"),
  slab: () => import("./data/slab.json"),
  pacifico: () => import("./data/pacifico.json"),
  lobster: () => import("./data/lobster.json"),
  fraktur: () => import("./data/fraktur.json"),
  rye: () => import("./data/rye.json"),
  stencil: () => import("./data/stencil.json"),
  pixel: () => import("./data/pixel.json"),
  bebas: () => import("./data/bebas.json"),
  caveat: () => import("./data/caveat.json"),
  bangers: () => import("./data/bangers.json"),
};

/** Police chargée : glyphes décodés à la demande, en hauteurs de capitale. */
export class OutlineFont {
  private cache = new Map<string, { adv: number; rings: P2[][] } | null>();
  readonly lineGap: number;
  constructor(readonly data: FontData) {
    this.lineGap = (data.asc - data.desc) / data.cap;
  }
  has(ch: string) {
    return ch in this.data.glyphs;
  }
  glyph(ch: string): { adv: number; rings: P2[][] } | null {
    let g = this.cache.get(ch);
    if (g !== undefined) return g;
    const raw = this.data.glyphs[ch];
    const k = 1 / this.data.cap;
    g = raw ? { adv: (raw[0] as number) * k, rings: (raw.slice(1) as number[][]).map((c) => decode(c, k)) } : null;
    this.cache.set(ch, g);
    return g;
  }
  kern(a: string, b: string): number {
    return (this.data.kern[a + b] ?? 0) / this.data.cap;
  }
}

function decode(c: number[], k: number): P2[] {
  const out: P2[] = [];
  let x = 0, y = 0;
  for (let i = 0; i + 1 < c.length; i += 2) {
    x += c[i];
    y += c[i + 1];
    out.push([x * k, y * k]);
  }
  return out;
}

const fonts = new Map<string, OutlineFont>();
let icons: IconData | null = null;
const iconCache = new Map<string, P2[][] | null>();
const pending = new Map<string, Promise<void>>();

export function registerFont(d: FontData) {
  fonts.set(d.id, new OutlineFont(d));
}
export function registerIcons(d: IconData) {
  icons = d;
  iconCache.clear();
}
/** Police chargée, ou null (police inconnue ou pas encore chargée). */
export const getFont = (id: string | undefined): OutlineFont | null => (id ? fonts.get(id) ?? null : null);
export const iconsLoaded = () => !!icons;
export const iconNames = () => (icons ? Object.keys(icons.icons) : []);

/** Tracés d'une icône dans un carré de côté 1 (y vers le haut), et demi-largeur du trait. */
export function getIcon(name: string): { lines: P2[][]; hw: number } | null {
  if (!icons) return null;
  let g = iconCache.get(name);
  if (g === undefined) {
    const raw = icons.icons[name];
    g = raw ? raw.map((c) => decode(c, 1 / icons!.size)) : null;
    iconCache.set(name, g);
  }
  return g ? { lines: g, hw: icons.stroke / icons.size / 2 } : null;
}

/** Charge des polices (et les icônes) ; sans effet pour celles déjà là, les inconnues sont ignorées. */
export async function loadTextAssets(ids: Iterable<string>, withIcons = false): Promise<void> {
  const jobs: Promise<void>[] = [];
  const need = (key: string, run: () => Promise<void>) => {
    let p = pending.get(key);
    if (!p) pending.set(key, (p = run().catch(() => pending.delete(key) as unknown as void)));
    jobs.push(p);
  };
  for (const id of ids)
    if (LOADERS[id] && !fonts.has(id)) need(id, async () => registerFont((await LOADERS[id]()).default as FontData));
  if (withIcons && !icons) need("icons", async () => registerIcons((await import("./data/icons.json")).default as unknown as IconData));
  await Promise.all(jobs);
}

/* ---------- polices choisies quand `font` vaut « auto » ---------- */

/** Enseignes de boutique, selon le style du bâtiment. */
export const SIGN_FONTS: Record<string, string[]> = {
  bourg: ["playfair", "slab", "lobster"],
  boutique: ["playfair", "lobster", "pacifico", "slab"],
  pierre: ["playfair", "slab"],
  colombages: ["fraktur", "playfair", "slab"],
  ferme: ["rye", "caveat", "slab"],
  chaumiere: ["caveat", "rye"],
  chalet: ["rye", "slab", "caveat"],
  mediterraneen: ["lobster", "pacifico", "playfair"],
  moderne: ["inter", "bebas"],
  neon: ["pacifico", "bangers"],
  vapeur: ["rye", "slab", "stencil"],
  japonais: ["inter"],
  chateau: ["fraktur"],
  chapelle: ["fraktur"],
  tour: ["fraktur", "slab"],
  moulin: ["caveat", "slab"],
  phare: ["slab", "bebas"],
};
/** Objets de décor qui écrivent. */
export const PROP_FONTS: Record<string, string[]> = {
  townsign: ["inter"],
  streetsign: ["inter"],
  signpost: ["slab", "rye"],
  billboard: ["bangers", "lobster", "bebas", "pacifico", "playfair"],
  hangingsign: ["lobster", "rye", "playfair", "fraktur"],
  milestone: ["inter"],
};
/** Maillots (nom et numéro) et texte du devant d'un haut. */
export const SHIRT_NUMBER_FONTS = ["bebas"];
export const SHIRT_TEXT_FONTS = ["bangers", "pacifico", "bebas", "inter", "stencil", "caveat", "lobster"];
/** Panneaux du stade. */
export const AD_FONTS = ["bebas", "inter", "bangers", "lobster"];

/**
 * Polices et icônes dont une recette peut avoir besoin, lues dans son texte (styles de bâtiments, objets qui
 * écrivent, maillots, stade, polices nommées, icônes `{nom}`). Large plutôt que juste : une police chargée pour rien
 * ne coûte qu'un téléchargement.
 */
export function textAssetsOf(recipe: unknown): { fonts: string[]; icons: boolean } {
  const s = JSON.stringify(recipe ?? {});
  const out = new Set<string>();
  const add = (l: string[] | undefined) => l?.forEach((f) => out.add(f));
  if (/building/.test(s)) {
    const styles = Object.keys(SIGN_FONTS).filter((st) => new RegExp(`['"]${st}['"]`).test(s));
    for (const st of styles.length ? styles : ["bourg"]) add(SIGN_FONTS[st]);
    if (!/['"]style['"]/.test(s)) add(SIGN_FONTS.bourg);
  }
  for (const k of Object.keys(PROP_FONTS)) if (s.includes(k)) add(PROP_FONTS[k]);
  if (/shirtName|shirtNumber|football|"players"/.test(s)) add(SHIRT_NUMBER_FONTS);
  if (/shirtText/.test(s)) add(SHIRT_TEXT_FONTS);
  if (/sport\.pitch|football|"players"/.test(s)) add(AD_FONTS);
  for (const id of FONT_IDS) if (new RegExp(`['"]${id}['"]`).test(s)) out.add(id);
  out.delete("procgen");
  return { fonts: [...out], icons: /\{[a-z0-9-]+\}/.test(s) };
}

/** Précharge ce qu'une recette peut écrire. */
export function loadTextAssetsFor(recipe: unknown): Promise<void> {
  const need = textAssetsOf(recipe);
  return loadTextAssets(need.fonts, need.icons);
}

/** Police d'un texte : nom donné, ou tirage dans la liste « auto » ; null = police à traits de procgen. */
export function pickFont(asked: unknown, auto: string[], pick: (l: string[]) => string): string {
  const a = typeof asked === "string" ? asked : "auto";
  if (a !== "auto") return FONTS[a] ? a : "procgen";
  return auto.length ? pick(auto) : "procgen";
}
