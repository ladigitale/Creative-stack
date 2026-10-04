import { DEFAULT_EXPOSURE, DEFAULT_FOV } from "./constants";
import { orbit, type OrbitLimits } from "./orbit";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type * as THREE from "three";

export type TuneCtx = {
  dprMax: number;
  renderer: THREE.WebGLRenderer;
  fov: number;
  perspCam: THREE.PerspectiveCamera;
  fitEnabled: boolean;
  controls: OrbitControls | null;
  limits: OrbitLimits;
  activeCam: THREE.Camera;
  target: THREE.Vector3;
};

function setDprMax(ctx: TuneCtx, v: number) {
  ctx.dprMax = Math.max(1, v || 2);
}

function setExposure(ctx: TuneCtx, v: number) {
  ctx.renderer.toneMappingExposure = Number.isFinite(v) ? v : DEFAULT_EXPOSURE;
}

function setFov(ctx: TuneCtx, v: number) {
  ctx.fov = Number.isFinite(v) && v > 0 ? v : DEFAULT_FOV;
  ctx.perspCam.fov = ctx.fov;
  ctx.perspCam.updateProjectionMatrix();
}

function setFit(ctx: TuneCtx, v: boolean) {
  ctx.fitEnabled = v;
}

function setAutoRotate(ctx: TuneCtx, v: boolean) {
  if (ctx.controls) ctx.controls.autoRotate = v;
}

function setDamping(ctx: TuneCtx, v: number) {
  if (!ctx.controls) return;
  const d = Number.isFinite(v) ? Math.max(0, v) : 0.08;
  ctx.controls.enableDamping = d > 0;
  ctx.controls.dampingFactor = d > 0 ? d : 0.08;
}

/** Coupe autoRotate + vide l’inertie OrbitControls. */
function stopMotion(ctx: TuneCtx) {
  if (!ctx.controls) return;
  ctx.controls.autoRotate = false;
  const wasDamping = ctx.controls.enableDamping;
  const factor = ctx.controls.dampingFactor;
  ctx.controls.enableDamping = false;
  ctx.controls.update();
  ctx.controls.enableDamping = wasDamping;
  ctx.controls.dampingFactor = factor;
}

function setOrbitLimits(ctx: TuneCtx, opts: Partial<OrbitLimits>) {
  ctx.limits = orbit.mergeLimits(ctx.limits, opts);
  orbit.applyLimitsToControls(ctx.controls, ctx.limits);
}

function setOrbitSpherical(
  ctx: TuneCtx,
  yaw: number,
  pitch: number,
  distance: number,
) {
  orbit.setSpherical(
    {
      activeCam: ctx.activeCam,
      controls: ctx.controls,
      target: ctx.target,
      limits: ctx.limits,
    },
    yaw,
    pitch,
    distance,
  );
}

export const tune = {
  setDprMax,
  setExposure,
  setFov,
  setFit,
  setAutoRotate,
  setDamping,
  stopMotion,
  setOrbitLimits,
  setOrbitSpherical,
} as const;
