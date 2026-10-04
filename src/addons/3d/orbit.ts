import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DEFAULT_FOV, Sonic3dCameraMode } from "./constants";

export type OrbitLimits = {
  minDistance: number;
  maxDistance: number;
  minPolar: number;
  maxPolar: number;
};

export type OrbitSphericalCtx = {
  activeCam: THREE.Camera;
  controls: OrbitControls | null;
  target: THREE.Vector3;
  limits: OrbitLimits;
};

/** Applique les bornes distance / polar sur les OrbitControls. */
function applyLimitsToControls(
  controls: OrbitControls | null,
  limits: OrbitLimits,
) {
  if (!controls) return;
  controls.minDistance = limits.minDistance;
  controls.maxDistance = limits.maxDistance;
  controls.minPolarAngle = limits.minPolar;
  controls.maxPolarAngle = limits.maxPolar;
}

/**
 * Place la caméra en sphérique autour de la cible orbit
 * (même convention que `Sonic3dOutput.yaw` / `pitch` / `distance`).
 */
function setSpherical(
  ctx: OrbitSphericalCtx,
  yaw: number,
  pitch: number,
  distance: number,
) {
  const t = ctx.controls?.target ?? ctx.target;
  let d = Number.isFinite(distance) ? distance : 1;
  d = Math.max(ctx.limits.minDistance, d);
  if (Number.isFinite(ctx.limits.maxDistance)) {
    d = Math.min(ctx.limits.maxDistance, d);
  }
  const elev = Math.max(
    -(Math.PI / 2 - 0.05),
    Math.min(Math.PI / 2 - 0.05, pitch),
  );
  const horiz = d * Math.cos(elev);
  ctx.activeCam.position.set(
    t.x + horiz * Math.sin(yaw),
    t.y + d * Math.sin(elev),
    t.z + horiz * Math.cos(yaw),
  );
  if (ctx.controls) {
    ctx.controls.target.copy(t);
    ctx.controls.update();
  } else {
    ctx.activeCam.lookAt(t);
  }
}

export type FitCtx = {
  bbox: THREE.Box3;
  target: THREE.Vector3;
  activeCam: THREE.Camera;
  controls: OrbitControls | null;
  mode: Sonic3dCameraMode;
  fov: number;
  perspCam: THREE.PerspectiveCamera;
  orthoCam: THREE.OrthographicCamera;
};

function fitToContent(ctx: FitCtx) {
  if (ctx.bbox.isEmpty()) return;
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  ctx.bbox.getSize(size);
  ctx.bbox.getCenter(center);
  ctx.target.copy(center);

  const maxDim = Math.max(size.x, size.y, size.z, 0.001);
  const dist =
    ctx.mode === Sonic3dCameraMode.Ortho
      ? maxDim * 1.8
      : maxDim /
          (2 * Math.tan(((ctx.fov || DEFAULT_FOV) * Math.PI) / 360)) *
        1.35;

  const dir = new THREE.Vector3(1, 0.65, 1).normalize();
  ctx.activeCam.position.copy(center).addScaledVector(dir, dist);
  if (ctx.controls) {
    ctx.controls.target.copy(center);
    ctx.controls.update();
  } else {
    ctx.activeCam.lookAt(center);
  }

  if (ctx.mode === Sonic3dCameraMode.Ortho) {
    const aspect = ctx.perspCam.aspect || 1;
    const frustum = maxDim * 0.75;
    ctx.orthoCam.left = -frustum * aspect;
    ctx.orthoCam.right = frustum * aspect;
    ctx.orthoCam.top = frustum;
    ctx.orthoCam.bottom = -frustum;
    ctx.orthoCam.updateProjectionMatrix();
  }
}

/** Merge partiel de bornes orbit (distances monde, polar radians). */
function mergeLimits(
  current: OrbitLimits,
  opts: Partial<OrbitLimits>,
): OrbitLimits {
  const next = { ...current };
  if (opts.minDistance != null && Number.isFinite(opts.minDistance)) {
    next.minDistance = Math.max(0, opts.minDistance);
  }
  if (opts.maxDistance != null && Number.isFinite(opts.maxDistance)) {
    next.maxDistance =
      opts.maxDistance <= 0
        ? Infinity
        : Math.max(next.minDistance, opts.maxDistance);
  }
  if (opts.minPolar != null && Number.isFinite(opts.minPolar)) {
    next.minPolar = Math.max(0, opts.minPolar);
  }
  if (opts.maxPolar != null && Number.isFinite(opts.maxPolar)) {
    next.maxPolar = Math.min(Math.PI, Math.max(next.minPolar, opts.maxPolar));
  }
  return next;
}

const WHEEL_LIMIT_EPS = 1e-6;

/**
 * `true` si la molette changerait encore le zoom (marge restante).
 * Aligné sur OrbitControls : deltaY < 0 = zoom in, > 0 = zoom out.
 */
function wheelAffectsZoom(controls: OrbitControls, deltaY: number): boolean {
  if (!Number.isFinite(deltaY) || deltaY === 0) return false;
  const zoomingIn = deltaY < 0;
  const obj = controls.object;
  if ((obj as THREE.OrthographicCamera).isOrthographicCamera) {
    const z = (obj as THREE.OrthographicCamera).zoom;
    return zoomingIn
      ? z < controls.maxZoom - WHEEL_LIMIT_EPS
      : z > controls.minZoom + WHEEL_LIMIT_EPS;
  }
  const dist = controls.getDistance();
  if (zoomingIn) return dist > controls.minDistance + WHEEL_LIMIT_EPS;
  if (!Number.isFinite(controls.maxDistance)) return true;
  return dist < controls.maxDistance - WHEEL_LIMIT_EPS;
}

/**
 * Aux bornes zoom : stoppe OrbitControls (qui fait toujours preventDefault)
 * pour laisser le scroll page reprendre — comportement nav embarqué.
 */
function bindWheelPageScrollRelay(
  canvas: HTMLElement,
  getControls: () => OrbitControls | null,
): () => void {
  const onWheel = (event: WheelEvent) => {
    const controls = getControls();
    if (!controls?.enabled || !controls.enableZoom) return;
    if (wheelAffectsZoom(controls, event.deltaY)) return;
    event.stopImmediatePropagation();
  };
  canvas.addEventListener("wheel", onWheel, { capture: true, passive: true });
  return () => {
    canvas.removeEventListener("wheel", onWheel, { capture: true });
  };
}

export const orbit = {
  applyLimitsToControls,
  setSpherical,
  fitToContent,
  mergeLimits,
  wheelAffectsZoom,
  bindWheelPageScrollRelay,
} as const;
