/**
 * Adaptateur d'animation : un seul point d'entrée pour la vue, quel que soit le squelette.
 *
 * `motionFor(asset)` → `{ kind, info, pose(state, rootPos?, rootYaw?) }` : humanoïde via `humanoidPose`, animal via
 * `animalPose`. `stepLengthFor(asset, vitesse)` donne le « pas » (demi-cycle) : la phase s'intègre toujours par
 * `phase += Δdistance / (2 · stepLengthFor(asset, vitesse))`.
 */
import type { V3 } from "../core/math";
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
