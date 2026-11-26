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
import { type Q, type V3, DEG, add, clamp, cross, dot, len, mix, norm, qAxis, qConj, qEuler, qId, qMul, qRot, qSlerp, scale, smoothstep, sub } from "../core/math";
import { type Pose, Skeleton, qFromBasis } from "./skeleton";

export const ACTIONS = ["idle", "walk", "run", "wave", "point", "cheer", "talk", "carry", "sit", "jump", "think", "bow", "hammer", "sweep", "dig", "kick", "drink", "eat", "sleep"] as const;
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
  const rot: Record<string, Q> = {};

  /* ---------- bassin ---------- */
  const amp = m.amp;
  // la jambe d'appui, presque tendue, fait d'elle-même monter le bassin à mi-appui et descendre au double appui
  // (abaissement exact par IK) : le rebond ajouté ne fait plus qu'accentuer la course
  const bobAmp = leg * mix(0.006, 0.045, run) * Math.min(1, vn * 1.2) * m.bob * moving;
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
  const reachArm = (out: Record<string, Q>, s: "l" | "r", target: V3, poleOut = 0.6) => {
    const sg = s === "l" ? 1 : -1;
    const ub = sk.bone(`upperarm.${s}`)!, fb = sk.bone(`forearm.${s}`)!, hb = sk.bone(`hand.${s}`)!;
    const l1 = len(sub(ub.tail, ub.head)), l2 = len(sub(fb.tail, fb.head)) + len(sub(hb.tail, hb.head)) * 0.45;
    const ik = twoBoneIK(ub.head, target, l1, l2, norm([sg * poleOut, -1, -0.25]));
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
    return { R, ua: len(sub(ub.tail, ub.head)), mouth: add(hb.head, [0, hH * 0.3, R * 1.0]) as V3, chin: add(hb.head, [0, hH * 0.12, R * 0.85]) as V3 };
  })();
  const armAmp = mix(16, 40, run) * Math.min(1, 0.35 + vn) * moving * amp;
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
  const at = st.actionTime;
  const over: Record<string, Q> = {};
  // entrée d'un geste : le bras dépasse un peu sa cible puis s'y pose (0,6 s), plutôt qu'un arrêt sec
  const settle = at < 0.6 ? 1 + 0.08 * Math.sin((at / 0.6) * Math.PI) * (1 - at / 0.6) * 2 : 1;
  const raiseArm = (s: "l" | "r", abduct: number, forward: number, elbowDeg: number) => {
    const sg = s === "l" ? 1 : -1;
    const ab = 45 + (abduct - 45) * settle;
    over[`upperarm.${s}`] = qMul(qAxis([1, 0, 0], -forward * settle * DEG), qAxis([0, 0, 1], sg * (ab - 45) * DEG));
    over[`forearm.${s}`] = hinge(sk, `forearm.${s}`, elbowDeg);
    // au-delà de l'horizontale, l'omoplate tourne et l'épaule monte (rythme scapulo-huméral)
    over[`clavicle.${s}`] = qAxis([0, 0, 1], sg * (Math.max(0, ab - 60) * 0.16 + m.shoulders * 0.6) * DEG);
  };
  switch (st.action) {
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
  // pas de bloc qui bascule d'un coup : le tronc part d'abord, puis le bras, l'avant-bras et la main (enchaînement)
  const LAG: Record<string, number> = { spine: 0, chest: 0.05, clavicle: 0.08, upperarm: 0.12, neck: 0.12, head: 0.2, forearm: 0.24, hand: 0.32 };
  for (const [k, q] of Object.entries(over)) {
    const d = LAG[k.split(".")[0]] ?? 0;
    const wb = d > 0 && w < 1 ? smoothstep(0, 1, clamp((w - d) / (1 - d), 0, 1)) : w;
    rot[k] = qSlerp(rot[k] ?? qId(), q, wb);
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
  let drop = crouch + jumpCrouch + sit * (info.hipY - seatTop);
  // squelette de repos aux genoux un peu pliés : le bassin remonte pour que la jambe d'appui soit vraiment tendue
  // (sinon tout le monde se tient accroupi, genoux à 20°)
  const standLift = Math.max(0, leg * 0.999 - (info.hipY - info.ankleY)) * (1 - sit);
  const bob0 = bob + standLift;
  const pelvisOffset: V3 = [sway, bob0 - drop + jumpY, 0];
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
      {
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
  clearHead(sk, rot, st.action === "eat" || st.action === "drink" || st.action === "think" || st.action === "sleep");
  pose = { rot, root: toWorld(pelvisOffset), rootRot: yawQ };
  return { pose, feet: { l: toWorld(feetLocal.l.p), r: toWorld(feetLocal.r.p) } };
}
