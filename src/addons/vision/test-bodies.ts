import type { RawFace } from "../../shared/ml/face";
import type { Point } from "../../shared/ml/hands";
import { JOINT_NAMES, type PosePoint, type RawPose } from "../../shared/ml/pose";

/** Visage synthétique de face (pour les tests uniquement). */
export function fakeFace(cx = 0.5, cy = 0.5, blend: Record<string, number> = {}, noseDx = 0): RawFace {
  const lm: Point[] = Array.from({ length: 478 }, () => ({ x: cx, y: cy, z: 0 }));
  lm[234] = { x: cx - 0.15, y: cy, z: 0 };
  lm[454] = { x: cx + 0.15, y: cy, z: 0 };
  lm[33] = { x: cx - 0.11, y: cy - 0.06, z: 0 };
  lm[133] = { x: cx - 0.04, y: cy - 0.06, z: 0 };
  lm[263] = { x: cx + 0.11, y: cy - 0.06, z: 0 };
  lm[362] = { x: cx + 0.04, y: cy - 0.06, z: 0 };
  lm[1] = { x: cx + noseDx, y: cy, z: 0.05 };
  lm[152] = { x: cx, y: cy + 0.12, z: 0 };
  return { landmarks: lm, blendshapes: blend };
}

/** Corps synthétique de face, poignet gauche à la hauteur `wristY` (pour les tests uniquement). */
export function fakePose(wristY = 0.3, shift = 0): RawPose {
  const lm: PosePoint[] = JOINT_NAMES.map(() => ({ x: 0.5 + shift, y: 0.5, z: 0, visibility: 0.9 }));
  const set = (n: (typeof JOINT_NAMES)[number], x: number, y: number) => (lm[JOINT_NAMES.indexOf(n)] = { x: x + shift, y, z: 0, visibility: 0.9 });
  set("leftShoulder", 0.4, 0.3);
  set("rightShoulder", 0.6, 0.3);
  set("leftHip", 0.45, 0.6);
  set("rightHip", 0.55, 0.6);
  set("leftWrist", 0.2, wristY);
  set("rightWrist", 0.8, 0.6);
  return { landmarks: lm };
}

/** Résultat MediaPipe brut d'un visage (pour les tests des convertisseurs). */
export function mpFaceResult(blend: Record<string, number>) {
  const f = fakeFace(0.5, 0.5, blend);
  return {
    faceLandmarks: [f.landmarks],
    faceBlendshapes: [{ categories: Object.entries(blend).map(([categoryName, score]) => ({ categoryName, score })) }],
  };
}
