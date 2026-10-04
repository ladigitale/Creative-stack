import * as THREE from "three";
import {
  DEFAULT_EXPOSURE,
  DEFAULT_FOV,
  DEFAULT_MAX_DISTANCE,
  DEFAULT_MIN_DISTANCE,
  DEFAULT_MIN_POLAR_RAD,
  Sonic3dCameraMode,
} from "./constants";
import { demoContent } from "./demo-content";
import { createRenderer } from "./gl";
import type { OrbitLimits } from "./orbit";
import type { SceneRuntimeOptions } from "./opts";

export type BootedScene = {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  perspCam: THREE.PerspectiveCamera;
  orthoCam: THREE.OrthographicCamera;
  activeCam: THREE.Camera;
  root: THREE.Group;
  lights: THREE.Light[];
  dprMax: number;
  mode: Sonic3dCameraMode;
  fov: number;
  fitEnabled: boolean;
  limits: OrbitLimits;
  autoRotate: boolean;
};

/** Alloue scène / caméras / renderer / lumières (sans OrbitControls). */
export function bootScene(opts: SceneRuntimeOptions): BootedScene {
  const dprMax = opts.dprMax ?? 2;
  const mode = opts.camera ?? Sonic3dCameraMode.Orbit;
  const fov = opts.fov ?? DEFAULT_FOV;
  const fitEnabled = opts.fit !== false;
  const limits: OrbitLimits = {
    minDistance: opts.minDistance ?? DEFAULT_MIN_DISTANCE,
    maxDistance: opts.maxDistance ?? DEFAULT_MAX_DISTANCE,
    minPolar: opts.minPolar ?? DEFAULT_MIN_POLAR_RAD,
    maxPolar: opts.maxPolar ?? Math.PI - DEFAULT_MIN_POLAR_RAD,
  };

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0a);
  const root = new THREE.Group();
  scene.add(root);

  const perspCam = new THREE.PerspectiveCamera(fov, 1, 0.01, 2000);
  perspCam.position.set(2.2, 1.6, 2.8);
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 2000);
  orthoCam.position.set(2.2, 1.6, 2.8);

  const renderer = createRenderer(opts.canvas);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure ?? DEFAULT_EXPOSURE;
  renderer.setPixelRatio(1);

  return {
    scene,
    renderer,
    canvas: opts.canvas,
    perspCam,
    orthoCam,
    activeCam: perspCam,
    root,
    lights: demoContent.setupLights(scene),
    dprMax,
    mode,
    fov,
    fitEnabled,
    limits,
    autoRotate: !!opts.autoRotate,
  };
}
