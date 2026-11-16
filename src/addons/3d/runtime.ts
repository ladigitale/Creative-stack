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
import { NodeOverrides, type NodesSpec } from "./nodes";
import { tune, type TuneCtx } from "./tune";
import type { Sonic3dAsset, Sonic3dOutput } from "./types";
import { view, type ViewCtx } from "./view";
import { Monde3d } from "./monde";
import type { PlacedInfo } from "../../shared/monde/arrange";
import { load as loadOps } from "./load";
import type { Monde } from "../../shared/monde/format";

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
  /** Surcharges de nœuds pilotées par DP (clé `nodes`). */
  readonly nodes = new NodeOverrides();
  /** Monde décrit en primitives (clé `monde`), ajouté au contenu chargé. */
  readonly monde = new Monde3d();
  private mondeData: Monde | null = null;
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
    // un modèle procgen généré en différé n'attend pas le prochain patch pour s'afficher
    this.monde.onAsync = () => {
      if (!this._ready) return;
      // les maillages générés arrivent après le cadrage : boîte englobante à jour
      if (this.content) loadOps.updateBBox(this as never);
      this.render();
    };
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
  /** Point visé piloté par les données (`lookAt`) : la caméra glisse vers lui en gardant son cadrage. */
  private lookGoal: THREE.Vector3 | null = null;
  setLookAt(x: number, y: number, z: number, instant = false) {
    if (!this.controls) return;
    const goal = new THREE.Vector3(x, y, z);
    if (instant) {
      const d = goal.clone().sub(this.controls.target);
      this.controls.target.add(d);
      this.activeCam.position.add(d);
      this.lookGoal = null;
      this.controls.update();
    } else this.lookGoal = goal;
  }
  private lookT = 0;
  private stepLook(now: number) {
    const dt = this.lookT ? Math.min(0.1, (now - this.lookT) / 1000) : 0.016;
    this.lookT = now;
    if (!this.lookGoal || !this.controls) return;
    const d = this.lookGoal.clone().sub(this.controls.target);
    if (d.lengthSq() < 1e-6) {
      this.lookGoal = null;
      return;
    }
    d.multiplyScalar(1 - Math.exp(-dt * 6));
    this.controls.target.add(d);
    this.activeCam.position.add(d);
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
    this.nodes.dispose();
    await ops.runLoad(this.asOpsCtx(), asset);
    if (this.mondeData && this.content) this.mountMonde(this.mondeData, true);
    this.nodes.attach(this.content);
  }

  /** Mémorise le monde à monter au prochain chargement (runtime neuf ou rechargement). */
  stageMonde(m: Monde | null) {
    this.mondeData = m;
  }

  /** Construit (ou reconstruit) le monde dans le contenu courant ; `fit` recadre si demandé. */
  setMonde(m: Monde | null, fit = true): boolean {
    this.mondeData = m;
    if (!this._ready || !this.content) return false;
    if (!m) {
      this.monde.clear();
      this.monde.group.removeFromParent();
      this.monde.applySky(this.scene, null);
    } else this.mountMonde(m, fit);
    this.nodes.attach(this.content);
    return true;
  }

  private mountMonde(m: Monde, fit: boolean) {
    const first = this.monde.group.parent !== this.content;
    try {
      this.monde.set(m, performance.now());
    } catch (err) {
      // un monde ne doit jamais casser la scène (glb, nodes, taps continuent)
      m.issues.push({ path: "", message: `rendu 3D : ${err instanceof Error ? err.message : String(err)}` });
      this.monde.clear();
    }
    if (this.monde.group.parent !== this.content) this.content!.add(this.monde.group);
    this.monde.applySky(this.scene, m);
    if (first && fit && this.fitEnabled) {
      loadOps.updateBBox(this as never);
      this.fitToContent();
    } else loadOps.updateBBox(this as never);
  }

  /** Applique `nodes` ; true si la scène a changé (un seul render à la charge de l'appelant). */
  applyNodes(spec: NodesSpec, animate = true): boolean {
    if (!this._ready) return false;
    const now = performance.now();
    // déplacements `collide` : ramenés au point atteint avant d'être appliqués
    const sp = this.mondeData ? this.monde.guardNodes(spec) : spec;
    const a = this.mondeData ? this.monde.applyNodes(sp, now) : false;
    return this.nodes.apply(sp, now, animate) || a;
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
    const now = performance.now();
    if (this.mondeData) this.monde.step(now);
    this.nodes.step(now);
    if (this.mondeData) this.monde.follow();
    this.stepLook(now);
    this.controls?.update();
    if (this.postFx.isEnabled) {
      this.postFx.render(this.scene, this.activeCam, this.postFrame);
    } else {
      this.renderer.render(this.scene, this.activeCam);
    }
  }
  pick(normX: number, normY: number, names?: string): SceneHit | null {
    return ops.pick(this.asOpsCtx(), normX, normY, names);
  }

  /** Objet du monde déplaçable sous le pointeur (le décor et l'espace ne comptent pas) ; vide : aucun. */
  worldInstanceAt(normX: number, normY: number, names?: string): string {
    if (!this.mondeData || !this.content) return "";
    let re: RegExp | null = null;
    try {
      re = names ? new RegExp(names) : null;
    } catch {
      return "";
    }
    this.dragNdc.set(normX * 2 - 1, -(normY * 2 - 1));
    this.raycaster.setFromCamera(this.dragNdc, this.activeCam);
    for (const h of this.raycaster.intersectObject(this.content, true)) {
      const n = this.monde.instanceOfObject(h.object);
      if (n && (!re || re.test(n))) return n;
    }
    return "";
  }

  /** Rang de l'entrée de `place` d'une instance du monde (-1 : inconnu). */
  worldSrcOf(name: string): number {
    return this.monde.srcOf(name);
  }

  /** Glisser d'une instance du monde : nom de l'instance saisie sous le pointeur (vide : aucune), orbite suspendue. */
  dragStart(normX: number, normY: number, names?: string): string {
    const name = this.worldInstanceAt(normX, normY, names);
    if (!name) return "";
    this.dragPlaneY = this.monde.heightOf(name);
    if (this.controls) this.controls.enabled = false;
    return name;
  }

  /** Point visé sur le plan horizontal de l'instance, puis rangement (appui, aimantation, collisions). */
  dragMove(name: string, normX: number, normY: number, ry?: number): PlacedInfo | null {
    this.dragNdc.set(normX * 2 - 1, -(normY * 2 - 1));
    this.raycaster.setFromCamera(this.dragNdc, this.activeCam);
    const ray = this.raycaster.ray;
    // une porte ou une fenêtre glisse sur le mur visé
    const wall = this.monde.openingRay(name, [ray.origin.x, ray.origin.y, ray.origin.z], [ray.direction.x, ray.direction.y, ray.direction.z]);
    if (wall) {
      const res = this.monde.dragTo(name, wall.x, wall.z, performance.now(), undefined, wall.bord);
      this.render();
      return res;
    }
    if (Math.abs(ray.direction.y) < 1e-4) return null;
    const t = (this.dragPlaneY - ray.origin.y) / ray.direction.y;
    if (t <= 0) return null;
    const res = this.monde.dragTo(name, ray.origin.x + ray.direction.x * t, ray.origin.z + ray.direction.z * t, performance.now(), ry);
    this.render();
    return res;
  }

  /** Cap affiché d'une instance du monde (radians). */
  headingOf(name: string): number {
    return this.monde.headingOf(name);
  }

  /** Fin du glisser ; `moved` : l'objet a bougé (résultat publié, conflits recalculés). */
  dragEnd(name: string, moved: boolean) {
    if (this.controls) this.controls.enabled = true;
    if (!moved) return;
    this.monde.dropped(name);
    this.render();
  }
  private dragPlaneY = 0;
  private dragNdc = new THREE.Vector2();
  setHoverAt(
    normX: number,
    normY: number,
    names?: string,
    highlight = true,
  ): SceneHit | null {
    return ops.setHoverAt(this.asOpsCtx(), normX, normY, names, highlight);
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
    this.nodes.dispose();
    this.monde.dispose();
    this.postFx.dispose();
    ops.dispose(this.asOpsCtx(), loseContext);
  }

  private asTuneCtx = () => this as unknown as TuneCtx;
  private asViewCtx = () => this as unknown as ViewCtx;
  private asOpsCtx = () => this as unknown as OpsCtx;
}
