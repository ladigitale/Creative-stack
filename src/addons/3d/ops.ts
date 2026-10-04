import type * as THREE from "three";
import { load, type LoadCtx } from "./load";
import { orbit } from "./orbit";
import { pick, type HighlightCtx, type SceneHit } from "./pick";
import { snapshot } from "./snapshot";
import type { Sonic3dAsset, Sonic3dOutput } from "./types";
import type { Sonic3dCameraMode } from "./constants";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { OrbitLimits } from "./orbit";

export type OpsCtx = HighlightCtx &
  LoadCtx & {
    loadToken: number;
    _ready: boolean;
    _loading: boolean;
    lastError: string | null;
    lights: THREE.Light[];
    scene: THREE.Scene;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls | null;
    bbox: THREE.Box3;
    target: THREE.Vector3;
    mode: Sonic3dCameraMode;
    fov: number;
    perspCam: THREE.PerspectiveCamera;
    orthoCam: THREE.OrthographicCamera;
    activeCam: THREE.Camera;
    limits: OrbitLimits;
    unbindWheelRelay: (() => void) | null;
  };

async function runLoad(
  ctx: OpsCtx,
  asset: Sonic3dAsset | null,
): Promise<void> {
  const token = ++ctx.loadToken;
  ctx._loading = true;
  ctx._ready = false;
  ctx.lastError = null;
  try {
    const result = await load.asset(
      ctx,
      asset,
      token,
      (t) => t === ctx.loadToken,
    );
    if (token !== ctx.loadToken) return;
    ctx._ready = result.ready;
    ctx._loading = false;
  } catch (err) {
    if (token !== ctx.loadToken) return;
    ctx._loading = false;
    ctx._ready = false;
    ctx.lastError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

function fitToContent(ctx: OpsCtx) {
  orbit.fitToContent({
    bbox: ctx.bbox,
    target: ctx.target,
    activeCam: ctx.activeCam,
    controls: ctx.controls,
    mode: ctx.mode,
    fov: ctx.fov,
    perspCam: ctx.perspCam,
    orthoCam: ctx.orthoCam,
  });
}

function buildSnapshot(
  ctx: OpsCtx,
  base: {
    time: number;
    frame: number;
    hovering: number;
    pointerX: number;
    pointerY: number;
    hit?: SceneHit | null;
  },
): Sonic3dOutput {
  return snapshot.build(
    {
      activeCam: ctx.activeCam,
      controls: ctx.controls,
      target: ctx.target,
      mode: ctx.mode,
      perspCam: ctx.perspCam,
      orthoCam: ctx.orthoCam,
      bbox: ctx.bbox,
      ready: ctx._ready,
      loading: ctx._loading,
    },
    base,
  );
}

function dispose(ctx: OpsCtx, loseContext = false) {
  ctx.loadToken++;
  ctx.unbindWheelRelay?.();
  ctx.unbindWheelRelay = null;
  ctx.controls?.dispose();
  ctx.controls = null;
  load.clearContent(ctx);
  load.revokeBlob(ctx);
  for (const light of ctx.lights) ctx.scene.remove(light);
  ctx.lights = [];
  ctx.renderer.dispose();
  if (loseContext) {
    const ext = ctx.renderer.getContext()?.getExtension?.("WEBGL_lose_context");
    ext?.loseContext?.();
  }
  ctx._ready = false;
}

export const ops = {
  runLoad,
  fitToContent,
  buildSnapshot,
  dispose,
  pick: (ctx: HighlightCtx, x: number, y: number) => pick.hit(ctx, x, y),
  setHoverAt: (ctx: HighlightCtx, x: number, y: number) =>
    pick.setHoverAt(ctx, x, y),
  clearHighlight: (ctx: HighlightCtx) => pick.clearHighlight(ctx),
} as const;
