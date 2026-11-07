/**
 * Composition légère pour le mode vectoriel : même recette, même placement, mêmes ids, mêmes acteurs et même grille
 * de navigation que `composeScene`, mais **sans maillages** (les dessinateurs vectoriels lisent les paramètres).
 *
 * Les générateurs coûteux (surfaces implicites : arbres, buissons, rochers, personnages ; bâtiments) sont remplacés le
 * temps d'un appel **synchrone** par des doublures qui calculent l'emprise, la hauteur, les ancres, le squelette et les
 * couleurs à partir des paramètres résolus (mêmes formules que les vrais générateurs). Les générateurs inconnus
 * (ajoutés par d'autres modules) gardent leur vraie construction.
 *
 * À terme : une option `assetBuilder` dans `ComposeInput` remplacera cette substitution (voir rapport d'intégration).
 */
import { clamp, qId, type V3 } from "../core/math";
import { Mesh } from "../geom/mesh";
import { HAIR_COLORS, OUTFITS, SKIN_TONES } from "../gen/character";
import { GENERATORS } from "../gen/index";
import type { Anchor, Asset, Generator } from "../gen/types";
import { type Archetype, type Age, buildHumanoid, proportions } from "../rig/humanoid";
import { type ComposeInput, type SceneModel, composeScene } from "../scene/compose";
import type { Role } from "../style/roles";

const HEX = /^#[0-9a-f]{6}$/i;
const A = (pos: V3, scale = 1, bone?: string): Anchor => ({ pos, rot: qId(), scale, ...(bone ? { bone } : {}) });

type Stub = (p: Record<string, unknown>, ctx: Parameters<Generator["build"]>[1]) => Asset;

/** Dimensions d'un bâtiment (mêmes formules que `gen/building.ts`). */
export function buildingDims(p: Record<string, unknown>) {
  const st = String(p.style ?? "bourg");
  const bays = Number(p.bays ?? 3), floors = Number(p.floors ?? 2), D = Number(p.depth ?? 7);
  const bayW = st === "moderne" || st === "neon" ? 3.2 : st === "chaumiere" ? 2.6 : 2.7;
  const W = bays * bayW + (st === "moderne" ? 0 : 0.6);
  const fh = st === "moderne" || st === "neon" ? 3.3 : st === "chaumiere" ? 2.6 : 3;
  const plinth = st === "moderne" ? 0.25 : 0.5;
  const top = plinth + floors * fh;
  const over = st === "moderne" ? 0 : 0.35;
  const roof = st === "moderne" || st === "neon" ? "flat" : String(p.roof ?? "gable");
  let roofTop = top;
  let rh = 0;
  if (roof === "gable") {
    const pitch = ((st === "chaumiere" ? 48 : 38) * Math.PI) / 180;
    rh = Math.tan(pitch) * (D / 2 + over);
    roofTop = top + rh;
  } else if (roof === "hip" || roof === "mansard") {
    rh = (roof === "hip" ? 0.42 : 0.55) * Math.min(W, D);
    roofTop = top + rh * (roof === "hip" ? 1 : 0.72);
  } else roofTop = top + 0.5;
  const winW = st === "moderne" || st === "neon" ? 1.9 : st === "chaumiere" ? 0.9 : 1.05;
  const winH = st === "moderne" || st === "neon" ? 1.9 : st === "chaumiere" ? 1.0 : 1.45;
  const doorBay = Math.floor((bays - 1) / 2);
  const x0 = -W / 2 + (st === "moderne" ? 0 : 0.3);
  return { st, bays, floors, D, W, bayW, fh, plinth, top, over, roof, rh, roofTop, winW, winH, doorBay, x0 };
}

const STUBS: Record<string, Stub> = {
  building(p) {
    const b = buildingDims(p);
    return {
      generator: "building", mesh: new Mesh(),
      anchors: { door: A([b.x0 + (b.doorBay + 0.5) * b.bayW, 0, b.D / 2 + 0.8]), roof: A([0, b.roofTop, 0], b.W / 2) },
      footprint: { hx: b.W / 2 + b.over, hz: b.D / 2 + b.over + 0.2, r: Math.hypot(b.W / 2, b.D / 2) },
      height: clamp(b.roofTop + 1, 0, 200), extra: { width: b.W, depth: b.D },
    };
  },
  tree(p) {
    const H = Number(p.height ?? 6), sp = String(p.species);
    const conifer = sp === "pine" || sp === "fir";
    const trunkR = H * (sp === "palm" ? 0.022 : conifer ? 0.03 : 0.035);
    const r = H * (conifer ? 0.2 : sp === "palm" ? 0.32 : sp === "willow" ? 0.36 : 0.3);
    return { generator: "tree", mesh: new Mesh(), anchors: { top: A([0, H, 0], r) }, footprint: { hx: trunkR * 2, hz: trunkR * 2, r }, height: H };
  },
  bush(p) {
    const S = Number(p.size ?? 1);
    return { generator: "bush", mesh: new Mesh(), anchors: {}, footprint: { hx: S * 0.4, hz: S * 0.4, r: S * 0.5 }, height: S * 0.75 };
  },
  grass(p) {
    const s = Number(p.size ?? 0.35);
    return { generator: "grass", mesh: new Mesh(), anchors: {}, footprint: { hx: 0.05, hz: 0.05, r: s * 0.3 }, height: s };
  },
  flowers(p) {
    const s = Number(p.size ?? 0.8);
    return { generator: "flowers", mesh: new Mesh(), anchors: {}, footprint: { hx: s * 0.5, hz: s * 0.5, r: s * 0.5 }, height: 0.4 };
  },
  rock(p) {
    const S = Number(p.size ?? 1.2), n = Number(p.pieces ?? 3), fl = Number(p.flat ?? 0.3);
    const hx = S * (n > 1 ? 0.95 : 0.5);
    return { generator: "rock", mesh: new Mesh(), anchors: {}, footprint: { hx, hz: hx, r: hx }, height: S * 0.5 * (1 - fl * 0.4) * 0.95 };
  },
  character(p, ctx) {
    const rng = ctx.rng;
    const skinS = String(p.skin), hcS = String(p.hairColor);
    const skin = HEX.test(skinS) ? skinS : SKIN_TONES[skinS] ?? rng.fork("skin").pick(Object.values(SKIN_TONES).slice(0, 8));
    const hairC = HEX.test(hcS) ? hcS : HAIR_COLORS[hcS] ?? rng.fork("haircolor").pick(Object.values(HAIR_COLORS).slice(0, 8));
    const outfit = OUTFITS[String(p.outfit)] ?? rng.fork("outfit").pick(Object.values(OUTFITS));
    const cc = (p.colors ?? {}) as Record<string, unknown>;
    const oc = (k: string, i: number) => (typeof cc[k] === "string" && HEX.test(cc[k] as string) ? (cc[k] as string) : outfit[i]);
    const colors: Partial<Record<Role, string>> = { skin, hair: hairC, cloth1: oc("top", 0), cloth2: oc("bottom", 1), cloth3: oc("detail", 2), leather: oc("leather", 3), accent: oc("hat", 2) };
    const v = rng.fork("var");
    const P = proportions({ height: Number(p.height), archetype: p.archetype as Archetype, age: p.age as Age, build: Number(p.build), shape: Number(p.shape), headSize: Number(p.headSize) * v.vary(1, 0.03), belly: Number(p.belly) });
    const skel = buildHumanoid(P);
    const H = P.H;
    const hh = P.headH;
    const hat = String(p.hat);
    const anchors: Record<string, Anchor> = {
      "head.top": A([0, H + (hat === "wizard" ? hh * 1.1 : hat === "tophat" ? hh * 0.7 : hh * 0.08), 0], P.headW, "head"),
      "head.center": A([0, H - hh * 0.5, 0], P.headW, "head"),
      "hand.r.grip": A(skel.bone("hand.r")!.head, 0.05, "hand.r"),
      "hand.l.grip": A(skel.bone("hand.l")!.head, 0.05, "hand.l"),
      back: A([0, P.shoulderY - H * 0.08, -H * 0.06], P.shoulderHalf, "chest"),
      "chest.front": A([0, P.shoulderY - H * 0.08, H * 0.06], P.shoulderHalf, "chest"),
      feet: A([0, 0, 0], P.shoulderHalf, "root"),
    };
    const hx = Math.max(P.shoulderHalf * 1.2, P.hipHalf * 1.4);
    return { generator: "character", mesh: new Mesh(), skeleton: skel, anchors, footprint: { hx, hz: H * 0.09, r: Math.max(hx, H * 0.12) }, height: H, colors, blink: true };
  },
};

/** Composition vectorielle (synchrone, sans maillage). Le résultat est un `SceneModel` ordinaire. */
export function composeVector(input: ComposeInput): SceneModel {
  const saved: Record<string, Generator> = {};
  for (const [id, stub] of Object.entries(STUBS)) {
    const g = GENERATORS[id];
    if (!g) continue;
    saved[id] = g;
    GENERATORS[id] = { ...g, build: stub as Generator["build"] };
  }
  try {
    return composeScene(input);
  } finally {
    for (const [id, g] of Object.entries(saved)) GENERATORS[id] = g;
  }
}
