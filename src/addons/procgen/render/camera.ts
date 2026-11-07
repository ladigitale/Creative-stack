/**
 * Caméras : `side` (profil orthographique), `front`, `iso`, `oblique` (cavalière), `top`, `perspective` (orbite),
 * `follow` (perspective derrière un acteur). Toutes regardent une cible (`cx, cy, cz`) ; `zoom` multiplie le cadrage.
 */
import * as THREE from "three";

export const CAMERAS = ["side", "front", "iso", "oblique", "top", "perspective", "follow"] as const;
export type CameraMode = (typeof CAMERAS)[number];

export type ViewState = { camera: CameraMode; yaw: number; pitch: number; zoom: number; cx: number; cy: number; cz: number; fov: number };

export const DEFAULT_VIEW: ViewState = { camera: "iso", yaw: 30, pitch: 30, zoom: 1, cx: 0, cy: 0, cz: 0, fov: 40 };

export function parseView(v: unknown, base: ViewState): ViewState {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const n = (k: string, d: number) => (Number.isFinite(Number(o[k])) && o[k] !== null && o[k] !== "" ? Number(o[k]) : d);
  const cam = (CAMERAS as readonly string[]).includes(String(o.camera)) ? (o.camera as CameraMode) : base.camera;
  return { camera: cam, yaw: n("yaw", base.yaw), pitch: n("pitch", base.pitch), zoom: Math.max(0.05, n("zoom", base.zoom)), cx: n("cx", base.cx), cy: n("cy", base.cy), cz: n("cz", base.cz), fov: n("fov", base.fov) };
}

/** Place la caméra ; `extent` = demi-taille de la scène (cadrage de base). Renvoie la caméra active. */
export function applyView(v: ViewState, aspect: number, extent: number, ortho: THREE.OrthographicCamera, persp: THREE.PerspectiveCamera, target?: THREE.Vector3): THREE.Camera {
  const D = Math.PI / 180;
  const t = target ?? new THREE.Vector3(v.cx, v.cy, v.cz);
  const far = extent * 12 + 100;
  if (v.camera === "perspective" || v.camera === "follow") {
    const pitch = Math.max(2, Math.min(88, v.pitch)) * D;
    const yaw = v.yaw * D;
    const dist = (extent * 1.25) / v.zoom / Math.tan((v.fov * D) / 2) * 0.55;
    persp.fov = v.fov;
    persp.aspect = aspect;
    persp.near = Math.max(0.05, dist * 0.01);
    persp.far = far;
    persp.position.set(t.x + Math.sin(yaw) * Math.cos(pitch) * dist, t.y + Math.sin(pitch) * dist, t.z + Math.cos(yaw) * Math.cos(pitch) * dist);
    persp.lookAt(t);
    persp.updateProjectionMatrix();
    return persp;
  }
  const half = (extent * 0.62) / v.zoom;
  ortho.left = -half * aspect;
  ortho.right = half * aspect;
  ortho.top = half;
  ortho.bottom = -half;
  ortho.near = 0.1;
  ortho.far = far;
  let yaw = 0, pitch = 0;
  switch (v.camera) {
    case "side": yaw = 0; pitch = 0.0001; break;
    case "front": yaw = v.yaw === DEFAULT_VIEW.yaw ? 0 : v.yaw; pitch = 8; break;
    case "iso": yaw = v.yaw; pitch = 35.264; break;
    case "top": yaw = v.yaw === DEFAULT_VIEW.yaw ? 0 : v.yaw; pitch = 89.9; break;
    case "oblique": yaw = 0; pitch = 0.0001; break;
  }
  const dist = far * 0.5;
  ortho.position.set(t.x + Math.sin(yaw * D) * Math.cos(pitch * D) * dist, t.y + Math.sin(pitch * D) * dist, t.z + Math.cos(yaw * D) * Math.cos(pitch * D) * dist);
  ortho.up.set(0, 1, 0);
  ortho.lookAt(t);
  ortho.updateProjectionMatrix();
  if (v.camera === "oblique") {
    // projection cavalière : la profondeur décale vers le haut (et un peu à droite)
    const k = 0.5;
    // cisaillement centré sur la profondeur de la cible (z vue = -dist)
    const shear = new THREE.Matrix4().set(1, 0, -k * 0.35, -k * 0.35 * dist, 0, 1, -k, -k * dist, 0, 0, 1, 0, 0, 0, 0, 1);
    ortho.projectionMatrix.multiply(shear);
    ortho.projectionMatrixInverse.copy(ortho.projectionMatrix).invert();
  }
  return ortho;
}
