/**
 * Squelette humanoïde paramétrique en **A-pose** (bras à 45°, coudes fléchis de 15°, jambes écartées de 8°, genoux 5°).
 *
 * Proportions par archétype, comptées en têtes (on n'interpole pas librement entre archétypes) ; l'âge et la carrure
 * modulent à l'intérieur d'un archétype. Os (23) : root, pelvis, spine, chest, neck, head, clavicle/upperarm/forearm/
 * hand (.l/.r), thigh/shin/foot/toe (.l/.r). `.l` = gauche du personnage = +x ; l'avant est +z.
 */
import { type V3, DEG, add, madd, norm, scale } from "../core/math";
import { type BoneDef, Skeleton } from "./skeleton";

export const ARCHETYPES = {
  chibi: { heads: 2.6, crotch: 0.27, arm: 0.3, shoulder: 0.15, hip: 0.085, neck: 0.012, hand: 1.55, foot: 1.45, headW: 1.08, headD: 1.0, limb: 1.45, torsoD: 1.15 },
  cartoon: { heads: 4.5, crotch: 0.4, arm: 0.36, shoulder: 0.13, hip: 0.083, neck: 0.022, hand: 1.3, foot: 1.25, headW: 0.92, headD: 0.98, limb: 1.15, torsoD: 1.05 },
  stylized: { heads: 6, crotch: 0.46, arm: 0.4, shoulder: 0.125, hip: 0.08, neck: 0.03, hand: 1.15, foot: 1.12, headW: 0.82, headD: 0.95, limb: 1, torsoD: 1 },
  heroic: { heads: 7.2, crotch: 0.48, arm: 0.43, shoulder: 0.135, hip: 0.076, neck: 0.036, hand: 1.06, foot: 1.02, headW: 0.78, headD: 0.93, limb: 0.95, torsoD: 0.98 },
} as const;
export type Archetype = keyof typeof ARCHETYPES;

export const AGES = ["child", "teen", "adult", "elder"] as const;
export type Age = (typeof AGES)[number];

export type BodyParams = {
  height: number;
  archetype: Archetype;
  age: Age;
  /** 0 fin … 1 massif. */
  build: number;
  /** -1 hanches larges … +1 épaules larges. */
  shape: number;
  /** Facteur sur la taille de la tête (0.8 … 1.3). */
  headSize: number;
  /** Ventre 0 … 1. */
  belly: number;
  /** Variations de silhouette, chacune dans [-1, 1] (0 = proportions de l'archétype). */
  legs?: number;
  arms?: number;
  neck?: number;
  shoulders?: number;
  hips?: number;
  /** -1 cambré, fier … +1 voûté (dos rond, tête en avant) : inscrit dans la pose de repos. */
  posture?: number;
  /** Asymétrie : une épaule plus basse que l'autre (signe = côté). */
  asym?: number;
};

export type Proportions = {
  H: number;
  headH: number;
  headW: number;
  headD: number;
  shoulderHalf: number;
  hipHalf: number;
  crotchY: number;
  hipY: number;
  shoulderY: number;
  chinY: number;
  upperArm: number;
  foreArm: number;
  handLen: number;
  thigh: number;
  shin: number;
  ankleY: number;
  footLen: number;
  /** Épaisseurs (rayons) de base, avant carrure. */
  limb: number;
  torsoD: number;
  hand: number;
  foot: number;
  /** Posture (-1 … 1) et asymétrie d'épaules (-1 … 1). */
  posture: number;
  asym: number;
};

export function proportions(p: BodyParams): Proportions {
  const a = ARCHETYPES[p.archetype];
  const ageMod = { child: { heads: -1.3, crotch: -0.04, head: 1.12, limb: 0.92 }, teen: { heads: -0.5, crotch: 0, head: 1.04, limb: 0.95 }, adult: { heads: 0, crotch: 0, head: 1, limb: 1 }, elder: { heads: -0.15, crotch: -0.01, head: 1, limb: 0.94 } }[p.age];
  const heads = Math.max(2.2, a.heads + (p.archetype === "chibi" ? ageMod.heads * 0.3 : ageMod.heads));
  const H = p.height;
  const headH = (H / heads) * p.headSize * ageMod.head;
  const legs = p.legs ?? 0, arms = p.arms ?? 0;
  const crotchY = H * Math.max(0.22, (a.crotch + ageMod.crotch) * (1 + 0.07 * legs));
  const chinY = H - headH;
  const neckLen = H * a.neck * (1 + 0.35 * (p.neck ?? 0));
  const shoulderY = chinY - neckLen - headH * 0.12;
  const hipY = crotchY + H * 0.03;
  const armLen = H * a.arm * (1 + 0.06 * arms);
  const ankleY = H * 0.045;
  const legLen = hipY - ankleY;
  const sh = 1 + p.shape * 0.12 + (p.shoulders ?? 0) * 0.07;
  const hipMul = 1 + (p.hips ?? 0) * 0.09;
  return {
    H,
    headH,
    headW: headH * a.headW,
    headD: headH * a.headD,
    shoulderHalf: H * a.shoulder * sh * (0.92 + 0.16 * p.build),
    hipHalf: H * a.hip * (2 - (1 + p.shape * 0.12)) * hipMul * (0.92 + 0.16 * p.build),
    crotchY,
    hipY,
    shoulderY,
    chinY,
    upperArm: armLen * 0.46,
    foreArm: armLen * 0.4,
    handLen: armLen * 0.14 * a.hand,
    thigh: legLen * 0.52,
    shin: legLen * 0.48,
    ankleY,
    footLen: H * 0.14 * a.foot,
    limb: a.limb * ageMod.limb,
    torsoD: a.torsoD,
    hand: a.hand,
    foot: a.foot,
    posture: Math.max(-1, Math.min(1, p.posture ?? 0)),
    asym: Math.max(-1, Math.min(1, p.asym ?? 0)),
  };
}

/** Directions de l'A-pose (côté gauche, x+) : bras, avant-bras, cuisse, tibia. */
export function aPoseDirs() {
  const arm = norm([Math.sin(45 * DEG), -Math.cos(45 * DEG), 0]);
  // coude fléchi de 15° vers l'avant
  const fore = norm(add(scale(arm, Math.cos(15 * DEG)), [0, 0, Math.sin(15 * DEG)]));
  const thigh = norm([Math.sin(8 * DEG), -Math.cos(8 * DEG), 0]);
  // genou fléchi de 5° (tibia légèrement vers l'arrière)
  const shin = norm(add(scale(thigh, Math.cos(5 * DEG)), [0, 0, -Math.sin(5 * DEG)]));
  return { arm, fore, thigh, shin };
}

export function buildHumanoid(P: Proportions): Skeleton {
  const H = P.H;
  const d = aPoseDirs();
  const r = (k: number) => k * H * P.limb;
  const bones: BoneDef[] = [];
  const add_ = (b: Omit<BoneDef, "deform"> & { deform?: boolean }) => bones.push({ deform: true, ...b });
  add_({ name: "root", parent: null, head: [0, 0, 0], tail: [0, H * 0.05, 0], radius: [0, 0], deform: false });
  const pelvisTop: V3 = [0, P.hipY + H * 0.06, 0];
  add_({ name: "pelvis", parent: "root", head: [0, P.hipY, 0], tail: pelvisTop, radius: [P.hipHalf * 1.1, P.hipHalf], swing: 30, twist: [-30, 30] });
  // posture : voûté = haut du dos et tête vers l'avant, épaules un peu tombées ; cambré = l'inverse
  const pz = P.posture * H;
  const chestY = P.hipY + (P.shoulderY - P.hipY) * 0.55;
  add_({ name: "spine", parent: "pelvis", head: pelvisTop, tail: [0, chestY, pz * 0.006], radius: [r(0.075), r(0.08)], swing: 35, twist: [-30, 30] });
  const chestTop: V3 = [0, P.shoulderY + H * 0.005 - Math.max(0, P.posture) * H * 0.006, pz * 0.022];
  add_({ name: "chest", parent: "spine", head: [0, chestY, pz * 0.006], tail: chestTop, radius: [r(0.085), P.shoulderHalf * 0.7], swing: 30, twist: [-25, 25] });
  const neckTop: V3 = [0, P.chinY + P.headH * 0.12 - Math.max(0, P.posture) * H * 0.008, -P.headD * 0.05 + pz * 0.04];
  add_({ name: "neck", parent: "chest", head: chestTop, tail: neckTop, radius: [r(0.032), r(0.03)], swing: 40, twist: [-60, 60] });
  add_({ name: "head", parent: "neck", head: neckTop, tail: [0, H, -P.headD * 0.05 + pz * 0.04], radius: [P.headW * 0.5, P.headW * 0.5], swing: 40, twist: [-70, 70] });
  for (const [s, sx] of [["l", 1], ["r", -1]] as const) {
    const drop = P.asym * sx * H * 0.006 + Math.max(0, P.posture) * H * 0.004;
    const clav0: V3 = [sx * H * 0.015, P.shoulderY - H * 0.012, H * 0.01 + chestTop[2]];
    const shoulder: V3 = [sx * P.shoulderHalf, P.shoulderY - H * 0.02 - drop, -H * 0.005 + chestTop[2] * 0.9];
    add_({ name: `clavicle.${s}`, parent: "chest", head: clav0, tail: shoulder, radius: [r(0.03), r(0.035)], swing: 25, twist: [-10, 10] });
    const arm: V3 = [d.arm[0] * sx, d.arm[1], d.arm[2]];
    const fore: V3 = [d.fore[0] * sx, d.fore[1], d.fore[2]];
    const elbow = madd(shoulder, arm, P.upperArm);
    const wrist = madd(elbow, fore, P.foreArm);
    const handTip = madd(wrist, fore, P.handLen);
    add_({ name: `upperarm.${s}`, parent: `clavicle.${s}`, head: shoulder, tail: elbow, radius: [r(0.036), r(0.03)], swing: 120, twist: [-90, 90] });
    add_({ name: `forearm.${s}`, parent: `upperarm.${s}`, head: elbow, tail: wrist, radius: [r(0.03), r(0.022)], swing: 150, twist: [-80, 80] });
    add_({ name: `hand.${s}`, parent: `forearm.${s}`, head: wrist, tail: handTip, radius: [r(0.024) * P.hand, r(0.02) * P.hand], swing: 75, twist: [-20, 20] });
    const hip: V3 = [sx * P.hipHalf * 0.8, P.hipY - H * 0.012, 0];
    const th: V3 = [d.thigh[0] * sx, d.thigh[1], d.thigh[2]];
    const sh: V3 = [d.shin[0] * sx, d.shin[1], d.shin[2]];
    const knee = madd(hip, th, P.thigh);
    const ankle = madd(knee, sh, P.shin);
    const ankleG: V3 = [ankle[0], P.ankleY, ankle[2]];
    const ball: V3 = [ankle[0], H * 0.018, ankle[2] + P.footLen * 0.62];
    const toe: V3 = [ankle[0], H * 0.016, ankle[2] + P.footLen * 0.85];
    add_({ name: `thigh.${s}`, parent: "pelvis", head: hip, tail: knee, radius: [r(0.062), r(0.045)], swing: 120, twist: [-40, 40] });
    add_({ name: `shin.${s}`, parent: `thigh.${s}`, head: knee, tail: ankleG, radius: [r(0.042), r(0.028)], swing: 150, twist: [-10, 10] });
    add_({ name: `foot.${s}`, parent: `shin.${s}`, head: ankleG, tail: ball, radius: [r(0.03) * P.foot, r(0.03) * P.foot], swing: 50, twist: [-15, 15] });
    add_({ name: `toe.${s}`, parent: `foot.${s}`, head: ball, tail: toe, radius: [r(0.026) * P.foot, r(0.022) * P.foot], swing: 60, twist: [-5, 5] });
  }
  return new Skeleton(bones);
}

/** Paires parent-enfant soudées en union douce, avec le rayon de soudure (× hauteur). */
export const HUMANOID_BLENDS: [string, string, number][] = [
  ["pelvis", "spine", 0.03],
  ["spine", "chest", 0.03],
  ["chest", "neck", 0.022],
  ["neck", "head", 0.012],
  ["chest", "clavicle", 0.018],
  ["clavicle", "upperarm", 0.016],
  ["upperarm", "forearm", 0.012],
  ["forearm", "hand", 0.008],
  ["pelvis", "thigh", 0.02],
  ["thigh", "shin", 0.014],
  ["shin", "foot", 0.012],
  ["foot", "toe", 0.008],
];
