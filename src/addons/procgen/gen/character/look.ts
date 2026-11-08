/**
 * Apparence d'un personnage : listes de valeurs, profils de rôle (villageois, garde, marin…) et résolution des valeurs
 * `auto` en une combinaison **cohérente** tirée de la graine.
 *
 * Un rôle **biaise** les tirages sans les enfermer (le profil s'ajoute aux poids par défaut) ; une valeur explicite
 * l'emporte toujours. Chaque emplacement tire sur sa propre branche d'aléa : imposer le chapeau ne change pas la barbe.
 */
import type { Rng } from "../../core/rng";
import { TOOL_KINDS } from "../tool";
import { type AnimalSpec, ANIMAL_NAMES, resolveAnimal } from "./animal";
import type { Issues } from "../../core/schema";

export const SKIN_TONES: Record<string, string> = {
  porcelain: "#f3d6c4", fair: "#ebc3a6", sand: "#ddaa86", honey: "#c99169", cinnamon: "#ab7350", amber: "#8f5a3a", brown: "#6f432a", ebony: "#4c2d1d", green: "#8fae84", blue: "#8d9ec4",
};
export const HAIR_COLORS: Record<string, string> = {
  black: "#2a2422", darkbrown: "#45302a", brown: "#6a4a35", auburn: "#7a3a28", ginger: "#b1622f", blonde: "#d3b57c", platinum: "#e6dbc4", grey: "#9a958e", white: "#e8e5df", blue: "#3e5c8a", pink: "#c27a92",
};
export const EYE_COLORS: Record<string, string> = {
  darkbrown: "#3b2619", brown: "#5e3b22", hazel: "#7a6232", amber: "#9a6a26", green: "#4f7044", blue: "#4d7398", grey: "#6f7c86", violet: "#6c5a8a",
};
/** Garde-robes désaturées (haut, bas, détail, cuir) : couleurs crédibles, accent rare. */
export const OUTFITS: Record<string, [string, string, string, string]> = {
  earth: ["#8a6a4f", "#4d4a44", "#c9b48f", "#4a3427"],
  sea: ["#4f6f86", "#2f3b48", "#d8cdb6", "#3d2e25"],
  forest: ["#5e7150", "#4a3d32", "#b9a77f", "#3b2c22"],
  royal: ["#6b3f5e", "#2e2c3a", "#c9a75a", "#2b2120"],
  work: ["#6f7d8c", "#3b4250", "#c06a3a", "#33291f"],
  autumn: ["#a35a3a", "#5a4636", "#e0c48e", "#3e2b20"],
  slate: ["#54595f", "#2e3136", "#a8b2b8", "#26211d"],
  rose: ["#b77a7f", "#55505a", "#efe2cf", "#4b3a33"],
  sand: ["#c2a77e", "#7a6650", "#5d7a74", "#4a3628"],
  ink: ["#2f3440", "#22252c", "#b5463c", "#1f1a18"],
  linen: ["#d9cdb4", "#6b5d4c", "#8a4f3a", "#4a3628"],
  moss: ["#7d8456", "#5b4b3a", "#d6c7a0", "#3e2f22"],
  plum: ["#5b4a6e", "#3b3540", "#d0b48a", "#2f2522"],
  brick: ["#9b4f3f", "#3f4249", "#d9c9a8", "#3a2a20"],
};

export const TOPS = ["none", "tee", "long", "tank", "sweater", "shirt", "tunic", "coat", "robe", "dress"] as const;
export const BOTTOMS = ["trousers", "shorts", "skirt", "longskirt", "overalls"] as const;
export const OVERS = ["none", "vest", "jacket", "apron", "armor"] as const;
export const COLLARS = ["none", "round", "shirt", "turtle"] as const;
export const BELTS = ["none", "belt", "sash"] as const;
export const DETAILS = ["none", "buttons", "pockets", "full"] as const;
export const GLOVES = ["none", "gloves"] as const;
export const SHOES = ["shoes", "boots", "tallboots", "sandals", "barefoot"] as const;
export const PATTERNS = ["plain", "stripes", "vstripes", "checks"] as const;
export const HAIRS = ["none", "shaved", "crop", "short", "sidepart", "bob", "wavy", "long", "ponytail", "lowtail", "bun", "topknot", "pigtails", "braids", "curly", "afro", "mohawk"] as const;
export const HATS = ["none", "cap", "beret", "tophat", "wizard", "straw", "helmet", "crown", "beanie", "bandana", "turban", "cowboy", "flowers", "tricorn", "toque", "hood"] as const;
export const BAGS = ["none", "backpack", "satchel", "cape", "scarf", "pouch"] as const;
/** Objets tenus : accessoires propres au personnage, puis tous les outils (`tool.<kind>`, mêmes pièces que le générateur `tool`). */
export const ITEMS: readonly string[] = ["none", "staff", "sword", "lantern", "book", "umbrella", "torch", "flower", "mug", "spear", "hammer", "pitchfork", "wand", ...TOOL_KINDS.map((k) => `tool.${k}`)];
export const MOODS = ["neutral", "happy", "sad", "angry", "surprised", "sleepy"] as const;
export const HEAD_SHAPES = ["round", "oval", "square", "long"] as const;
export const EYES = ["round", "almond", "narrow", "sleepy", "big"] as const;
export const BROWS = ["none", "thin", "straight", "arched", "thick", "bushy"] as const;
export const NOSES = ["button", "long", "aquiline", "wide", "upturned"] as const;
export const LIPS = ["thin", "medium", "full"] as const;
export const EARS = ["small", "round", "large", "pointed"] as const;
/** Personnage animal : espèces livrées (fiches de `animal.ts`), `custom` = fiche entièrement donnée par `animalSpec`. */
export const ANIMALS = ["none", "custom", ...ANIMAL_NAMES] as const;
export const BEARDS = ["none", "stubble", "short", "full", "goatee", "long", "chinstrap"] as const;
export const MUSTACHES = ["none", "thin", "pencil", "walrus", "handlebar"] as const;
export const GLASSES = ["none", "round", "square", "half"] as const;
export const LEVELS = ["none", "light", "strong"] as const;
export const FIGURES = ["feminine", "masculine", "androgynous"] as const;
export const ROLES_CHAR = ["villager", "merchant", "guard", "noble", "sailor", "farmer", "wizard", "worker", "child", "traveler", "scholar", "cook"] as const;

export type Look = {
  role: string;
  figure: string;
  archetype: string;
  age: string;
  height: number;
  build: number;
  shape: number;
  headSize: number;
  belly: number;
  body: { legs: number; arms: number; neck: number; shoulders: number; hips: number; bust: number; posture: number; asym: number };
  top: string;
  bottom: string;
  over: string;
  collar: string;
  belt: string;
  details: string;
  gloves: string;
  shoes: string;
  pattern: string;
  hair: string;
  hat: string;
  bag: string;
  item: string;
  mood: string;
  headShape: string;
  eyes: string;
  brows: string;
  nose: string;
  lips: string;
  ears: string;
  /** Espèce du personnage animal (`none` : humain). */
  animal: string;
  /** Fiche résolue de l'animal (null : humain). */
  animalSpec: AnimalSpec | null;
  beard: string;
  mustache: string;
  glasses: string;
  freckles: string;
  blush: string;
  wrinkles: string;
  detail: string;
};

type W = Record<string, number>;
/** Poids par défaut (villageois ordinaire). */
const BASE: Record<string, W> = {
  top: { tee: 3, long: 3, sweater: 2, shirt: 3, tunic: 2, tank: 0.4, coat: 1.2, dress: 0 },
  bottom: { trousers: 5, shorts: 0.8, skirt: 0.4, longskirt: 0.4, overalls: 0.6 },
  over: { none: 7, vest: 1.4, jacket: 1.1, apron: 0.35 },
  collar: { none: 2, round: 2, shirt: 1.2, turtle: 0.4 },
  belt: { none: 3, belt: 2.2, sash: 0.6 },
  details: { none: 2.5, buttons: 2, pockets: 1, full: 1 },
  gloves: { none: 12, gloves: 0.5 },
  shoes: { shoes: 4, boots: 3, tallboots: 0.6, sandals: 0.6, barefoot: 0.15 },
  pattern: { plain: 7, stripes: 0.9, vstripes: 0.5, checks: 0.7 },
  hat: { none: 7, cap: 0.6, beret: 0.6, straw: 0.7, beanie: 0.7, bandana: 0.4, cowboy: 0.2, flowers: 0.2, turban: 0.2, hood: 0.3 },
  bag: { none: 6, backpack: 0.5, satchel: 1, scarf: 0.8, pouch: 0.7, cape: 0.2 },
  item: { none: 7, lantern: 0.4, book: 0.4, mug: 0.5, flower: 0.3, umbrella: 0.2, staff: 0.2 },
  headShape: { round: 1, oval: 1.4, square: 1, long: 0.8 },
  eyes: { round: 1.2, almond: 1.4, narrow: 0.7, sleepy: 0.5, big: 0.4 },
  brows: { thin: 1, straight: 1.4, arched: 1, thick: 1, bushy: 0.3 },
  nose: { button: 1, long: 1, aquiline: 0.7, wide: 0.8, upturned: 0.7 },
  lips: { thin: 1, medium: 2, full: 1 },
  ears: { small: 1, round: 2, large: 0.6, pointed: 0.05 },
  glasses: { none: 12, round: 0.5, square: 0.5, half: 0.3 },
  freckles: { none: 6, light: 1, strong: 0.4 },
  blush: { none: 3, light: 2, strong: 0.5 },
  age: { adult: 6, elder: 1.4, teen: 1, child: 0.6 },
  outfit: Object.fromEntries(Object.keys(OUTFITS).map((k) => [k, 1])),
};

/** Profils de rôle : poids ajoutés aux poids par défaut. */
const PROFILES: Record<string, Record<string, W> & { body?: Partial<Look["body"]> & { build?: number; belly?: number } }> = {
  villager: {},
  merchant: {
    top: { shirt: 4, tunic: 2, coat: 2 }, over: { vest: 5, apron: 1.5 }, belt: { belt: 3, sash: 3 }, bag: { satchel: 3, pouch: 4 }, details: { buttons: 3, full: 3 },
    hat: { beret: 2, tophat: 0.6, cap: 1, turban: 1.2 }, item: { book: 1.5, mug: 1.5, lantern: 0.6 }, outfit: { royal: 2, autumn: 2, sand: 2, plum: 2, brick: 2 }, age: { adult: 3, elder: 2 },
    body: { belly: 0.45 },
  },
  guard: {
    over: { armor: 14, vest: 1 }, top: { long: 3, tunic: 4 }, hat: { helmet: 12, none: 1 }, item: { spear: 8, sword: 5, none: -6 }, belt: { belt: 6 }, gloves: { gloves: 8 },
    shoes: { tallboots: 5, boots: 4 }, bottom: { trousers: 6, skirt: -0.4, longskirt: -0.4 }, outfit: { slate: 3, ink: 3, royal: 2, brick: 2 }, age: { adult: 4, child: -0.6, elder: -1 },
    body: { posture: -0.5, build: 0.25 },
  },
  noble: {
    top: { coat: 4, dress: 2, shirt: 2, robe: 1 }, over: { vest: 2, jacket: 2.5 }, collar: { shirt: 3, turtle: 1 }, hat: { tophat: 2, crown: 0.8, beret: 1 }, item: { book: 1, flower: 1.5, umbrella: 1.5 },
    outfit: { royal: 5, rose: 3, ink: 3, plum: 3 }, details: { full: 5, buttons: 3 }, shoes: { tallboots: 2, shoes: 2 }, glasses: { half: 0.6, round: 0.4 }, pattern: { plain: 4 },
    body: { posture: -0.6 },
  },
  sailor: {
    top: { tee: 4, long: 3, sweater: 3 }, pattern: { stripes: 7 }, bottom: { trousers: 5, shorts: 2 }, hat: { tricorn: 1.2, beanie: 4, bandana: 3, cap: 1.5 }, item: { lantern: 1.5 },
    outfit: { sea: 6, ink: 2, slate: 2 }, shoes: { boots: 4, barefoot: 1.2 }, bag: { scarf: 2 }, beard: { full: 3, short: 2 },
  },
  farmer: {
    bottom: { overalls: 6, trousers: 3 }, top: { shirt: 4, tee: 2, long: 2 }, pattern: { checks: 4, plain: 2 }, hat: { straw: 8, cap: 1.5, bandana: 1.5 }, item: { pitchfork: 6 },
    outfit: { forest: 3, earth: 3, autumn: 2, moss: 3, linen: 2 }, shoes: { boots: 5 }, over: { apron: 0.8 }, gloves: { gloves: 0.6 },
  },
  wizard: {
    top: { robe: 18 }, hat: { wizard: 14, hood: 3 }, item: { staff: 9, wand: 3, book: 3, none: -6 }, beard: { long: 9, full: 2 }, age: { elder: 10 }, outfit: { royal: 4, sea: 3, ink: 3, forest: 3, plum: 4 },
    belt: { sash: 5 }, brows: { bushy: 5 }, bag: { cape: 1.5 }, pattern: { plain: 6 }, body: { posture: 0.4 },
  },
  worker: {
    bottom: { overalls: 4, trousers: 4 }, top: { tee: 2, shirt: 2, long: 2, tank: 1 }, over: { apron: 2.5, vest: 1 }, hat: { cap: 3, beanie: 2, bandana: 1.5 }, item: { hammer: 8 }, gloves: { gloves: 4 },
    belt: { belt: 4 }, details: { pockets: 4 }, outfit: { work: 5, slate: 2, earth: 2, brick: 2 }, shoes: { boots: 4, tallboots: 1.5 }, body: { build: 0.2 },
  },
  child: {
    age: { child: 30 }, bottom: { shorts: 3, trousers: 3, skirt: 2 }, top: { tee: 3, sweater: 3, dress: 1.5 }, hat: { beanie: 1.2, cap: 1, flowers: 0.6 }, item: { flower: 1.5, book: 0.6 },
    pattern: { stripes: 2, checks: 1 }, hair: { pigtails: 3, short: 2, bob: 2, ponytail: 2, curly: 1.5 }, freckles: { light: 3, strong: 1 }, blush: { light: 3, strong: 2 },
  },
  traveler: {
    bag: { backpack: 5, cape: 3, scarf: 2 }, hat: { cowboy: 2, hood: 3, straw: 1, tricorn: 0.5 }, top: { coat: 4, tunic: 3 }, item: { staff: 3, lantern: 2 }, shoes: { boots: 5, tallboots: 2 },
    belt: { belt: 3 }, gloves: { gloves: 1.5 }, outfit: { earth: 3, moss: 3, sand: 2, forest: 2 },
  },
  scholar: {
    top: { robe: 2, coat: 3, shirt: 2 }, over: { vest: 2.5 }, glasses: { round: 4, half: 3, square: 2 }, item: { book: 9 }, hat: { beret: 1.5 }, age: { elder: 2.5 }, collar: { shirt: 2, turtle: 1 },
    outfit: { plum: 3, ink: 3, slate: 2, sea: 2 }, body: { posture: 0.45 },
  },
  cook: {
    hat: { toque: 14 }, over: { apron: 14 }, top: { shirt: 3, tee: 2, long: 2 }, item: { mug: 2 }, outfit: { linen: 4, work: 2, autumn: 2 }, body: { belly: 0.5 },
  },
};

/** Biais de silhouette (tirages `auto`) selon la figure : coupe, coiffure, pilosité. */
const FIGURE_W: Record<string, Record<string, W>> = {
  feminine: {
    top: { dress: 2.5, tank: 0.3 }, bottom: { skirt: 3, longskirt: 3 }, hair: { long: 4, bob: 3, ponytail: 3, bun: 2.5, braids: 2, wavy: 3, curly: 2, pigtails: 1, lowtail: 1.5, topknot: 1, afro: 1 },
    hat: { flowers: 0.6, beret: 0.6, bandana: 0.3 }, brows: { arched: 2, thin: 1.5 }, lips: { full: 1.5 }, blush: { light: 2 }, bag: { satchel: 0.6 },
  },
  masculine: {
    hair: { short: 5, crop: 3, sidepart: 3, shaved: 1.5, curly: 1.5, none: 1.2, lowtail: 0.8, afro: 0.6, mohawk: 0.2, wavy: 0.6 },
    brows: { thick: 2, straight: 2, bushy: 0.5 }, nose: { long: 0.6, aquiline: 0.6, wide: 0.6 }, headShape: { square: 1.2 },
  },
  androgynous: { hair: { short: 2, bob: 2, crop: 2, wavy: 1.5, curly: 1.5, ponytail: 1, sidepart: 1.5, afro: 0.8, lowtail: 1 } },
};

const pick = (rng: Rng, w: W) => rng.weighted(Object.entries(w).filter(([, x]) => x > 0) as [string, number][]);

function merged(slot: string, role: string, figure: string): W {
  const out: W = { ...(BASE[slot] ?? {}) };
  const add = (src: W | undefined, k = 1) => {
    if (!src) return;
    for (const [key, val] of Object.entries(src)) out[key] = (out[key] ?? 0) + val * k;
  };
  add(FIGURE_W[figure]?.[slot]);
  // un profil de rôle domine les poids par défaut sans les annuler
  const prof = PROFILES[role]?.[slot] as W | undefined;
  if (prof) {
    for (const key of Object.keys(out)) out[key] *= 0.35;
    add(prof);
  }
  return out;
}

export type LookInput = Record<string, unknown> & { colors: Record<string, unknown> };

/** Valeurs `auto` → combinaison cohérente. */
export function resolveLook(pp: LookInput, rng: Rng, issues: Issues, path: string): Look {
  const s = (k: string) => String(pp[k] ?? "auto");
  const n = (k: string) => Number(pp[k]);
  const role = s("role") === "auto" ? pick(rng.fork("auto/role"), { villager: 8, merchant: 1, farmer: 1.5, worker: 1.2, traveler: 0.8, sailor: 0.5, scholar: 0.5, cook: 0.4, noble: 0.4, guard: 0.4, child: 1 }) : s("role");
  const age = s("age") !== "auto" ? s("age") : pick(rng.fork("auto/age"), merged("age", role, ""));
  const young = age === "child" || age === "teen";
  const figure = s("figure") !== "auto" ? s("figure") : pick(rng.fork("auto/figure"), { feminine: 1, masculine: 1, androgynous: young ? 0.6 : 0.25 });
  const choose = (slot: string, extra?: (w: W) => void) => {
    if (s(slot) !== "auto") return s(slot);
    const w = merged(slot, role, figure);
    extra?.(w);
    return pick(rng.fork(`auto/${slot}`), w);
  };
  const v = rng.fork("auto/body");
  const prof = PROFILES[role]?.body ?? {};
  const variation = Number.isFinite(n("variation")) ? n("variation") : 0.6;
  const jit = (amp: number) => v.range(-1, 1) * amp * variation;
  const ov = (pp.body && typeof pp.body === "object" ? pp.body : {}) as Record<string, unknown>;
  const bodyVal = (k: keyof Look["body"], seeded: number) => (typeof ov[k] === "number" && Number.isFinite(ov[k]) ? Math.max(-1, Math.min(1, ov[k] as number)) : seeded);
  const fem = figure === "feminine", masc = figure === "masculine";
  const elder = age === "elder";
  const body: Look["body"] = {
    legs: bodyVal("legs", jit(0.8)),
    arms: bodyVal("arms", jit(0.7)),
    neck: bodyVal("neck", jit(0.7) + (fem ? 0.25 : masc ? -0.15 : 0)),
    shoulders: bodyVal("shoulders", jit(0.6) + (masc ? 0.35 : fem ? -0.3 : 0)),
    hips: bodyVal("hips", jit(0.6) + (fem ? 0.45 : masc ? -0.2 : 0)),
    bust: bodyVal("bust", fem && !young ? Math.max(0, 0.45 + jit(0.45)) : 0),
    posture: bodyVal("posture", (prof.posture ?? 0) + (elder ? 0.55 : 0) + jit(0.35)),
    asym: bodyVal("asym", jit(0.6)),
  };
  // valeurs numériques laissées par défaut : légère variation de graine (foules moins répétitives)
  const DEF = { build: 0.45, shape: 0, headSize: 1, belly: 0.15, height: 1.7 };
  const build = n("build") === DEF.build ? Math.max(0, Math.min(1, DEF.build + (prof.build ?? 0) + jit(0.3))) : n("build");
  const shape = n("shape") === DEF.shape ? Math.max(-1, Math.min(1, (masc ? 0.25 : fem ? -0.3 : 0) + jit(0.25))) : n("shape");
  const belly = n("belly") === DEF.belly ? Math.max(0, Math.min(1, (prof.belly ?? 0.1) + (elder ? 0.15 : 0) + Math.max(0, jit(0.35)) - (young ? 0.1 : 0))) : n("belly");
  const headSize = n("headSize") === DEF.headSize ? 1 + jit(0.04) : n("headSize");
  const ageH = { child: 0.7, teen: 0.92, adult: 1, elder: 0.97 }[age] ?? 1;
  const height = n("height") === DEF.height ? DEF.height * ageH * (fem ? 0.96 : 1.02) * (1 + jit(0.05)) : n("height");

  let top = choose("top", (w) => {
    if (masc) (w.dress = 0), (w.tank = (w.tank ?? 0) * 0.6);
  });
  let bottom = choose("bottom", (w) => {
    if (masc) (w.skirt = 0), (w.longskirt = 0);
  });
  let over = choose("over");
  let hat = choose("hat");
  let hair = choose("hair", (w) => {
    // coiffures volumineuses rares sous un chapeau
    if (hat !== "none") for (const k of ["afro", "mohawk", "topknot", "bun", "pigtails"]) w[k] = (w[k] ?? 0) * 0.1;
    if (elder) (w.none = (w.none ?? 0) + (masc ? 2 : 0)), (w.shaved = (w.shaved ?? 0) + 0.5);
  });
  if (!(hair in Object.fromEntries(HAIRS.map((h) => [h, 1])))) hair = "short";
  let collar = choose("collar", (w) => {
    if (top === "shirt" || over === "vest" || over === "jacket") w.shirt = (w.shirt ?? 0) + 4;
    if (top === "sweater") w.turtle = (w.turtle ?? 0) + 1.5;
  });
  const belt = choose("belt", (w) => {
    if (top === "tunic" || top === "robe" || over === "armor") w.belt = (w.belt ?? 0) + 3;
    if (top === "dress") w.sash = (w.sash ?? 0) + 1;
  });
  const details = choose("details", (w) => {
    if (top === "shirt" || top === "coat" || over === "vest" || over === "jacket") w.buttons = (w.buttons ?? 0) + 3;
  });
  const gloves = choose("gloves");
  const shoes = choose("shoes");
  const pattern = choose("pattern", (w) => {
    if (top === "robe" || over === "armor") (w.checks = 0), (w.vstripes = 0), (w.stripes = 0);
  });
  const bag = choose("bag");
  const item = choose("item");
  const headShape = choose("headShape");
  const eyes = choose("eyes", (w) => {
    if (elder) w.sleepy = (w.sleepy ?? 0) + 1;
    if (young) w.big = (w.big ?? 0) + 1.5;
  });
  const brows = choose("brows", (w) => {
    if (elder) w.bushy = (w.bushy ?? 0) + 1.2;
  });
  const nose = choose("nose", (w) => {
    if (young) (w.button = (w.button ?? 0) + 3), (w.aquiline = 0);
  });
  const lips = choose("lips");
  const ears = choose("ears");
  let beard = choose("beard", (w) => {
    if (!masc || young) for (const k of BEARDS) w[k] = k === "none" ? 1 : 0;
    else {
      w.none = (w.none ?? 0) + 4;
      w.stubble = (w.stubble ?? 0) + 1;
      w.short = (w.short ?? 0) + 1.2;
      w.full = (w.full ?? 0) + 1;
      w.goatee = (w.goatee ?? 0) + 0.6;
      w.chinstrap = (w.chinstrap ?? 0) + 0.3;
      w.long = (w.long ?? 0) + (elder ? 1.5 : 0.15);
    }
  });
  let mustache = choose("mustache", (w) => {
    if (!masc || young) for (const k of MUSTACHES) w[k] = k === "none" ? 1 : 0;
    else {
      w.none = (w.none ?? 0) + 4;
      w.thin = (w.thin ?? 0) + 0.6;
      w.pencil = (w.pencil ?? 0) + 0.3;
      w.walrus = (w.walrus ?? 0) + (beard === "full" || beard === "long" ? 3 : 0.5);
      w.handlebar = (w.handlebar ?? 0) + 0.4;
      if (beard === "goatee") w.thin += 3;
    }
  });
  const glasses = choose("glasses", (w) => {
    if (elder) (w.half = (w.half ?? 0) + 0.8), (w.round = (w.round ?? 0) + 0.6);
  });
  const freckles = choose("freckles");
  const blush = choose("blush");
  const wrinkles = s("wrinkles") !== "auto" ? s("wrinkles") : elder ? pick(rng.fork("auto/wrinkles"), { light: 1, strong: 1.2 }) : age === "adult" ? pick(rng.fork("auto/wrinkles"), { none: 6, light: 1 }) : "none";

  // cohérences
  const note = (k: string, got: string, used: string, why: string) => ((pp[k] ?? "auto") !== "auto" ? issues.add({ path: `${path}.${k}`, code: "info", message: why, got, used }) : undefined);
  if (hat !== "none" && hair === "mohawk") note("hair", hair, (hair = "short"), "crête incompatible avec un chapeau : coiffure courte utilisée");
  if ((hat === "helmet" || hat === "hood" || hat === "tophat" || hat === "toque" || hat === "wizard") && (hair === "afro" || hair === "topknot" || hair === "bun")) note("hair", hair, (hair = hair === "afro" ? "curly" : "lowtail"), "coiffure volumineuse sous un couvre-chef couvrant : variante plate");
  if (top === "robe" || top === "dress") bottom = bottom === "overalls" ? "trousers" : bottom;
  if ((top === "coat" || top === "robe") && (over === "jacket" || over === "vest")) over = "none";
  if (over === "armor" && collar === "shirt") collar = "none";
  if (top === "none" || top === "tank" || top === "dress") collar = top === "dress" && collar === "round" ? collar : "none";
  if (age === "child" && over === "armor") over = "none";
  if (top === "none" && (over === "vest" || over === "jacket")) top = "tee";

  // personnage animal : pas de cheveux, de barbe ni de lèvres, oreilles et museau de l'espèce
  const a0 = s("animal") === "auto" ? "none" : s("animal");
  let animal = (ANIMALS as readonly string[]).includes(a0) ? a0 : "none";
  if (animal === "none" && a0 !== "none") issues.add({ path: `${path}.animal`, code: "unknown", message: `espèce « ${a0} » inconnue`, hint: ANIMALS.join(", ") });
  const animalSpec = resolveAnimal(animal, pp.animalSpec);
  if (animalSpec && animal === "none") animal = "custom";
  let glasses2 = glasses, freckles2 = freckles, wrinkles2 = wrinkles, brows2 = brows;
  if (animal !== "none") {
    if (s("hair") === "auto") hair = "none";
    if (s("brows") === "auto") brows2 = "none";
    beard = "none";
    mustache = "none";
    if (s("glasses") === "auto") glasses2 = "none";
    if (s("freckles") === "auto") freckles2 = "none";
    if (s("wrinkles") === "auto") wrinkles2 = "none";
  }
  return {
    animal,
    animalSpec,
    role, figure, archetype: s("archetype"), age, height, build, shape, headSize, belly, body,
    top, bottom, over, collar, belt, details, gloves, shoes, pattern, hair, hat, bag, item, mood: s("mood"),
    headShape, eyes, brows: brows2, nose, lips, ears, beard, mustache, glasses: glasses2, freckles: freckles2, blush, wrinkles: wrinkles2, detail: s("detail"),
  };
}

/** Couleurs propres du personnage (rôle → #rrggbb), cohérentes avec la carnation et l'âge. */
export function resolveColors(pp: LookInput, look: Look, rng: Rng, issues: Issues, path: string) {
  const HEX = /^#[0-9a-f]{6}$/i;
  const sk = String(pp.skin ?? "auto");
  const skinKeys = Object.keys(SKIN_TONES).slice(0, 8);
  const skinKey = SKIN_TONES[sk] ? sk : HEX.test(sk) ? "" : rng.fork("skin").pick(skinKeys);
  if (sk !== "auto" && !HEX.test(sk) && !SKIN_TONES[sk]) issues.add({ path: `${path}.skin`, code: "unknown", message: `carnation « ${sk} » inconnue`, hint: Object.keys(SKIN_TONES).join(", ") });
  const an = look.animalSpec;
  const skin = HEX.test(sk) ? sk : an && sk === "auto" ? rng.fork("fur").pick(an.colors.fur) : SKIN_TONES[skinKey];
  const dark = skinKey ? skinKeys.indexOf(skinKey) / 7 : 0.4;
  const hc = String(pp.hairColor ?? "auto");
  let hair: string;
  if (HEX.test(hc)) hair = hc;
  else if (HAIR_COLORS[hc]) hair = HAIR_COLORS[hc];
  else {
    const r = rng.fork("haircolor");
    const w: W = look.age === "elder" ? { grey: 4, white: 4, platinum: 0.5, darkbrown: 0.4 } : { black: 1 + dark * 5, darkbrown: 2 + dark * 2, brown: 2.5, auburn: 0.8 * (1 - dark), ginger: 0.7 * (1 - dark) ** 2, blonde: 1.6 * (1 - dark) ** 2, platinum: 0.3 * (1 - dark) ** 2 };
    hair = HAIR_COLORS[pick(r, w)];
  }
  const ec = String(pp.eyeColor ?? "auto");
  const iris = HEX.test(ec) ? ec : EYE_COLORS[ec] ?? EYE_COLORS[pick(rng.fork("eyecolor"), { darkbrown: 1 + dark * 6, brown: 2 + dark * 2, hazel: 1.2, amber: 0.4, green: 1.2 * (1 - dark), blue: 1.6 * (1 - dark) ** 1.5, grey: 0.8 * (1 - dark) })];
  const role = look.role;
  const prof = PROFILES[role]?.outfit;
  const outfitKey = OUTFITS[String(pp.outfit)] ? String(pp.outfit) : pick(rng.fork("outfit"), { ...BASE.outfit, ...(prof ?? {}) });
  const outfit = OUTFITS[outfitKey];
  const c = (pp.colors ?? {}) as Record<string, unknown>;
  const oc = (k: string, i: number) => (typeof c[k] === "string" && HEX.test(c[k] as string) ? (c[k] as string) : outfit[i]);
  const shade = (hex: string, k: number, toward = "#3a2218") => mixHex(hex, toward, k);
  const metal = role === "noble" || look.hat === "crown" ? "#c9a75a" : role === "guard" ? "#8d959c" : "#7a8188";
  return {
    skin,
    hair,
    cloth1: oc("top", 0),
    cloth2: oc("bottom", 1),
    cloth3: oc("detail", 2),
    leather: oc("leather", 3),
    accent: typeof c.hat === "string" && HEX.test(c.hat) ? (c.hat as string) : rng.fork("hatcolor").pick([outfit[2], outfit[0], outfit[1], "#8a4b3a", "#3f5468"]),
    eye: iris,
    ink: "#1b1617",
    // lèvres et pommettes (rôle libre « sky » réservé au ciel sur les décors, propre au personnage ici)
    sky: typeof c.lips === "string" && HEX.test(c.lips) ? (c.lips as string) : mixHex(skin, "#b04a4a", 0.32 + dark * 0.1),
    // peau ombrée : taches de rousseur, rides, barbe de trois jours
    bark: look.beard === "stubble" ? mixHex(skin, hair, 0.42) : shade(skin, 0.3),
    metal,
    flower: rng.fork("flowercolor").pick(["#d38a5c", "#d07a8f", "#e2c25a", "#9a7ac4", "#e8e0d0"]),
    paper: look.over === "apron" || look.hat === "toque" ? "#ece6da" : "#e8dcc4",
    // paille (rôle « leaf2 » : texture tachetée, sans le mélange de pente des rôles de sol)
    leaf2: "#d6b878",
    // personnage animal : museau, truffe, intérieur des oreilles, bec, crinière, marques, bout de queue (voir ANIMAL_ROLE)
    ...(an
      ? {
          white: an.colors.muzzle,
          black: an.colors.nose,
          sky: an.colors.innerEar,
          orange: an.colors.beak,
          hair: HEX.test(hc) || HAIR_COLORS[hc] ? hair : an.colors.mane,
          bark: an.colors.marks,
          paper: an.colors.tailTip,
        }
      : {}),
  } as const;
}

export function mixHex(a: string, b: string, k: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return "#" + pa.map((x, i) => Math.round(x + (pb[i] - x) * k).toString(16).padStart(2, "0")).join("");
}
