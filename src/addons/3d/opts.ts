import type { Sonic3dCameraMode } from "./constants";

export type SceneRuntimeOptions = {
  canvas: HTMLCanvasElement;
  dprMax?: number;
  camera?: Sonic3dCameraMode;
  fov?: number;
  exposure?: number;
  autoRotate?: boolean;
  fit?: boolean;
  minDistance?: number;
  maxDistance?: number;
  /** Polar angles in radians. */
  minPolar?: number;
  maxPolar?: number;
};
