/**
 * Corps à partir des 33 points MediaPipe Pose Landmarker. Coordonnées normalisées 0..1, origine en haut à gauche.
 */
import type { Point } from "./hands";

export type PosePoint = Point & { visibility: number };

export type RawPose = {
  landmarks: PosePoint[];
  world?: Point[];
};

/** Noms des 33 points, dans l'ordre MediaPipe (côté du sujet). */
export const JOINT_NAMES = [
  "nose",
  "leftEyeInner",
  "leftEye",
  "leftEyeOuter",
  "rightEyeInner",
  "rightEye",
  "rightEyeOuter",
  "leftEar",
  "rightEar",
  "mouthLeft",
  "mouthRight",
  "leftShoulder",
  "rightShoulder",
  "leftElbow",
  "rightElbow",
  "leftWrist",
  "rightWrist",
  "leftPinky",
  "rightPinky",
  "leftIndex",
  "rightIndex",
  "leftThumb",
  "rightThumb",
  "leftHip",
  "rightHip",
  "leftKnee",
  "rightKnee",
  "leftAnkle",
  "rightAnkle",
  "leftHeel",
  "rightHeel",
  "leftFootIndex",
  "rightFootIndex",
] as const;

export type JointName = (typeof JOINT_NAMES)[number];

/** Nom du point du même côté, de l'autre côté du corps (`leftWrist` ↔ `rightWrist`). */
export function swapSide(name: JointName): JointName {
  if (name.startsWith("left")) return ("right" + name.slice(4)) as JointName;
  if (name.startsWith("right")) return ("left" + name.slice(5)) as JointName;
  return name;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function mirrorPose(points: PosePoint[]): PosePoint[] {
  return points.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z, visibility: p.visibility }));
}

/** Points indexés par nom. `swap` : échange gauche/droite (image non retournée → côté écran). */
export function jointsByName(lm: PosePoint[], swap: boolean): Record<JointName, PosePoint> {
  const out = {} as Record<JointName, PosePoint>;
  JOINT_NAMES.forEach((name, i) => {
    if (lm[i]) out[swap ? swapSide(name) : name] = lm[i];
  });
  return out;
}

export type AngleMetrics = {
  /** Extension de l'articulation : 0 = très fléchie (≤ 45°), 1 = tendue (180°). Côtés écran. */
  elbowLeft: number;
  elbowRight: number;
  kneeLeft: number;
  kneeRight: number;
  /** 0 = debout jambes tendues, 1 = très fléchi : moyenne de la flexion des deux genoux. */
  squat: number;
};

export const ANGLE_KEYS = ["elbowLeft", "elbowRight", "kneeLeft", "kneeRight", "squat"] as const;

/** Angle (degrés) en `b` entre b→a et b→c, en 3D ; 180 = aligné. */
function angleAt(a: Point, b: Point, c: Point): number {
  const ux = a.x - b.x, uy = a.y - b.y, uz = a.z - b.z;
  const vx = c.x - b.x, vy = c.y - b.y, vz = c.z - b.z;
  const n = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz);
  if (n < 1e-12) return 180;
  const cos = (ux * vx + uy * vy + uz * vz) / n;
  return (Math.acos(cos < -1 ? -1 : cos > 1 ? 1 : cos) * 180) / Math.PI;
}

/** Articulations en extension 0..1 (45° → 0, 180° → 1). Plus fidèle avec des points en mètres (`world`) qu'en image. */
export function jointAngles(j: Record<JointName, Point>): AngleMetrics {
  const ext = (a: Point | undefined, b: Point | undefined, c: Point | undefined) =>
    a && b && c ? clamp((angleAt(a, b, c) - 45) / 135, 0, 1) : 1;
  const kneeLeft = ext(j.leftHip, j.leftKnee, j.leftAnkle);
  const kneeRight = ext(j.rightHip, j.rightKnee, j.rightAnkle);
  return {
    elbowLeft: ext(j.leftShoulder, j.leftElbow, j.leftWrist),
    elbowRight: ext(j.rightShoulder, j.rightElbow, j.rightWrist),
    kneeLeft,
    kneeRight,
    squat: 1 - (kneeLeft + kneeRight) / 2,
  };
}

export type BodyMetrics = AngleMetrics & {
  /** Centre des hanches. */
  x: number;
  y: number;
  /** Poignet à la hauteur de l'épaule = 0,5 ; à la hanche ≈ 0 ; une longueur de buste au-dessus de l'épaule = 1. */
  raiseLeft: number;
  raiseRight: number;
  /** Écart entre les poignets / largeur d'épaules (bras écartés ≈ 3 à 4). */
  span: number;
  /** Inclinaison du buste, -1..1 (positif = épaules vers la droite de l'écran). */
  lean: number;
};

export function bodyMetrics(j: Record<JointName, PosePoint>): BodyMetrics {
  const shoulders = mid(j.leftShoulder, j.rightShoulder);
  const hips = mid(j.leftHip, j.rightHip);
  const torso = Math.max(Math.hypot(shoulders.x - hips.x, shoulders.y - hips.y), 1e-4);
  const shoulderWidth = Math.max(dist(j.leftShoulder, j.rightShoulder), 1e-4);
  const raise = (wrist: Point, shoulder: Point) => clamp(0.5 + (shoulder.y - wrist.y) / torso / 2, 0, 1);
  return {
    x: hips.x,
    y: hips.y,
    raiseLeft: raise(j.leftWrist, j.leftShoulder),
    raiseRight: raise(j.rightWrist, j.rightShoulder),
    span: dist(j.leftWrist, j.rightWrist) / shoulderWidth,
    lean: clamp((shoulders.x - hips.x) / torso, -1, 1),
    ...jointAngles(j),
  };
}
