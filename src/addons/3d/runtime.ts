import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Sonic3dCameraMode } from "./constants";
import { EYE_FOV, EyeNav } from "./eye";
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
import { PhotoMode } from "./photo";
import { GradePass } from "./grade-pass";
import type { Lumiere } from "../../shared/monde/ambiance";
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
  /** Rendu photo (lancer de rayons à l'arrêt), réglé par `monde.photo`. */
  readonly photo: PhotoMode;
  /** Étalonnage du monde (ambiance, `etalonnage`). */
  private grade = new GradePass();
  private lightsSaved: { i: number; c: THREE.Color; p: THREE.Vector3 }[] | null = null;
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
    this.photo = new PhotoMode(this.renderer, () => this.render());
    this.photo.envSource = () => this.monde.photoEnv(this.mondeData);
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
    // à hauteur d'yeux, les bornes d'orbite sont gardées pour la sortie, pas appliquées
    if (this.isEye) this.limits = { ...this.limits, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v != null && Number.isFinite(v as number))) };
    else tune.setOrbitLimits(this.asTuneCtx(), opts);
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
    const prev = this.mode;
    view.applyCameraMode(this.asViewCtx(), mode);
    tune.setDamping(this.asTuneCtx(), this.damping);
    // champ plus large dans la pièce, celui de l'attribut dehors
    this.perspCam.fov = mode === Sonic3dCameraMode.Eye ? Math.max(this.fov, EYE_FOV) : this.fov;
    this.perspCam.updateProjectionMatrix();
    // entrer dans la pièce, ou en ressortir pour la revoir en entier
    if (mode === Sonic3dCameraMode.Eye && this._ready) this.eye.enter(this.eyeCtx());
    else if (prev === Sonic3dCameraMode.Eye && mode !== prev && this._ready) this.fitToContent();
  }

  /**
   * Position à l'écran (pixels CSS, depuis le coin haut gauche) du haut de l'objet sélectionné, `null` sans sélection
   * ou s'il est derrière la caméra : de quoi poser une bulle au-dessus de lui (slot `selection` de sonic-3d).
   */
  selectionScreen(): { x: number; y: number } | null {
    if (!this.mondeData) return null;
    const p = this.monde.selectionPoint();
    if (!p) return null;
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(this.activeCam);
    if (v.z > 1 || v.z < -1) return null;
    return { x: ((v.x + 1) / 2) * this.lastCssW, y: ((1 - v.y) / 2) * this.lastCssH };
  }

  /* ---------------------------------------------------------------- à hauteur d'yeux */

  private eye = new EyeNav();
  private eyeCtx = () => ({ activeCam: this.activeCam, controls: this.controls, contour: this.mondeData?.contour ?? null, entry: this.eyeEntry(), center: this.bbox.isEmpty() ? new THREE.Vector3() : this.bbox.getCenter(new THREE.Vector3()) });
  /** Première porte du monde (mètres) : là où l'on entre dans la pièce. */
  private eyeEntry(): { x: number; z: number; nx: number; nz: number } | null {
    const m = this.mondeData;
    if (!m) return null;
    const name = Object.keys(m.openings).find((n) => /^porte/.test(n));
    if (!name) return null;
    const o = m.openings[name];
    const e = m.edges.find((q) => q.bord === o.bord);
    if (!e) return null;
    const c = o.at * m.unit - e.L / 2;
    return { x: e.m[0] + e.l[0] * c, z: e.m[1] + e.l[1] * c, nx: e.n[0], nz: e.n[1] };
  }
  /** Vrai en vue à hauteur d'yeux. */
  get isEye(): boolean {
    return this.mode === Sonic3dCameraMode.Eye;
  }
  /** Hauteur des yeux (m). */
  setEyeHeight(h: number) {
    if (Number.isFinite(h) && h > 0.3 && h < 3) this.eye.height = h;
  }
  /** Tap à hauteur d'yeux : va au point du sol visé (vrai si le sol est sous le pointeur). */
  eyeGoAt(normX: number, normY: number): boolean {
    if (!this.isEye) return false;
    this.dragNdc.set(normX * 2 - 1, -(normY * 2 - 1));
    this.raycaster.setFromCamera(this.dragNdc, this.activeCam);
    const ray = this.raycaster.ray;
    if (ray.direction.y > -1e-3) return false;
    const t = -ray.origin.y / ray.direction.y;
    this.eye.goTo(this.eyeCtx(), ray.origin.x + ray.direction.x * t, ray.origin.z + ray.direction.z * t);
    return true;
  }
  /** Avance (`n` > 0) ou recule de `n` pas. */
  eyeStep(n: number) {
    if (this.isEye) this.eye.step(this.eyeCtx(), n);
  }
  /** Tourne le regard (radians, positif : à gauche). */
  eyeTurn(rad: number) {
    if (this.isEye) this.eye.turn(this.eyeCtx(), rad);
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
      this.photo.configure(null);
      this.grade.set(null, "", 0);
      this.applyLumiere(null);
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
    this.monde.applySky(this.scene, m, this.renderer);
    // le style toon n'a pas d'équivalent physique : pas de photo
    this.photo.configure(m.look === "toon" ? null : m.photo);
    this.grade.set(m.grade, m.ciel, m.brume);
    this.applyLumiere(m.lumiere);
    this.photo.invalidate();
    if (first && fit && this.fitEnabled) {
      loadOps.updateBBox(this as never);
      this.fitToContent();
    } else loadOps.updateBBox(this as never);
  }

  /** Lumière du monde (ambiance, `lumiere`) sur l'éclairage par défaut [ambiante, principale, appoint] ; null : rendue. */
  private applyLumiere(l: Lumiere | null) {
    const [amb, key, fill] = this.lights as [THREE.AmbientLight, THREE.DirectionalLight, THREE.DirectionalLight];
    if (!amb || !key) return;
    if (!l) {
      if (this.lightsSaved) {
        this.lights.forEach((li, i) => {
          const s = this.lightsSaved![i];
          if (!s) return;
          li.intensity = s.i;
          li.color.copy(s.c);
          li.position.copy(s.p);
        });
        this.lightsSaved = null;
      }
      return;
    }
    this.lightsSaved ??= this.lights.map((li) => ({ i: li.intensity, c: li.color.clone(), p: li.position.clone() }));
    amb.intensity = l.ambiante;
    amb.color.set(l.couleurAmbiante);
    key.intensity = l.intensite;
    key.color.set(l.couleur);
    const h = THREE.MathUtils.degToRad(l.hauteur), a = THREE.MathUtils.degToRad(l.azimut);
    key.position.set(Math.cos(h) * Math.sin(a) * 8, Math.sin(h) * 8, Math.cos(h) * Math.cos(a) * 8);
    if (fill) fill.intensity = l.intensite * 0.25;
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
    // à hauteur d'yeux, « cadrer » veut dire se replacer dans la pièce
    if (this.isEye) {
      this.eye.enter(this.eyeCtx());
      return;
    }
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
    if (this.isEye) this.eye.tick(this.eyeCtx(), now);
    this.controls?.update();
    if (this.mondeData) this.monde.texAdapt.scan(this.monde.group, this.activeCam, this.lastCssH * this.renderer.getPixelRatio(), now);
    if (this.photo.enabled && this.photo.frame(this.scene, this.activeCam, this.raster, now)) return;
    this.raster();
  }
  private raster = () => {
    if (this.grade.enabled && !this.postFx.isEnabled) {
      this.grade.render(this.renderer, this.scene, this.activeCam, performance.now() / 1000);
      return;
    }
    if (this.postFx.isEnabled) {
      this.postFx.render(this.scene, this.activeCam, this.postFrame);
    } else {
      this.renderer.render(this.scene, this.activeCam);
    }
  };
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
    this.monde.grab(name);
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
    this.monde.release(name);
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
    this.photo.dispose();
    this.grade.dispose();
    ops.dispose(this.asOpsCtx(), loseContext);
  }

  private asTuneCtx = () => this as unknown as TuneCtx;
  private asViewCtx = () => this as unknown as ViewCtx;
  private asOpsCtx = () => this as unknown as OpsCtx;
}
