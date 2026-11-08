/**
 * Animation procédurale d'un humanoïde : locomotion (repos → marche → course), actions du haut du corps, humeur.
 *
 * - Avance par **distance parcourue** : la phase du cycle est intégrée par l'appelant (`phase += Δdistance / foulée`),
 *   donc les pieds en appui ne glissent pas, même quand la vitesse change.
 * - Pieds : appui (pied fixe au sol, recule exactement à la vitesse du corps), envol (arc), roulé talon → plante →
 *   pointe ; jambes résolues par **IK deux os** avec vecteur de pôle (genou vers l'avant) et IK douce (pas de claquement
 *   en extension) ; bassin abaissé si une cible est hors d'atteinte.
 * - Bassin : rebond (bas au contact en marche, à mi-appui en course), lacet, bascule, balancement latéral ;
 *   épaules en contre-rotation ; balancier des bras opposé aux jambes ; coude plus fléchi avec la vitesse ;
 *   inclinaison avec la vitesse ; tête stabilisée.
 */
import { type Q, type V3, DEG, add, clamp, cross, dot, len, mix, norm, qAxis, qConj, qEuler, qId, qMul, qSlerp, scale, smoothstep, sub } from "../core/math";
import { type Pose, Skeleton, qFromBasis } from "./skeleton";

export const ACTIONS = ["idle", "walk", "run", "wave", "point", "cheer", "talk", "carry", "sit", "jump", "think", "bow", "hammer", "sweep", "dig", "kick"] as const;
export type Action = (typeof ACTIONS)[number];

export type MotionState = {
  /** Vitesse au sol (m/s), lissée par l'appelant. */
  speed: number;
  /** Phase du cycle de foulée (tours ; intégrée par la distance). */
  phase: number;
  /** Temps (s). */
  time: number;
  /** Action du haut du corps et son temps depuis le début (s). */
  action: Action;
  actionTime: number;
  /** Poids de l'action (0..1, fondu entrant/sortant géré par l'appelant). */
  actionWeight: number;
  mood: string;
  /** Virage (rad/s) : inclinaison vers l'intérieur. */
  turn: number;
  /** Graine de micro-variations (posture, tics). */
  seed: number;
  /** Assis : hauteur de l'assise (m, 0 = par terre). Le bassin s'y pose, les pieds restent au sol devant. */
  seatY?: number;
};

export type RigInfo = {
  hipY: number;
  thigh: number;
  shin: number;
  ankleY: number;
  footLen: number;
  hipX: number;
};

export function rigInfo(sk: Skeleton): RigInfo {
  const th = sk.bone("thigh.l")!, sh = sk.bone("shin.l")!, ft = sk.bone("foot.l")!;
  return { hipY: th.head[1], thigh: len(sub(th.tail, th.head)), shin: len(sub(sh.tail, sh.head)), ankleY: sh.tail[1], footLen: len(sub(ft.tail, ft.head)) * 1.4, hipX: th.head[0] };
}

/** Longueur d'un pas (m) pour une vitesse donnée : la cadence en découle (vitesse / pas). */
export function stepLength(info: RigInfo, speed: number): number {
  const leg = info.thigh + info.shin;
  const vn = speed / leg;
  const run = smoothstep(1.6, 2.6, vn);
  const walk = leg * clamp(0.38 + 0.2 * vn, 0.3, 0.85);
  const runL = leg * clamp(0.75 + 0.22 * vn, 0.85, 1.7);
  return mix(walk, runL, run);
}

type MoodK = { lean: number; head: number; amp: number; bob: number; chest: number; shoulders: number };
const MOOD: Record<string, MoodK> = {
  neutral: { lean: 0, head: 0, amp: 1, bob: 1, chest: 0, shoulders: 0 },
  happy: { lean: -2, head: -4, amp: 1.2, bob: 1.35, chest: -3, shoulders: 0 },
  sad: { lean: 9, head: 14, amp: 0.55, bob: 0.5, chest: 6, shoulders: 4 },
  angry: { lean: 7, head: 4, amp: 1.1, bob: 0.8, chest: -2, shoulders: 6 },
  surprised: { lean: -4, head: -6, amp: 0.9, bob: 1, chest: -4, shoulders: 3 },
  sleepy: { lean: 5, head: 16, amp: 0.6, bob: 0.6, chest: 4, shoulders: 2 },
};

/** Rotation autour de l'axe charnière d'un os : `cross(direction, avant)` (positif = le bout part vers l'avant). */
function hinge(sk: Skeleton, name: string, angleDeg: number, sign = 1): Q {
  const ax = sk.axis[sk.index[name]];
  const h = norm(cross(ax, [0, 0, 1]));
  return qAxis(h, sign * angleDeg * DEG);
}

/** IK deux os : position du genou (ou coude) pour atteindre `target` depuis `root`, pliée vers `pole`. Douce en extension. */
export function twoBoneIK(root: V3, target: V3, l1: number, l2: number, pole: V3): { mid: V3; end: V3; reach: number } {
  const total = l1 + l2;
  let d = sub(target, root);
  let D = len(d);
  // IK douce : au-delà de 96 % de l'extension, la distance effective tend vers l'extension sans l'atteindre brutalement
  const soft = total * 0.04;
  const da = total - soft;
  let reach = 1;
  if (D > da) {
    const De = da + soft * (1 - Math.exp(-(D - da) / soft));
    reach = De / D;
    D = De;
  }
  D = Math.max(D, Math.abs(l1 - l2) + 1e-4);
  const dir = norm(d);
  d = scale(dir, D);
  const a = (l1 * l1 - l2 * l2 + D * D) / (2 * D);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const pp = norm(sub(pole, scale(dir, dot(pole, dir))));
  const mid = add(add(root, scale(dir, a)), scale(pp, h));
  return { mid, end: add(root, d), reach };
}

/**
 * Pose d'un humanoïde. `rootPos` / `rootYaw` : placement du personnage dans la scène (le modèle regarde +z).
 * Renvoie la pose et les positions de pieds (pour le contrôle de glissement des tests).
 */
export function humanoidPose(sk: Skeleton, info: RigInfo, st: MotionState, rootPos: V3 = [0, 0, 0], rootYaw = 0): { pose: Pose; feet: { l: V3; r: V3 } } {
  const m = MOOD[st.mood] ?? MOOD.neutral;
  const leg = info.thigh + info.shin;
  const v = Math.max(0, st.speed);
  const vn = v / leg;
  const moving = smoothstep(0.03, 0.35, v);
  const run = smoothstep(1.6, 2.6, vn);
  const step = stepLength(info, Math.max(v, 0.2));
  const stride = 2 * step;
  const phi = st.phase;
  const TAU = Math.PI * 2;
  const t = st.time;
  const rnd = (k: number) => ((Math.sin(st.seed * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
  const rot: Record<string, Q> = {};

  /* ---------- bassin ---------- */
  const amp = m.amp;
  const bobAmp = leg * mix(0.028, 0.045, run) * Math.min(1, vn * 1.2) * m.bob * moving;
  const bob = run > 0.5 ? -bobAmp * (0.5 + 0.5 * Math.cos(TAU * 2 * (phi - 0.18))) : -bobAmp * (0.5 + 0.5 * Math.cos(TAU * 2 * phi));
  const crouch = leg * (mix(0.012, 0.045, run) * moving + 0.004);
  const breathe = Math.sin(t * TAU * 0.23 + rnd(1) * 6);
  const idleSway = (1 - moving) * leg * 0.008 * Math.sin(t * TAU * 0.11 + rnd(2) * 6);
  const pelvisYaw = 7 * DEG * Math.sin(TAU * phi) * moving * amp;
  const pelvisRoll = 4 * DEG * Math.sin(TAU * phi * 2 + Math.PI / 2) * moving * (1 - run * 0.5);
  const sway = leg * 0.018 * Math.sin(TAU * phi) * moving * (1 - run * 0.6) + idleSway;
  const lean = (m.lean + mix(3, 13, run) * moving * Math.min(1, vn * 1.5) + 2 * (1 - moving)) * DEG;
  const turnLean = clamp(st.turn * v * 0.15, -0.3, 0.3);
  rot.pelvis = qMul(qEuler(lean * 0.4, pelvisYaw, pelvisRoll + turnLean), qId());
  rot.spine = qEuler(lean * 0.35 + m.chest * 0.5 * DEG + breathe * 0.6 * DEG, -pelvisYaw * 0.5, -pelvisRoll * 0.5);
  rot.chest = qEuler(lean * 0.25 + m.chest * 0.5 * DEG + breathe * 1.2 * DEG, -pelvisYaw * 0.9, -pelvisRoll * 0.4);
  // tête stabilisée : annule le lacet du buste et l'inclinaison
  const look = 6 * DEG * Math.sin(t * 0.37 + rnd(3) * 9) * (1 - moving * 0.7);
  rot.neck = qEuler(-lean * 0.3 + m.head * 0.4 * DEG, pelvisYaw * 0.3 + look * 0.4, 0);
  rot.head = qEuler(-lean * 0.35 + m.head * 0.6 * DEG + Math.sin(t * 1.3) * 0.6 * DEG * (1 - moving), pelvisYaw * 0.3 + look * 0.6, 0);

  /* ---------- bras ---------- */
  const armAmp = mix(18, 42, run) * Math.min(1, 0.35 + vn) * moving * amp + 3 * (1 - moving);
  const elbow = mix(8, 78, run) * moving + 10 + 4 * breathe * (1 - moving);
  for (const [s, sg] of [["l", 1], ["r", -1]] as const) {
    const swing = sg * -armAmp * Math.cos(TAU * phi) + (1 - moving) * 1.5 * Math.sin(t * 0.8 + sg);
    // ramener l'A-pose vers le corps (adduction) puis balancier avant/arrière
    const adduct = qAxis([0, 0, 1], -sg * (36 - m.shoulders * 0.5 + run * 4) * DEG);
    const flex = qAxis([1, 0, 0], -swing * DEG);
    rot[`clavicle.${s}`] = qAxis([0, 0, 1], sg * m.shoulders * 0.6 * DEG);
    rot[`upperarm.${s}`] = qMul(flex, adduct);
    rot[`forearm.${s}`] = hinge(sk, `forearm.${s}`, elbow + Math.max(0, swing) * 0.3);
    rot[`hand.${s}`] = qAxis([1, 0, 0], -6 * DEG);
  }

  /* ---------- actions (haut du corps) ---------- */
  const w = clamp(st.actionWeight, 0, 1);
  const at = st.actionTime;
  const over: Record<string, Q> = {};
  const raiseArm = (s: "l" | "r", abduct: number, forward: number, elbowDeg: number) => {
    const sg = s === "l" ? 1 : -1;
    over[`upperarm.${s}`] = qMul(qAxis([1, 0, 0], -forward * DEG), qAxis([0, 0, 1], sg * (abduct - 45) * DEG));
    over[`forearm.${s}`] = hinge(sk, `forearm.${s}`, elbowDeg);
  };
  switch (st.action) {
    case "wave":
      raiseArm("r", 150, 10, 25 + 25 * Math.sin(at * 9));
      over.head = qEuler(-4 * DEG, -8 * DEG, 4 * DEG);
      break;
    case "point":
      raiseArm("r", 50, 80, 4);
      over.head = qEuler(0, -6 * DEG, 0);
      break;
    case "cheer":
      raiseArm("r", 165 + 6 * Math.sin(at * 8), 5, 12);
      raiseArm("l", 165 + 6 * Math.sin(at * 8 + 1), 5, 12);
      over.head = qEuler(-12 * DEG, 0, 0);
      break;
    case "talk": {
      const g = Math.sin(at * 3.1);
      raiseArm("r", 20, 35 + 15 * g, 70 + 15 * Math.sin(at * 4.3));
      raiseArm("l", 15, 20 - 10 * g, 55);
      over.head = qEuler((3 * Math.sin(at * 5.3)) * DEG, 6 * Math.sin(at * 1.7) * DEG, 0);
      break;
    }
    case "carry":
      raiseArm("r", 10, 45, 85);
      raiseArm("l", 10, 45, 85);
      break;
    case "think":
      raiseArm("r", 15, 40, 140);
      over.head = qEuler(8 * DEG, -10 * DEG, 6 * DEG);
      break;
    case "hammer": {
      // frappe : le bras droit monte puis s'abat (2 coups par seconde), regard sur l'ouvrage
      const k = 0.5 + 0.5 * Math.sin(at * 2 * TAU);
      raiseArm("r", 22, 35 + 75 * k, 25 + 75 * k);
      raiseArm("l", 14, 30, 70);
      over.spine = qEuler(8 * DEG, 0, 0);
      over.head = qEuler(14 * DEG, 0, 0);
      break;
    }
    case "sweep": {
      // balai, râteau : main gauche avancée plus bas (approchée, sans IK sur le manche), le buste va et vient
      const k = Math.sin(at * 1.4 * TAU);
      raiseArm("r", 18, 28 + 10 * k, 45);
      raiseArm("l", 22, 48 - 10 * k, 70);
      over.spine = qEuler(14 * DEG, 16 * k * DEG, 0);
      over.chest = qEuler(4 * DEG, 10 * k * DEG, 0);
      over.head = qEuler(12 * DEG, -6 * k * DEG, 0);
      break;
    }
    case "dig": {
      // bêcher : on se penche, on enfonce, on soulève (un cycle toutes les 1,1 s)
      const c = (at % 1.1) / 1.1, k = Math.sin(c * Math.PI);
      raiseArm("r", 15, 40 + 35 * k, 30 + 30 * (1 - k));
      raiseArm("l", 18, 55 + 25 * k, 50);
      over.spine = qEuler((18 + 16 * (1 - k)) * DEG, 0, 0);
      over.chest = qEuler(8 * DEG, 0, 0);
      over.head = qEuler(10 * DEG, 0, 0);
      break;
    }
    case "bow": {
      const k = Math.sin(clamp(at / 1.2, 0, 1) * Math.PI);
      over.spine = qEuler(35 * k * DEG, 0, 0);
      over.chest = qEuler(15 * k * DEG, 0, 0);
      break;
    }
  }
  for (const [k, q] of Object.entries(over)) rot[k] = qSlerp(rot[k] ?? qId(), q, w);

  /* ---------- jambes : IK ---------- */
  const sit = st.action === "sit" ? w : 0;
  const jumpT = st.action === "jump" ? at % 1.1 : -1;
  let jumpY = 0;
  let jumpCrouch = 0;
  if (jumpT >= 0) {
    if (jumpT < 0.25) jumpCrouch = Math.sin((jumpT / 0.25) * Math.PI * 0.5) * leg * 0.12;
    else if (jumpT < 0.85) jumpY = Math.sin(((jumpT - 0.25) / 0.6) * Math.PI) * leg * 0.45;
    else jumpCrouch = Math.sin(((jumpT - 0.85) / 0.25) * Math.PI) * leg * 0.08;
    jumpY *= w;
    jumpCrouch *= w;
  }
  const yawQ = qAxis([0, 1, 0], rootYaw);
  const toWorld = (p: V3): V3 => {
    const r = qMul(qMul(yawQ, [p[0], p[1], p[2], 0]), qConj(yawQ));
    return [r[0] + rootPos[0], r[1] + rootPos[1], r[2] + rootPos[2]];
  };
  const seatTop = st.seatY && st.seatY > 0 ? Math.min(info.hipY * 0.95, st.seatY + info.thigh * 0.18) : info.thigh * 0.25;
  let drop = crouch + jumpCrouch + sit * (info.hipY - seatTop);
  const pelvisOffset: V3 = [sway, bob - drop + jumpY, 0];
  const beta = mix(0.62, 0.38, run);
  const lift = leg * mix(0.075, 0.2, run) * Math.min(1, vn * 1.3) * moving;
  const feetLocal: Record<"l" | "r", { p: V3; pitch: number; planted: boolean }> = { l: { p: [0, 0, 0], pitch: 0, planted: true }, r: { p: [0, 0, 0], pitch: 0, planted: true } };
  for (const [s, off] of [["l", 0], ["r", 0.5]] as const) {
    const sx = s === "l" ? info.hipX * 0.9 : -info.hipX * 0.9;
    const u = (((phi + off) % 1) + 1) % 1;
    let z: number, y: number, pitch: number;
    if (u < beta) {
      z = stride * (beta / 2 - u);
      y = 0;
      const heel = 1 - smoothstep(0, 0.12, u);
      const toeOff = smoothstep(beta - 0.22, beta, u);
      pitch = (heel * -12 + toeOff * 28) * moving;
    } else {
      const sw = (u - beta) / (1 - beta);
      const e = sw * sw * (3 - 2 * sw);
      z = stride * (-beta / 2 + beta * e);
      y = lift * Math.sin(Math.PI * sw) ** 1.2;
      pitch = mix(28, -14, smoothstep(0, 0.85, sw)) * moving;
    }
    z *= moving;
    feetLocal[s] = { p: [sx + sway * 0.2, y, z + info.footLen * 0.05], pitch, planted: u < beta || moving < 0.05 };
    if (sit > 0) feetLocal[s].p = [sx * 1.15, 0, mix(feetLocal[s].p[2], info.thigh * 0.95, sit)];
    // tir : le pied droit recule, puis fouette vers l'avant et vers le haut (0,7 s)
    if (st.action === "kick" && s === "r") {
      const t = clamp(st.actionTime / 0.7, 0, 1);
      const back = Math.sin(clamp(t / 0.35, 0, 1) * Math.PI * 0.5) * (1 - smoothstep(0.35, 0.5, t));
      const swing = Math.sin(clamp((t - 0.3) / 0.5, 0, 1) * Math.PI);
      const L = info.thigh + info.shin;
      feetLocal[s] = { p: [sx * 0.6, (0.12 * back + 0.35 * swing) * L * w, (-0.35 * back + 0.75 * swing) * L * w], pitch: 30 * swing * w, planted: false };
    }
  }
  // passes : position du bassin, puis IK, puis abaissement si hors d'atteinte
  let pose: Pose = { rot, root: toWorld(pelvisOffset), rootRot: yawQ };
  for (let pass = 0; pass < 2; pass++) {
    pose = { rot, root: toWorld([pelvisOffset[0], pelvisOffset[1], pelvisOffset[2]]), rootRot: yawQ };
    const W = sk.world(pose);
    const Wq = sk.worldQuats(W);
    let worst = 1;
    for (const s of ["l", "r"] as const) {
      const ti = sk.index[`thigh.${s}`];
      const pelvisI = sk.index.pelvis;
      const hip = sk.headOf(W, `thigh.${s}`);
      const f = feetLocal[s];
      const ankleTarget = toWorld([f.p[0], f.p[1] + info.ankleY + (f.pitch > 0 ? Math.sin(f.pitch * DEG) * info.footLen * 0.55 : 0), f.p[2]]);
      const fwd = toWorld([0, 0, 1]);
      const pole = sub(fwd, rootPos);
      const sitPole: V3 = sit > 0 ? add(pole, [0, sit * 0.7, 0]) : pole;
      const ik = twoBoneIK(hip, ankleTarget, info.thigh, info.shin, norm(sitPole));
      worst = Math.min(worst, ik.reach);
      const thighRest = sk.axis[ti];
      const shinRest = sk.axis[sk.index[`shin.${s}`]];
      const f0: V3 = [0, 0, 1];
      const thighW = qFromBasis(thighRest, f0, norm(sub(ik.mid, hip)), sitPole);
      const shinW = qFromBasis(shinRest, f0, norm(sub(ik.end, ik.mid)), sitPole);
      rot[`thigh.${s}`] = Skeleton.toLocal(Wq[pelvisI], thighW);
      rot[`shin.${s}`] = Skeleton.toLocal(thighW, shinW);
      const footW = qMul(yawQ, qAxis([1, 0, 0], f.pitch * DEG));
      rot[`foot.${s}`] = Skeleton.toLocal(shinW, footW);
      rot[`toe.${s}`] = qAxis([1, 0, 0], -Math.max(0, f.pitch) * 0.8 * DEG);
    }
    if (worst < 0.995 && pass === 0) {
      drop += (1 - worst) * leg * 0.9;
      pelvisOffset[1] = bob - drop + jumpY;
    } else if (pass === 0) break;
  }
  pose = { rot, root: toWorld(pelvisOffset), rootRot: yawQ };
  return { pose, feet: { l: toWorld(feetLocal.l.p), r: toWorld(feetLocal.r.p) } };
}
