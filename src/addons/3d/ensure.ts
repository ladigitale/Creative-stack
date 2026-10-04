import type { Sonic3dCameraMode } from "./constants";
import { parse } from "./parse";
import { playback, wantsOffscreenPlay } from "./playback";
import { reload } from "./reload";
import { SceneRuntime } from "./scene-runtime";

export type EnsureHost = {
  releasing: boolean;
  runtime: SceneRuntime | null;
  dprMax: number;
  camera: Sonic3dCameraMode;
  fov: number;
  exposure: number;
  fit: boolean;
  minDistance: number;
  maxDistance: number;
  minPolar: number;
  maxPolar: number;
  damping: number;
  loadToken: number;
  ready: boolean;
  inView: boolean;
  releaseOffscreen: boolean;
  playOffscreen: boolean;
  frameConsumerCount: number;
  getBoundingClientRect: () => DOMRect;
  clientWidth: number;
  clientHeight: number;
  renderRoot: ShadowRoot | null | undefined;
  syncPlayback: () => void;
};

function getCanvas(host: EnsureHost): HTMLCanvasElement | null {
  return (
    (host.renderRoot?.querySelector("canvas") as HTMLCanvasElement | null) ??
    null
  );
}

async function ensureRuntime(host: EnsureHost) {
  if (host.releasing || host.runtime) return;
  const canvas = getCanvas(host);
  if (!canvas) return;
  try {
    host.runtime = new SceneRuntime({
      canvas,
      dprMax: host.dprMax,
      camera: parse.cameraMode(host.camera),
      fov: host.fov,
      exposure: host.exposure,
      autoRotate: false,
      fit: host.fit,
      minDistance: host.minDistance,
      maxDistance: host.maxDistance,
      minPolar: reload.degToRad(host.minPolar),
      maxPolar: reload.degToRad(host.maxPolar),
    });
    host.runtime.setDamping(host.damping);
    reload.applyOrbitLimits(host as never);
    syncSize(host);
    await reload.run(host as never);
  } catch (err) {
    reload.emitError(host as never, err);
  }
}

function releaseRuntime(host: EnsureHost) {
  host.loadToken++;
  playback.stopLoop(host as never);
  host.ready = false;
  host.releasing = true;
  host.runtime?.dispose(false);
  host.runtime = null;
  host.releasing = false;
}

function syncVisibility(host: EnsureHost) {
  const keepOffscreen = wantsOffscreenPlay(host);
  if (!host.inView && host.releaseOffscreen && !keepOffscreen) {
    releaseRuntime(host);
    return;
  }
  if (
    (!host.runtime || host.runtime.isLost) &&
    (host.inView || keepOffscreen || !host.releaseOffscreen)
  ) {
    void ensureRuntime(host);
    return;
  }
  host.syncPlayback();
}

function syncSize(host: EnsureHost) {
  if (!host.runtime) return;
  const rect = host.getBoundingClientRect();
  const cssW = Math.max(rect.width, host.clientWidth, 1);
  const cssH = Math.max(rect.height, host.clientHeight, 1);
  host.runtime.resize(cssW, cssH);
  if (host.ready) host.runtime.render();
}

export const ensure = {
  ensureRuntime,
  releaseRuntime,
  syncVisibility,
  syncSize,
} as const;
