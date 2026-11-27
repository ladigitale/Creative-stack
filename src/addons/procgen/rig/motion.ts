/**
 * Adaptateur d'animation : un seul point d'entrée pour la vue, quel que soit le squelette.
 *
 * `motionFor(asset)` → `{ kind, info, pose(state, rootPos?, rootYaw?) }` : humanoïde via `humanoidPose`, animal via
 * `animalPose`. `stepLengthFor(asset, vitesse)` donne le « pas » (demi-cycle) : la phase s'intègre toujours par
 * `phase += Δdistance / (2 · stepLengthFor(asset, vitesse))`.
 */
import { type Q, type V3, qConj, qId, qMul } from "../core/math";
import type { Asset } from "../gen/types";
import { type MotionState, type RigInfo, humanoidPose, rigInfo, stepLength } from "./locomotion";
import { type AnimalInfo, animalInfo, animalPose, animalStepLength } from "./quadruped-motion";
import { AnimalSkeleton } from "./quadruped";
import type { Pose } from "./skeleton";

export type Motion =
  | { kind: "humanoid"; info: RigInfo; pose(state: MotionState, rootPos?: V3, rootYaw?: number): { pose: Pose }; stepLength(speed: number): number; legLength: number }
  | { kind: "animal"; info: AnimalInfo; pose(state: MotionState, rootPos?: V3, rootYaw?: number): { pose: Pose }; stepLength(speed: number): number; legLength: number };

const memo = new WeakMap<object, Motion>();

export function isAnimal(asset: Pick<Asset, "skeleton" | "generator">): boolean {
  return asset.skeleton instanceof AnimalSkeleton || asset.generator === "animal";
}

export function motionFor(asset: Pick<Asset, "skeleton" | "generator">): Motion {
  const sk = asset.skeleton;
  if (!sk) throw new Error("motionFor : asset sans squelette");
  const hit = memo.get(sk);
  if (hit) return hit;
  let m: Motion;
  if (isAnimal(asset)) {
    const info = animalInfo(sk);
    m = {
      kind: "animal",
      info,
      // `MotionState` de l'humanoïde est un sur-ensemble de l'état animal (action ignorée)
      pose: (st, rootPos, rootYaw) => animalPose(sk, info, st, rootPos, rootYaw),
      stepLength: (speed) => animalStepLength(info, speed),
      legLength: info.legLen,
    };
  } else {
    const info = rigInfo(sk);
    m = { kind: "humanoid", info, pose: (st, rootPos, rootYaw) => humanoidPose(sk, info, st, rootPos, rootYaw), stepLength: (speed) => stepLength(info, speed), legLength: info.thigh + info.shin };
  }
  memo.set(sk, m);
  return m;
}

export function stepLengthFor(asset: Pick<Asset, "skeleton" | "generator">, speed: number): number {
  return motionFor(asset).stepLength(speed);
}

/**
 * Fondu entre deux poses quand l'état d'animation change (action, assise…) : la nouvelle pose part de la dernière
 * pose affichée et la rejoint en `dur` secondes (courbe douce). Sans changement, la pose passe telle quelle.
 */
/* ---------- inertialisation : aucun saut de pose ---------- */

/** Rotation → vecteur (axe × angle), chemin le plus court. */
function qLog(q: Q): V3 {
  const w = q[3] < 0 ? -1 : 1;
  const x = q[0] * w, y = q[1] * w, z = q[2] * w, c = Math.min(1, q[3] * w);
  const s = Math.hypot(x, y, z);
  if (s < 1e-9) return [2 * x, 2 * y, 2 * z];
  const a = 2 * Math.atan2(s, c);
  return [(x / s) * a, (y / s) * a, (z / s) * a];
}
function qExp(v: V3): Q {
  const a = Math.hypot(v[0], v[1], v[2]);
  if (a < 1e-9) return [v[0] / 2, v[1] / 2, v[2] / 2, 1];
  const s = Math.sin(a / 2) / a;
  return [v[0] * s, v[1] * s, v[2] * s, Math.cos(a / 2)];
}
/** Ressort critique (amortisseur) : `x` et `v` ramenés vers 0 avec une demi-vie `h` (s). */
function damp(x: number[], v: number[], h: number, dt: number) {
  const y = (4 * 0.69314718) / (h + 1e-5) / 2;
  const e = Math.exp(-y * dt);
  for (let k = 0; k < x.length; k++) {
    const j1 = v[k] + x[k] * y;
    x[k] = e * (x[k] + j1 * dt);
    v[k] = e * (v[k] - j1 * y * dt);
  }
}

type Off = { x: number[]; v: number[] };

/**
 * Fondu de poses par **inertialisation** : quand la pose visée saute (changement d'action, d'humeur, de figure de
 * danse, coude qui bascule, acteur qui revient dans le champ), la pose affichée ne saute pas. L'écart entre ce qui
 * était affiché et la nouvelle pose devient un décalage par os qui s'éteint en douceur (ressort critique, demi-vie
 * ~0,09 s), en gardant la vitesse du mouvement en cours : ni arrêt figé, ni rattrapage brutal. Tant que la pose
 * visée est continue, elle passe telle quelle : les gestes rapides (frappe, lancer) gardent leur vivacité.
 *
 * Un os est jugé en saut quand sa rotation change d'un coup beaucoup plus que ne l'annonçait sa vitesse récente.
 */
export class PoseBlend {
  private prevTarget: Record<string, Q> = {};
  private prevStep: Record<string, number> = {};
  private prevOut: Record<string, Q> = {};
  private outVel: Record<string, V3> = {};
  private off = new Map<string, Off>();
  private rootOff: Off | null = null;
  private prevRoot: V3 | null = null;
  private prevRootOut: V3 | null = null;
  private rootVel: V3 = [0, 0, 0];
  private key: string | null = null;

  private half: number;
  /** `dur` : durée du raccord (s) ; le décalage s'éteint à ~94 % (quatre demi-vies). */
  constructor(dur = 0.36) {
    this.half = dur / 4;
  }

  apply(pose: Pose, key: string, dt: number): Pose {
    const keyChanged = this.key !== null && key !== this.key;
    this.key = key;
    const h = Math.max(1e-3, dt);
    const rot: Record<string, Q> = {};
    const names = new Set([...Object.keys(pose.rot), ...Object.keys(this.prevTarget)]);
    for (const n of names) {
      const tgt = pose.rot[n] ?? qId();
      const prevT = this.prevTarget[n];
      const step = prevT ? Math.hypot(...qLog(qMul(qConj(prevT), tgt))) : 0;
      const expected = this.prevStep[n] ?? 0;
      // saut : changement d'état, ou pas angulaire bien au-delà de la vitesse récente (et sensible en valeur)
      const jump = prevT && this.prevOut[n] && (keyChanged || (step > 0.1 && step > 2 * expected + 0.05));
      if (jump) {
        // pose affichée prolongée d'une image à sa vitesse actuelle ; le décalage la relie à la nouvelle cible
        const w = this.outVel[n] ?? [0, 0, 0];
        const cont = qMul(qExp([w[0] * dt, w[1] * dt, w[2] * dt]), this.prevOut[n]);
        const x = qLog(qMul(qConj(tgt), cont));
        // vitesse du décalage : celle de l'affiché moins celle (estimée) de la cible
        const o = this.off.get(n) ?? { x: [0, 0, 0], v: [0, 0, 0] };
        o.x = x;
        o.v = [0, 0, 0];
        this.off.set(n, o);
        this.prevStep[n] = expected;
      } else this.prevStep[n] = step;
      this.prevTarget[n] = tgt;
      let out = tgt;
      const o = this.off.get(n);
      if (o) {
        damp(o.x, o.v, this.half, dt);
        if (Math.hypot(o.x[0], o.x[1], o.x[2]) < 1e-4 && Math.hypot(o.v[0], o.v[1], o.v[2]) < 1e-3) this.off.delete(n);
        else out = qMul(tgt, qExp(o.x as V3));
      }
      const po = this.prevOut[n];
      if (po) {
        const d = qLog(qMul(out, qConj(po)));
        this.outVel[n] = [d[0] / h, d[1] / h, d[2] / h];
      }
      this.prevOut[n] = out;
      rot[n] = out;
    }
    // racine : même principe en translation
    let root = pose.root;
    if (this.prevRoot && this.prevRootOut) {
      const st = Math.hypot(root[0] - this.prevRoot[0], root[1] - this.prevRoot[1], root[2] - this.prevRoot[2]);
      if (keyChanged || st > 0.05 + 3 * Math.hypot(...this.rootVel) * dt) {
        const c: V3 = [this.prevRootOut[0] + this.rootVel[0] * dt, this.prevRootOut[1] + this.rootVel[1] * dt, this.prevRootOut[2] + this.rootVel[2] * dt];
        this.rootOff = { x: [c[0] - root[0], c[1] - root[1], c[2] - root[2]], v: [0, 0, 0] };
      }
    }
    this.prevRoot = root;
    if (this.rootOff) {
      damp(this.rootOff.x, this.rootOff.v, this.half, dt);
      const [x, y, z] = this.rootOff.x;
      if (Math.hypot(x, y, z) < 1e-5) this.rootOff = null;
      else root = [root[0] + x, root[1] + y, root[2] + z];
    }
    if (this.prevRootOut) this.rootVel = [(root[0] - this.prevRootOut[0]) / h, (root[1] - this.prevRootOut[1]) / h, (root[2] - this.prevRootOut[2]) / h];
    this.prevRootOut = root;
    return { ...pose, rot, root };
  }
}

/**
 * Cap affiché qui rejoint le cap logique sans à-coup : approche amortie, vitesse de rotation bornée (rad/s). Rend le
 * nouveau cap et la vitesse de rotation (pour l'inclinaison du virage et le piétinement sur place).
 */
export function turnToward(disp: number, target: number, dt: number, maxRate = 5): { yaw: number; rate: number } {
  let d = target - disp;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  if (dt <= 0) return { yaw: disp, rate: 0 };
  const k = 1 - Math.exp(-dt * 8);
  const step = Math.max(-maxRate * dt, Math.min(maxRate * dt, d * k));
  return { yaw: disp + step, rate: step / dt };
}
