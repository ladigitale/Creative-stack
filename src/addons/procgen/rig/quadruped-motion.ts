/**
 * Animation procédurale des animaux : repos (respiration, queue, oreilles, regard), **marche** (séquence latérale),
 * **trot** (diagonale), **galop** (transverse, grands animaux), **bond** (lapin) ; oiseaux : marche avec hochement de
 * tête (poule) ou dandinement (canard).
 *
 * - Avance par **distance parcourue** : `phase` (en cycles) est intégrée par l'appelant
 *   (`phase += Δdistance / (2 · animalStepLength(info, vitesse))`) ; un cycle complet vaut deux « pas ».
 *   Un pied en appui recule exactement à la vitesse du corps : il ne glisse pas.
 * - Pattes : cible du boulet (appui fixe, envol en arc), métacarpe / métatarse orienté selon l'inclinaison de la patte
 *   et replié en phase d'envol, puis **IK deux os** (épaule → coude → carpe, coude vers l'arrière ; hanche → grasset
 *   → jarret, grasset vers l'avant) ; corps abaissé si une cible est hors d'atteinte.
 * - Corps : rebond, tangage (galop), roulis, ondulation latérale de la colonne, flexion de la colonne au galop
 *   (félins, chiens), balancier de tête, queue et oreilles.
 */
import { type Q, type V3, DEG, add, clamp, mix, norm, qAxis, qEuler, qId, qMul, qRot, scale, smoothstep, sub } from "../core/math";
import { twoBoneIK } from "./locomotion";
import { AnimalSkeleton, type BirdProps, type QuadProps, type Species } from "./quadruped";
import { type Pose, Skeleton, qFromBasis } from "./skeleton";

/** État d'animation (sous-ensemble compatible de `MotionState` de l'humanoïde). */
export type AnimalMotionState = {
  speed: number;
  phase: number;
  time: number;
  mood: string;
  turn: number;
  seed: number;
};

export type LegInfo = {
  id: "fl" | "fr" | "hl" | "hr";
  front: boolean;
  side: 1 | -1;
  bones: [string, string, string, string];
  /** Longueurs des trois premiers os. */
  l: [number, number, number];
  /** Position de repos du boulet (tête du 4e os), repère du modèle. */
  foot0: V3;
};

export type AnimalInfo = {
  kind: "quad" | "bird";
  species: Species;
  /** Hauteur au garrot (oiseaux : hauteur du dos). */
  W: number;
  /** Hauteur de la hanche (normalise les vitesses). */
  legLen: number;
  legs: LegInfo[];
  center: V3;
  gallop: boolean;
  bound: boolean;
  spineFlex: number;
  waddle: number;
  bob: number;
  herbivore: boolean;
  /** Compatibilité avec le code qui lit `thigh + shin` (longueur de jambe) d'un `RigInfo`. */
  thigh: number;
  shin: number;
};

const G = 9.81;

export function animalInfo(sk: Skeleton): AnimalInfo {
  if (!(sk instanceof AnimalSkeleton)) throw new Error("animalInfo : squelette non animal");
  const meta = sk.meta;
  const pr = meta.props;
  const legs: LegInfo[] = [];
  const mk = (id: LegInfo["id"], front: boolean, s: "l" | "r") => {
    const names = (front ? ["upperarm", "forearm", "hand", "finger"] : ["thigh", "shin", "foot", "toe"]).map((n) => `${n}.${s}`) as LegInfo["bones"];
    if (!sk.has(names[0])) return;
    legs.push({ id, front, side: s === "l" ? 1 : -1, bones: names, l: [sk.length[sk.index[names[0]]], sk.length[sk.index[names[1]]], sk.length[sk.index[names[2]]]], foot0: sk.bone(names[3])!.head });
  };
  mk("fl", true, "l");
  mk("fr", true, "r");
  mk("hl", false, "l");
  mk("hr", false, "r");
  const hip = sk.bone("thigh.l")!.head[1];
  const q = pr.kind === "quad" ? (pr as QuadProps) : null;
  const b = pr.kind === "bird" ? (pr as BirdProps) : null;
  const herb = ["horse", "cow", "sheep", "goat", "deer", "rabbit", "pig"].includes(meta.species);
  return {
    kind: pr.kind, species: meta.species, W: meta.W, legLen: hip, legs, center: meta.center,
    gallop: q?.gallop ?? false, bound: q?.bound ?? false, spineFlex: q?.spineFlex ?? 0.2, waddle: b?.waddle ?? 0, bob: b?.bob ?? 0, herbivore: herb,
    thigh: hip * 0.5, shin: hip * 0.5,
  };
}

/** Nombre de Froude (vitesse normalisée par la longueur de patte). */
const froude = (info: AnimalInfo, v: number) => (v * v) / (G * Math.max(0.05, info.legLen));

/** Longueur d'un « pas » (m) : la moitié d'un cycle complet. Foulée relative ≈ 2,3 · Fr^0,3 (Alexander). */
export function animalStepLength(info: AnimalInfo, speed: number): number {
  const fr = clamp(froude(info, Math.max(speed, 0.05)), 0.02, 3);
  const k = info.kind === "bird" ? 1.6 : info.bound ? 2.6 : 2.3;
  return (info.legLen * k * Math.pow(fr, 0.3)) / 2;
}

/** Décalages de phase [fl, fr, hl, hr] et facteur d'appui par allure. */
const GAITS = {
  walk: { off: [0.25, 0.75, 0, 0.5], duty: 0.68 },
  trot: { off: [0.5, 1.0, 0, 0.5], duty: 0.46 },
  gallop: { off: [0.5, 0.6, 0, 0.1], duty: 0.34 },
  bound: { off: [0.5, 0.54, 0, 0.04], duty: 0.42 },
} as const;

type MoodK = { neck: number; head: number; tail: number; ears: number; wag: number; graze: number };
const MOODS: Record<string, MoodK> = {
  calm: { neck: 0, head: 0, tail: 0, ears: 0, wag: 0.2, graze: 0 },
  neutral: { neck: 0, head: 0, tail: 0, ears: 0, wag: 0.2, graze: 0 },
  alert: { neck: -14, head: -6, tail: -10, ears: -14, wag: 0, graze: 0 },
  happy: { neck: -4, head: -3, tail: -22, ears: 6, wag: 1, graze: 0 },
  tired: { neck: 16, head: 10, tail: 18, ears: 22, wag: 0.05, graze: 0 },
  grazing: { neck: 0, head: 0, tail: 5, ears: 8, wag: 0.3, graze: 1 },
};

const TAU = Math.PI * 2;
const wrap = (x: number) => ((x % 1) + 1) % 1;

/**
 * Pose d'un animal. `rootPos` / `rootYaw` : placement dans la scène (le modèle regarde +z).
 * Renvoie la pose et les positions de boulet (pour les tests de glissement).
 */
export function animalPose(sk: Skeleton, info: AnimalInfo, st: AnimalMotionState, rootPos: V3 = [0, 0, 0], rootYaw = 0): { pose: Pose; feet: Record<string, V3> } {
  return info.kind === "bird" ? birdPose(sk, info, st, rootPos, rootYaw) : quadPose(sk, info, st, rootPos, rootYaw);
}

function common(info: AnimalInfo, st: AnimalMotionState, rootPos: V3, rootYaw: number) {
  const yawQ = qAxis([0, 1, 0], rootYaw);
  const toWorld = (p: V3): V3 => add(qRot(yawQ, p), rootPos);
  const dirWorld = (d: V3): V3 => qRot(yawQ, d);
  const rnd = (k: number) => ((Math.sin(st.seed * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
  const v = Math.max(0, st.speed);
  const moving = smoothstep(0.02, 0.12 * Math.sqrt(info.legLen / 0.5), v);
  return { yawQ, toWorld, dirWorld, rnd, v, moving };
}

/** Pose une patte : boulet en `F` (monde), canon selon `cAng` (° autour de x, + = vers l'arrière), phalanges `toeAng`. */
function solveLeg(sk: Skeleton, W: ReturnType<Skeleton["world"]>, Wq: Q[], leg: LegInfo, F: V3, cAng: number, toeAng: number, yawQ: Q, rot: Record<string, Q>): number {
  const [b1, b2, b3, b4] = leg.bones;
  const i1 = sk.index[b1];
  const S = sk.headOf(W, b1);
  const X = qRot(yawQ, [1, 0, 0]);
  // canon : direction de repos tournée autour de l'axe latéral
  const restC = sk.axis[sk.index[b3]];
  const cQ = qMul(yawQ, qAxis([1, 0, 0], cAng * DEG));
  const c = qRot(cQ, restC);
  const J: V3 = sub(F, scale(c, leg.l[2]));
  const pole = qRot(yawQ, norm(leg.front ? [0, 0.15, -1] : [0, 0.1, 1]));
  const ik = twoBoneIK(S, J, leg.l[0], leg.l[1], pole);
  const w1 = qFromBasis(sk.axis[i1], [1, 0, 0], norm(sub(ik.mid, S)), X);
  const w2 = qFromBasis(sk.axis[sk.index[b2]], [1, 0, 0], norm(sub(ik.end, ik.mid)), X);
  const w3 = qFromBasis(restC, [1, 0, 0], c, X);
  const w4 = qMul(yawQ, qAxis([1, 0, 0], toeAng * DEG));
  rot[b1] = Skeleton.toLocal(Wq[sk.parentIdx[i1]], w1);
  rot[b2] = Skeleton.toLocal(w1, w2);
  rot[b3] = Skeleton.toLocal(w2, w3);
  rot[b4] = Skeleton.toLocal(w3, w4);
  return ik.reach;
}

function quadPose(sk: Skeleton, info: AnimalInfo, st: AnimalMotionState, rootPos: V3, rootYaw: number) {
  const { yawQ, toWorld, rnd, v, moving } = common(info, st, rootPos, rootYaw);
  const m = MOODS[st.mood] ?? MOODS.calm;
  const t = st.time;
  const L = info.legLen;
  const fr = froude(info, v);
  // allures : poids continus selon le nombre de Froude
  const trotW = info.bound ? 0 : smoothstep(0.32, 0.6, fr);
  const galW = info.gallop ? smoothstep(1.8, 2.8, fr) : 0;
  const boundW = info.bound ? 1 : 0;
  const offs = [0, 1, 2, 3].map((i) => {
    if (boundW) return GAITS.bound.off[i];
    const a = mix(GAITS.walk.off[i], GAITS.trot.off[i], trotW);
    return mix(a, GAITS.gallop.off[i], galW);
  });
  const duty = boundW ? GAITS.bound.duty : mix(mix(GAITS.walk.duty, GAITS.trot.duty, trotW), GAITS.gallop.duty, galW);
  const stride = 2 * animalStepLength(info, Math.max(v, 0.05));
  const phi = st.phase;
  const rot: Record<string, Q> = {};
  const flex = info.spineFlex;

  /* ---------- corps ---------- */
  const breathe = Math.sin(t * TAU * (0.35 / Math.sqrt(Math.max(0.2, info.W))) + rnd(1) * 6);
  // rebond : 2 par cycle au pas et au trot ; 1 par cycle au galop / au bond
  const bobAmp = L * mix(mix(0.012, 0.025, trotW), 0.05, Math.max(galW, boundW)) * moving;
  const bob2 = -bobAmp * (0.5 + 0.5 * Math.cos(TAU * 2 * (phi - 0.1)));
  const bob1 = bobAmp * 1.4 * Math.sin(TAU * (phi - 0.25));
  const bob = mix(bob2, bob1, Math.max(galW, boundW));
  // tangage au galop (bascule avant-arrière), roulis et lacet au pas
  const pitch = (Math.max(galW, boundW) * 7 * Math.sin(TAU * (phi + 0.1)) * moving + 1.2 * breathe * (1 - moving) * 0.2) * DEG;
  const roll = 2.2 * DEG * Math.sin(TAU * phi) * moving * (1 - galW) * (1 - trotW * 0.5);
  const turnLean = clamp(-st.turn * v * 0.04, -0.2, 0.2);
  // ondulation latérale de la colonne (pas), flexion dorsale (galop, bond)
  const undul = (2 + 5 * flex) * DEG * Math.sin(TAU * phi) * moving * (1 - galW);
  const flexA = (4 + 12 * flex) * DEG * Math.sin(TAU * (phi + 0.05)) * moving * Math.max(galW, boundW);
  const pitchQ = qAxis([1, 0, 0], pitch);
  const bodyQ = qMul(yawQ, qMul(qAxis([0, 0, 1], roll + turnLean), pitchQ));
  rot.pelvis = qEuler(-flexA * 0.5 + breathe * 0.3 * DEG, undul, 0);
  rot.spine = qEuler(flexA * 0.3, -undul * 0.6, 0);
  rot.chest = qEuler(flexA * 0.5 + breathe * 0.6 * DEG, -undul * 0.8, 0);

  /* ---------- cou et tête ---------- */
  const graze = m.graze * (1 - moving) * (info.herbivore ? 1 : 0.55);
  // balancier : la tête hoche 2 fois par cycle au pas, une fois au galop ; stable au trot
  const nod = moving * (mix(mix(4, 1, trotW), 7, galW) * Math.sin(TAU * (phi * mix(2, 1, galW) + 0.15)));
  const look = (1 - moving) * 14 * Math.sin(t * 0.31 + rnd(2) * 9) * (1 - graze);
  const lookUp = (1 - moving) * 4 * Math.sin(t * 0.23 + rnd(3) * 7);
  // broutage : abaisser le cou jusqu'au sol, petites saccades
  const munch = graze * Math.sin(t * 5.2) * 3;
  const neckP = (m.neck + nod * 0.6 - pitch / DEG * 0.6 + graze * 46 - lookUp - flexA / DEG * 0.4 + (galW * 10 + trotW * 3) * moving) * DEG;
  rot["neck.1"] = qEuler(neckP * 0.55, look * 0.4 * DEG + undul * 0.6, 0);
  rot["neck.2"] = qEuler(neckP * 0.45, look * 0.3 * DEG, 0);
  rot.head = qEuler((m.head + nod * 0.4 + graze * 22 + munch - galW * 6 * moving) * DEG, look * 0.3 * DEG, look * 0.1 * DEG);
  if (sk.has("jaw")) rot.jaw = qAxis([1, 0, 0], ((graze ? 6 + 5 * Math.sin(t * 9) : 0) + (info.species === "dog" ? 6 * moving * trotW : 0)) * DEG);
  // oreilles : dressées en alerte, couchées au galop, petits frémissements
  const twitch = (k: number) => {
    const ph = (t * 0.37 + rnd(k) * 5) % 1;
    return ph < 0.06 ? Math.sin((ph / 0.06) * Math.PI) : 0;
  };
  for (const [s, sg, k] of [["l", 1, 4], ["r", -1, 5]] as const) {
    if (!sk.has(`ear.${s}`)) continue;
    const back = m.ears + galW * 25 * moving + 10 * twitch(k);
    rot[`ear.${s}`] = qEuler(-back * DEG * 0.8, 0, sg * (8 * twitch(k + 2) - back * 0.3) * DEG);
  }
  // queue : relevée et balancée avec l'allure, remuée (chien heureux)
  const wag = m.wag * (info.species === "dog" || info.species === "fox" ? 1 : 0.4);
  const wagA = (wag * 26 * Math.sin(t * TAU * (wag > 0.5 ? 3.2 : 0.6) + rnd(6) * 6) + 8 * Math.sin(TAU * phi) * moving) * DEG;
  const lift = (m.tail - 10 * moving * (trotW + galW) * (info.species === "horse" ? 1 : 0.6)) * DEG;
  const swish = info.species === "horse" || info.species === "cow" ? 10 * DEG * Math.sin(t * 0.9 + rnd(7) * 5) * (1 - moving) : 0;
  for (let i = 1; i <= 3; i++) if (sk.has(`tail.${i}`)) rot[`tail.${i}`] = qEuler(lift * (i === 1 ? 0.6 : 0.25) + (galW * moving * 6 * Math.sin(TAU * phi + i)) * DEG, (wagA + swish) * (0.4 + 0.25 * i), 0);

  /* ---------- pattes ---------- */
  const legsTarget: { leg: LegInfo; F: V3; cAng: number; toeAng: number; planted: boolean }[] = [];
  const swingLift = L * mix(mix(0.07, 0.11, trotW), 0.16, Math.max(galW, boundW)) * Math.min(1, 0.4 + Math.sqrt(fr)) * moving;
  const feet: Record<string, V3> = {};
  for (const [i, leg] of info.legs.entries()) {
    const u = wrap(phi + offs[i] + (info.legs.length === 4 ? 0 : 0));
    let z: number, y = 0, sw = 0;
    const planted = u < duty;
    if (planted) z = stride * (duty / 2 - u);
    else {
      sw = (u - duty) / (1 - duty);
      const e = sw * sw * (3 - 2 * sw);
      z = stride * (-duty / 2 + duty * e);
      y = swingLift * Math.pow(Math.sin(Math.PI * Math.min(1, sw * 1.08)), 1.1) * (leg.front ? 1.05 : 0.9);
    }
    z *= moving;
    // pied d'appui légèrement en arrière pour les pattes avant (charge sous l'épaule)
    const f0 = leg.foot0;
    const Fl: V3 = [f0[0], f0[1] + y, f0[2] + z];
    // canon : suit l'inclinaison de la patte en appui, se replie en envol
    const joint = sk.bone(leg.bones[0])!.head;
    const lean = Math.atan2(joint[2] - Fl[2], joint[1] - Fl[1]) / DEG - Math.atan2(joint[2] - f0[2], joint[1] - f0[1]) / DEG;
    const foldF = mix(mix(55, 80, trotW), 95, Math.max(galW, boundW));
    const foldH = mix(mix(30, 45, trotW), 55, Math.max(galW, boundW));
    let cAng = lean * 0.75;
    let toeAng = 0;
    if (!planted) {
      const s = Math.sin(Math.PI * sw);
      if (leg.front) {
        cAng = mix(lean * 0.75, -lean * 0.3, sw) + foldF * Math.pow(s, 0.9) * moving * (1 - smoothstep(0.75, 1, sw));
        toeAng = foldF * 0.6 * s * moving;
      } else {
        cAng = lean * 0.75 * (1 - sw) + foldH * s * (1 - sw * 0.6) * moving - 10 * smoothstep(0.6, 1, sw) * moving;
        toeAng = foldH * 0.7 * s * moving;
      }
    } else {
      // fin d'appui : le boulet se lève (pince au sol)
      const push = smoothstep(duty * 0.75, duty, u) * moving;
      toeAng = -push * 20;
    }
    legsTarget.push({ leg, F: toWorld(Fl), cAng, toeAng, planted });
    feet[leg.id] = toWorld(Fl);
  }
  // deux passes : corps, IK, abaissement du corps si une patte n'atteint pas sa cible
  let drop = graze * L * 0.02 + moving * L * 0.01 * (trotW + galW);
  let pose: Pose = { rot, root: rootPos, rootRot: bodyQ };
  const c0 = info.center;
  for (let pass = 0; pass < 3; pass++) {
    // tangage autour du centre du tronc : racine = c - R·c
    const lift0: V3 = [0, bob - drop, 0];
    const rc = qRot(qMul(qAxis([0, 0, 1], roll + turnLean), pitchQ), c0);
    const piv: V3 = [c0[0] - rc[0], c0[1] - rc[1], c0[2] - rc[2]];
    pose = { rot, root: toWorld(add(lift0, piv)), rootRot: bodyQ };
    const W = sk.world(pose);
    const Wq = sk.worldQuats(W);
    let worst = 1;
    for (const lt of legsTarget) {
      const r = solveLeg(sk, W, Wq, lt.leg, lt.F, lt.cAng, lt.toeAng, yawQ, rot);
      if (lt.planted) worst = Math.min(worst, r);
    }
    // seules les pattes d'appui abaissent le corps (une patte en l'air peut rester tendue)
    if (worst < 0.999 && pass < 2 && drop < L * 0.12) drop = Math.min(L * 0.12, drop + (1 - worst) * L * 1.05);
    else break;
  }
  return { pose, feet };
}

function birdPose(sk: Skeleton, info: AnimalInfo, st: AnimalMotionState, rootPos: V3, rootYaw: number) {
  const { yawQ, toWorld, rnd, v, moving } = common(info, st, rootPos, rootYaw);
  const m = MOODS[st.mood] ?? MOODS.calm;
  const t = st.time;
  const L = info.legLen;
  const stride = 2 * animalStepLength(info, Math.max(v, 0.05));
  const phi = st.phase;
  const duty = 0.62;
  const rot: Record<string, Q> = {};
  const breathe = Math.sin(t * TAU * 0.9 + rnd(1) * 6);
  // dandinement : roulis vers la patte d'appui ; rebond 2 fois par cycle
  const roll = (info.waddle * 9 + 2) * DEG * Math.sin(TAU * phi) * moving;
  const yawW = info.waddle * 6 * DEG * Math.sin(TAU * phi + 0.6) * moving;
  const bob = -L * 0.035 * moving * (0.5 + 0.5 * Math.cos(TAU * 2 * phi));
  const bodyQ = qMul(yawQ, qAxis([0, 0, 1], roll));
  rot.pelvis = qEuler(breathe * 0.8 * DEG, yawW, 0);
  rot.chest = qEuler(breathe * 0.6 * DEG, 0, 0);
  // picorer (poule au repos ou en « grazing »), regards par saccades
  const peckOn = (1 - moving) * (m.graze || info.species === "chicken" ? 1 : 0);
  const pk = (t * 0.45 + rnd(2)) % 1;
  const peck = peckOn * (pk < 0.18 ? Math.sin((pk / 0.18) * Math.PI) : 0) * (m.graze ? 1 : 0.6);
  const sacc = Math.floor(t * 0.9 + rnd(3) * 10);
  const lookY = (1 - moving) * (((Math.sin(sacc * 12.9898 + st.seed) * 43758.5453) % 1) * 2 - 1) * 35 * (1 - peck);
  if (sk.has("tail.1")) rot["tail.1"] = qEuler((m.tail * 0.5 + (info.species === "duck" ? 0 : -breathe)) * DEG, (info.species === "duck" ? 14 * Math.sin(t * 6) * (1 - moving) * m.wag : 0) * DEG + yawW, 0);
  for (const [s, sg] of [["l", 1], ["r", -1]] as const) if (sk.has(`wing.${s}`)) rot[`wing.${s}`] = qEuler(0, 0, sg * (m.ears < 0 ? 6 : 0) * DEG + sg * (info.waddle ? roll * 0.3 : 0));
  // pattes
  const feet: Record<string, V3> = {};
  const targets: { leg: LegInfo; F: V3; cAng: number; toeAng: number; planted: boolean }[] = [];
  const liftH = L * 0.16 * moving;
  info.legs.forEach((leg, i) => {
    const u = wrap(phi + (i === 0 ? 0 : 0.5));
    let z: number, y = 0, sw = 0;
    const planted = u < duty;
    if (planted) z = stride * (duty / 2 - u);
    else {
      sw = (u - duty) / (1 - duty);
      const e = sw * sw * (3 - 2 * sw);
      z = stride * (-duty / 2 + duty * e);
      y = liftH * Math.sin(Math.PI * sw);
    }
    z *= moving;
    const f0 = leg.foot0;
    const Fl: V3 = [f0[0] * (1 - info.waddle * 0.15 * moving), f0[1] + y, f0[2] + z];
    const joint = sk.bone(leg.bones[0])!.head;
    const lean = Math.atan2(joint[2] - Fl[2], joint[1] - Fl[1]) / DEG - Math.atan2(joint[2] - f0[2], joint[1] - f0[1]) / DEG;
    const s = Math.sin(Math.PI * sw);
    const cAng = planted ? lean * 0.6 : lean * 0.6 * (1 - sw) + 40 * s * moving;
    const toeAng = planted ? 0 : 55 * s * moving;
    targets.push({ leg, F: toWorld(Fl), cAng, toeAng, planted });
    feet[leg.id] = toWorld(Fl);
  });
  let drop = 0;
  let pose: Pose = { rot, root: rootPos, rootRot: bodyQ };
  // hochement : la tête reste fixe dans le monde pendant ~70 % du pas, puis se projette vers l'avant
  const step = stride / 2;
  const sp = wrap(phi * 2 + 0.1);
  const hold = 0.7;
  const amp = info.bob * step * hold * 0.5 * moving;
  const headZ = sp < hold ? amp * (1 - (2 * sp) / hold) : -amp + 2 * amp * smoothstep(0, 1, (sp - hold) / (1 - hold));
  for (let pass = 0; pass < 3; pass++) {
    pose = { rot, root: toWorld([0, bob - drop, 0]), rootRot: bodyQ };
    let W = sk.world(pose);
    let Wq = sk.worldQuats(W);
    // cou en IK : place le haut du cou (nuque) à la cible, tête gardée horizontale
    const n1 = sk.index["neck.1"], n2 = sk.index["neck.2"];
    const base = sk.headOf(W, "neck.1");
    const restPoll = sk.bones[sk.index.head].head;
    const restBase = sk.bones[n1].head;
    const offL = sub(restPoll, restBase);
    const pk3: V3 = [0, -peck * L * 0.95, peck * L * 0.25];
    const want = add(base, qRot(yawQ, add(add(offL, [0, (m.neck < 0 ? 0.08 : m.neck > 0 ? -0.1 : 0) * L, headZ]), pk3)));
    const X = qRot(yawQ, [1, 0, 0]);
    const ik = twoBoneIK(base, want, sk.length[n1], sk.length[n2], qRot(yawQ, [0, 0, -1]));
    const w1 = qFromBasis(sk.axis[n1], [1, 0, 0], norm(sub(ik.mid, base)), X);
    const w2 = qFromBasis(sk.axis[n2], [1, 0, 0], norm(sub(ik.end, ik.mid)), X);
    rot["neck.1"] = Skeleton.toLocal(Wq[sk.parentIdx[n1]], w1);
    rot["neck.2"] = Skeleton.toLocal(w1, w2);
    rot.head = Skeleton.toLocal(w2, qMul(yawQ, qEuler((peck * 50 + breathe) * DEG, lookY * DEG, 0)));
    W = sk.world(pose);
    Wq = sk.worldQuats(W);
    let worst = 1;
    for (const lt of targets) {
      const r = solveLeg(sk, W, Wq, lt.leg, lt.F, lt.cAng, lt.toeAng, yawQ, rot);
      if (lt.planted) worst = Math.min(worst, r);
    }
    if (worst < 0.999 && pass < 2) drop += (1 - worst) * L * 1.05;
    else break;
  }
  return { pose, feet };
}

