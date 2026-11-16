/**
 * Ligne d'horizon du ciel (dégradé du shader de post, `uHorizonY`).
 *
 * L'horizon est calé sur la direction de visée horizontale de la caméra, pas sur un axe fixe du
 * monde : en orbite (yaw), sa hauteur à l'écran ne change pas.
 * - Perspective : la ligne d'horizon du plan y = 0 est la ligne de fuite des directions horizontales ;
 *   on projette `position caméra + f · grand` (même hauteur que la caméra).
 * - Orthographique (iso, dessus, côté, cavalière, face) : direction de rayon constante ; on projette un
 *   point au sol `cible + f · extent · 4`.
 * `f` = direction de visée projetée sur XZ ; caméra verticale : projection XZ de son vecteur up.
 */
import * as THREE from "three";

import { clamp } from "../core/math";

/** Direction horizontale de visée (XZ normalisé), jamais NaN. */
export function horizonDirection(forward: { x: number; z: number }, up: { x: number; z: number }): [number, number] {
  let x = forward.x, z = forward.z;
  let n = Math.hypot(x, z);
  if (n < 1e-4) {
    // caméra verticale : vers le haut de l'écran
    x = up.x;
    z = up.z;
    n = Math.hypot(x, z);
  }
  if (!(n > 1e-9)) return [0, -1];
  return [x / n, z / n];
}

const tmpF = new THREE.Vector3();
const tmpU = new THREE.Vector3();
const tmpP = new THREE.Vector3();

/** `uHorizonY` (0 = bas de l'écran, 1 = haut) pour une caméra à jour (`updateMatrixWorld` fait). */
export function horizonScreenY(camera: THREE.Camera, target: THREE.Vector3, extent: number): number {
  camera.getWorldDirection(tmpF);
  tmpU.set(0, 1, 0).applyQuaternion(camera.quaternion);
  const [fx, fz] = horizonDirection(tmpF, tmpU);
  const persp = (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
  if (persp) {
    const far = (camera as THREE.PerspectiveCamera).far;
    const d = Math.max(1, far * 0.5);
    tmpP.set(camera.position.x + fx * d, camera.position.y, camera.position.z + fz * d);
  } else {
    const d = extent * 4;
    tmpP.set(target.x + fx * d, 0, target.z + fz * d);
  }
  tmpP.project(camera);
  const y = tmpP.y * 0.5 + 0.5;
  return Number.isFinite(y) ? clamp(y, -0.5, 0.95) : 0.35;
}
