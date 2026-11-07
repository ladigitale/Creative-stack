/**
 * Composition légère pour le mode vectoriel : même recette, même placement, mêmes ids, mêmes acteurs et même grille
 * de navigation que `composeScene`, mais **sans maillages** (les dessinateurs vectoriels lisent les paramètres).
 *
 * Les générateurs coûteux (surfaces implicites : arbres, buissons, rochers, personnages ; bâtiments) sont remplacés,
 * via l'option `assetBuilder` de `composeScene`, par des doublures qui calculent l'emprise, la hauteur, les ancres, le
 * squelette et les couleurs à partir des paramètres résolus (mêmes formules que les vrais générateurs). Les autres
 * générateurs gardent leur vraie construction.
 */
import { clamp, qId, type V3 } from "../core/math";
import { Mesh } from "../geom/mesh";
import { resolveColors as resolveCharColors, resolveLook } from "../gen/character/look";
import type { Anchor, Asset, Generator } from "../gen/types";
import { GENERATORS } from "../gen/index";
import { type Plan, buildPlan } from "./buildplan";
import { type Archetype, type Age, buildHumanoid, proportions } from "../rig/humanoid";
import { type ComposeInput, type SceneModel, composeScene } from "../scene/compose";
import type { Role } from "../style/roles";

const HEX = /^#[0-9a-f]{6}$/i;
const A = (pos: V3, scale = 1, bone?: string): Anchor => ({ pos, rot: qId(), scale, ...(bone ? { bone } : {}) });

type Stub = (p: Record<string, unknown>, ctx: Parameters<Generator["build"]>[1]) => Asset;

const PLANS_BY_PATH = new Map<string, Plan>();
const PLANS_BY_PARAMS = new Map<string, Plan>();
/** Données propres au dessin vectoriel d'un modèle composé par `composeVector` (graine, plans des bâtiments). */
export const VECTOR_META = new WeakMap<SceneModel, { seed: string; plans: Map<string, Plan>; byParams: Map<string, Plan> }>();

const STUBS: Record<string, Stub> = {
  building(p, ctx) {
    // vrai générateur (emprise, hauteur, ancres et recentrage exacts) sans garder le maillage ; plan mémorisé
    const plan = buildPlan(p, ctx.rng);
    PLANS_BY_PATH.set(ctx.path, plan);
    PLANS_BY_PARAMS.set(JSON.stringify(p), plan);
    const real = GENERATORS.building.build(p as never, ctx);
    return { ...real, mesh: new Mesh() };
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
    // même apparence que le vrai générateur : tirages « auto » par graine, couleurs, proportions
    const rng = ctx.rng;
    const pp = { ...p, colors: (p.colors ?? {}) as Record<string, unknown> };
    const look = resolveLook(pp, rng, ctx.issues, ctx.path);
    const colors = resolveCharColors(pp, look, rng, ctx.issues, ctx.path) as Partial<Record<Role, string>>;
    const P = proportions({
      height: look.height, archetype: look.archetype as Archetype, age: look.age as Age, build: look.build, shape: look.shape, headSize: look.headSize, belly: look.belly,
      legs: look.body.legs, arms: look.body.arms, neck: look.body.neck, shoulders: look.body.shoulders, hips: look.body.hips, posture: look.body.posture, asym: look.body.asym,
    });
    const skel = buildHumanoid(P);
    const H = P.H;
    const hh = P.headH;
    const hat = look.hat;
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
    return { generator: "character", mesh: new Mesh(), skeleton: skel, anchors, footprint: { hx, hz: H * 0.09, r: Math.max(hx, H * 0.12) }, height: H, colors, blink: true, extra: { look } };
  },
};

/** Composition vectorielle (synchrone, sans maillage). Le résultat est un `SceneModel` ordinaire. */
export function composeVector(input: ComposeInput): SceneModel {
  PLANS_BY_PATH.clear();
  PLANS_BY_PARAMS.clear();
  const model = composeScene({ ...input, assetBuilder: (id, p, ctx) => (STUBS[id] ? STUBS[id](p, ctx) : null) });
  const plans = new Map<string, Plan>();
  for (const o of model.objects) {
    if (o.generator !== "building") continue;
    const pl = PLANS_BY_PATH.get(o.id);
    if (pl) plans.set(o.id, pl);
  }
  VECTOR_META.set(model, { seed: String(input.seed ?? 1), plans, byParams: new Map(PLANS_BY_PARAMS) });
  return model;
}
