import type { BoneSpec } from "./skeleton";

/** Attributs d'un os, tels qu'écrits en SDUI (chaînes). */
export type BoneAttrs = Record<string, string>;

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** Os décrit par ses attributs (`name`, `parent`, `length`, `angle`, `at`, `offset`, `min`, `max`) ; `null` sans nom. */
export function boneSpecFromAttrs(attrs: BoneAttrs): BoneSpec | null {
  const name = (attrs.name ?? "").trim();
  if (!name) return null;
  const parent = (attrs.parent ?? "").trim();
  return {
    name,
    parent: parent || null,
    length: Math.max(0, num(attrs.length, 100)),
    angle: num(attrs.angle, 0),
    at: Math.max(0, Math.min(1, num(attrs.at, 1))),
    offset: num(attrs.offset, 0),
    min: num(attrs.min, -180),
    max: num(attrs.max, 180),
  };
}

/**
 * Corps humain de face, hauteur d'environ 300 unités, tête en haut. Les noms d'articulations sont ceux de
 * `sonic-pose-tracker` (`left*` = côté gauche de l'écran). L'os `bassin` est la racine (milieu des hanches).
 * Les bras et les jambes sont dessinés pendants au repos.
 */
export const HUMAN_PRESET: BoneAttrs[] = [
  { name: "bassin", length: "0" },
  { name: "torse", parent: "bassin", angle: "180", length: "110", aim: "leftHip+rightHip>leftShoulder+rightShoulder" },
  { name: "tete", parent: "torse", angle: "0", length: "50", aim: "leftShoulder+rightShoulder>leftEar+rightEar | leftShoulder+rightShoulder>nose" },
  { name: "bras-gauche", parent: "torse", angle: "180", length: "65", offset: "42", aim: "leftShoulder>leftElbow" },
  { name: "avant-bras-gauche", parent: "bras-gauche", length: "60", aim: "leftElbow>leftWrist" },
  { name: "main-gauche", parent: "avant-bras-gauche", length: "28", aim: "leftWrist>leftIndex | leftWrist>leftPinky" },
  { name: "bras-droit", parent: "torse", angle: "180", length: "65", offset: "-42", aim: "rightShoulder>rightElbow" },
  { name: "avant-bras-droit", parent: "bras-droit", length: "60", aim: "rightElbow>rightWrist" },
  { name: "main-droite", parent: "avant-bras-droit", length: "28", aim: "rightWrist>rightIndex | rightWrist>rightPinky" },
  { name: "cuisse-gauche", parent: "bassin", offset: "-24", length: "85", aim: "leftHip>leftKnee" },
  { name: "mollet-gauche", parent: "cuisse-gauche", length: "80", aim: "leftKnee>leftAnkle" },
  { name: "cuisse-droite", parent: "bassin", offset: "24", length: "85", aim: "rightHip>rightKnee" },
  { name: "mollet-droit", parent: "cuisse-droite", length: "80", aim: "rightKnee>rightAnkle" },
];

