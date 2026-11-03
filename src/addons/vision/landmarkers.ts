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

export type RawDetection = { label: string; score: number; x: number; y: number; w: number; h: number };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Détections MediaPipe (boîtes en pixels) → boîtes normalisées 0..1, triées par score décroissant. */
export function detectionsFromMediaPipe(result: MpResult, minScore = 0): RawDetection[] {
  const size = result.size;
  if (!size || size.width <= 0 || size.height <= 0) return [];
  const out: RawDetection[] = [];
  for (const d of result.detections ?? []) {
    const b = d.boundingBox;
    const cat = d.categories?.[0];
    if (!b || !cat) continue;
    const score = cat.score ?? 0;
    if (score < minScore) continue;
    const x = clamp01(b.originX / size.width);
    const y = clamp01(b.originY / size.height);
    out.push({
      label: cat.categoryName ?? cat.displayName ?? "",
      score,
      x,
      y,
      w: clamp01((b.originX + b.width) / size.width) - x,
      h: clamp01((b.originY + b.height) / size.height) - y,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}
