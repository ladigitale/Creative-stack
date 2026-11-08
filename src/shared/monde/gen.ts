/**
 * Modèles « gen » du format monde : `{ "gen": "character", "params": {…}, "seed": 3 }` délègue la forme aux
 * générateurs procgen (personnages et animaux skinnés en maillage continu, arbres, bâtiments, objets…), rendus par
 * `sonic-3d` avec le style procgen. Ce module est **pur** (aucun three.js, aucun générateur) : il décrit seulement ce que
 * le format doit connaître pour lire, valider et piloter ces modèles :
 *
 * - les os, exposés comme des pièces sans forme aux noms français (`cuisseL`, `avantBrasR`, `queue2`) : les clips du
 *   format les animent (rotations ajoutées à l'animation procédurale) et `nodes.<instance>_<os>` reste valide ;
 * - les clips par défaut : locomotion et actions du moteur procgen (`marche`, `course`, `joie`…) et gestes de jeu
 *   écrits en pistes d'os (`tir`, `passe`, `tacle`, `controle`, `chute`, `plongeon`) ;
 * - la correspondance des rôles de couleur (`maillot` → `cloth1`…).
 */
import type { ClipIn, PartIn } from "./format";
import type { PresetOut } from "./presets";
import { hash32 } from "./math";

/** Générateurs procgen utilisables (`prop.lamp`, `animal.dog`, `ball.soccer` : raccourcis `famille.sorte`). */
export const GEN_IDS = [
  "character",
  "animal",
  "tree",
  "bush",
  "grass",
  "flowers",
  "plant",
  "rock",
  "building",
  "prop",
  "vehicle",
  "wall",
  "emblem",
  "ball",
  "seat",
  "assembly",
] as const;

export type GenRig = "humanoid" | "quadruped" | "bird" | "none";

const BIRDS = new Set(["duck", "chicken"]);

/** Famille du générateur (`animal.dog` → `animal`). */
export function genFamily(id: string): string {
  const d = id.indexOf(".");
  return d > 0 ? id.slice(0, d) : id;
}

export function isGenId(id: unknown): id is string {
  return typeof id === "string" && (GEN_IDS as readonly string[]).includes(genFamily(id));
}

export function genRig(id: string, params: Record<string, unknown> | undefined): GenRig {
  const fam = genFamily(id);
  if (fam === "character") return "humanoid";
  if (fam === "animal") {
    const sp = id.includes(".") ? id.slice(id.indexOf(".") + 1) : String(params?.species ?? "dog");
    return BIRDS.has(sp) ? "bird" : "quadruped";
  }
  return "none";
}

/* ------------------------------------------------------------------ os ↔ pièces */

const FR: Record<string, string> = {
  root: "racine",
  pelvis: "bassin",
  spine: "dos",
  chest: "torse",
  neck: "cou",
  head: "tete",
  clavicle: "epaule",
  upperarm: "bras",
  forearm: "avantBras",
  hand: "main",
  finger: "doigt",
  thigh: "cuisse",
  shin: "mollet",
  foot: "pied",
  toe: "orteil",
  ear: "oreille",
  tail: "queue",
  jaw: "machoire",
  wing: "aile",
};
const EN = Object.fromEntries(Object.entries(FR).map(([k, v]) => [v, k]));

/** Nom de pièce d'un os : `thigh.l` → `cuisseL`, `neck.1` → `cou1`, `tail.3` → `queue3`. */
export function boneAlias(bone: string): string {
  const [base, suf] = bone.split(".");
  const fr = FR[base] ?? base;
  if (suf === "l") return `${fr}L`;
  if (suf === "r") return `${fr}R`;
  return suf ? `${fr}${suf}` : fr;
}

/** Os d'une pièce (inverse de `boneAlias`) ; `null` si le nom n'en désigne aucun. */
export function aliasBone(alias: string): string | null {
  const m = /^([a-zA-Z]+?)(L|R|\d+)?$/.exec(alias);
  if (!m) return null;
  const en = EN[m[1]];
  if (!en) return null;
  if (!m[2]) return en;
  if (m[2] === "L") return `${en}.l`;
  if (m[2] === "R") return `${en}.r`;
  return `${en}.${m[2]}`;
}

type J = [name: string, parent: string, mirror?: boolean];

const HUMANOID: J[] = [
  ["racine", ""],
  ["bassin", "racine"],
  ["dos", "bassin"],
  ["torse", "dos"],
  ["cou", "torse"],
  ["tete", "cou"],
  ["epaule", "torse", true],
  ["bras", "epaule"],
  ["avantBras", "bras"],
  ["main", "avantBras"],
  ["cuisse", "bassin", true],
  ["mollet", "cuisse"],
  ["pied", "mollet"],
  ["orteil", "pied"],
];

const QUADRUPED: J[] = [
  ["racine", ""],
  ["bassin", "racine"],
  ["dos", "bassin"],
  ["torse", "dos"],
  ["cou1", "torse"],
  ["cou2", "cou1"],
  ["tete", "cou2"],
  ["machoire", "tete"],
  ["oreille", "tete", true],
  ["queue1", "bassin"],
  ["queue2", "queue1"],
  ["queue3", "queue2"],
  ["bras", "torse", true],
  ["avantBras", "bras"],
  ["main", "avantBras"],
  ["doigt", "main"],
  ["cuisse", "bassin", true],
  ["mollet", "cuisse"],
  ["pied", "mollet"],
  ["orteil", "pied"],
];

const BIRD: J[] = [
  ["racine", ""],
  ["bassin", "racine"],
  ["torse", "bassin"],
  ["cou1", "torse"],
  ["cou2", "cou1"],
  ["tete", "cou2"],
  ["queue1", "bassin"],
  ["aile", "torse", true],
  ["cuisse", "bassin", true],
  ["mollet", "cuisse"],
  ["pied", "mollet"],
  ["orteil", "pied"],
];

/* ------------------------------------------------------------------ moteur et clips */

/**
 * Clips joués par le moteur procgen : vitesse de locomotion imposée quand l'instance ne se déplace pas (m/s ; sinon
 * la vitesse réelle, mesurée sur ses déplacements, fait marcher ou courir avec les pieds plantés) et action du haut du
 * corps. Les autres clips sont des pistes d'os ajoutées à la pose procédurale.
 */
/** Actions du moteur procgen (copie de rig/locomotion ACTIONS, vérifiée par test). */
export const GEN_ACTIONS = ["idle", "walk", "run", "wave", "point", "cheer", "talk", "carry", "sit", "jump", "think", "bow", "hammer", "sweep", "dig", "kick"] as const;

/** Locomotion et action d'un clip : champs du clip, sinon ceux de son nom (GEN_MOTION). */
export function genMotion(name: string, def?: { action: string; move: number | null } | null): { speed: number; action: string } {
  const mo = Object.prototype.hasOwnProperty.call(GEN_MOTION, name) ? GEN_MOTION[name] : undefined;
  return { speed: def?.move ?? mo?.speed ?? 0, action: def?.action || mo?.action || "" };
}

export const GEN_MOTION: Record<string, { speed?: number; action?: string }> = {
  idle: { action: "idle" },
  marche: { speed: 1.3 },
  course: { speed: 3.8 },
  joie: { action: "cheer" },
  saut: { action: "jump" },
  salut: { action: "wave" },
  montre: { action: "point" },
  parle: { action: "talk" },
  porte: { action: "carry" },
  assis: { action: "sit" },
  reflechit: { action: "think" },
  salue: { action: "bow" },
};

const LOCO: Record<string, ClipIn> = Object.fromEntries(Object.keys(GEN_MOTION).map((k) => [k, { ms: 1000, tracks: {} }]));

/** Gestes de jeu (humanoïde), en degrés ajoutés à la pose procédurale. Axes du personnage : x = sa gauche, z = l'avant. */
const HUMAN_CLIPS: Record<string, ClipIn> = {
  tir: {
    ms: 620,
    loop: false,
    then: "idle",
    tracks: {
      cuisseR: { rx: [0, 32, -78, -30, 0] },
      molletR: { rx: [0, 78, 12, 8, 0] },
      cuisseL: { rx: [0, -8, 6, 0, 0] },
      bras: { rz: [0, 35, 55, 25, 0], sync: true },
      torse: { ry: [0, -14, 18, 6, 0], rx: [0, -4, 6, 2, 0] },
    },
  },
  passe: {
    ms: 520,
    loop: false,
    then: "idle",
    tracks: {
      cuisseR: { rx: [0, 22, -42, 0], ry: [0, 0, -18, 0] },
      molletR: { rx: [0, 50, 8, 0] },
      bras: { rz: [0, 22, 30, 0], sync: true },
      torse: { ry: [0, -8, 10, 0] },
    },
  },
  controle: {
    ms: 460,
    loop: false,
    then: "idle",
    tracks: {
      cuisseR: { rx: [0, -38, -10, 0] },
      molletR: { rx: [0, 42, 10, 0] },
      torse: { rx: [0, 10, 4, 0] },
      bras: { rz: [0, 18, 8, 0], sync: true },
    },
  },
  tacle: {
    ms: 700,
    loop: false,
    tracks: {
      racine: { rx: [0, -40, -62, -64], y: [0, -0.02, 0.04, 0.05] },
      cuisseR: { rx: [0, -60, -70, -72] },
      molletR: { rx: [0, 10, 4, 0] },
      cuisseL: { rx: [0, 20, 45, 48] },
      molletL: { rx: [0, 60, 95, 100] },
      bras: { rz: [0, 40, 70, 75], sync: true },
      tete: { rx: [0, 15, 30, 30] },
    },
  },
  chute: {
    ms: 820,
    loop: false,
    tracks: {
      racine: { rx: [0, -25, -70, -86], y: [0, 0, 0.04, 0.09] },
      cuisse: { rx: [0, -15, -25, -18], sync: true },
      mollet: { rx: [0, 20, 30, 18], sync: true },
      bras: { rz: [0, 45, 75, 80], sync: true },
      tete: { rx: [0, 10, 25, 20] },
    },
  },
  plongeon: {
    ms: 720,
    loop: false,
    tracks: {
      racine: { rz: [0, 25, 70, 84], y: [0, 0.25, 0.22, 0.1] },
      bras: { rz: [0, 90, 150, 160], sync: true },
      cuisse: { rz: [0, 10, 18, 18], sync: true },
      tete: { rz: [0, -10, -20, -20] },
    },
  },
};

/** Préréglage équivalent d'un modèle gen : os en pièces sans forme, clips par défaut. */
export function genPreset(id: string, params: Record<string, unknown> | undefined): PresetOut & { rig: GenRig } {
  const rig = genRig(id, params);
  const joints = rig === "humanoid" ? HUMANOID : rig === "quadruped" ? QUADRUPED : rig === "bird" ? BIRD : [];
  const parts: PartIn[] = joints.map(([name, parent, mirror]) => ({ name, ...(parent ? { parent } : {}), ...(mirror ? { mirror: "x" as const } : {}) }));
  const clips = rig === "none" ? {} : rig === "humanoid" ? { ...LOCO, ...HUMAN_CLIPS } : { idle: LOCO.idle, marche: LOCO.marche, course: LOCO.course, saut: LOCO.saut, assis: LOCO.assis };
  return { parts, clips, clip: rig === "none" ? "" : "idle", rig, roles: Object.fromEntries(Object.keys(GEN_ROLES).map((k) => [k, ""])) };
}

/* ------------------------------------------------------------------ couleurs */

/**
 * Rôles du format → rôles procgen. Les noms procgen (`cloth1`, `skin`, `roof`…) sont aussi acceptés tels quels.
 * Une couleur de rôle (`roles` du placement ou de `nodes`) remplace la couleur tirée par le générateur.
 */
export const GEN_ROLES: Record<string, string> = {
  maillot: "cloth1",
  haut: "cloth1",
  short: "cloth2",
  bas: "cloth2",
  chaussette: "cloth3",
  detail: "cloth3",
  chaussure: "leather",
  cuir: "leather",
  peau: "skin",
  fourrure: "skin",
  museau: "white",
  truffe: "black",
  oreille: "sky",
  bec: "orange",
  criniere: "hair",
  marques: "bark",
  boutQueue: "paper",
  cornes: "leaf2",
  cheveux: "hair",
  oeil: "eye",
  accent: "accent",
  metal: "metal",
  bois: "wood",
  ecorce: "bark",
  feuillage: "leaf",
  fleur: "flower",
  pierre: "stone",
  mur: "wall",
  toit: "roof",
  bordure: "trim",
  vitre: "glass",
  sol: "ground",
  herbe: "grass",
  chemin: "path",
  route: "road",
  eau: "water",
  rouge: "red",
  orange: "orange",
  jaune: "yellow",
  vert: "green",
  bleu: "blue",
  violet: "purple",
  blanc: "white",
  noir: "black",
};

/** Rôle procgen d'un nom de rôle du format (ou nom procgen direct) ; `null` si inconnu. */
export function genRole(name: string, procgenRoles: readonly string[]): string | null {
  if (Object.prototype.hasOwnProperty.call(GEN_ROLES, name)) return GEN_ROLES[name];
  return procgenRoles.includes(name) ? name : null;
}

/** Variantes par placement d'un modèle `gen` : `params` (fusionnés à ceux du modèle) et `genSeed`. */
export const GEN_VARIANTS_MAX = 64;

/**
 * Réécrit `place` : un placement d'un modèle `gen` qui porte `params` et/ou `genSeed` vise une variante
 * `<modèle>~<clé>` (mêmes réglages + retouches), partagée entre placements identiques. Entrée JSON brute.
 */
export function genVariants<T extends { models?: unknown; place?: unknown }>(src: T, issues: { path: string; message: string }[]): T {
  const models = src.models && typeof src.models === "object" && !Array.isArray(src.models) ? (src.models as Record<string, Record<string, unknown>>) : null;
  if (!models || !Array.isArray(src.place)) return src;
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!src.place.some((p) => isObj(p) && (isObj(p.params) || p.genSeed !== undefined))) return src;
  const out: Record<string, Record<string, unknown>> = { ...models };
  let n = 0;
  const place = src.place.map((raw, i) => {
    if (!isObj(raw) || (!isObj(raw.params) && raw.genSeed === undefined)) return raw;
    const { params, genSeed, ...rest } = raw;
    const name = typeof raw.model === "string" ? raw.model : "";
    const base = Object.prototype.hasOwnProperty.call(models, name) ? models[name] : null;
    if (!base || typeof base.gen !== "string") {
      issues.push({ path: `place.${i}.params`, message: "params / genSeed : seulement pour un modèle gen" });
      return rest;
    }
    const key = JSON.stringify([isObj(params) ? params : null, typeof genSeed === "string" || typeof genSeed === "number" ? genSeed : null]);
    const vname = `${name}~${hash32(key).toString(36)}`;
    if (!Object.prototype.hasOwnProperty.call(out, vname)) {
      if (++n > GEN_VARIANTS_MAX) {
        if (n === GEN_VARIANTS_MAX + 1) issues.push({ path: `place.${i}`, message: `plus de ${GEN_VARIANTS_MAX} variantes gen : modèle de base utilisé` });
        return rest;
      }
      out[vname] = {
        ...base,
        params: { ...(isObj(base.params) ? base.params : {}), ...(isObj(params) ? params : {}) },
        // même tirage que le modèle de base (sa graine par défaut est son nom), sauf `genSeed`
        seed: typeof genSeed === "string" || typeof genSeed === "number" ? genSeed : (base.seed ?? name),
      };
    }
    return { ...rest, model: vname };
  });
  return { ...src, models: out, place };
}
