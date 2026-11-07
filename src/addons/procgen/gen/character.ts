/**
 * Générateur `character` : personnage humanoïde d'**une seule peau continue**, skinnée sur un squelette 3D.
 *
 * Corps, vêtements, cheveux, chapeau et sac sont des primitives d'un même champ implicite construit sur les os
 * (union douce entre os parent-enfant seulement, union dure ailleurs). Un vêtement est une couche plus large sur les
 * mêmes os : il recouvre la peau sans l'interpénétrer, et la peau couverte n'est pas générée (l'union garde la surface
 * extérieure). Le visage (yeux, pupilles, reflets, sourcils, bouche) et l'objet tenu sont des gabarits rattachés aux os.
 */
import { type Q, type V3, DEG, add, clamp, cross, dot, len, lerp3, m4Compose, madd, mix, norm, qAxis, qFromTo, qId, scale, smoothstep, sub } from "../core/math";
import { Field, type Blend, type FieldPrim, polygonize } from "../geom/implicit";
import { Mesh } from "../geom/mesh";
import { box, cylinder, ellipsoid, lathe, tube } from "../geom/prims";
import { AGES, ARCHETYPES, type Archetype, type Age, HUMANOID_BLENDS, buildHumanoid, proportions } from "../rig/humanoid";
import { computeWeights } from "../rig/weights";
import type { Skeleton } from "../rig/skeleton";
import { ROLE, type Role } from "../style/roles";
import { type Anchor, type Asset, defineGenerator } from "./types";

export const SKIN_TONES: Record<string, string> = {
  porcelain: "#f3d6c4", fair: "#ebc3a6", sand: "#ddaa86", honey: "#c99169", cinnamon: "#ab7350", amber: "#8f5a3a", brown: "#6f432a", ebony: "#4c2d1d", green: "#8fae84", blue: "#8d9ec4",
};
export const HAIR_COLORS: Record<string, string> = {
  black: "#2a2422", darkbrown: "#45302a", brown: "#6a4a35", auburn: "#7a3a28", ginger: "#b1622f", blonde: "#d3b57c", platinum: "#e6dbc4", grey: "#9a958e", white: "#e8e5df", blue: "#3e5c8a", pink: "#c27a92",
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
};

const TOPS = ["none", "tee", "long", "tank", "sweater", "coat", "robe"] as const;
const BOTTOMS = ["trousers", "shorts", "skirt", "longskirt"] as const;
const SHOES = ["shoes", "boots", "sandals", "barefoot"] as const;
const HAIRS = ["none", "crop", "short", "bob", "long", "ponytail", "bun", "curly", "mohawk"] as const;
const HATS = ["none", "cap", "beret", "tophat", "wizard", "straw", "helmet", "crown"] as const;
const BAGS = ["none", "backpack", "satchel", "cape", "scarf"] as const;
const ITEMS = ["none", "staff", "sword", "lantern", "book", "umbrella", "torch", "flower", "mug"] as const;
const MOODS = ["neutral", "happy", "sad", "angry", "surprised", "sleepy"] as const;

export const characterSchema = {
  height: { type: "number", default: 1.7, min: 0.5, max: 2.6, unit: "m", doc: "Taille (m)" },
  archetype: { type: "enum", default: "stylized", options: Object.keys(ARCHETYPES), doc: "Proportions : chibi (2,6 têtes), cartoon (4,5), stylized (6), heroic (7,2)" },
  age: { type: "enum", default: "adult", options: AGES, doc: "child, teen, adult, elder" },
  build: { type: "number", default: 0.45, min: 0, max: 1, doc: "Carrure : 0 fin … 1 massif" },
  shape: { type: "number", default: 0, min: -1, max: 1, doc: "-1 hanches larges … +1 épaules larges" },
  headSize: { type: "number", default: 1, min: 0.8, max: 1.3, doc: "Taille relative de la tête" },
  belly: { type: "number", default: 0.15, min: 0, max: 1, doc: "Ventre" },
  skin: { type: "string", default: "auto", doc: `Carnation : ${Object.keys(SKIN_TONES).join(", ")}, #rrggbb ou auto (graine)` },
  hair: { type: "enum", default: "short", options: HAIRS, doc: "Coiffure" },
  hairColor: { type: "string", default: "auto", doc: `Couleur : ${Object.keys(HAIR_COLORS).join(", ")}, #rrggbb ou auto` },
  top: { type: "enum", default: "tee", options: TOPS, doc: "Haut" },
  bottom: { type: "enum", default: "trousers", options: BOTTOMS, doc: "Bas" },
  shoes: { type: "enum", default: "shoes", options: SHOES, doc: "Chaussures" },
  hat: { type: "enum", default: "none", options: HATS, doc: "Chapeau" },
  bag: { type: "enum", default: "none", options: BAGS, doc: "Sac, cape ou écharpe" },
  item: { type: "enum", default: "none", options: ITEMS, doc: "Objet tenu (main droite)" },
  mood: { type: "enum", default: "neutral", options: MOODS, doc: "Expression du visage (et posture d'animation)" },
  outfit: { type: "string", default: "auto", doc: `Garde-robe : ${Object.keys(OUTFITS).join(", ")} ou auto` },
  colors: { type: "object", default: {}, doc: "Surcharges de couleurs : {top, bottom, detail, leather, hat} en #rrggbb" },
  detail: { type: "enum", default: "auto", options: ["auto", "high", "crowd"], doc: "Finesse du maillage : high (héros), crowd (foule, ≈ 2× plus rapide), auto (héros pour les acteurs, foule pour les couches)" },
} as const;

type P = {
  height: number; archetype: string; age: string; build: number; shape: number; headSize: number; belly: number; skin: string; hair: string; hairColor: string;
  top: string; bottom: string; shoes: string; hat: string; bag: string; item: string; mood: string; outfit: string; colors: Record<string, unknown>; detail: string;
};

const HEX = /^#[0-9a-f]{6}$/i;
const cache = new Map<string, { mesh: Mesh; skeleton: Skeleton; anchors: Record<string, Anchor>; footprint: Asset["footprint"]; height: number }>();

export const character = defineGenerator({
  id: "character",
  label: "Personnage",
  doc: "Humanoïde d'une seule peau, skinné (quaternions duaux) : proportions par archétype, vêtements en couches, coiffures, chapeaux, sacs, objet tenu, visage expressif avec clignement. Animé par la scène (actions, marche, IK).",
  tags: ["personnage", "humain", "foule", "pnj", "héros"],
  schema: characterSchema,
  build(p, ctx) {
    const pp = p as unknown as P;
    const rng = ctx.rng;
    // couleurs (uniformes : ne changent pas la géométrie)
    const skin = HEX.test(pp.skin) ? pp.skin : SKIN_TONES[pp.skin] ?? rng.fork("skin").pick(Object.values(SKIN_TONES).slice(0, 8));
    if (pp.skin !== "auto" && !HEX.test(pp.skin) && !SKIN_TONES[pp.skin]) ctx.issues.add({ path: `${ctx.path}.skin`, code: "unknown", message: `carnation « ${pp.skin} » inconnue`, hint: Object.keys(SKIN_TONES).join(", ") });
    const hairC = HEX.test(pp.hairColor) ? pp.hairColor : HAIR_COLORS[pp.hairColor] ?? rng.fork("haircolor").pick(Object.values(HAIR_COLORS).slice(0, 8));
    const outfit = OUTFITS[pp.outfit] ?? rng.fork("outfit").pick(Object.values(OUTFITS));
    const oc = (k: string, i: number) => (typeof pp.colors[k] === "string" && HEX.test(pp.colors[k] as string) ? (pp.colors[k] as string) : outfit[i]);
    const colors: Partial<Record<Role, string>> = { skin, hair: hairC, cloth1: oc("top", 0), cloth2: oc("bottom", 1), cloth3: oc("detail", 2), leather: oc("leather", 3), accent: oc("hat", 2) };
    // compatibilités
    let hair = pp.hair;
    if (pp.hat !== "none" && hair === "mohawk") {
      ctx.issues.add({ path: `${ctx.path}.hair`, code: "info", message: "crête incompatible avec un chapeau : coiffure courte utilisée", got: "mohawk", used: "short" });
      hair = "short";
    }
    // micro-variations stables par graine
    const v = rng.fork("var");
    const key = JSON.stringify({ ...pp, skin: 0, hairColor: 0, outfit: 0, colors: 0, hair, seed: rng.key.split("/").slice(-1)[0] });
    let built = cache.get(key);
    if (!built) {
      built = buildBody({ ...pp, hair }, v);
      cache.set(key, built);
      if (cache.size > 48) cache.delete(cache.keys().next().value as string);
    }
    return { generator: "character", mesh: built.mesh, skeleton: built.skeleton, anchors: built.anchors, footprint: built.footprint, height: built.height, colors, blink: true };
  },
});

function buildBody(p: P, v: import("../core/rng").Rng) {
  const P = proportions({ height: p.height, archetype: p.archetype as Archetype, age: p.age as Age, build: p.build, shape: p.shape, headSize: p.headSize * v.vary(1, 0.03), belly: p.belly });
  const skel = buildHumanoid(P);
  const H = P.H;
  const cell = H * (p.archetype === "chibi" ? 0.0115 : 0.0125) * (p.detail === "crowd" ? 1.4 : 1);
  const thick = Math.max(cell * 1.6, H * 0.011);
  const bw = 0.82 + 0.4 * p.build;
  const prims: FieldPrim[] = [];
  const primBone: number[] = [];
  const drape: boolean[] = [];
  const B = (n: string) => skel.bones[skel.index[n]];
  const push = (f: FieldPrim, bone: string, isDrape = false) => {
    prims.push(f);
    primBone.push(skel.index[bone]);
    drape.push(isDrape);
    return prims.length - 1;
  };
  const S = ROLE.skin;
  const groups: Record<string, number[]> = {};
  const g = (name: string, i: number) => ((groups[name] ??= []).push(i), i);
  const at = (bone: string, t: number): V3 => lerp3(B(bone).head, B(bone).tail, t);
  const rad = (bone: string, t: number) => mix(B(bone).radius[0], B(bone).radius[1], t);
  const cap = (bone: string, t0: number, t1: number, extra: number, role: number, mul = 1): FieldPrim => ({ kind: "capsule", a: at(bone, t0), b: at(bone, t1), ra: rad(bone, t0) * mul + extra, rb: rad(bone, t1) * mul + extra, role, tag: 0 });

  /* ---------- corps ---------- */
  const hipC: V3 = [0, P.hipY + H * 0.01, -H * 0.008];
  const torsoD = P.torsoD;
  g("pelvis", push({ kind: "ellipsoid", c: hipC, r: [P.hipHalf * 1.32 * bw, H * 0.068, H * 0.072 * torsoD * bw], role: S, tag: 0 }, "pelvis"));
  const sp = (rr: number) => ({ ...cap("spine", 0, 1, 0, S, rr * bw) });
  g("spine", push(sp(1), "spine"));
  if (p.belly > 0.05) g("spine", push({ kind: "ellipsoid", c: add(at("spine", 0.35), [0, 0, H * 0.025 * p.belly]), r: [H * (0.075 + 0.03 * p.belly) * bw, H * 0.075, H * (0.06 + 0.045 * p.belly) * bw], role: S, tag: 0 }, "spine"));
  const chestC = add(at("chest", 0.45), [0, 0, H * 0.004]);
  const chestR: V3 = [P.shoulderHalf * 0.88 * mix(0.95, 1.08, p.build), H * 0.1, H * 0.068 * torsoD * bw];
  g("chest", push({ kind: "ellipsoid", c: chestC, r: chestR, role: S, tag: 0 }, "chest"));
  g("neck", push(cap("neck", -0.1, 1.05, 0, S), "neck"));
  const headC: V3 = [0, P.chinY + P.headH * 0.5, P.headD * 0.02];
  const headR: V3 = [P.headW * 0.5, P.headH * 0.5, P.headD * 0.5];
  const headPrim = g("head", push({ kind: "ellipsoid", c: headC, r: headR, role: S, tag: 0 }, "head"));
  // mâchoire : allonge le bas du visage pour les archétypes réalistes
  if (p.archetype === "stylized" || p.archetype === "heroic") g("head", push({ kind: "ellipsoid", c: add(headC, [0, -P.headH * 0.2, P.headD * 0.06]), r: [P.headW * 0.36, P.headH * 0.3, P.headD * 0.38], role: S, tag: 0 }, "head"));
  // nez et oreilles (dans le champ : soudés au visage)
  const onHead = (dir: V3) => {
    const d = norm(dir);
    const k = 1 / len([d[0] / headR[0], d[1] / headR[1], d[2] / headR[2]]);
    const pt = madd(headC, d, k);
    const n = norm([(pt[0] - headC[0]) / (headR[0] * headR[0]), (pt[1] - headC[1]) / (headR[1] * headR[1]), (pt[2] - headC[2]) / (headR[2] * headR[2])]);
    return { pt, n };
  };
  if (p.archetype !== "chibi") {
    const nose = onHead([0, -0.12, 1]);
    const nr = P.headW * (p.archetype === "cartoon" ? 0.085 : 0.07);
    g("head", push({ kind: "ellipsoid", c: madd(nose.pt, nose.n, nr * 0.25), r: [nr * 0.75, nr, nr * 0.9], role: S, tag: 0 }, "head"));
  }
  for (const sx of [1, -1]) {
    const ear = onHead([sx, -0.05, -0.05]);
    const er = P.headH * (p.archetype === "chibi" ? 0.13 : 0.11);
    g("head", push({ kind: "ellipsoid", c: madd(ear.pt, ear.n, er * 0.1), r: [er * 0.35, er, er * 0.62], role: S, tag: 0 }, "head"));
  }
  for (const s of ["l", "r"]) {
    g("clavicle", push(cap(`clavicle.${s}`, 0.2, 1, 0, S, bw), `clavicle.${s}`));
    g("upperarm", push(cap(`upperarm.${s}`, 0, 1, 0, S, bw), `upperarm.${s}`));
    g("forearm", push(cap(`forearm.${s}`, 0, 1, 0, S, mix(0.95, 1.1, p.build)), `forearm.${s}`));
    // main : paume (moufle) + pouce
    const hb = B(`hand.${s}`);
    const hd = norm(sub(hb.tail, hb.head));
    const side: V3 = [s === "l" ? 1 : -1, 0, 0];
    const fwd = norm(cross(hd, side));
    const hr = hb.radius[0];
    g("hand", push({ kind: "capsule", a: madd(hb.head, hd, hr * 0.5), b: madd(hb.tail, hd, -hr * 0.4), ra: hr, rb: hr * 0.85, role: S, tag: 0 }, `hand.${s}`));
    g("hand", push({ kind: "capsule", a: madd(madd(hb.head, hd, hr * 0.9), fwd, hr * 0.7), b: madd(madd(hb.head, hd, hr * 2.2), fwd, hr * 1.45), ra: hr * 0.45, rb: hr * 0.36, role: S, tag: 0 }, `hand.${s}`));
    g("thigh", push(cap(`thigh.${s}`, 0, 1, 0, S, bw), `thigh.${s}`));
    g("shin", push(cap(`shin.${s}`, 0, 1, 0, S, mix(0.95, 1.08, p.build)), `shin.${s}`));
    const fb = B(`foot.${s}`);
    const fr = fb.radius[0];
    g("foot", push({ kind: "capsule", a: add(fb.head, [0, -fr * 0.2, -fr * 0.6]), b: add(fb.tail, [0, fr * 0.05, 0]), ra: fr * 0.95, rb: fr * 0.9, role: S, tag: 0 }, `foot.${s}`));
    g("toe", push(cap(`toe.${s}`, 0, 1, 0, S), `toe.${s}`));
  }

  /* ---------- vêtements (couches sur les mêmes os) ---------- */
  const C1 = ROLE.cloth1, C2 = ROLE.cloth2, C3 = ROLE.cloth3, LE = ROLE.leather;
  const layer = (name: string, f: FieldPrim, bone: string, isDrape = false) => g(name, push(f, bone, isDrape));
  const inflate = (i: number, extra: number, role: number): FieldPrim => {
    const f = prims[i];
    if (f.kind === "ellipsoid") return { ...f, r: [f.r[0] + extra, f.r[1] + extra, f.r[2] + extra], role };
    if (f.kind === "capsule") return { ...f, ra: f.ra + extra, rb: f.rb + extra, role };
    return { ...f, role };
  };
  const torsoIdx = [...groups.chest, ...groups.spine];
  const pelvisIdx = groups.pelvis[0];
  const top = p.top;
  if (top !== "none") {
    for (const i of torsoIdx) layer("chest", inflate(i, thick, C1), skel.bones[primBone[i]].name);
    // ourlet sur les hanches
    layer("pelvis", { kind: "ellipsoid", c: add(hipC, [0, H * 0.035, 0]), r: [P.hipHalf * 1.3 * bw + thick * 1.15, H * 0.045, H * 0.07 * torsoD * bw + thick * 1.15], role: C1, tag: 0 }, "pelvis");
    for (const s of ["l", "r"]) {
      if (top !== "tank") layer("clavicle", cap(`clavicle.${s}`, 0.2, 1, thick, C1, bw), `clavicle.${s}`);
      const sleeve = { tee: [0.55, 0], long: [1, 0.93], tank: [0, 0], sweater: [1, 0.95], coat: [1, 0.9], robe: [1, 0.95] }[top] ?? [0, 0];
      if (sleeve[0] > 0) layer("upperarm", cap(`upperarm.${s}`, 0, sleeve[0], thick, C1, bw * (top === "robe" ? 1.15 : 1)), `upperarm.${s}`);
      if (sleeve[1] > 0) layer("forearm", cap(`forearm.${s}`, 0, sleeve[1], thick * (top === "robe" ? 1.8 : 1), C1, top === "robe" ? 1.25 : 1), `forearm.${s}`);
    }
    if (top === "sweater") layer("neck", cap("neck", -0.1, 0.45, thick * 0.9, C1), "neck");
    if (top === "coat" || top === "robe") {
      // pans tombants (poids mêlés bassin + cuisses)
      const knee = B("shin.l").head[1];
      const bottomY = top === "robe" ? P.ankleY + H * 0.03 : knee - H * 0.01;
      layer("pelvis", { kind: "capsule", a: [0, P.hipY + H * 0.03, -H * 0.005], b: [0, bottomY, -H * 0.012], ra: P.hipHalf * 1.32 * bw + thick, rb: P.hipHalf * (top === "robe" ? 2.05 : 1.75) * bw + thick, role: C1, tag: 0 }, "pelvis", true);
      // ceinture
      layer("spine", { kind: "ellipsoid", c: at("spine", 0.25), r: [rad("spine", 0.25) * bw + thick * 1.6, H * 0.012, rad("spine", 0.25) * bw * 0.95 + thick * 1.6], role: LE, tag: 0 }, "spine");
    }
  }
  const bottom = p.bottom;
  const covered = top === "robe";
  if (!covered) {
    layer("pelvis", inflate(pelvisIdx, thick * 0.6, C2), "pelvis");
    for (const s of ["l", "r"]) {
      if (bottom === "trousers") {
        layer("thigh", cap(`thigh.${s}`, 0, 1, thick * 0.6, C2, bw), `thigh.${s}`);
        layer("shin", cap(`shin.${s}`, 0, 0.92, thick * 0.6, C2, 1.04), `shin.${s}`);
      } else if (bottom === "shorts") layer("thigh", cap(`thigh.${s}`, 0, 0.62, thick * 0.7, C2, bw * 1.08), `thigh.${s}`);
    }
    if (bottom === "skirt" || bottom === "longskirt") {
      const knee = B("shin.l").head[1];
      const endY = bottom === "longskirt" ? P.ankleY + H * 0.05 : knee + H * 0.03;
      layer("pelvis", { kind: "capsule", a: [0, P.hipY + H * 0.02, -H * 0.006], b: [0, endY, -H * 0.012], ra: P.hipHalf * 1.3 * bw + thick * 0.7, rb: P.hipHalf * (bottom === "longskirt" ? 1.95 : 1.7) * bw + thick, role: C2, tag: 0 }, "pelvis", true);
    }
  }
  for (const s of ["l", "r"]) {
    if (p.shoes === "barefoot") continue;
    const ex = p.shoes === "sandals" ? thick * 0.25 : thick * 0.8;
    const fi = groups.foot[s === "l" ? 0 : 1];
    layer("foot", inflate(fi, ex, LE), `foot.${s}`);
    layer("toe", inflate(groups.toe[s === "l" ? 0 : 1], ex, LE), `toe.${s}`);
    if (p.shoes === "boots") layer("shin", cap(`shin.${s}`, 0.5, 1, thick * 1.25, LE, 1.05), `shin.${s}`);
    if (p.shoes === "shoes") layer("shin", cap(`shin.${s}`, 0.9, 1, ex, LE), `shin.${s}`);
  }

  /* ---------- cheveux ---------- */
  const HR = ROLE.hair;
  const hairPrim = (c: V3, r: V3, bump = 0) => layer("head", { kind: "ellipsoid", c, r, role: HR, tag: 0, ...(bump ? { bump: { amp: bump, freq: 1 / (P.headW * 0.18), seed: v.range(0, 99) } } : {}) }, "head");
  const hh = P.headH, hw = P.headW, hd = P.headD;
  if (p.hair !== "none") {
    const t = p.hair === "crop" ? 0.025 : 0.06;
    hairPrim(add(headC, [0, hh * 0.07, -hd * 0.06]), [headR[0] * (1 + t * 0.8), headR[1] * (0.95 + t * 0.3), headR[2] * (1 + t * 0.6)], p.hair === "curly" ? hw * 0.03 : 0);
    // frange
    if (p.hair !== "crop") hairPrim(add(headC, [hw * v.range(-0.08, 0.08), hh * 0.28, hd * 0.2]), [hw * 0.38, hh * 0.13, hd * 0.32], p.hair === "curly" ? hw * 0.025 : 0);
    if (p.hair === "bob") hairPrim(add(headC, [0, -hh * 0.08, -hd * 0.1]), [hw * 0.56, hh * 0.42, hd * 0.5]);
    if (p.hair === "long") {
      hairPrim(add(headC, [0, -hh * 0.1, -hd * 0.12]), [hw * 0.55, hh * 0.45, hd * 0.48]);
      layer("chest", { kind: "capsule", a: add(headC, [0, -hh * 0.3, -hd * 0.28]), b: add(at("chest", 0.35), [0, 0, -chestR[2] - thick * 1.2]), ra: hw * 0.36, rb: hw * 0.42, role: HR, tag: 0 }, "chest");
    }
    if (p.hair === "ponytail") layer("head", { kind: "capsule", a: add(headC, [0, hh * 0.05, -hd * 0.5]), b: add(headC, [0, -hh * 0.75, -hd * 0.72]), ra: hw * 0.13, rb: hw * 0.06, role: HR, tag: 0 }, "head");
    if (p.hair === "bun") hairPrim(add(headC, [0, hh * 0.5, -hd * 0.32]), [hw * 0.2, hw * 0.2, hw * 0.2]);
    if (p.hair === "curly") hairPrim(add(headC, [0, hh * 0.12, -hd * 0.08]), [headR[0] * 1.14, headR[1] * 1.02, headR[2] * 1.1], hw * 0.045);
    if (p.hair === "mohawk") layer("head", { kind: "box", c: add(headC, [0, hh * 0.45, -hd * 0.1]), h: [hw * 0.07, hh * 0.18, hd * 0.42], round: hw * 0.05, role: HR, tag: 0 }, "head");
  }

  /* ---------- chapeau ---------- */
  const A = ROLE.accent;
  const topY = headC[1] + headR[1];
  const hatC: V3 = [0, topY - hh * 0.18, headC[2] - hd * 0.03];
  switch (p.hat) {
    case "cap":
      layer("head", { kind: "ellipsoid", c: add(headC, [0, hh * 0.14, -hd * 0.04]), r: [headR[0] * 1.1, headR[1] * 0.82, headR[2] * 1.08], role: A, tag: 0 }, "head");
      layer("head", { kind: "ellipsoid", c: add(headC, [0, hh * 0.22, hd * 0.5]), r: [hw * 0.42, hh * 0.035, hd * 0.32], role: A, tag: 0 }, "head");
      break;
    case "beret":
      layer("head", { kind: "ellipsoid", c: add(hatC, [hw * 0.08, hh * 0.12, 0]), r: [hw * 0.6, hh * 0.16, hd * 0.6], role: A, tag: 0 }, "head");
      break;
    case "tophat":
      layer("head", { kind: "ellipsoid", c: add(hatC, [0, hh * 0.04, 0]), r: [hw * 0.82, hh * 0.03, hd * 0.82], role: ROLE.ink, tag: 0 }, "head");
      layer("head", { kind: "cone", a: add(hatC, [0, hh * 0.03, 0]), b: add(hatC, [0, hh * 0.8, 0]), ra: hw * 0.46, rb: hw * 0.5, round: hw * 0.03, role: ROLE.ink, tag: 0 }, "head");
      break;
    case "wizard":
      layer("head", { kind: "ellipsoid", c: add(hatC, [0, hh * 0.02, 0]), r: [hw * 0.95, hh * 0.035, hd * 0.95], role: A, tag: 0 }, "head");
      layer("head", { kind: "cone", a: add(hatC, [0, hh * 0.02, 0]), b: add(hatC, [-hw * 0.18, hh * 1.3, -hd * 0.25]), ra: hw * 0.56, rb: hw * 0.02, round: hw * 0.03, role: A, tag: 0 }, "head");
      break;
    case "straw":
      layer("head", { kind: "ellipsoid", c: add(hatC, [0, hh * 0.02, 0]), r: [hw * 1.15, hh * 0.04, hd * 1.15], role: ROLE.path, tag: 0 }, "head");
      layer("head", { kind: "ellipsoid", c: add(hatC, [0, hh * 0.18, 0]), r: [hw * 0.55, hh * 0.24, hd * 0.55], role: ROLE.path, tag: 0 }, "head");
      break;
    case "helmet":
      layer("head", { kind: "ellipsoid", c: add(headC, [0, hh * 0.1, -hd * 0.04]), r: [headR[0] * 1.16, headR[1] * 0.94, headR[2] * 1.14], role: ROLE.metal, tag: 0 }, "head");
      break;
    case "crown":
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        layer("head", { kind: "capsule", a: add(hatC, [Math.cos(a) * hw * 0.42, hh * 0.08, Math.sin(a) * hd * 0.42]), b: add(hatC, [Math.cos(a) * hw * 0.45, hh * 0.3, Math.sin(a) * hd * 0.45]), ra: hw * 0.08, rb: hw * 0.03, role: ROLE.metal, tag: 0 }, "head");
      }
      layer("head", { kind: "ellipsoid", c: add(hatC, [0, hh * 0.1, 0]), r: [hw * 0.5, hh * 0.08, hd * 0.5], role: ROLE.metal, tag: 0 }, "head");
      break;
  }

  /* ---------- sacs ---------- */
  const backZ = chestC[2] - chestR[2] - thick;
  switch (p.bag) {
    case "backpack":
      layer("chest", { kind: "box", c: [0, chestC[1] - H * 0.02, backZ - H * 0.05], h: [chestR[0] * 0.62, H * 0.1, H * 0.05], round: H * 0.025, role: C3, tag: 0 }, "chest");
      break;
    case "satchel":
      layer("chest", { kind: "capsule", a: add(at("clavicle.l", 0.7), [0, thick, 0]), b: [-P.hipHalf * 1.2, P.hipY + H * 0.02, 0], ra: thick * 1.05 + H * 0.006, rb: thick * 1.05 + H * 0.006, role: LE, tag: 0 }, "chest");
      layer("pelvis", { kind: "box", c: [-P.hipHalf * 1.35 - H * 0.02, P.hipY - H * 0.01, H * 0.01], h: [H * 0.025, H * 0.05, H * 0.07], round: H * 0.015, role: LE, tag: 0 }, "pelvis");
      break;
    case "cape":
      layer("chest", { kind: "box", c: [0, (P.shoulderY + P.crotchY) / 2 - H * 0.04, backZ - H * 0.02], h: [P.shoulderHalf * 1.05, (P.shoulderY - P.crotchY) / 2 + H * 0.06, H * 0.012], round: H * 0.01, role: C3, tag: 0 }, "chest");
      break;
    case "scarf":
      layer("neck", { kind: "ellipsoid", c: at("neck", 0.15), r: [rad("neck", 0) * 1.9, H * 0.024, rad("neck", 0) * 1.9], role: C3, tag: 0 }, "neck");
      layer("chest", { kind: "capsule", a: add(at("neck", 0), [P.headW * 0.12, 0, rad("neck", 0) * 1.6]), b: add(at("chest", 0.3), [P.headW * 0.2, 0, chestR[2] + thick * 1.3]), ra: H * 0.02, rb: H * 0.02, role: C3, tag: 0 }, "chest");
      break;
  }

  /* ---------- soudures ---------- */
  const blends: Blend[] = [];
  const family = (n: string) => n.replace(/\.(l|r)$/, "");
  const sideOf = (n: string) => (n.endsWith(".l") ? "l" : n.endsWith(".r") ? "r" : "");
  const byFam = new Map<string, number[]>();
  prims.forEach((_, i) => {
    const f = family(skel.bones[primBone[i]].name);
    (byFam.get(f) ?? byFam.set(f, []).get(f)!).push(i);
  });
  for (const [ga, gb, k] of HUMANOID_BLENDS)
    for (const i of byFam.get(ga) ?? [])
      for (const j of byFam.get(gb) ?? []) {
        const si = sideOf(skel.bones[primBone[i]].name), sj = sideOf(skel.bones[primBone[j]].name);
        if (si && sj && si !== sj) continue;
        if (prims[i].role !== prims[j].role) continue;
        blends.push({ a: i, b: j, k: k * H });
      }
  // primitives d'un même os : soudure douce (mâchoire, nez, oreilles, pouce)
  const byBone = new Map<number, number[]>();
  prims.forEach((_, i) => (byBone.get(primBone[i]) ?? byBone.set(primBone[i], []).get(primBone[i])!).push(i));
  for (const list of byBone.values())
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) if (prims[list[x]].role === prims[list[y]].role) blends.push({ a: list[x], b: list[y], k: H * 0.01 });

  const field = new Field(prims, blends);
  const { mesh, owner } = polygonize(field, { cell, smooth: 3, ao: true });
  const boneOwner = Int32Array.from(owner, (o) => (o >= 0 ? primBone[o] : 0));
  const thighY = B("shin.l").head[1];
  computeWeights(mesh, boneOwner, skel, {
    passes: 9,
    side: (vi) => {
      const x = mesh.pos[vi * 3];
      return x > H * 0.008 ? "l" : x < -H * 0.008 ? "r" : "";
    },
    sharp: { "hand.l": 0.5, "hand.r": 0.5, "toe.l": 0.4, "toe.r": 0.4, head: 0.6 },
    override: (vi) => {
      const o = owner[vi];
      if (o < 0 || !drape[o]) return null;
      const pt = mesh.getPos(vi);
      const a = smoothstep(P.crotchY + H * 0.02, thighY, pt[1]);
      const sx = pt[0] >= 0 ? "l" : "r";
      const sideW = smoothstep(0, P.hipHalf * 0.9, Math.abs(pt[0]));
      const legW = (1 - a) * 0 + a * 0.6 * (0.4 + 0.6 * sideW);
      return { pelvis: 1 - legW, [`thigh.${sx}`]: legW };
    },
  });

  /* ---------- visage ---------- */
  const headIdx = skel.index.head;
  const face = new Mesh();
  const morph: number[] = [];
  const skinOf = (m: Mesh, bone: number) => {
    m.skin = new Array(m.vertexCount * 4).fill(0).map((_, k) => (k % 4 === 0 ? bone : 0));
    m.weight = new Array(m.vertexCount * 4).fill(0).map((_, k) => (k % 4 === 0 ? 1 : 0));
    return m;
  };
  const orient = (n: V3): Q => qFromTo([0, 0, 1], n);
  const arch = p.archetype as Archetype;
  const eyeR = P.headW * { chibi: 0.12, cartoon: 0.1, stylized: 0.078, heroic: 0.064 }[arch];
  const eyeX = P.headW * { chibi: 0.24, cartoon: 0.21, stylized: 0.19, heroic: 0.18 }[arch];
  const eyeY = { chibi: -0.12, cartoon: -0.05, stylized: 0.0, heroic: 0.02 }[arch];
  const mood = p.mood;
  const sleepy = mood === "sleepy";
  const addFace = (m: Mesh, blinkCenterY: number | null) => {
    const base = face.vertexCount;
    face.append(m);
    for (let i = base; i < face.vertexCount; i++) {
      const y = face.pos[i * 3 + 1];
      morph.push(0, blinkCenterY === null ? 0 : (blinkCenterY - y) * 0.92, 0);
    }
  };
  const asym = v.range(-0.03, 0.03);
  for (const sx of [1, -1]) {
    const e = onHead([sx * (eyeX / headR[0]) * 1.05, eyeY * 2 + asym * sx, 0.92]);
    const q = orient(e.n);
    const lid = sleepy ? 0.55 : 1;
    const ctr = madd(e.pt, e.n, -eyeR * 0.08);
    if (arch === "chibi" || arch === "cartoon") {
      const pupil = ellipsoid(eyeR * 0.72, eyeR * lid, eyeR * 0.32, ROLE.eye, 14, 8).transform(m4Compose(ctr, q));
      const hl = ellipsoid(eyeR * 0.2, eyeR * 0.2, eyeR * 0.12, ROLE.eyeWhite, 8, 5).transform(m4Compose(madd(madd(ctr, e.n, eyeR * 0.24), [sx * -0.6, 0.8, 0], eyeR * 0.35), q));
      addFace(pupil, ctr[1]);
      addFace(hl, ctr[1]);
    } else {
      const white = ellipsoid(eyeR, eyeR * 0.78 * lid, eyeR * 0.36, ROLE.eyeWhite, 14, 8).transform(m4Compose(ctr, q));
      const iris = ellipsoid(eyeR * 0.52, eyeR * 0.6 * lid, eyeR * 0.28, ROLE.eye, 12, 6).transform(m4Compose(madd(ctr, e.n, eyeR * 0.14), q));
      const hl = ellipsoid(eyeR * 0.13, eyeR * 0.13, eyeR * 0.08, ROLE.eyeWhite, 6, 4).transform(m4Compose(madd(madd(ctr, e.n, eyeR * 0.36), [sx * -0.4, 0.6, 0], eyeR * 0.3), q));
      addFace(white, ctr[1]);
      addFace(iris, ctr[1]);
      addFace(hl, ctr[1]);
    }
    // sourcils
    const browIn = { angry: -0.55, sad: 0.6, surprised: 0.45, happy: 0.15, neutral: 0, sleepy: -0.1 }[mood] ?? 0;
    const pts: V3[] = [];
    const radii: number[] = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      const bx = sx * (eyeX + eyeR * mix(-1.05, 1.05, t));
      const inner = 1 - t;
      const by = e.pt[1] + eyeR * (1.45 + (sx > 0 ? inner : inner) * browIn * 0.7 + Math.sin(t * Math.PI) * 0.25);
      const s = onHead([bx / headR[0], (by - headC[1]) / headR[1], 0.9]);
      pts.push(madd(s.pt, s.n, eyeR * 0.05));
      radii.push(eyeR * 0.16 * (0.6 + 0.4 * Math.sin(t * Math.PI)));
    }
    if (sx < 0) pts.reverse(), radii.reverse();
    addFace(tube(pts, radii, ROLE.hair, 5, true, true), null);
  }
  // bouche
  const mouthY = { chibi: -0.42, cartoon: -0.45, stylized: -0.5, heroic: -0.52 }[arch];
  if (mood === "surprised") {
    const m = onHead([0, mouthY, 1]);
    addFace(ellipsoid(eyeR * 0.35, eyeR * 0.45, eyeR * 0.15, ROLE.mouth, 10, 6).transform(m4Compose(m.pt, orient(m.n))), null);
  } else {
    const curve = { happy: 1, neutral: 0.15, sad: -0.8, angry: -0.45, sleepy: 0 }[mood] ?? 0;
    const mw = P.headW * (arch === "chibi" ? 0.11 : 0.15) * (mood === "happy" ? 1.15 : 1);
    const pts: V3[] = [];
    const radii: number[] = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const x = mix(-mw, mw, t);
      const y = headC[1] + mouthY * headR[1] + curve * eyeR * 0.45 * (2 * (t - 0.5)) ** 2 - curve * eyeR * 0.2;
      const s = onHead([x / headR[0], (y - headC[1]) / headR[1], 0.96]);
      pts.push(madd(s.pt, s.n, eyeR * 0.02));
      radii.push(eyeR * 0.1 * (0.5 + 0.5 * Math.sin(t * Math.PI)) + eyeR * 0.02);
    }
    addFace(tube(pts, radii, ROLE.mouth, 5, true, true), null);
  }
  skinOf(face, headIdx);
  face.morph = morph;
  mesh.append(face);

  /* ---------- objet tenu ---------- */
  const hand = B("hand.r");
  const hdir = norm(sub(hand.tail, hand.head));
  const grip = madd(hand.head, hdir, hand.radius[0] * 1.2);
  const item = buildItem(p.item, H);
  if (item) {
    // l'objet est tenu verticalement dans le poing, en pose de repos
    item.transform(m4Compose(grip, qId()));
    skinOf(item, skel.index["hand.r"]);
    mesh.append(item);
  }

  /* ---------- ancres ---------- */
  const anchors: Record<string, Anchor> = {
    "head.top": { bone: "head", pos: [0, topY + (p.hat === "wizard" ? hh * 1.1 : p.hat === "tophat" ? hh * 0.7 : hh * 0.08), headC[2]], rot: qId(), scale: P.headW },
    "head.center": { bone: "head", pos: headC, rot: qId(), scale: P.headW },
    "hand.r.grip": { bone: "hand.r", pos: grip, rot: qId(), scale: hand.radius[0] * 2 },
    "hand.l.grip": { bone: "hand.l", pos: madd(B("hand.l").head, norm(sub(B("hand.l").tail, B("hand.l").head)), B("hand.l").radius[0] * 1.2), rot: qId(), scale: hand.radius[0] * 2 },
    back: { bone: "chest", pos: [0, chestC[1], backZ], rot: qAxis([0, 1, 0], Math.PI), scale: chestR[0] },
    "chest.front": { bone: "chest", pos: [0, chestC[1], chestC[2] + chestR[2] + thick], rot: qId(), scale: chestR[0] },
    "hip.l": { bone: "pelvis", pos: [P.hipHalf * 1.3, P.hipY, 0], rot: qId(), scale: P.hipHalf },
    "hip.r": { bone: "pelvis", pos: [-P.hipHalf * 1.3, P.hipY, 0], rot: qId(), scale: P.hipHalf },
    feet: { bone: "root", pos: [0, 0, 0], rot: qId(), scale: P.shoulderHalf },
  };
  const bb = mesh.bounds();
  const hx = Math.max(P.shoulderHalf * 1.2, P.hipHalf * 1.4);
  return { mesh, skeleton: skel, anchors, footprint: { hx, hz: H * 0.09, r: Math.max(hx, H * 0.12) }, height: bb.max[1] };
}

/** Objets tenus, modélisés debout, poignée à l'origine. */
function buildItem(kind: string, H: number): Mesh | null {
  const m = new Mesh();
  const W = ROLE.wood, M = ROLE.metal;
  switch (kind) {
    case "staff":
      m.append(cylinder(H * 0.012, H * 0.01, H * 0.62, W, 8), m4Compose([0, -H * 0.25, 0]));
      m.append(ellipsoid(H * 0.028, H * 0.034, H * 0.028, ROLE.accent, 10, 6), m4Compose([0, H * 0.39, 0]));
      return m;
    case "sword":
      m.append(cylinder(H * 0.01, H * 0.01, H * 0.06, ROLE.leather, 8), m4Compose([0, -H * 0.03, 0]));
      m.append(box(H * 0.04, H * 0.007, H * 0.01, M, H * 0.003), m4Compose([0, H * 0.035, 0]));
      m.append(box(H * 0.012, H * 0.17, H * 0.003, M, H * 0.002), m4Compose([0, H * 0.21, 0]));
      return m;
    case "lantern":
      m.append(cylinder(H * 0.004, H * 0.004, H * 0.08, M, 6), m4Compose([0, -H * 0.08, 0]));
      m.append(lathe([[0, -0.07], [0.03, -0.072], [0.036, -0.12], [0.03, -0.16], [0.012, -0.17], [0, -0.17]].map(([r, y]) => [r * H, y * H] as [number, number]), ROLE.lamp, 10), m4Compose([0, -H * 0.0, 0]));
      m.append(box(H * 0.032, H * 0.006, H * 0.032, M, H * 0.002), m4Compose([0, -H * 0.068, 0]));
      return m;
    case "book":
      m.append(box(H * 0.045, H * 0.06, H * 0.012, ROLE.accent, H * 0.004), m4Compose([0, -H * 0.02, H * 0.02]));
      m.append(box(H * 0.042, H * 0.057, H * 0.009, ROLE.paper, 0), m4Compose([H * 0.004, -H * 0.02, H * 0.02]));
      return m;
    case "umbrella":
      m.append(cylinder(H * 0.006, H * 0.006, H * 0.5, ROLE.ink, 6), m4Compose([0, -H * 0.03, 0]));
      m.append(lathe([[0, 0], [0.18, -0.05], [0.26, -0.11], [0.27, -0.12]].map(([r, y]) => [r * H, y * H] as [number, number]), ROLE.accent, 16, false), m4Compose([0, H * 0.5, 0]));
      return m;
    case "torch":
      m.append(cylinder(H * 0.012, H * 0.016, H * 0.24, W, 8), m4Compose([0, -H * 0.06, 0]));
      m.append(ellipsoid(H * 0.03, H * 0.05, H * 0.03, ROLE.fire, 10, 6), m4Compose([0, H * 0.2, 0]));
      return m;
    case "flower":
      m.append(cylinder(H * 0.003, H * 0.003, H * 0.14, ROLE.leaf, 5), m4Compose([0, -H * 0.02, 0]));
      m.append(ellipsoid(H * 0.022, H * 0.012, H * 0.022, ROLE.flower, 10, 5), m4Compose([0, H * 0.125, 0]));
      return m;
    case "mug":
      m.append(lathe([[0, 0], [0.028, 0], [0.03, 0.06], [0.026, 0.06], [0.024, 0.008], [0, 0.008]].map(([r, y]) => [r * H, y * H] as [number, number]), ROLE.paper, 12, false), m4Compose([H * 0.01, -H * 0.03, H * 0.03]));
      return m;
  }
  return null;
}

export const _test = { buildBody };
