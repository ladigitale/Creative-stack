import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Sonic3dCameraMode } from "./constants";
import { bootScene } from "./boot";
import { ops, type OpsCtx } from "./ops";
import type { SceneRuntimeOptions } from "./opts";
import type { SceneHit } from "./pick";
import {
  PostFxCompileError,
  PostFxPipeline,
  type PostFxConfig,
  type PostFxUniforms,
} from "./post-fx";
import { tune, type TuneCtx } from "./tune";
import type { Sonic3dAsset, Sonic3dOutput } from "./types";
import { view, type ViewCtx } from "./view";

export type { SceneHit, SceneRuntimeOptions };
export { PostFxCompileError };
export type { PostFxConfig, PostFxUniforms };

/**
 * Runtime Three.js encapsulé : renderer, scène, caméra, load, fit, pick, post FX.
 * Le composant Lit gère RAF / viewport / DP.
 */
export class SceneRuntime {
  readonly scene: THREE.Scene;
  readonly renderer: THREE.WebGLRenderer;
  private canvas: HTMLCanvasElement;
  private perspCam: THREE.PerspectiveCamera;
  private orthoCam: THREE.OrthographicCamera;
  private activeCam: THREE.Camera;
  private controls: OrbitControls | null = null;
  private unbindWheelRelay: (() => void) | null = null;
  private root: THREE.Group;
  private content: THREE.Object3D | null = null;
  private lights: THREE.Light[];
  private loader = new GLTFLoader();
  private loadToken = 0;
  private blobUrl: string | null = null;
  private dprMax: number;
  private mode: Sonic3dCameraMode;
  private fov: number;
  private fitEnabled: boolean;
  private limits: ReturnType<typeof bootScene>["limits"];
  private bbox = new THREE.Box3();
  private target = new THREE.Vector3();
  private _ready = false;
  private _loading = false;
  private lastError: string | null = null;
  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();
  private highlighted: THREE.Mesh | null = null;
  private prevEmissive = new THREE.Color();
  private prevEmissiveIntensity = 0;
  private postFx: PostFxPipeline;
  private lastCssW = 1;
  private lastCssH = 1;
  private damping = 0.08;
  private postFrame: PostFxUniforms = {
    time: 0,
    timeDelta: 1 / 60,
    frame: 0,
    mouse: [0, 0, 0, 0],
    params: [0, 0, 0, 0],
    near: 0.1,
    far: 100,
  };

  constructor(opts: SceneRuntimeOptions) {
    const b = bootScene(opts);
    this.scene = b.scene;
    this.renderer = b.renderer;
    this.canvas = b.canvas;
    this.perspCam = b.perspCam;
    this.orthoCam = b.orthoCam;
    this.activeCam = b.activeCam;
    this.root = b.root;
    this.lights = b.lights;
    this.dprMax = b.dprMax;
    this.mode = b.mode;
    this.fov = b.fov;
    this.fitEnabled = b.fitEnabled;
    this.limits = b.limits;
    this.postFx = new PostFxPipeline(this.renderer);
    this.applyCameraMode(this.mode);
    if (b.autoRotate) this.setAutoRotate(true);
    void [
      this.canvas,
      this.perspCam,
      this.orthoCam,
      this.root,
      this.content,
      this.lights,
      this.loader,
      this.loadToken,
      this.blobUrl,
      this.dprMax,
      this.fov,
      this.fitEnabled,
      this.limits,
      this.bbox,
      this.target,
      this.raycaster,
      this.pointerNdc,
      this.highlighted,
      this.prevEmissive,
      this.prevEmissiveIntensity,
      this.unbindWheelRelay,
    ];
  }

  get ready() {
    return this._ready;
  }
  get loading() {
    return this._loading;
  }
  get error() {
    return this.lastError;
  }
  get isLost() {
    return this.renderer.getContext()?.isContextLost?.() ?? false;
  }
  get hasPostFx() {
    return this.postFx.isEnabled;
  }

  setDprMax(v: number) {
    tune.setDprMax(this.asTuneCtx(), v);
  }
  setExposure(v: number) {
    tune.setExposure(this.asTuneCtx(), v);
  }
  setFov(v: number) {
    tune.setFov(this.asTuneCtx(), v);
  }
  setFit(v: boolean) {
    tune.setFit(this.asTuneCtx(), v);
  }
  setAutoRotate(v: boolean) {
    tune.setAutoRotate(this.asTuneCtx(), v);
  }
  setDamping(v: number) {
    this.damping = Number.isFinite(v) ? Math.max(0, v) : 0.08;
    tune.setDamping(this.asTuneCtx(), this.damping);
  }
  /** Coupe autoRotate + inertie OrbitControls. */
  stopMotion() {
    tune.setAutoRotate(this.asTuneCtx(), false);
    tune.stopMotion(this.asTuneCtx());
  }
  setOrbitLimits(opts: Parameters<typeof tune.setOrbitLimits>[1]) {
    tune.setOrbitLimits(this.asTuneCtx(), opts);
  }
  setOrbitSpherical(yaw: number, pitch: number, distance: number) {
    tune.setOrbitSpherical(this.asTuneCtx(), yaw, pitch, distance);
  }

  applyCameraMode(mode: Sonic3dCameraMode) {
    view.applyCameraMode(this.asViewCtx(), mode);
    tune.setDamping(this.asTuneCtx(), this.damping);
  }
  resize(cssW: number, cssH: number) {
    this.lastCssW = cssW;
    this.lastCssH = cssH;
    view.resize(this.asViewCtx(), cssW, cssH);
    const dpr = Math.min(
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
      this.dprMax,
    );
    this.postFx.resize(cssW * dpr, cssH * dpr);
  }
  async load(asset: Sonic3dAsset | null) {
    return ops.runLoad(this.asOpsCtx(), asset);
  }
  fitToContent() {
    ops.fitToContent(this.asOpsCtx());
  }

  setPostConfig(config: PostFxConfig | null) {
    this.postFx.setConfig(config);
    if (config && this.lastCssW > 0) {
      this.resize(this.lastCssW, this.lastCssH);
    }
  }

  setPostElementResolver(fn: ((key: string) => Element | null) | null) {
    this.postFx.setElementResolver(fn);
  }

  setPostFrame(frame: Partial<PostFxUniforms>) {
    Object.assign(this.postFrame, frame);
    const cam = this.activeCam as THREE.PerspectiveCamera;
    if ("near" in cam && "far" in cam) {
      this.postFrame.near = cam.near;
      this.postFrame.far = cam.far;
    }
  }

  render() {
    this.controls?.update();
    if (this.postFx.isEnabled) {
      this.postFx.render(this.scene, this.activeCam, this.postFrame);
    } else {
      this.renderer.render(this.scene, this.activeCam);
    }
  }
  pick(normX: number, normY: number): SceneHit | null {
    return ops.pick(this.asOpsCtx(), normX, normY);
  }
  setHoverAt(normX: number, normY: number): SceneHit | null {
    return ops.setHoverAt(this.asOpsCtx(), normX, normY);
  }
  clearHighlight() {
    ops.clearHighlight(this.asOpsCtx());
  }
  snapshot(base: {
    time: number;
    frame: number;
    hovering: number;
    pointerX: number;
    pointerY: number;
    hit?: SceneHit | null;
  }): Sonic3dOutput {
    return ops.buildSnapshot(this.asOpsCtx(), base);
  }
  dispose(loseContext = false) {
    this.postFx.dispose();
    ops.dispose(this.asOpsCtx(), loseContext);
  }

  private asTuneCtx = () => this as unknown as TuneCtx;
  private asViewCtx = () => this as unknown as ViewCtx;
  private asOpsCtx = () => this as unknown as OpsCtx;
}
