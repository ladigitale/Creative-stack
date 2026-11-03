/**
 * Géométrie de visage à partir des 478 points MediaPipe Face Landmarker et des 52 blendshapes.
 * Coordonnées normalisées 0..1 (origine en haut à gauche) ; aucune dépendance au DOM.
 * Indices : 1 bout du nez, 13 / 14 lèvres intérieures haut / bas, 33 / 133 coin extérieur / intérieur de
 * l'œil côté image gauche, 263 / 362 côté image droite, 234 / 454 joues côté image gauche / droite, 10 front, 152 menton.
 */
import type { Point } from "./hands";

export type RawFace = {
  landmarks: Point[];
  /** Blendshapes MediaPipe (noms du sujet : `eyeBlinkLeft` = son œil gauche), 0..1. */
  blendshapes: Record<string, number>;
};

export type FaceMetrics = {
  /** Bout du nez. */
  x: number;
  y: number;
  z: number;
  /** Largeur du visage (joue à joue) relative à l'image : proxy de distance. */
  size: number;
  /** Rotation gauche/droite, -1..1 (±1 ≈ ±60°) ; positif = visage tourné vers la droite de l'écran. */
  yaw: number;
  /** Inclinaison haut/bas, -1..1 ; positif = tête baissée. */
  pitch: number;
  /** Inclinaison de côté (oreille vers l'épaule), -1..1 (±1 ≈ ±45°) ; positif = vers la droite de l'écran. */
  roll: number;
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

export function mirrorFace(points: Point[]): Point[] {
  return points.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z }));
}

/** Posture de la tête estimée à partir des points (approximation : pas de matrice 3D). */
export function faceMetrics(lm: Point[]): FaceMetrics {
  const nose = lm[1];
  const cheekL = lm[234];
  const cheekR = lm[454];
  const eyeL = mid(lm[33], lm[133]);
  const eyeR = mid(lm[263], lm[362]);
  const eyes = mid(eyeL, eyeR);
  const chin = lm[152];
  const width = Math.max(Math.hypot(cheekR.x - cheekL.x, cheekR.y - cheekL.y), 1e-4);
  const cheeks = mid(cheekL, cheekR);
  // Le nez se décale vers le côté où le visage tourne ; ±½ largeur ≈ ±60°.
  const yaw = clamp(((nose.x - cheeks.x) / width) * 2, -1, 1);
  // Distance œil → nez rapportée à œil → menton : ≈ 0,5 de face, plus petit tête baissée, plus grand tête levée.
  const faceH = Math.max(Math.hypot(chin.x - eyes.x, chin.y - eyes.y), 1e-4);
  const pitch = clamp(-((nose.y - eyes.y) / faceH - 0.5) * 4, -1, 1);
  const roll = clamp(Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x) / (Math.PI / 4), -1, 1);
  return { x: nose.x, y: nose.y, z: nose.z, size: width, yaw, pitch, roll };
}

export type FaceExpressions = {
  mouthOpen: number;
  smile: number;
  pucker: number;
  browUp: number;
  browDown: number;
  blinkLeft: number;
  blinkRight: number;
  /** Regard gauche/droite, -1..1 (positif = vers la droite de l'écran). */
  gazeX: number;
  /** Regard haut/bas, -1..1 (positif = vers le haut). */
  gazeY: number;
};

const b = (s: Record<string, number>, k: string) => s[k] ?? 0;
const avg = (...v: number[]) => v.reduce((a, x) => a + x, 0) / v.length;

/**
 * Expressions simples à partir des blendshapes. Les noms MediaPipe sont ceux du sujet ; `screenIsSubject`
 * dit si l'image affichée est un miroir (le côté gauche du sujet est alors à gauche de l'écran).
 */
export function faceExpressions(s: Record<string, number>, screenIsSubject: boolean): FaceExpressions {
  const L = screenIsSubject ? "Left" : "Right";
  const R = screenIsSubject ? "Right" : "Left";
  // Regard vers la droite de l'écran : l'œil droit (écran) regarde vers l'extérieur et le gauche vers l'intérieur.
  const gazeX = clamp(avg(b(s, `eyeLookOut${R}`), b(s, `eyeLookIn${L}`)) - avg(b(s, `eyeLookOut${L}`), b(s, `eyeLookIn${R}`)), -1, 1);
  const gazeY = clamp(avg(b(s, "eyeLookUpLeft"), b(s, "eyeLookUpRight")) - avg(b(s, "eyeLookDownLeft"), b(s, "eyeLookDownRight")), -1, 1);
  return {
    mouthOpen: b(s, "jawOpen"),
    smile: avg(b(s, "mouthSmileLeft"), b(s, "mouthSmileRight")),
    pucker: b(s, "mouthPucker"),
    browUp: avg(b(s, "browInnerUp"), b(s, "browOuterUpLeft"), b(s, "browOuterUpRight")),
    browDown: avg(b(s, "browDownLeft"), b(s, "browDownRight")),
    blinkLeft: b(s, `eyeBlink${L}`),
    blinkRight: b(s, `eyeBlink${R}`),
    gazeX,
    gazeY,
  };
}
