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
import { type Q, type V3, DEG, add, clamp, cross, dot, len, mix, norm, qAxis, qConj, qEuler, qId, qFromTo, qMul, qRot, qSlerp, scale, smoothstep, sub } from "../core/math";
import { type Pose, Skeleton, qFromBasis } from "./skeleton";

export const ACTIONS = ["idle", "walk", "run", "wave", "point", "cheer", "talk", "carry", "sit", "jump", "think", "bow", "hammer", "sweep", "dig", "kick", "drink", "eat", "sleep", "throw", "comb", "guard", "punch", "fightkick", "sword", "archery", "hang", "dance", "swim", "climb"] as const;
/** Poses à bord (posées par la conduite, pas des ordres d'acteur) : mains au volant, à califourchon, à la rame. */
export const RIDE_ACTIONS = ["drive", "ride", "row"] as const;
export type Action = (typeof ACTIONS)[number] | (typeof RIDE_ACTIONS)[number];

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
  /** Boire, manger à une cible : hauteur de la cible au-dessus des pieds (m). Absent : gobelet, nourriture à la main ; animal : au sol. */
  reachY?: number;
  /**
   * Assis dans un véhicule ou sur une monture (`drive`, `ride`, `row`, `sit`) : pieds par rapport au bassin posé
   * (`y` sous les pieds de l'acteur, écart latéral, avance), `pedal` = tours de pédalier (vélo), `r` son rayon.
   */
  seatFoot?: { y: number; spread: number; fwd: number; pedal?: number; r?: number };
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
  // IK douce : au-delà de 99 % de l'extension, la distance effective tend vers l'extension sans claquer. Une zone
  // plus large (4 %) laissait le genou plié d'une vingtaine de degrés en permanence : démarche accroupie
  const soft = total * 0.006;
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
 * Garde-fou anatomique : ni la main ni l'avant-bras ne traversent la tête (grosses têtes chibi et cartoon, bras levés,
 * gestes vers le visage) ni les cuisses (balancier de la marche, hanches larges). Si un point du bras entre dans la
 * tête ou une cuisse, le bras pivote à l'épaule pour s'en écarter, par petits pas. `touch` : geste qui va au visage (manger, boire, réfléchir) : contact permis, pas plus.
 */
function clearHead(sk: Skeleton, rot: Record<string, Q>, touch: boolean) {
  const hi = sk.index.head;
  if (hi === undefined) return;
  const hb = sk.bones[hi];
  const R = Math.max(hb.radius[0], len(sub(hb.tail, hb.head)) * 0.5) * (touch ? 0.92 : 1.04);
  // cuisses (rayon habillé) : un bras qui pend ou se balance ne les traverse pas
  const thighR = (s: string) => (sk.bones[sk.index[`thigh.${s}`]]?.radius[0] ?? 0) * 1.25;
  for (const s of ["l", "r"] as const) {
    const ui = sk.index[`upperarm.${s}`], hand = sk.index[`hand.${s}`];
    if (ui === undefined || hand === undefined) continue;
    const hr = sk.bones[hand].radius[0] * (touch ? 0.5 : 1.3);
    for (let it = 0; it < 10; it++) {
      const W = sk.world({ rot, root: [0, 0, 0] });
      const c = scale(add(sk.headOf(W, "head"), sk.tailOf(W, "head")), 0.5);
      const pts = [sk.headOf(W, `forearm.${s}`), sk.headOf(W, `hand.${s}`), sk.tailOf(W, `hand.${s}`), scale(add(sk.headOf(W, `forearm.${s}`), sk.headOf(W, `hand.${s}`)), 0.5)];
      let worst = 0, wp: V3 | null = null, from: V3 = c;
      for (const p of pts) {
        const pen = R + hr - len(sub(p, c));
        if (pen > worst) (worst = pen), (wp = p), (from = c);
        for (const t of ["l", "r"]) {
          if (sk.index[`thigh.${t}`] === undefined) continue;
          const a = sk.headOf(W, `thigh.${t}`), b = sk.tailOf(W, `thigh.${t}`);
          const ab = sub(b, a);
          const u = Math.max(0, Math.min(1, dot(sub(p, a), ab) / Math.max(1e-9, dot(ab, ab))));
          const q = add(a, scale(ab, u));
          const pen2 = thighR(t) + hr * 0.6 - len(sub(p, q));
          if (pen2 > worst) (worst = pen2), (wp = p), (from = q);
        }
      }
      if (!wp || worst < 1e-4) break;
      const sh = sk.headOf(W, `upperarm.${s}`);
      // rotation à l'épaule qui éloigne le point fautif de l'obstacle (axe ⟂ bras et poussée)
      const arm = sub(wp, sh), push = norm(sub(wp, from));
      let ax = cross(arm, push);
      if (len(ax) < 1e-6) ax = [0, 0, 1];
      const ang = Math.min(0.25, worst / Math.max(1e-3, len(arm)) + 0.01);
      const Wq = sk.worldQuats(W);
      const parent = Wq[sk.parentIdx[ui]];
      const axL = qRot(qConj(parent), norm(ax));
      rot[`upperarm.${s}`] = qMul(qAxis(axL, ang), rot[`upperarm.${s}`] ?? qId());
    }
  }
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
  /** Bruit lisse (-0.5 … 0.5) propre à l'acteur : variation continue qui ne se répète pas d'un cycle à l'autre. */
  const nz = (x: number, k: number) => {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    const h = (j: number) => rnd(k * 31.7 + j * 1.618);
    return h(i) + (h(i + 1) - h(i)) * u - 0.5;
  };
  const rot: Record<string, Q> = {};

  /* ---------- bassin ---------- */
  const amp = m.amp;
  // la jambe d'appui, presque tendue, fait d'elle-même monter le bassin à mi-appui et descendre au double appui
  // (abaissement exact par IK) : le rebond ajouté ne fait plus qu'accentuer la course
  const bobAmp = leg * mix(0.006, 0.045, run) * Math.min(1, vn * 1.2) * m.bob * moving * (1 + 0.35 * nz(t * 0.27, 43));
  const bob = run > 0.5 ? -bobAmp * (0.5 + 0.5 * Math.cos(TAU * 2 * (phi - 0.18))) : -bobAmp * (0.5 + 0.5 * Math.cos(TAU * 2 * phi));
  // genou d'appui fléchi de ~10° à la marche (amorti), plus en course ; au repos à peine déverrouillé
  const crouch = leg * (mix(0.002, 0.045, run) * moving + 0.002);
  const breathe = Math.sin(t * TAU * 0.23 + rnd(1) * 6);
  const idleSway = (1 - moving) * leg * 0.008 * Math.sin(t * TAU * 0.11 + rnd(2) * 6);
  const pelvisYaw = 7 * DEG * Math.sin(TAU * phi) * moving * amp;
  const pelvisRoll = 4 * DEG * Math.sin(TAU * phi * 2 + Math.PI / 2) * moving * (1 - run * 0.5);
  // contrapposto au repos : le poids passe d'une jambe à l'autre toutes les 7 à 12 s (maintien, puis bascule
  // lente) ; bassin décalé au-dessus de la jambe d'appui, hanche libre qui descend, épaules en sens inverse
  const still = (1 - moving) * (["sit", "sleep", "drive", "ride", "row", "jump", "kick", "bow"].includes(st.action) ? 1 - clamp(st.actionWeight, 0, 1) : 1);
  const ws = still * Math.tanh(2.6 * Math.sin((t * TAU) / (7 + rnd(4) * 5) + rnd(5) * 6)) * (0.7 + 0.3 * rnd(6));
  const hipRoll = 5 * DEG * ws;
  const sway = leg * 0.03 * Math.sin(TAU * phi) * moving * (1 - run * 0.6) + idleSway + leg * 0.04 * ws;
  const lean = (m.lean + mix(5, 14, run) * moving * Math.min(1, vn * 1.5) + 2 * (1 - moving)) * DEG;
  // poussée de chaque pas : le buste se penche un peu plus à l'impulsion, se redresse à l'attaque du talon
  const push = moving * 1.5 * DEG * Math.sin(TAU * 2 * (phi + 0.1));
  const turnLean = clamp(st.turn * v * 0.15, -0.3, 0.3);
  rot.pelvis = qMul(qEuler(lean * 0.4, pelvisYaw + 3 * DEG * ws, pelvisRoll + turnLean + hipRoll), qId());
  rot.spine = qEuler(lean * 0.35 + push + m.chest * 0.5 * DEG + breathe * 0.6 * DEG, -pelvisYaw * 0.5 - 1.5 * DEG * ws, -pelvisRoll * 0.5 - hipRoll * 0.9);
  rot.chest = qEuler(lean * 0.25 + m.chest * 0.5 * DEG + breathe * 1.2 * DEG, -pelvisYaw * 0.9 - 1.5 * DEG * ws, -pelvisRoll * 0.4 - hipRoll * 0.7);
  // tête stabilisée : annule le lacet du buste et l'inclinaison
  // regard au repos : la tête se pose quelques secondes sur un point puis tourne (vite au départ, amortie à
  // l'arrivée) vers un autre, au lieu d'osciller en continu
  const glance = (() => {
    const per = 3.2 + rnd(11) * 2.5, k = Math.floor((t + rnd(12) * 9) / per), u = ((t + rnd(12) * 9) / per) % 1;
    const tgt = (j: number) => 22 * (((Math.sin(st.seed * 7.13 + j * 3.71) * 43758.5453) % 1 + 1) % 1 - 0.5) * 2;
    const e = smoothstep(0, 0.22, u);
    return (tgt(k - 1) + (tgt(k) - tgt(k - 1)) * (e * (2 - e))) * DEG;
  })();
  const look = (6 * DEG * Math.sin(t * 0.37 + rnd(3) * 9) * moving * 0.3) + glance * (1 - moving) * 0.8;
  // la tête amortit le pas (léger retard sur le rebond du bassin) et penche un peu du côté de la hanche d'appui
  const nod = moving * 1.6 * DEG * Math.cos(TAU * 2 * (phi - 0.08)) * m.bob;
  rot.neck = qEuler(-lean * 0.3 + m.head * 0.4 * DEG + nod * 0.4, pelvisYaw * 0.3 + look * 0.4, hipRoll * 0.4);
  rot.head = qEuler(-lean * 0.35 + m.head * 0.6 * DEG + Math.sin(t * 1.3) * 0.6 * DEG * (1 - moving) + nod * 0.6, pelvisYaw * 0.3 + look * 0.6, hipRoll * 0.5 + 2 * DEG * still * Math.sin(t * 0.29 + rnd(7) * 6));

  /* ---------- bras ---------- */
  /**
   * Bras piloté comme une vraie épaule : flexion (vers l'avant, plan sagittal), abduction (écart, plan frontal),
   * rotation de l'humérus (`twist` > 0 : l'avant-bras plié rentre vers le ventre), puis flexion du coude.
   */
  const aimArm = (out: Record<string, Q>, s: "l" | "r", flexDeg: number, abdDeg: number, elbowDeg: number, twistDeg = 0) => {
    const sg = s === "l" ? 1 : -1;
    const a = abdDeg * DEG, f = flexDeg * DEG;
    const d0: V3 = [sg * Math.sin(a), -Math.cos(a), 0];
    aimDir(out, s, [d0[0], d0[1] * Math.cos(f), -d0[1] * Math.sin(f)], elbowDeg, twistDeg);
  };
  /** Même chose avec la direction du bras donnée directement (repère du buste : x à gauche, y en haut, z devant). */
  const aimDir = (out: Record<string, Q>, s: "l" | "r", dir: V3, elbowDeg: number, twistDeg = 0, pronDeg = 0) => {
    const sg = s === "l" ? 1 : -1;
    const d = norm(dir);
    // sens de flexion du coude : vers l'avant (ou vers le haut si le bras pointe déjà devant), tourné par `twist`
    const fw: V3 = Math.abs(d[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
    const b0 = norm(sub(fw, scale(d, dot(fw, d))));
    const mid = sub([-sg, 0, 0], scale(d, -sg * d[0]));
    const m0 = len(mid) > 1e-4 ? norm(mid) : norm(cross(d, b0));
    const tw = twistDeg * DEG;
    const bend = norm(add(scale(b0, Math.cos(tw)), scale(m0, Math.sin(tw))));
    const ui = sk.index[`upperarm.${s}`];
    out[`upperarm.${s}`] = qFromBasis(sk.axis[ui], [0, 0, 1], d, bend);
    // coude, puis rotation de l'avant-bras sur lui-même (pronation > 0 : la paume se tourne vers le corps / le bas)
    const fi = sk.index[`forearm.${s}`];
    out[`forearm.${s}`] = pronDeg ? qMul(hinge(sk, `forearm.${s}`, elbowDeg), qAxis(sk.axis[fi], -sg * pronDeg * DEG)) : hinge(sk, `forearm.${s}`, elbowDeg);
  };
  /**
   * Main portée à un point du corps (bouche, menton…), en repère de repos du personnage : IK deux os sur le bras
   * (coude vers le bas et l'extérieur), valable quelles que soient la taille de la tête et la longueur des bras.
   */
  const reachArm = (out: Record<string, Q>, s: "l" | "r", target: V3, poleOut = 0.6, pole?: V3) => {
    const sg = s === "l" ? 1 : -1;
    const ub = sk.bone(`upperarm.${s}`)!, fb = sk.bone(`forearm.${s}`)!, hb = sk.bone(`hand.${s}`)!;
    const l1 = len(sub(ub.tail, ub.head)), l2 = len(sub(fb.tail, fb.head)) + len(sub(hb.tail, hb.head)) * 0.45;
    const ik = twoBoneIK(ub.head, target, l1, l2, norm(pole ?? [sg * poleOut, -1, -0.25]));
    const d = norm(sub(ik.mid, ub.head));
    const fa = norm(sub(ik.end, ik.mid));
    const bend0 = sub(fa, scale(d, dot(fa, d)));
    const bend = len(bend0) > 1e-5 ? norm(bend0) : ([0, 0, 1] as V3);
    out[`upperarm.${s}`] = qFromBasis(sk.axis[sk.index[`upperarm.${s}`]], [0, 0, 1], d, bend);
    out[`forearm.${s}`] = hinge(sk, `forearm.${s}`, Math.acos(clamp(dot(d, fa), -1, 1)) / DEG);
  };
  /** Repères du visage en position de repos : bouche, menton (devant la tête). */
  const face = (() => {
    const hb = sk.bone("head")!;
    const R = hb.radius[0], hH = len(sub(hb.tail, hb.head));
    const ub = sk.bone("upperarm.r")!;
    return { R, hH, base: hb.head, ua: len(sub(ub.tail, ub.head)), mouth: add(hb.head, [0, hH * 0.3, R * 1.0]) as V3, chin: add(hb.head, [0, hH * 0.12, R * 0.85]) as V3 };
  })();
  // balancier des bras qui respire : plus ample, moins ample, jamais deux foulées identiques
  const armAmp = mix(16, 40, run) * Math.min(1, 0.35 + vn) * moving * amp * (1 + 0.4 * nz(t * 0.3, 41));
  for (const [s, sg] of [["l", 1], ["r", -1]] as const) {
    // balancier opposé à la jambe, un peu plus ample vers l'avant ; au repos le bras pend, légèrement devant
    const c = Math.cos(TAU * phi);
    const swing = sg * -armAmp * c * (sg * -c > 0 ? 1.08 : 0.85) + (1 - moving) * (3 + 1.2 * breathe + 1.5 * Math.sin(t * 0.7 + sg * 2 + rnd(9) * 6));
    // l'avant-bras suit avec retard (fouet) : le coude se plie surtout quand le bras part devant
    const lag = sg * -Math.cos(TAU * (phi - 0.09));
    const side = sg * ws;
    const elbow = mix(14, 85, run) * moving + (1 - moving) * (13 + 5 * (rnd(10 + sg) - 0.5)) + moving * Math.max(0, lag) * mix(26, 15, run) * amp + 2 * breathe * (1 - moving);
    // la hanche d'appui repousse le bras de son côté
    const abd = 7 + run * 6 + m.shoulders * 0.3 + 3 * Math.max(0, side) + 2 * (rnd(8 + sg) - 0.5);
    aimArm(rot, s, swing, abd, elbow, mix(18, 30, run));
    rot[`clavicle.${s}`] = qMul(qAxis([0, 1, 0], sg * swing * 0.15 * DEG), qAxis([0, 0, 1], sg * (m.shoulders * 0.6 + breathe * 0.8) * DEG));
    // poignet souple : la main traîne derrière l'avant-bras
    rot[`hand.${s}`] = qMul(qAxis([1, 0, 0], (-8 + 6 * lag * moving) * DEG), qAxis([0, 0, 1], sg * 5 * DEG));
  }

  /* ---------- actions (haut du corps) ---------- */
  const w = clamp(st.actionWeight, 0, 1);
  // temps du geste légèrement accéléré ou ralenti, au hasard et en douceur : deux cycles ne tombent jamais pareil
  // (une boucle rejouée à l'identique fait automate). La dérivée reste proche de 1 : le geste ne recule jamais
  // tempo : reste proche de la cadence d'équilibre (±4 % par acteur, très légère dérive) ; la variation porte
  // sur les positions visées (plus bas), pas sur la synchronisation du geste
  const rate = 0.96 + 0.08 * rnd(5);
  const at = Math.max(0, st.actionTime * rate + 0.04 * nz(st.actionTime * 0.4, 7) * smoothstep(0, 1.5, st.actionTime));
  const over: Record<string, Q> = {};
  // entrée d'un geste : le bras dépasse un peu sa cible puis s'y pose (0,6 s), plutôt qu'un arrêt sec
  // posture des pieds et des jambes demandée par l'action (fractions de jambe : x à gauche, y, z devant)
  let stance: { l: V3; r: V3 } | null = null;
  let stanceDrop = 0;
  let kickFoot: { p: V3; pitch: number } | null = null;
  let hangLift = 0, hangSwing = 0;
  // danse : pas marqués (décalage des pieds) ; nage : corps à l'horizontale ; escalade : élévation le long de la paroi
  let footOff: { l: V3; r: V3 } | null = null;
  let swimK = 0, swimBob = 0, swimKick = 0;
  let climbLift = 0, climbPh = 0;
  const settle = at < 0.6 ? 1 + 0.08 * Math.sin((at / 0.6) * Math.PI) * (1 - at / 0.6) * 2 : 1;
  const raiseArm = (s: "l" | "r", abduct: number, forward: number, elbowDeg: number) => {
    const sg = s === "l" ? 1 : -1;
    const ab = 45 + (abduct - 45) * settle;
    over[`upperarm.${s}`] = qMul(qAxis([1, 0, 0], -forward * settle * DEG), qAxis([0, 0, 1], sg * (ab - 45) * DEG));
    over[`forearm.${s}`] = hinge(sk, `forearm.${s}`, elbowDeg);
    // au-delà de l'horizontale, l'omoplate tourne et l'épaule monte (rythme scapulo-huméral)
    over[`clavicle.${s}`] = qAxis([0, 0, 1], sg * (Math.max(0, ab - 60) * 0.16 + m.shoulders * 0.6) * DEG);
  };
  /** Interpolation par clés (temps croissants dans [0, 1]) : chaque passage est lissé (départ et arrivée en douceur). */
  const keyed = (c: number, keys: [number, number[]][]): number[] => {
    if (c <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++)
      if (c <= keys[i][0]) {
        const [t0, a] = keys[i - 1], [t1, b] = keys[i];
        const u = smoothstep(0, 1, (c - t0) / Math.max(1e-6, t1 - t0));
        return a.map((x, j) => x + (b[j] - x) * u);
      }
    return keys[keys.length - 1][1];
  };
  /**
   * Oriente l'objet tenu (main droite) : le poignet tourne pour que le manche suive `dirB` (repère du bassin : x à
   * gauche, y en haut, z devant). Axe du manche au repos : celui de la prise posée par `character` (bras en A).
   */
  type AimDir = V3 | ((forearm: V3) => V3);
  /** Objet tenu orienté : axe du manche, et si besoin direction de sa tête (+x de l'objet) ou de sa face (+z). */
  let itemAim: { axis: AimDir; ref?: AimDir; refAxis?: "x" | "z" } | null = null;
  const aimItem = (axis: AimDir, ref?: AimDir, refAxis: "x" | "z" = "x") => void (itemAim = { axis, ref, refAxis });
  /** Garde de combat : poings devant le menton, coudes serrés qui protègent les côtes. */
  const guardArm = (out: Record<string, Q>, s: "l" | "r", k = 1) => aimArm(out, s, 36 + 8 * k, 10, 118 + 10 * k, 14);
  /** Mélange deux poses de bras (0 = a, 1 = b). */
  const blendArm = (s: "l" | "r", a: Record<string, Q>, b: Record<string, Q>, k: number) => {
    for (const n of [`upperarm.${s}`, `forearm.${s}`, `hand.${s}`, `clavicle.${s}`]) if (a[n] || b[n]) over[n] = qSlerp(a[n] ?? qId(), b[n] ?? qId(), k);
  };
  switch (st.action) {
    case "throw": {
      // lancer par-dessus l'épaule (1,6 s) : armé (bras en arrière, buste tourné, pied gauche devant), fouet du bras
      // par-dessus l'épaule avec rotation du buste, lâcher devant, accompagnement en travers du corps, retour
      const c = (at % 1.6) / 1.6;
      const [dx, dy, dz, el, yaw, pitch] = keyed(c, [
        [0, [-0.35, -0.85, 0.2, 20, 0, 0]],
        [0.38, [-0.55, 0.55, -0.62, 95, -38, -6]],
        [0.48, [-0.45, 0.75, -0.2, 110, -30, -8]],
        [0.58, [-0.2, 0.35, 0.92, 15, 28, 12]],
        [0.72, [0.35, -0.55, 0.78, 25, 38, 20]],
        [1, [-0.35, -0.85, 0.2, 20, 0, 0]],
      ]);
      aimDir(over, "r", [dx, dy, dz], el, 15, 30);
      const lk = smoothstep(0.1, 0.38, c) * (1 - smoothstep(0.58, 0.8, c));
      aimArm(over, "l", 20 + 60 * lk, 14 + 6 * lk, 25 + 20 * (1 - lk), 10);
      over.spine = qEuler(pitch * 0.4 * DEG, yaw * 0.45 * DEG, 0);
      over.chest = qEuler(pitch * 0.6 * DEG, yaw * 0.55 * DEG, 0);
      over.head = qEuler(-pitch * 0.5 * DEG, -yaw * 0.8 * DEG, 0);
      stance = { l: [0.02, 0, 0.22], r: [-0.04, 0, -0.14] };
      break;
    }
    case "comb": {
      // se coiffer : la main droite passe du front au-dessus de l'oreille (le long du crâne), puis revient à distance ;
      // la gauche tient un miroir devant la poitrine, la tête s'incline vers la main
      const c = (at % 1.4) / 1.4;
      const R = face.R, hH = face.hH, b = face.base;
      const front: V3 = add(b, [-R * 0.25, hH * 1.02 + R * 0.15, R * 0.55]);
      const top: V3 = add(b, [-R * 0.75, hH * 0.95 + R * 0.12, R * 0.05]);
      const back: V3 = add(b, [-R * 1.15, hH * 0.6, -R * 0.45]);
      const away: V3 = add(b, [-R * 1.3, hH * 1.05, R * 0.9]);
      const [x, y, z] = keyed(c, [[0, away as number[]], [0.15, front as number[]], [0.45, top as number[]], [0.65, back as number[]], [1, away as number[]]]);
      reachArm(over, "r", [x, y, z], 0.9, [-1, 0.2, 0.1]);
      over["hand.r"] = qAxis([1, 0, 0], 30 * DEG);
      aimArm(over, "l", 48, 12, 105, 40);
      over.head = qEuler(6 * DEG, -6 * DEG, -(6 + 4 * Math.sin(c * TAU)) * DEG);
      break;
    }
    case "guard": {
      // garde de combat : poings hauts, menton rentré, sautillement léger et buste qui oscille
      const b2 = Math.sin(at * 2 * TAU);
      guardArm(over, "l", 1);
      guardArm(over, "r", 0.85);
      over.spine = qEuler(6 * DEG, (-12 + 4 * Math.sin(at * 1.3 * TAU)) * DEG, 0);
      over.head = qEuler(10 * DEG, 10 * DEG, 0);
      stance = { l: [0.06, 0, 0.2], r: [-0.06, 0, -0.16] };
      stanceDrop = leg * (0.035 + 0.012 * b2);
      break;
    }
    case "punch": {
      // enchaînement (0,8 s par coup) : direct du bras avant, direct du bras arrière, crochet, uppercut. Le poing part
      // vite, reste un instant, revient en garde ; le buste et la hanche tournent dans le coup
      const n = Math.floor(at / 0.8) % 4, c = (at % 0.8) / 0.8;
      const e = c < 0.16 ? smoothstep(0, 0.16, c) : c < 0.3 ? 1 : 1 - smoothstep(0.3, 0.72, c);
      const G: Record<string, Q> = {}, S: Record<string, Q> = {};
      guardArm(G, "l"), guardArm(G, "r", 0.85);
      let yaw = -12, roll = 0, dip = 6;
      if (n === 0) { aimDir(S, "l", [0.08, 0.2, 1], 4, 10, 85); yaw = -12 - 14 * e; }
      else if (n === 1) { aimDir(S, "r", [0.12, 0.22, 1], 4, 10, 85); yaw = -12 + 40 * e; }
      else if (n === 2) {
        // crochet : bras à l'horizontale, coude plié à angle droit, qui balaie vers l'avant avec la rotation du buste
        const sw = smoothstep(0, 0.3, c);
        aimDir(S, "l", [0.8 - 0.55 * sw, 0.22, 0.45 + 0.4 * sw], 95, 88, 85);
        yaw = -12 - 30 * e;
      } else {
        // uppercut : on plie les genoux, le poing remonte de bas en haut devant le menton
        const up = smoothstep(0, 0.3, c);
        aimDir(S, "r", [0.08, -0.45 + 0.55 * up, 0.9], 100 - 5 * up, 15, -10);
        yaw = -12 + 22 * e;
        dip = 6 - 10 * e;
        stanceDrop = leg * 0.05 * (1 - up) * (1 - smoothstep(0.3, 0.7, c));
      }
      for (const s of ["l", "r"] as const) blendArm(s, G, { ...G, ...Object.fromEntries(Object.entries(S).filter(([k2]) => k2.endsWith(`.${s}`))) }, Object.keys(S).some((k2) => k2.endsWith(`.${s}`)) ? e : 0);
      over.spine = qEuler(dip * 0.5 * DEG, yaw * 0.45 * DEG, roll * DEG);
      over.chest = qEuler(dip * 0.5 * DEG, yaw * 0.55 * DEG, 0);
      over.head = qEuler(8 * DEG, -yaw * 0.7 * DEG, 0);
      stance = { l: [0.06, 0, 0.2], r: [-0.06, 0, -0.16] };
      stanceDrop += leg * 0.03;
      break;
    }
    case "fightkick": {
      // coups de pied (1,2 s chacun) : direct de face, circulaire, latéral. Genou armé, détente, retour armé, pose ;
      // bras en garde, le buste contre-balance (il part à l'opposé de la jambe)
      const n = Math.floor(at / 1.2) % 3, c = (at % 1.2) / 1.2;
      guardArm(over, "l", 1);
      guardArm(over, "r", 0.85);
      const L = leg;
      const k = keyed(c, [[0, [0]], [0.22, [1]], [0.36, [2]], [0.5, [2]], [0.66, [1]], [0.86, [0]], [1, [0]]])[0];
      // clés du pied droit : posé, armé (genou haut), détente
      const P0: V3 = [-info.hipX * 0.9, 0, -0.14 * L];
      const ch: V3[] = [[-0.1 * L, 0.42 * L, 0.32 * L], [-0.45 * L, 0.45 * L, -0.02 * L], [-0.32 * L, 0.42 * L, 0.12 * L]];
      const ex: V3[] = [[-0.08 * L, 0.56 * L, 0.74 * L], [0.05 * L, 0.64 * L, 0.66 * L], [-0.78 * L, 0.56 * L, 0.06 * L]];
      const a = k <= 1 ? P0 : ch[n], bb = k <= 1 ? ch[n] : ex[n], u = k <= 1 ? k : k - 1;
      kickFoot = { p: [a[0] + (bb[0] - a[0]) * u, a[1] + (bb[1] - a[1]) * u, a[2] + (bb[2] - a[2]) * u], pitch: n === 0 ? -20 * Math.max(0, k - 1) : 25 * Math.min(1, k) };
      const lean = Math.min(1, k) * (n === 2 ? 1 : n === 1 ? 0.8 : 0.4);
      over.spine = qEuler((n === 0 ? -8 : 4) * lean * DEG, (n === 2 ? 40 : n === 1 ? 25 : -10) * lean * DEG, (n === 0 ? 0 : -14) * lean * DEG);
      over.chest = qEuler(0, (n === 2 ? 20 : 0) * lean * DEG, (n === 0 ? 0 : -8) * lean * DEG);
      over.head = qEuler(4 * DEG, -(n === 2 ? 55 : n === 1 ? 25 : 0) * lean * DEG, (n === 0 ? 0 : 16) * lean * DEG);
      stance = { l: [0.04, 0, 0.12], r: [0, 0, 0] };
      break;
    }
    case "sword": {
      // escrime à une main (épée tenue à droite, 1 s par coup) : coup de taille vertical, diagonal, horizontal, estoc
      // en fente ; armé, frappe rapide, retour en garde. Le bras libre s'écarte en arrière pour l'équilibre
      const n = Math.floor(at) % 4, c = at % 1;
      const guardK: number[] = [-0.3, -0.25, 0.92, 60, 0, 0];
      const cuts: [number[], number[]][] = [
        [[-0.12, 0.95, -0.05, 85, 0, -10], [-0.08, -0.2, 0.97, 8, 0, 14]],
        [[-0.75, 0.55, 0.15, 90, -25, -4], [0.55, -0.35, 0.75, 10, 30, 12]],
        [[-0.92, 0.12, -0.15, 70, -35, 0], [0.65, 0.08, 0.75, 6, 40, 4]],
        [[-0.4, -0.05, 0.3, 115, -10, 0], [-0.04, 0.06, 1, 0, 10, 10]],
      ];
      const [w0, w1] = cuts[n];
      const [dx, dy, dz, el, yaw, pitch] = keyed(c, [[0, guardK], [0.32, w0], [0.46, w1], [0.62, w1], [1, guardK]]);
      aimDir(over, "r", [dx, dy, dz], el, 10, 40);
      // lame dans le prolongement de l'avant-bras, relevée vers l'avant (garde, armé), alignée dans le coup
      const strike = c > 0.32 && c < 0.62 ? 1 : 0;
      aimItem((fa) => add(fa, strike ? [0, 0.1, 0.15] : [0, 0.55, 0.45]));
      aimArm(over, "l", -15, 40, 75, -30);
      over.spine = qEuler(pitch * 0.4 * DEG, yaw * 0.45 * DEG, 0);
      over.chest = qEuler(pitch * 0.6 * DEG, yaw * 0.55 * DEG, 0);
      over.head = qEuler(6 * DEG, -yaw * 0.7 * DEG, 0);
      const lunge = n === 3 ? smoothstep(0.3, 0.46, c) * (1 - smoothstep(0.62, 0.95, c)) : 0;
      stance = { l: [0.04, 0, -0.18 - 0.1 * lunge], r: [-0.04, 0, 0.2 + 0.32 * lunge] };
      stanceDrop = leg * (0.04 + 0.08 * lunge);
      break;
    }
    case "archery": {
      // tir à l'arc (arc tenu à droite, 3 s) : de profil, bras d'arc tendu vers la cible (devant l'acteur), la main
      // gauche encoche près de l'arc, tire la corde jusqu'à la mâchoire, vise, lâche (la main file en arrière) et revient
      const c = (at % 3) / 3;
      const turn = 62;
      over.spine = qEuler(0, turn * 0.45 * DEG, 0);
      over.chest = qEuler(0, turn * 0.55 * DEG, 0);
      over.head = qEuler(4 * DEG, -turn * 0.85 * DEG, 0);
      const toChest = qConj(qAxis([0, 1, 0], turn * DEG));
      aimDir(over, "r", qRot(toChest, [0, 0.12, 1]), 4, 0, -20);
      over["clavicle.r"] = qAxis([0, 0, 1], -6 * DEG);
      // repères dans le repère du buste (tourné) : main d'arc, point d'ancrage sous la pommette, côté cible
      const ub = sk.bone("upperarm.r")!;
      const armL = face.ua * 2.05;
      const bowHand = add(ub.head, scale(norm(qRot(toChest, [0, 0.12, 1])), armL));
      // ancrage : coin de la mâchoire côté cible, devant le visage (la corde effleure le menton)
      const anchor: V3 = add(add(face.chin, scale(qRot(toChest, [0, 0, 1]), face.R * 0.55)), [0, -face.hH * 0.04, 0]);
      const nock: V3 = add(scale(add(bowHand, anchor), 0.5), [0, -face.R * 0.1, 0]);
      const behind: V3 = add(anchor, scale(qRot(toChest, [0, 0, -1]), face.R * 0.7));
      const [x, y, z] = keyed(c, [[0, nock as number[]], [0.15, nock as number[]], [0.5, anchor as number[]], [0.76, anchor as number[]], [0.8, behind as number[]], [1, nock as number[]]]);
      reachArm(over, "l", [x, y, z], 0, add(qRot(toChest, [0, 0, -1]), [0.6, 0.6, 0]));
      over["hand.l"] = qAxis([0, 0, 1], 15 * DEG);
      aimItem([0, 1, 0.1], [0, 0, 1], "z");
      stance = { l: [0.04, 0, -0.12], r: [-0.02, 0, 0.14] };
      break;
    }
    case "dance": {
      // danse à 112 battements par minute : rebond sur le temps, pas de côté qui marquent chaque temps, quatre
      // enchaînements de bras (8 temps chacun) tirés par acteur et qui tournent
      const beat = (at * 112) / 60, b = beat % 1, n = Math.floor(beat);
      const bounce = 0.5 - 0.5 * Math.cos(b * TAU);
      const side = n % 2 ? 1 : -1;
      const move = (Math.floor(beat / 8) + Math.floor(rnd(31) * 4)) % 4;
      const tap = Math.sin(Math.PI * b);
      const fs = side > 0 ? "l" : "r";
      footOff = { l: [0, 0, 0], r: [0, 0, 0] };
      footOff[fs] = [side * leg * 0.14 * tap, leg * 0.07 * tap, leg * 0.03 * tap];
      stance = { l: [0.05, 0, 0], r: [-0.05, 0, 0] };
      stanceDrop = leg * (0.02 + 0.045 * (1 - bounce));
      const sw = Math.sin(beat * Math.PI);
      if (move === 0) {
        // bras pliés qui balancent en opposition
        aimArm(over, "l", 25 + 25 * sw, 18, 95, 30);
        aimArm(over, "r", 25 - 25 * sw, 18, 95, 30);
      } else if (move === 1) {
        // bras levés qui ondulent d'un côté à l'autre
        for (const [s2, sg2] of [["l", 1], ["r", -1]] as const) aimDir(over, s2, [sg2 * 0.45 + 0.35 * sw, 1, 0.25], 25, 0, 10);
      } else if (move === 2) {
        // disco : le bras droit pointe en haut puis traverse en bas, l'autre main sur la hanche
        aimDir(over, "r", side > 0 ? [-0.55, 0.85, 0.3] : [0.35, -0.6, 0.6], 6, 0, 0);
        aimArm(over, "l", 10, 35, 105, -40);
      } else {
        // épaules qui roulent, avant-bras devant
        aimArm(over, "l", 40, 14, 100, 35);
        aimArm(over, "r", 40, 14, 100, 35);
        over["clavicle.l"] = qAxis([0, 0, 1], 9 * Math.max(0, sw) * DEG);
        over["clavicle.r"] = qAxis([0, 0, 1], 9 * Math.min(0, sw) * DEG);
      }
      over.spine = qEuler(0, 10 * side * bounce * DEG, 6 * sw * DEG);
      over.chest = qEuler(-3 * DEG, -6 * sw * DEG, -4 * sw * DEG);
      over.head = qEuler((6 * bounce - 3) * DEG, 8 * sw * DEG, 5 * sw * DEG);
      break;
    }
    case "swim": {
      // crawl : corps à l'horizontale à la surface, bras en moulinet alternés (entrée devant, traction sous le
      // corps, sortie à la hanche, retour coude haut au-dessus de l'eau), battements de jambes, roulis du corps et
      // respiration sur le côté tous les deux mouvements
      swimK = 1;
      const c = at * 0.75;
      for (const [s2, sg2, ph2] of [["r", -1, 0], ["l", 1, 0.5]] as const) {
        const a = TAU * (c + ph2);
        const rec = Math.sin(a) < 0;
        aimDir(over, s2, [sg2 * 0.2, Math.cos(a), Math.sin(a)], rec ? 70 * -Math.sin(a) + 15 : 20, rec ? 40 : 10, 30);
        over[`clavicle.${s2}`] = qAxis([0, 0, 1], sg2 * 12 * Math.max(0, Math.cos(a)) * DEG);
      }
      const roll = Math.sin(TAU * c);
      over.spine = qEuler(0, 18 * roll * DEG, 0);
      over.chest = qEuler(0, 10 * roll * DEG, 0);
      const breath = Math.max(0, Math.sin(TAU * c * 0.5)) ** 2;
      over.neck = qEuler(-25 * DEG, 0, 0);
      over.head = qEuler(-15 * DEG, 55 * breath * DEG, 0);
      swimBob = Math.sin(TAU * c * 2) * leg * 0.015;
      swimKick = Math.sin(at * 3 * TAU);
      break;
    }
    case "climb": {
      // escalade (paroi, échelle, filet) : la main droite et le pied gauche montent ensemble, puis l'inverse ; le
      // corps s'élève jusqu'à la prise visée (reachY) ou un mètre et demi, puis reste agrippé
      const ub = sk.bone("upperarm.r")!, fb = sk.bone("forearm.r")!;
      const reach = ub.head[1] + len(sub(ub.tail, ub.head)) + len(sub(fb.tail, fb.head));
      const top = st.reachY !== undefined ? Math.max(0, st.reachY - reach) : leg * 1.6;
      climbLift = Math.min(top, at * leg * 0.45);
      const going = climbLift < top - 1e-3 ? 1 : 0.25;
      climbPh = at * 0.8;
      for (const [s2, sg2, ph2] of [["r", -1, 0], ["l", 1, 0.5]] as const) {
        const u = (((climbPh + ph2) % 1) + 1) % 1;
        const up = going * (u < 0.5 ? Math.sin(u * TAU) : 0);
        aimDir(over, s2, [sg2 * 0.3, 1, 0.45 - 0.15 * up], 30 + 40 * (1 - up), 20, 60);
        over[`clavicle.${s2}`] = qAxis([0, 0, 1], sg2 * (14 + 8 * up) * DEG);
      }
      over.spine = qEuler(-8 * DEG, 0, 0);
      over.head = qEuler(-14 * DEG, 0, 0);
      break;
    }
    case "hang": {
      // pendu à une barre (une branche, une corniche) : bras tendus au-dessus de la tête, épaules montées, corps qui se
      // balance doucement, jambes pendantes ; avec reachY (hauteur de la prise), les mains s'y posent
      const sw = Math.sin(at * 1.1 * TAU);
      for (const [s, sgn] of [["r", -1], ["l", 1]] as const) {
        aimDir(over, s, [sgn * 0.16, 1, 0.08 + 0.05 * sw], 8, 0, 70);
        over[`clavicle.${s}`] = qAxis([0, 0, 1], sgn * 22 * DEG);
        over[`hand.${s}`] = qAxis([1, 0, 0], -10 * DEG);
      }
      over.spine = qEuler(-3 * sw * DEG, 0, 0);
      over.head = qEuler(-6 * DEG, 0, 0);
      const ub = sk.bone("upperarm.r")!, fb = sk.bone("forearm.r")!, hb = sk.bone("hand.r")!;
      const reach = ub.head[1] + len(sub(ub.tail, ub.head)) + len(sub(fb.tail, fb.head)) + len(sub(hb.tail, hb.head)) * 0.5;
      hangLift = st.reachY !== undefined ? Math.max(0, st.reachY - reach) : leg * 0.35;
      hangSwing = sw;
      break;
    }
    case "wave":
      // salut de la main : bras sur le côté, coude à hauteur d'épaule et plié, avant-bras dressé (vrillé de 80° autour
      // de l'humérus pour que la flexion monte au lieu d'avancer) qui balance de gauche à droite ; jamais bras tendu
      raiseArm("r", 105, 80, 92 + 22 * Math.sin(at * 8));
      over.head = qEuler(-4 * DEG, -8 * DEG, 4 * DEG);
      break;
    case "point":
      // montrer : bras tendu devant, en diagonale vers la cible (jamais à l'horizontale sur le côté)
      aimArm(over, "r", 78, 22, 6, 0);
      over.head = qEuler(0, -6 * DEG, 0);
      break;
    case "cheer": {
      // hourra : bras en V bien ouvert (35-40° de la verticale), un peu devant le plan du corps, coudes à peine
      // pliés vers l'avant, poings face avant. Les poings « poussent » vers le ciel (2 coups par seconde) : le bras
      // s'ouvre et se tend en haut, se replie un peu à la descente ; l'épaule monte un peu (omoplate), jamais
      // jusqu'aux oreilles. Poitrine ouverte, tête en arrière avec un temps de retard ; bras gauche décalé.
      for (const [s, sgn, ph] of [["r", -1, 0], ["l", 1, 0.12]] as const) {
        const p = 0.5 - 0.5 * Math.cos((at * 2 - ph) * TAU);
        const a = (27 + 5 * p) * DEG;
        // rythme scapulo-huméral : bras levé au-dessus de la tête, la clavicule s'élève d'une vingtaine de degrés et
        // emporte l'épaule (le moignon suit le bras au lieu de rester à l'horizontale, coude « cassé » à hauteur
        // d'épaule). La direction du bras est donnée dans le repère du buste : on retire l'élévation de la clavicule.
        const cq = qAxis([0, 0, 1], sgn * (17 + 6 * p) * DEG);
        over[`clavicle.${s}`] = cq;
        // bras nettement devant le plan du corps (sans cela ils partent en arrière), coude presque tendu : le repos
        // en A plie déjà l'avant-bras d'une quinzaine de degrés vers l'avant ; poings paume vers l'avant
        const dir = qRot(qConj(cq), [sgn * Math.sin(a), Math.cos(a), 0.3 - 0.06 * p]);
        aimDir(over, s, dir, -9 + 10 * (1 - p), 0, 20);
      }
      const pl = 0.5 - 0.5 * Math.cos((at * 2 - 0.15) * TAU);
      over.chest = qEuler(-(2 + 3 * pl) * DEG, 0, 0);
      over.head = qEuler(-(8 + 4 * pl) * DEG, 0, 0);
      break;
    }
    case "talk": {
      // parole : avant-bras devant le ventre, paumes vers le haut, une main « ponctue » sur les syllabes fortes
      // (battements accélérés puis amortis), l'autre accompagne plus mollement ; le buste suit, la tête hoche
      const beat = (x: number) => { const u = ((x % 1) + 1) % 1; return u < 0.25 ? smoothstep(0, 0.25, u) : 1 - smoothstep(0.25, 1, u); };
      const g = beat(at * 1.3 + rnd(13)), h = beat(at * 0.9 + 0.4);
      aimArm(over, "r", 12 + 14 * g, 16 + 8 * g, 66 - 12 * g, 24 - 14 * g);
      aimArm(over, "l", 8 + 6 * h, 13, 58 - 8 * h, 22);
      over["hand.r"] = qAxis([1, 0, 0], -(12 + 10 * g) * DEG);
      over.chest = qEuler(-1.5 * g * DEG, 5 * Math.sin(at * 3.1 - 0.6) * DEG, 0);
      over.head = qEuler((3 * Math.sin(at * 5.3) - 2 * g) * DEG, 6 * Math.sin(at * 1.7) * DEG, 2 * Math.sin(at * 0.8) * DEG);
      break;
    }
    case "carry":
      raiseArm("r", 10, 45, 85);
      raiseArm("l", 10, 45, 85);
      break;
    case "think":
      // réfléchir : main au menton, l'autre avant-bras en travers du ventre soutient le coude
      reachArm(over, "r", add(face.chin, scale([0, -0.1, 0.25], face.R)));
      aimArm(over, "l", 14, 8, 98, 80);
      over["hand.r"] = qAxis([1, 0, 0], 25 * DEG);
      over.head = qEuler(8 * DEG, -10 * DEG, 6 * DEG);
      break;
    case "hammer": {
      // frappe : le bras droit monte puis s'abat (2 coups par seconde), regard sur l'ouvrage
      // montée lente (armé), frappe rapide, petit rebond : un coup toutes les 0,5 s
      const c = (at * 2) % 1;
      const k = c < 0.62 ? smoothstep(0, 0.62, c) : c < 0.76 ? 1 - ((c - 0.62) / 0.14) ** 2 : 0.08 * Math.sin(((c - 0.76) / 0.24) * Math.PI);
      // le bras monte devant (pas sur le côté), coude plié à l'armé, s'abat devant soi ; l'autre main tient l'ouvrage
      aimArm(over, "r", 45 + 85 * k, 14, 25 + 70 * k, 5);
      aimArm(over, "l", 32, 10, 70, 35);
      over.spine = qEuler((6 + 6 * (1 - k)) * DEG, 0, 0);
      over.chest = qEuler(-4 * k * DEG, 0, 0);
      over.head = qEuler(14 * DEG, 0, 0);
      // l'outil : manche qui sort du poing en avant (poignet cassé), tête dans le plan du geste, face de frappe en avant
      // de la rotation (vers le bas à l'impact, vers l'arrière à l'armé)
      aimItem(
        (f) => { const p = norm(cross([1, 0, 0], f)); return norm(add(f, scale(p, -0.35))); },
        (f) => { const p = norm(cross([1, 0, 0], f)); const hd = norm(add(f, scale(p, -0.35))); return cross([1, 0, 0], hd); },
        "x",
      );
      break;
    }
    case "sweep": {
      // balai, râteau : main gauche avancée plus bas (approchée, sans IK sur le manche), le buste va et vient
      const k = Math.sin(at * 1.4 * TAU);
      aimArm(over, "r", 30 + 10 * k, 12, 40, 25);
      aimArm(over, "l", 48 - 10 * k, 6, 62, 55);
      over.spine = qEuler(14 * DEG, 16 * k * DEG, 0);
      over.chest = qEuler(4 * DEG, 10 * k * DEG, 0);
      over.head = qEuler(12 * DEG, -6 * k * DEG, 0);
      break;
    }
    case "dig": {
      // bêcher : on se penche, on enfonce, on soulève (un cycle toutes les 1,1 s)
      const c = (at % 1.1) / 1.1, k = Math.sin(c * Math.PI);
      aimArm(over, "r", 40 + 30 * k, 12, 30 + 30 * (1 - k), 20);
      aimArm(over, "l", 55 + 20 * k, 8, 50, 45);
      over.spine = qEuler((18 + 16 * (1 - k)) * DEG, 0, 0);
      over.chest = qEuler(8 * DEG, 0, 0);
      over.head = qEuler(10 * DEG, 0, 0);
      break;
    }
    case "drink": {
      if (st.reachY !== undefined && st.reachY < info.hipY * 1.15) {
        // eau basse (bassin, fontaine, abreuvoir) : penché en avant, mains en coupe portées à la bouche
        const k = 0.5 + 0.5 * Math.sin(at * 1.6);
        const bend = clamp(1 - st.reachY / (info.hipY * 1.15), 0.3, 1);
        aimArm(over, "r", 55 + 25 * k, 12, 40 + 70 * k, 40);
        aimArm(over, "l", 55 + 25 * k, 12, 40 + 70 * k, 40);
        over.spine = qEuler((20 + 25 * bend) * DEG, 0, 0);
        over.chest = qEuler((10 + 10 * bend) * DEG, 0, 0);
        over.head = qEuler((14 - 10 * k) * DEG, 0, 0);
      } else {
        // gobelet (ou l'objet tenu) porté à la bouche, tête renversée à chaque gorgée (cycle de 2,4 s)
        const c = (at % 2.4) / 2.4;
        const k = Math.sin(clamp((c - 0.15) / 0.6, 0, 1) * Math.PI);
        // gobelet porté à la bouche : coude devant et un peu écarté, avant-bras qui remonte vers le visage
        const rest: V3 = add(sk.bone("upperarm.r")!.head, scale([0.17, -1.1, 0.75], face.ua));
        const cup: V3 = add(face.mouth, scale([0, -0.35, 0.6], face.R));
        reachArm(over, "r", [rest[0] + (cup[0] - rest[0]) * k, rest[1] + (cup[1] - rest[1]) * k, rest[2] + (cup[2] - rest[2]) * k]);
        over.head = qEuler(-18 * k * DEG, 0, 0);
        over.neck = qEuler(-8 * k * DEG, 0, 0);
      }
      break;
    }
    case "eat": {
      // une bouchée toutes les 2 s : la main droite monte à la bouche, la gauche tient l'assiette, on mâche
      const c = (at % 2) / 2;
      const k = Math.sin(clamp(c / 0.45, 0, 1) * Math.PI);
      // la main droite monte à la bouche devant le visage, la gauche tient l'assiette devant le ventre
      const plate: V3 = add(sk.bone("upperarm.r")!.head, scale([0.3, -1.0, 0.8], face.ua));
      const bite: V3 = add(face.mouth, scale([0, -0.1, 0.35], face.R));
      reachArm(over, "r", [plate[0] + (bite[0] - plate[0]) * k, plate[1] + (bite[1] - plate[1]) * k, plate[2] + (bite[2] - plate[2]) * k]);
      aimArm(over, "l", 22, 10, 82, 40);
      over.head = qEuler((8 - 6 * k + (c > 0.45 ? 2.5 * Math.sin(at * 11) : 0)) * DEG, 0, 0);
      break;
    }
    case "sleep": {
      // assoupi (assis, ou par terre) : tête tombée sur la poitrine, épaules affaissées, mains sur les cuisses
      const br = Math.sin(t * 1.3);
      raiseArm("r", 8, 32, 58);
      raiseArm("l", 8, 32, 58);
      over.chest = qEuler((12 + br) * DEG, 0, 0);
      over.neck = qEuler(18 * DEG, 0, 0);
      over.head = qEuler(26 * DEG, 0, 10 * DEG);
      break;
    }
    case "drive":
      // mains au volant (ou aux rênes du cocher) : bras tendus devant, coudes un peu pliés
      raiseArm("r", 16, 58, 42);
      raiseArm("l", 16, 58, 42);
      over.spine = qEuler(-4 * DEG, 0, 0);
      break;
    case "ride": {
      // à califourchon : mains basses devant (rênes, guidon), buste un peu penché
      raiseArm("r", 14, 42, 55);
      raiseArm("l", 14, 42, 55);
      over.spine = qEuler(10 * DEG, 0, 0);
      break;
    }
    case "row": {
      // ramer : les mains tirent vers la poitrine, le buste bascule en arrière (un coup toutes les 2 s)
      const k = 0.5 + 0.5 * Math.sin(at * Math.PI);
      raiseArm("r", 22, 30 + 45 * (1 - k), 30 + 80 * k);
      raiseArm("l", 22, 30 + 45 * (1 - k), 30 + 80 * k);
      over.spine = qEuler((18 - 30 * k) * DEG, 0, 0);
      break;
    }
    case "bow": {
      const k = Math.sin(clamp(at / 1.2, 0, 1) * Math.PI);
      over.spine = qEuler(35 * k * DEG, 0, 0);
      over.chest = qEuler(15 * k * DEG, 0, 0);
      break;
    }
  }
  // gestes qui vont au visage (et grosses têtes) : cible plus stable, la main ne doit pas entrer dans la tête
  const faceAct = st.action === "eat" || st.action === "drink" || st.action === "think" || st.action === "comb" || st.action === "archery" || st.action === "wave";
  const bigHead = (sk.bone("head")?.radius[0] ?? 0) > len(sub(sk.bone("upperarm.r")!.tail, sk.bone("upperarm.r")!.head)) * 0.75;
  const varK = (faceAct ? 0.35 : 1) * (bigHead ? 0.5 : 1);
  // pas de bloc qui bascule d'un coup : le tronc part d'abord, puis le bras, l'avant-bras et la main (enchaînement)
  const LAG: Record<string, number> = { spine: 0, chest: 0.05, clavicle: 0.08, upperarm: 0.12, neck: 0.12, head: 0.2, forearm: 0.24, hand: 0.32 };
  for (const [k, q] of Object.entries(over)) {
    const d = LAG[k.split(".")[0]] ?? 0;
    const wb = d > 0 && w < 1 ? smoothstep(0, 1, clamp((w - d) / (1 - d), 0, 1)) : w;
    // ampleur du geste qui change d'un cycle à l'autre (±18 %), autrement pour le tronc, les bras et la tête
    const part = k.split(".")[0];
    // positions visées variables : l'écart à la pose d'équilibre (base) change d'ampleur (±20 %) et dévie un peu
    // (jusqu'à 15 % de cet écart) d'un cycle à l'autre ; près de l'équilibre, presque rien ne bouge
    const base = rot[k] ?? qId();
    const ph = part === "spine" || part === "chest" ? 0 : part === "head" || part === "neck" ? 3.1 : k.endsWith(".l") ? 5.7 : 8.3;
    const gain = 1 + 0.4 * varK * nz(at * 0.5 + ph, 23);
    const dq = qMul(qConj(base), q);
    const ang = 2 * Math.acos(Math.min(1, Math.abs(dq[3])));
    const dev = ang * 0.15 * varK;
    const off = qEuler(dev * 2 * nz(at * 0.5 + ph, 29), dev * 2 * nz(at * 0.5 + ph, 31), dev * 2 * nz(at * 0.5 + ph, 37));
    rot[k] = qSlerp(base, qMul(qSlerp(base, q, gain), off), wb);
  }

  // micro-variations lissées de chaque articulation du haut du corps (amplitude, orientation) : elles se superposent
  // à toutes les poses, au repos comme pendant un geste, et changent d'un personnage à l'autre
  const JIT: [string, number, number][] = [["spine", 1.5, 0.23], ["chest", 2, 0.31], ["neck", 1.5, 0.27], ["head", 3.5, 0.37], ["clavicle", 1.5, 0.29], ["upperarm", 3.5, 0.41], ["forearm", 3, 0.47], ["hand", 5, 0.53]];
  const jk = 0.6 + 0.6 * w;
  for (const [b, amp, fq] of JIT)
    for (const n of b === "spine" || b === "chest" || b === "neck" || b === "head" ? [b] : [`${b}.l`, `${b}.r`]) {
      const ki = n.length * 13 + n.charCodeAt(n.length - 1);
      const a = amp * jk * DEG;
      const j = qEuler(a * nz(t * fq, ki), a * nz(t * fq * 1.13, ki + 1), a * nz(t * fq * 0.87, ki + 2));
      rot[n] = qMul(rot[n] ?? qId(), j);
    }
  /* ---------- jambes : IK ---------- */
  const seated = st.action === "drive" || st.action === "ride" || st.action === "row";
  const sit = st.action === "sit" || st.action === "sleep" || seated ? (seated ? 1 : w) : 0;
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
  let drop = crouch + jumpCrouch + sit * (info.hipY - seatTop) + stanceDrop * w;
  // squelette de repos aux genoux un peu pliés : le bassin remonte pour que la jambe d'appui soit vraiment tendue
  // (sinon tout le monde se tient accroupi, genoux à 20°)
  const standLift = Math.max(0, leg * 0.999 - (info.hipY - info.ankleY)) * (1 - sit);
  const bob0 = bob + standLift;
  const hangY = hangLift * w;
  const climbY = climbLift * w;
  const pelvisOffset: V3 = [sway, bob0 - drop + jumpY + hangY + climbY, hangSwing * leg * 0.04 * w];
  const beta = mix(0.62, 0.38, run);
  const lift = leg * mix(0.075, 0.2, run) * Math.min(1, vn * 1.3) * moving;
  const feetLocal: Record<"l" | "r", { p: V3; pitch: number; planted: boolean }> = { l: { p: [0, 0, 0], pitch: 0, planted: true }, r: { p: [0, 0, 0], pitch: 0, planted: true } };
  for (const [s, off] of [["l", 0], ["r", 0.5]] as const) {
    const sx = s === "l" ? info.hipX * 0.9 : -info.hipX * 0.9;
    const u = (((phi + off) % 1) + 1) % 1;
    let z: number, y: number, pitch: number;
    if (u < beta) {
      // appui centré sur le double appui : le talon attaque autant devant que l'autre pied pousse derrière
      z = stride * (beta / 2 - u) - stride * (beta - 0.5) * 0.5;
      y = 0;
      const heel = 1 - smoothstep(0, 0.12, u);
      const toeOff = smoothstep(beta - 0.22, beta, u);
      pitch = (heel * -12 + toeOff * 28) * moving;
    } else {
      const sw = (u - beta) / (1 - beta);
      const e = sw * sw * (3 - 2 * sw);
      z = stride * (-beta / 2 + beta * e) - stride * (beta - 0.5) * 0.5;
      y = lift * Math.sin(Math.PI * sw) ** 1.2;
      pitch = mix(28, -14, smoothstep(0, 0.85, sw)) * moving;
    }
    z *= moving;
    feetLocal[s] = { p: [sx + sway * 0.2, y, z + info.footLen * 0.05], pitch, planted: u < beta || moving < 0.05 };
    if (sit > 0) feetLocal[s].p = [sx * 1.15, 0, mix(feetLocal[s].p[2], info.thigh * 0.95, sit)];
    // véhicule, monture : pieds au plancher, dans le vide de part et d'autre, ou sur les pédales
    const sf = sit > 0 ? st.seatFoot : undefined;
    if (sf) {
      const sg = s === "l" ? 1 : -1;
      const a = (sf.pedal ?? 0) * Math.PI * 2 + (s === "l" ? 0 : Math.PI);
      const r = sf.pedal !== undefined ? sf.r ?? 0.17 : 0;
      feetLocal[s] = { p: [sg * sf.spread, sf.y + Math.sin(a) * r, sf.fwd + Math.cos(a) * r], pitch: 0, planted: true };
    }
    // posture de l'action (garde, fente, profil) : pieds écartés et décalés, à l'arrêt seulement
    if (stance) {
      const o = stance[s], k = w * (1 - moving);
      feetLocal[s].p = [feetLocal[s].p[0] + o[0] * leg * k, feetLocal[s].p[1] + o[1] * leg * k, feetLocal[s].p[2] + o[2] * leg * k];
    }
    if (footOff) {
      const o = footOff[s];
      feetLocal[s].p = [feetLocal[s].p[0] + o[0] * w, feetLocal[s].p[1] + o[1] * w, feetLocal[s].p[2] + o[2] * w];
      if (o[1] > 1e-3) feetLocal[s].planted = false;
    }
    // escalade : pieds sur la paroi devant soi, qui montent en alternance avec la main opposée
    if (climbY > 0) {
      const u = (((climbPh + (s === "l" ? 0 : 0.5)) % 1) + 1) % 1;
      const up = u < 0.5 ? Math.sin(u * TAU) : 0;
      feetLocal[s] = { p: [feetLocal[s].p[0] * 0.9, climbY + leg * (0.08 + 0.3 * up), leg * 0.3], pitch: -10, planted: false };
    }
    if (kickFoot && s === "r") feetLocal[s] = { p: kickFoot.p.map((x) => x * w) as V3, pitch: kickFoot.pitch * w, planted: false };
    // suspendu : pieds dans le vide, pointes vers le bas, jambes qui suivent le balancement avec retard
    if (hangY > 0) {
      const sw2 = hangSwing * leg * 0.08;
      feetLocal[s] = { p: [feetLocal[s].p[0] * 0.8, hangY + leg * 0.02, -sw2 + (s === "l" ? 0.04 : -0.02) * leg], pitch: 35, planted: false };
    }
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
  for (let pass = 0; pass < (swimK > 0 ? 0 : 2); pass++) {
    pose = { rot, root: toWorld([pelvisOffset[0], pelvisOffset[1], pelvisOffset[2]]), rootRot: yawQ };
    const W = sk.world(pose);
    const Wq = sk.worldQuats(W);
    let worst = 1;
    let need = 0;
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
      // abaissement juste suffisant pour que la jambe atteigne sa cible presque tendue (genou jamais verrouillé)
      // la jambe qui frappe ne fait pas descendre le bassin (elle est hors d'atteinte par moments, c'est voulu)
      if (!(kickFoot && s === "r")) {
        const Lr = (info.thigh + info.shin) * 0.9985;
        const hd = Math.hypot(hip[0] - ankleTarget[0], hip[2] - ankleTarget[2]);
        need = Math.max(need, hip[1] - ankleTarget[1] - Math.sqrt(Math.max(0, Lr * Lr - hd * hd)));
      }
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
      drop += Math.max(need, 0) + leg * 0.001;
      pelvisOffset[1] = bob0 - drop + jumpY;
    } else if (pass === 0) break;
  }
  // garde-fou bras / tête / cuisses, une fois les jambes posées (la cuisse qui avance compte)
  clearHead(sk, rot, st.action === "eat" || st.action === "drink" || st.action === "think" || st.action === "sleep" || st.action === "comb" || st.action === "archery");
  if (itemAim) {
    // objet tenu orienté : le poignet tourne pour que le manche suive la direction voulue (repère de l'acteur), une fois
    // le bras posé (micro-variations comprises). Axe du manche au repos : celui de la prise posée par `character`
    const a36 = -36 * DEG;
    const g0 = norm([0, 0.944, 0.33]);
    const norm4 = (q: Q): Q => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
    const grip: V3 = [g0[0] * Math.cos(a36) - g0[1] * Math.sin(a36), g0[0] * Math.sin(a36) + g0[1] * Math.cos(a36), g0[2]];
    const Wq = sk.worldQuats(sk.world({ rot: { ...rot, "hand.r": qId() }, root: [0, 0, 0], rootRot: qId() }));
    const fq = Wq[sk.index["forearm.r"]];
    const aim = itemAim as { axis: AimDir; ref?: AimDir; refAxis?: "x" | "z" };
    const fa = qRot(fq, sk.axis[sk.index["forearm.r"]]);
    const dirOf = (d: AimDir) => (typeof d === "function" ? d(fa) : d);
    const dirB = dirOf(aim.axis);
    // avec une direction de tête (marteau, hache) ou de face (arc) : l'objet entier est orienté, pas seulement son
    // manche (sinon il tourne librement autour, tête de travers, arc vu de profil)
    const mount = qFromTo([0, 1, 0], grip);
    const h = aim.ref
      ? qFromBasis(grip, qRot(mount, aim.refAxis === "z" ? [0, 0, 1] : [1, 0, 0]), qRot(qConj(fq), norm(dirB)), qRot(qConj(fq), norm(dirOf(aim.ref))))
      : qFromTo(grip, qRot(qConj(fq), norm(dirB)));
    // le poignet tourne peu sur son axe : la part de rotation autour de l'avant-bras passe dans la pronation
    // (l'avant-bras tourne sur lui-même, dans ses limites), le poignet ne garde que la flexion
    const fi = sk.index["forearm.r"], ax = sk.axis[fi];
    const pr = dot([h[0], h[1], h[2]], ax);
    const tw = norm4([ax[0] * pr, ax[1] * pr, ax[2] * pr, h[3]]);
    const f0 = rot["forearm.r"] ?? qId();
    const f1 = sk.limit(fi, qMul(f0, tw));
    const T = qMul(qConj(f0), f1);
    rot["forearm.r"] = qSlerp(f0, f1, w);
    rot["hand.r"] = qSlerp(rot["hand.r"] ?? qId(), qMul(qConj(T), h), w);
  }

  if (swimK > 0) {
    // nage : le corps bascule à l'horizontale autour du bassin, posé à la surface (l'appelant met l'acteur au niveau
    // de l'eau) ; jambes tendues qui battent, pointes allongées
    const th = 82 * DEG * w;
    const sY = -leg * 0.06 + swimBob;
    pelvisOffset[0] = 0;
    pelvisOffset[1] = sY - info.hipY * Math.cos(th) + (1 - w) * info.hipY;
    pelvisOffset[2] = -info.hipY * Math.sin(th);
    for (const [s2, sg2] of [["l", 1], ["r", -1]] as const) {
      rot[`thigh.${s2}`] = qSlerp(rot[`thigh.${s2}`] ?? qId(), qAxis([1, 0, 0], (12 * sg2 * swimKick - 4) * DEG), w);
      rot[`shin.${s2}`] = qSlerp(rot[`shin.${s2}`] ?? qId(), hinge(sk, `shin.${s2}`, -(12 + 8 * Math.max(0, sg2 * swimKick))), w);
      rot[`foot.${s2}`] = qSlerp(rot[`foot.${s2}`] ?? qId(), qAxis([1, 0, 0], 50 * DEG), w);
    }
    pose = { rot, root: toWorld(pelvisOffset), rootRot: qMul(yawQ, qAxis([1, 0, 0], th)) };
    return { pose, feet: { l: toWorld(feetLocal.l.p), r: toWorld(feetLocal.r.p) } };
  }
  pose = { rot, root: toWorld(pelvisOffset), rootRot: yawQ };
  return { pose, feet: { l: toWorld(feetLocal.l.p), r: toWorld(feetLocal.r.p) } };
}
