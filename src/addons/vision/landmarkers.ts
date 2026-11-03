/** Conversion des résultats MediaPipe bruts (`MpResult`) en visages et corps. */
import type { RawFace } from "../../shared/ml/face";
import type { PosePoint, RawPose } from "../../shared/ml/pose";
import type { MpResult } from "./mp-engine";

type P = { x: number; y: number; z: number; visibility?: number };

export function facesFromMediaPipe(result: MpResult): RawFace[] {
  const out: RawFace[] = [];
  const faces = result.faceLandmarks ?? [];
  for (let i = 0; i < faces.length; i++) {
    const lm = faces[i];
    if (!lm || lm.length < 468) continue; // 468 points, +10 pour l'iris
    const blendshapes: Record<string, number> = {};
    for (const c of result.faceBlendshapes?.[i]?.categories ?? []) {
      if (c.categoryName && typeof c.score === "number") blendshapes[c.categoryName] = c.score;
    }
    out.push({ landmarks: (lm as P[]).map((p) => ({ x: p.x, y: p.y, z: p.z })), blendshapes });
  }
  return out;
}

export function posesFromMediaPipe(result: MpResult): RawPose[] {
  const out: RawPose[] = [];
  const poses = result.landmarks ?? [];
  for (let i = 0; i < poses.length; i++) {
    const lm = poses[i];
    if (!lm || lm.length < 33) continue;
    const landmarks: PosePoint[] = (lm as P[]).map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 1 }));
    const w = result.worldLandmarks?.[i] as P[] | undefined;
    out.push({ landmarks, world: w?.map((p) => ({ x: p.x, y: p.y, z: p.z })) });
  }
  return out;
}
