/**
 * Générateur `character` : personnage humanoïde skinné sur un squelette 3D (23 os).
 *
 * - Corps et vêtements : un champ implicite construit sur les os (union douce entre os parent-enfant, dure ailleurs),
 *   polygonisé une fois ; les vêtements sont des couches plus larges sur les mêmes os (voir character/body.ts).
 * - Tête et mains : champs propres polygonisés plus finement (nez, oreilles, lèvres, barbe, doigts) et rattachés sous
 *   le menton et au poignet (character/head.ts, character/hands.ts).
 * - Bords de couleur nets : les triangles sont découpés le long des frontières de rôles et des motifs.
 * - Variété : toute valeur `auto` est tirée de la graine, biaisée par le rôle (`role`) et la figure (`figure`), avec des
 *   règles de cohérence (character/look.ts).
 */
import { ARCHETYPES, AGES } from "../rig/humanoid";
import { buildCharacter, type Built } from "./character/build";
import {
  ANIMALS, BAGS, BEARDS, BELTS, BOTTOMS, BROWS, COLLARS, DETAILS, EARS, EYES, EYE_COLORS, FIGURES, GLASSES, GLOVES, HAIRS, HAIR_COLORS, HATS, HEAD_SHAPES, ITEMS, LEVELS, LIPS, MOODS, MUSTACHES, NOSES, OUTFITS, OVERS, PATTERNS, ROLES_CHAR, SHOES, SKIN_TONES, TOPS,
  resolveColors, resolveLook,
} from "./character/look";
import { defineGenerator } from "./types";

export { HAIR_COLORS, OUTFITS, SKIN_TONES, EYE_COLORS };

const auto = <T extends readonly string[]>(list: T) => ["auto", ...list] as const;

export const characterSchema = {
  role: { type: "enum", default: "auto", options: auto(ROLES_CHAR), doc: "Rôle social : biaise les tirages auto (tenue, chapeau, objet, âge, posture) sans les imposer" },
  figure: { type: "enum", default: "auto", options: auto(FIGURES), doc: "Silhouette et style : feminine, masculine, androgynous (biaise coupe, coiffure, pilosité)" },
  height: { type: "number", default: 1.7, min: 0.5, max: 2.6, unit: "m", doc: "Taille (m) ; laissée à 1,7 : varie selon l'âge et la graine" },
  archetype: { type: "enum", default: "stylized", options: Object.keys(ARCHETYPES), doc: "Proportions : chibi (2,6 têtes), cartoon (4,5), stylized (6), heroic (7,2)" },
  age: { type: "enum", default: "auto", options: auto(AGES), doc: "child, teen, adult, elder (auto : surtout adultes)" },
  build: { type: "number", default: 0.45, min: 0, max: 1, doc: "Carrure : 0 fin … 1 massif (laissée par défaut : varie avec la graine)" },
  shape: { type: "number", default: 0, min: -1, max: 1, doc: "-1 hanches larges … +1 épaules larges" },
  headSize: { type: "number", default: 1, min: 0.8, max: 1.3, doc: "Taille relative de la tête" },
  belly: { type: "number", default: 0.15, min: 0, max: 1, doc: "Ventre" },
  body: { type: "object", default: {}, doc: "Silhouette, chaque clé dans [-1, 1] : legs, arms, neck, shoulders, hips, bust (0…1), posture (-1 cambré … +1 voûté), asym ; absente = tirée de la graine" },
  variation: { type: "number", default: 0.6, min: 0, max: 1, doc: "Amplitude des variations de silhouette tirées de la graine" },
  skin: { type: "string", default: "auto", doc: `Carnation : ${Object.keys(SKIN_TONES).join(", ")}, #rrggbb ou auto (graine)` },
  hair: { type: "enum", default: "auto", options: auto(HAIRS), doc: "Coiffure" },
  hairColor: { type: "string", default: "auto", doc: `Couleur : ${Object.keys(HAIR_COLORS).join(", ")}, #rrggbb ou auto` },
  headShape: { type: "enum", default: "auto", options: auto(HEAD_SHAPES), doc: "Forme de tête" },
  eyes: { type: "enum", default: "auto", options: auto(EYES), doc: "Forme des yeux" },
  eyeColor: { type: "string", default: "auto", doc: `Iris : ${Object.keys(EYE_COLORS).join(", ")}, #rrggbb ou auto` },
  brows: { type: "enum", default: "auto", options: auto(BROWS), doc: "Sourcils" },
  nose: { type: "enum", default: "auto", options: auto(NOSES), doc: "Nez" },
  lips: { type: "enum", default: "auto", options: auto(LIPS), doc: "Lèvres" },
  ears: { type: "enum", default: "auto", options: auto(EARS), doc: "Oreilles (pointed : elfe)" },
  animal: { type: "enum", default: "none", options: ANIMALS, doc: "Personnage animal (corps humanoïde, vêtements et animations inchangés) : cat, fox, dog, bear, rabbit, mouse, pig, owl, frog, dino, lion, tiger, panda, koala, raccoon, monkey, cow, sheep, deer, horse, elephant, duck ; custom = fiche animalSpec seule" },
  animalSpec: { type: "object", default: {}, doc: "Retouche de la fiche de l'animal (ou espèce inventée) : ears {shape pointed|round|floppy|long|flap|tuft|none, size 0..3, spread 0..1, tilt}, horns none|small|antlers, snout {w, h, l} (l > 1,2 : trompe), nose, beak, mane, markings none|mask|patches, eyeBulge, spikes, eyeDiscs, tail {shape curve|bushy|wag|stub|pom|long|curl|fan|thick|tuft|none, length 0..3, tip}, colors {fur [#…], muzzle, nose, innerEar, beak, mane, marks, tailTip}" },
  beard: { type: "enum", default: "auto", options: auto(BEARDS), doc: "Barbe" },
  mustache: { type: "enum", default: "auto", options: auto(MUSTACHES), doc: "Moustache" },
  glasses: { type: "enum", default: "auto", options: auto(GLASSES), doc: "Lunettes" },
  freckles: { type: "enum", default: "auto", options: auto(LEVELS), doc: "Taches de rousseur" },
  blush: { type: "enum", default: "auto", options: auto(LEVELS), doc: "Joues rosées" },
  wrinkles: { type: "enum", default: "auto", options: auto(LEVELS), doc: "Rides (auto : selon l'âge)" },
  top: { type: "enum", default: "auto", options: auto(TOPS), doc: "Haut" },
  bottom: { type: "enum", default: "auto", options: auto(BOTTOMS), doc: "Bas (overalls : salopette)" },
  over: { type: "enum", default: "auto", options: auto(OVERS), doc: "Surcouche : gilet, veste ouverte, tablier, plastron" },
  collar: { type: "enum", default: "auto", options: auto(COLLARS), doc: "Col" },
  belt: { type: "enum", default: "auto", options: auto(BELTS), doc: "Ceinture (avec boucle) ou écharpe nouée" },
  details: { type: "enum", default: "auto", options: auto(DETAILS), doc: "Boutons, poches" },
  gloves: { type: "enum", default: "auto", options: auto(GLOVES), doc: "Gants" },
  pattern: { type: "enum", default: "auto", options: auto(PATTERNS), doc: "Motif du haut : rayures, rayures verticales, carreaux" },
  shoes: { type: "enum", default: "auto", options: auto(SHOES), doc: "Chaussures (tallboots : bottes hautes)" },
  hat: { type: "enum", default: "auto", options: auto(HATS), doc: "Couvre-chef (flowers : couronne de fleurs ; hood : capuche)" },
  bag: { type: "enum", default: "auto", options: auto(BAGS), doc: "Sac, cape, écharpe ou bourse" },
  item: { type: "enum", default: "auto", options: auto(ITEMS), doc: "Objet tenu (main droite, prise refermée)" },
  mood: { type: "enum", default: "neutral", options: MOODS, doc: "Expression du visage (et posture d'animation)" },
  outfit: { type: "string", default: "auto", doc: `Garde-robe : ${Object.keys(OUTFITS).join(", ")} ou auto` },
  colors: { type: "object", default: {}, doc: "Surcharges de couleurs : {top, bottom, detail, leather, hat, lips} en #rrggbb" },
  detail: { type: "enum", default: "auto", options: ["auto", "high", "crowd"], doc: "Finesse du maillage : high (héros), crowd (foule, ≈ 2× plus rapide), auto (héros pour les acteurs, foule pour les couches)" },
} as const;

const cache = new Map<string, Built>();

export const character = defineGenerator({
  id: "character",
  label: "Personnage",
  doc: "Humanoïde skinné (quaternions duaux) : proportions par archétype et silhouette variée, tête et mains fines (4 doigts + pouce, prise refermée sur l'objet), visage paramétrique (yeux, iris, sourcils, nez, lèvres, oreilles, barbe, moustache, lunettes, rides, taches de rousseur), garde-robe en couches (cols, gilets, vestes, tablier, salopette, robe, plastron, ceinture, boutons, poches, gants, bottes, motifs), 16 coiffures, 15 couvre-chefs, rôles sociaux qui biaisent les tirages. Bords de couleur nets. Animé par la scène.",
  tags: ["personnage", "humain", "foule", "pnj", "héros"],
  schema: characterSchema,
  build(p, ctx) {
    const pp = p as unknown as Record<string, unknown> & { colors: Record<string, unknown> };
    const rng = ctx.rng;
    const look = resolveLook(pp, rng, ctx.issues, ctx.path);
    const colors = resolveColors(pp, look, rng, ctx.issues, ctx.path);
    const v = rng.fork("var");
    const key = JSON.stringify({ look, seed: rng.key.split("/").slice(-1)[0] });
    let built = cache.get(key);
    if (!built) {
      built = buildCharacter(look, v);
      cache.set(key, built);
      if (cache.size > 48) cache.delete(cache.keys().next().value as string);
    }
    return { generator: "character", mesh: built.mesh, skeleton: built.skeleton, anchors: built.anchors, footprint: built.footprint, height: built.height, colors, blink: true, extra: { look } };
  },
});
