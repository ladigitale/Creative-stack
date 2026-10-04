import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Sonic3dCameraMode } from "./constants";
import { orbit, type OrbitLimits } from "./orbit";

export type ViewCtx = {
  canvas: HTMLCanvasElement;
  perspCam: THREE.PerspectiveCamera;
  orthoCam: THREE.OrthographicCamera;
  activeCam: THREE.Camera;
  controls: OrbitControls | null;
  target: THREE.Vector3;
  limits: OrbitLimits;
  mode: Sonic3dCameraMode;
  dprMax: number;
  renderer: THREE.WebGLRenderer;
  unbindWheelRelay: (() => void) | null;
};

function applyCameraMode(ctx: ViewCtx, mode: Sonic3dCameraMode) {
  ctx.mode = mode;
  const prevPos = ctx.activeCam.position.clone();
  const prevTarget = ctx.target.clone();
  ctx.activeCam =
    mode === Sonic3dCameraMode.Ortho ? ctx.orthoCam : ctx.perspCam;
  ctx.activeCam.position.copy(prevPos);
  ctx.controls?.dispose();
  ctx.controls = new OrbitControls(ctx.activeCam, ctx.canvas);
  ctx.controls.enableDamping = true;
  ctx.controls.dampingFactor = 0.08;
  ctx.controls.target.copy(prevTarget);
  ctx.controls.enablePan = true;
  orbit.applyLimitsToControls(ctx.controls, ctx.limits);
  ctx.controls.update();
  if (!ctx.unbindWheelRelay) {
    ctx.unbindWheelRelay = orbit.bindWheelPageScrollRelay(
      ctx.canvas,
      () => ctx.controls,
    );
  }
}

function resize(ctx: ViewCtx, cssW: number, cssH: number) {
  const w = Math.max(1, cssW);
  const h = Math.max(1, cssH);
  const dpr = Math.min(
    typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
    ctx.dprMax,
  );
  ctx.renderer.setPixelRatio(dpr);
  ctx.renderer.setSize(w, h, false);
  const aspect = w / h;
  ctx.perspCam.aspect = aspect;
  ctx.perspCam.updateProjectionMatrix();
  const frustum = 1.2;
  ctx.orthoCam.left = -frustum * aspect;
  ctx.orthoCam.right = frustum * aspect;
  ctx.orthoCam.top = frustum;
  ctx.orthoCam.bottom = -frustum;
  ctx.orthoCam.updateProjectionMatrix();
}

export const view = { applyCameraMode, resize } as const;
