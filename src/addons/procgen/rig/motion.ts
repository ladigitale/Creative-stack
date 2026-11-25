/**
 * Adaptateur d'animation : un seul point d'entrée pour la vue, quel que soit le squelette.
 *
 * `motionFor(asset)` → `{ kind, info, pose(state, rootPos?, rootYaw?) }` : humanoïde via `humanoidPose`, animal via
 * `animalPose`. `stepLengthFor(asset, vitesse)` donne le « pas » (demi-cycle) : la phase s'intègre toujours par
 * `phase += Δdistance / (2 · stepLengthFor(asset, vitesse))`.
 */
import { type Q, type V3, qId, qSlerp } from "../core/math";
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
export class PoseBlend {
  private last: Pose | null = null;
  private from: Pose | null = null;
  private t = 1;
  private key: string | null = null;

  constructor(private dur = 0.35) {}

  apply(pose: Pose, key: string, dt: number): Pose {
    if (this.key !== null && key !== this.key && this.last) {
      this.from = this.last;
      this.t = 0;
    }
    this.key = key;
    let out = pose;
    if (this.from && this.t < 1) {
      this.t = Math.min(1, this.t + Math.max(0, dt) / this.dur);
      const k = this.t * this.t * (3 - 2 * this.t);
      const f = this.from;
      const rot: Record<string, Q> = {};
      for (const n of new Set([...Object.keys(pose.rot), ...Object.keys(f.rot)])) rot[n] = qSlerp(f.rot[n] ?? qId(), pose.rot[n] ?? qId(), k);
      const r0 = f.root, r1 = pose.root;
      out = {
        ...pose,
        rot,
        root: [r0[0] + (r1[0] - r0[0]) * k, r0[1] + (r1[1] - r0[1]) * k, r0[2] + (r1[2] - r0[2]) * k],
        ...(pose.rootRot ? { rootRot: f.rootRot ? qSlerp(f.rootRot, pose.rootRot, k) : pose.rootRot } : {}),
      };
      if (this.t >= 1) this.from = null;
    }
    this.last = out;
    return out;
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
