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
  // contrapposto au repos : le poids passe d'une jambe à l'autre toutes les 7 à 12 s (maintien, puis bascule
  // lente) ; bassin décalé au-dessus de la jambe d'appui, hanche libre qui descend, épaules en sens inverse
  const still = (1 - moving) * (["sit", "sleep", "drive", "ride", "row", "jump", "kick", "bow"].includes(st.action) ? 1 - clamp(st.actionWeight, 0, 1) : 1);
  const ws = still * Math.tanh(2.6 * Math.sin((t * TAU) / (7 + rnd(4) * 5) + rnd(5) * 6)) * (0.7 + 0.3 * rnd(6));
  const hipRoll = 3.2 * DEG * ws;
  const sway = leg * 0.018 * Math.sin(TAU * phi) * moving * (1 - run * 0.6) + idleSway + leg * 0.022 * ws;
  const lean = (m.lean + mix(3, 13, run) * moving * Math.min(1, vn * 1.5) + 2 * (1 - moving)) * DEG;
  const turnLean = clamp(st.turn * v * 0.15, -0.3, 0.3);
  rot.pelvis = qMul(qEuler(lean * 0.4, pelvisYaw + 3 * DEG * ws, pelvisRoll + turnLean + hipRoll), qId());
  rot.spine = qEuler(lean * 0.35 + m.chest * 0.5 * DEG + breathe * 0.6 * DEG, -pelvisYaw * 0.5 - 1.5 * DEG * ws, -pelvisRoll * 0.5 - hipRoll * 0.9);
  rot.chest = qEuler(lean * 0.25 + m.chest * 0.5 * DEG + breathe * 1.2 * DEG, -pelvisYaw * 0.9 - 1.5 * DEG * ws, -pelvisRoll * 0.4 - hipRoll * 0.7);
  // tête stabilisée : annule le lacet du buste et l'inclinaison
  const look = 6 * DEG * Math.sin(t * 0.37 + rnd(3) * 9) * (1 - moving * 0.7);
  // la tête amortit le pas (léger retard sur le rebond du bassin) et penche un peu du côté de la hanche d'appui
  const nod = moving * 1.6 * DEG * Math.cos(TAU * 2 * (phi - 0.08)) * m.bob;
  rot.neck = qEuler(-lean * 0.3 + m.head * 0.4 * DEG + nod * 0.4, pelvisYaw * 0.3 + look * 0.4, hipRoll * 0.4);
  rot.head = qEuler(-lean * 0.35 + m.head * 0.6 * DEG + Math.sin(t * 1.3) * 0.6 * DEG * (1 - moving) + nod * 0.6, pelvisYaw * 0.3 + look * 0.6, hipRoll * 0.5 + 2 * DEG * still * Math.sin(t * 0.29 + rnd(7) * 6));

  /* ---------- bras ---------- */
  const armAmp = mix(18, 42, run) * Math.min(1, 0.35 + vn) * moving * amp + 3 * (1 - moving);
  const elbow = mix(8, 78, run) * moving + 10 + 4 * breathe * (1 - moving);
  for (const [s, sg] of [["l", 1], ["r", -1]] as const) {
    const swing = sg * -armAmp * Math.cos(TAU * phi) + (1 - moving) * 1.5 * Math.sin(t * 0.8 + sg);
    // l'avant-bras et la main suivent le bras avec retard (fouet) : la flexion du coude culmine après le balancier
    const lag = sg * -armAmp * Math.cos(TAU * (phi - 0.1));
    // côté de la hanche d'appui : bras un peu plus écarté (la hanche le repousse), l'autre pend plus près
    const side = sg * ws;
    const adduct = qAxis([0, 0, 1], -sg * (36 - m.shoulders * 0.5 + run * 4 - 3 * side + 2.5 * (rnd(8 + sg) - 0.5)) * DEG);
    const flex = qAxis([1, 0, 0], -swing * DEG);
    // omoplate : légère protraction quand le bras passe devant, respiration qui soulève les épaules
    rot[`clavicle.${s}`] = qMul(qAxis([0, 1, 0], sg * swing * 0.12 * DEG), qAxis([0, 0, 1], sg * (m.shoulders * 0.6 + breathe * 0.5) * DEG));
    rot[`upperarm.${s}`] = qMul(flex, adduct);
    rot[`forearm.${s}`] = hinge(sk, `forearm.${s}`, elbow + Math.max(0, lag) * 0.35 + 3 * (rnd(10 + sg) - 0.5) - 2 * side);
    rot[`hand.${s}`] = qMul(qAxis([1, 0, 0], (-6 + 0.25 * (swing - lag)) * DEG), qAxis([0, 0, 1], sg * 4 * DEG));
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
      raiseArm("r", 50, 80, 4);
      over.head = qEuler(0, -6 * DEG, 0);
      break;
    case "cheer": {
      // hourra : bras levés en V, à peine devant le plan du corps, coudes presque tendus, poings serrés. Les poings
      // « poussent » vers le ciel (2 coups par seconde) : le coude se tend en haut et se replie un peu à la descente,
      // la poitrine s'ouvre et la tête part en arrière avec un temps de retard ; bras gauche décalé d'un rien.
      for (const [s, ph] of [["r", 0], ["l", 0.12]] as const) {
        const p = 0.5 - 0.5 * Math.cos((at * 2 - ph) * TAU);
        raiseArm(s, 150 + 10 * p, -4, 6 + 14 * (1 - p));
      }
      const pl = 0.5 - 0.5 * Math.cos((at * 2 - 0.15) * TAU);
      over.chest = qEuler(-(5 + 4 * pl) * DEG, 0, 0);
      over.head = qEuler(-(10 + 5 * pl) * DEG, 0, 0);
      break;
    }
    case "talk": {
      const g = Math.sin(at * 3.1);
      raiseArm("r", 20, 35 + 15 * g, 70 + 15 * Math.sin(at * 4.3));
      raiseArm("l", 15, 20 - 10 * g, 55);
      // le buste accompagne le geste (rotation en léger retard), la tête ponctue
      over.chest = qEuler(0, 5 * Math.sin(at * 3.1 - 0.6) * DEG, 0);
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
      // montée lente (armé), frappe rapide, petit rebond : un coup toutes les 0,5 s
      const c = (at * 2) % 1;
      const k = c < 0.62 ? smoothstep(0, 0.62, c) : c < 0.76 ? 1 - ((c - 0.62) / 0.14) ** 2 : 0.08 * Math.sin(((c - 0.76) / 0.24) * Math.PI);
      raiseArm("r", 22, 35 + 75 * k, 25 + 75 * k);
      raiseArm("l", 14, 30, 70);
      over.spine = qEuler((6 + 6 * (1 - k)) * DEG, 0, 0);
      over.chest = qEuler(-4 * k * DEG, 0, 0);
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
    case "drink": {
      if (st.reachY !== undefined && st.reachY < info.hipY * 1.15) {
        // eau basse (bassin, fontaine, abreuvoir) : penché en avant, mains en coupe portées à la bouche
        const k = 0.5 + 0.5 * Math.sin(at * 1.6);
        const bend = clamp(1 - st.reachY / (info.hipY * 1.15), 0.3, 1);
        raiseArm("r", 14, 55 + 25 * k, 40 + 70 * k);
        raiseArm("l", 14, 55 + 25 * k, 40 + 70 * k);
        over.spine = qEuler((20 + 25 * bend) * DEG, 0, 0);
        over.chest = qEuler((10 + 10 * bend) * DEG, 0, 0);
        over.head = qEuler((14 - 10 * k) * DEG, 0, 0);
      } else {
        // gobelet (ou l'objet tenu) porté à la bouche, tête renversée à chaque gorgée (cycle de 2,4 s)
        const c = (at % 2.4) / 2.4;
        const k = Math.sin(clamp((c - 0.15) / 0.6, 0, 1) * Math.PI);
        raiseArm("r", 16, 40 + 25 * k, 95 + 45 * k);
        raiseArm("l", 10, 12, 20);
        over.head = qEuler(-18 * k * DEG, 0, 0);
        over.neck = qEuler(-8 * k * DEG, 0, 0);
      }
      break;
    }
    case "eat": {
      // une bouchée toutes les 2 s : la main droite monte à la bouche, la gauche tient l'assiette, on mâche
      const c = (at % 2) / 2;
      const k = Math.sin(clamp(c / 0.45, 0, 1) * Math.PI);
      raiseArm("r", 16, 30 + 30 * k, 70 + 70 * k);
      raiseArm("l", 12, 42, 85);
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
