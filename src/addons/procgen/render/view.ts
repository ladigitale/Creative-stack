/**
 * `ProcgenView` : rendu three.js d'un `SceneModel`, acteurs animés, sélection, événements de jeu.
 *
 * Passes : ombre (profondeur, seulement quand la scène ou un acteur bouge) → scène en MRT avec MSAA ×4
 * (couleur + normales/profondeur/id) → image de base (ciel, contours, papier, grain, vignette, sRGB) → pile d'effets
 * `post` facultative (`poststack.ts`, dans l'ordre donné), absente quand `post` est vide : l'image de base va alors
 * directement à l'écran.
 * Rendu à la demande : aucune image tant que rien ne bouge ; densité de pixels adaptée à la charge.
 */
import { encodeRoleFinishes } from "../style/finishes";
import * as THREE from "three";
import { BallWorld } from "../scene/balls";
import { type M4, type V3, clamp, m4Point, sub } from "../core/math";
import { type ActorModel, type ObjectInfo, type SceneModel, type Zone, groundHeight, reachOf } from "../scene/compose";
import { ACTIONS, type Action, type MotionState } from "../rig/locomotion";
import { type Motion, motionFor } from "../rig/motion";
import { dualQuat } from "../rig/skeleton";
import { type StyleTokens, resolveColors } from "../style/style";
import { ROLES } from "../style/roles";
import { type CameraMode, DEFAULT_VIEW, type ViewState, applyView, parseView } from "./camera";
import { type MaterialPair, type Shared, makeMaterials, sharedUniforms, toGeometry } from "./materials";
import { horizonScreenY } from "./horizon";
import { MAX_BONES, POST_FRAGMENT, POST_VERTEX } from "./shaders";
import { type Governor, governDpr, keepFrame, newGovernor } from "./steady";
import { PostStack } from "./poststack";
import { SNAP_MARGIN, gridOffset, marginTransform, snapApplicable } from "./pixelsnap";
import type { OrthoFrame, SnapRequest } from "./camera";

export type ActorIntent = { x?: number; z?: number; target?: string; vx?: number; vz?: number; action?: string; speed?: number; run?: boolean; facing?: number; look?: string; mood?: string; /** Coup de pied (cible ballon) : vitesse donnée (m/s) et part verticale. */ power?: number; loft?: number; /** Durée de l'action (s) : `actionEnd` puis repos. */ duration?: number };
export type GameEvent = { type: "pick" | "select" | "arrive" | "blocked" | "enter" | "leave" | "actionEnd" | "kick" | "hit" | "rest" | "place" | "dragstart" | "dragRefused" | "placeFree"; payload: Record<string, unknown> };

/** Objet saisi : de quoi le déplacer sans recomposer (matrice d'instance, sommets de sa tuile, ou acteur). */
type DragRT = {
  o: ObjectInfo;
  pos0: V3;
  yaw0: number;
  anchors0: Record<string, V3>;
  seatYaw0?: Record<string, number>;
  inst?: { im: THREE.InstancedMesh; i: number; m0: THREE.Matrix4 };
  tiles?: { mesh: THREE.Mesh; a: number; b: number; pos0: Float32Array; nrm0: Float32Array }[];
  actor?: ActorRT;
  cur: { x: number; y: number; z: number; yaw: number };
};

type ActorRT = {
  model: ActorModel;
  mesh: THREE.Mesh;
  mats: MaterialPair;
  /** Animation (humanoïde ou animal) : pose, longueur de pas, longueur de jambe. */
  mo: Motion;
  pos: V3;
  yaw: number;
  speed: number;
  phase: number;
  action: Action;
  actionTime: number;
  actionWeight: number;
  mood: string;
  path: [number, number][] | null;
  goal: {
    x: number; z: number; target?: string; seat?: { x: number; y: number; z: number; yaw: number; action?: Action }; kick?: { ball: string; power: number; loft: number; tries?: number };
    /** Boire, manger, dormir à une ancre `spot` : action lancée à l'arrivée, bouche au-dessus de l'ancre. */
    then?: { action: Action; spot: V3 };
  } | null;
  /** Hauteur de la cible (eau, gamelle) au-dessus des pieds pendant `drink` / `eat`. */
  reachY?: number;
  /** Durée demandée pour l'action en cours (s). */
  actionDur?: number;
  /** Hauteur de l'assise occupée (m) : le bassin s'y pose quand l'acteur est assis. */
  seatY?: number;
  /** Point libre devant l'assise, où l'acteur se relève. */
  standAt?: [number, number];
  drive: { vx: number; vz: number } | null;
  wantSpeed: number;
  wanderT: number;
  blinkT: number;
  turn: number;
  zones: Set<string>;
  hidden: boolean;
  lastIntent: string;
};

export class ProcgenView {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private ortho = new THREE.OrthographicCamera();
  private persp = new THREE.PerspectiveCamera();
  private camera: THREE.Camera = this.ortho;
  private shared: Shared = sharedUniforms();
  private roles = { value: new Float32Array(ROLES.length * 3) };
  private staticMats: MaterialPair;
  private model: SceneModel | null = null;
  private style: StyleTokens | null = null;
  private view: ViewState = { ...DEFAULT_VIEW };
  private extent = 20;
  private fitExtent = 20;
  private rt: THREE.WebGLRenderTarget | null = null;
  private shadowRT: THREE.WebGLRenderTarget;
  private post: THREE.Mesh;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private actors = new Map<string, ActorRT>();
  private objectsByObj = new Map<number, ObjectInfo>();
  private pickables: THREE.Object3D[] = [];
  private instanceObjs = new Map<THREE.InstancedMesh, number[]>();
  /** Ballons dynamiques et leur emplacement dans les maillages instanciés. */
  balls: BallWorld | null = null;
  private ballSlots = new Map<number, { im: THREE.InstancedMesh; i: number; m0: M4 }>();
  private dirty = true;
  private shadowDirty = true;
  private time = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  private visible = true;
  dpr = 1;
  maxDpr = 2;
  play = true;
  speed = 1;
  private frameTimes: number[] = [];
  private gov: Governor = newGovernor();
  /** Taille de rendu à appliquer au prochain rendu (jamais hors d'un rendu : `setSize` efface le canevas). */
  private sizeKey = "";
  fps = 0;
  private followId: string | null = null;
  private hiddenIds = new Set<string>();
  private selectedObj = -1;
  onEvent: (e: GameEvent) => void = () => {};
  onFrame: () => void = () => {};
  private disposed = false;
  private drag: DragRT | null = null;
  private settle: { d: DragRT; from: number; to: number; t0: number } | null = null;
  private stack: PostStack;
  private mobile = false;
  /** Distance caméra → point visé (profondeur relative des masques et de l'effet miniature). */
  private focusDist = 1;
  /** Rendu pixel accroché au monde : texels visibles et marge (null sinon). */
  private snapReq: SnapRequest | null = null;
  private frame: OrthoFrame = { a: 0, b: 0, half: 0, rx: 0, ry: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: false });
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.staticMats = makeMaterials(this.shared, this.roles, false);
    // ombres : 4096 sur ordinateur, 2048 sur mobile (écran tactile ou petite fenêtre)
    const mobile = typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches || Math.min(window.screen?.width ?? 2000, window.screen?.height ?? 2000) < 700);
    this.mobile = mobile;
    const SM = mobile ? 2048 : 4096;
    const depthTex = new THREE.DepthTexture(SM, SM);
    depthTex.type = THREE.UnsignedIntType;
    this.shadowRT = new THREE.WebGLRenderTarget(SM, SM, { depthTexture: depthTex, depthBuffer: true });
    this.shared.uShadowMap.value = depthTex;
    (this.shared.uShadowTexel.value as THREE.Vector2).set(1 / SM, 1 / SM);
    const postMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: POST_VERTEX,
      fragmentShader: POST_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: null }, tData: { value: null }, uTexel: { value: new THREE.Vector2() }, uOutline: { value: 1.5 }, uOutlineStrength: { value: 0.8 }, uInk: { value: new THREE.Color() },
        uSkyTop: { value: new THREE.Color() }, uSkyHorizon: { value: new THREE.Color() }, uSkyOn: { value: 1 }, uHorizonY: { value: 0.35 }, uGrain: { value: 0 }, uPaper: { value: 0 }, uVignette: { value: 0 },
        uTime: { value: 0 }, uPixel: { value: 0 }, uResolution: { value: new THREE.Vector2() }, uUvXf: { value: new THREE.Vector4(1, 1, 0, 0) },
      },
    });
    this.post = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat);
    this.post.frustumCulled = false;
    this.postScene.add(this.post);
    this.stack = new PostStack(this.renderer);
  }

  /* ---------------- scène ---------------- */

  setModel(model: SceneModel) {
    // ancien modèle remplacé dans la même tâche : aucune image vide entre les deux
    const first = !this.model;
    this.clearScene();
    this.model = model;
    const b = model.bounds;
    this.fitExtent = Math.max(4, Math.hypot(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2, (b.max[1] - b.min[1]) * 0.8);
    // vue de la recette au premier modèle ; ensuite la vue courante (orbite, pan, zoom de l'utilisateur) et le cadrage
    // sont conservés tant que la taille de la scène ne change pas beaucoup
    this.extent = first ? this.fitExtent : keepFrame(this.extent, this.fitExtent);
    this.shared.uGroundY.value = 0;
    this.shared.uWaterY.value = model.terrain?.spec.water ?? -1000;
    this.shared.uFar.value = this.extent * 6;
    for (const o of model.objects) this.objectsByObj.set(o.obj, o);
    const addStatic = (m: import("../geom/mesh").Mesh | null, pick = true) => {
      if (!m || !m.vertexCount) return;
      const mesh = new THREE.Mesh(toGeometry(m), this.staticMats.color);
      mesh.userData.depth = this.staticMats.depth;
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      if (pick) this.pickables.push(mesh);
    };
    addStatic(model.ground);
    addStatic(model.roads);
    addStatic(model.water);
    for (const t of model.tiles) addStatic(t);
    const bw = new BallWorld(model);
    this.balls = bw.count ? bw : null;
    this.ballSlots.clear();
    this.ballAwake.clear();
    this.ballsDirty = !!this.balls && this.hiddenIds.size > 0;
    if (this.balls) this.balls.hidden = new Set([...this.hiddenIds].filter((id) => this.balls!.byId.has(id)));
    for (const g of model.instances) {
      const geo = toGeometry(g.mesh);
      const im = new THREE.InstancedMesh(geo, this.staticMats.color, g.matrices.length);
      im.userData.depth = this.staticMats.depth;
      const objs = new Float32Array(g.objs);
      geo.setAttribute("aInstObj", new THREE.InstancedBufferAttribute(objs, 1));
      g.matrices.forEach((m, i) => im.setMatrixAt(i, new THREE.Matrix4().fromArray(m as unknown as number[])));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      this.scene.add(im);
      this.pickables.push(im);
      this.instanceObjs.set(im, g.objs);
      if (this.balls) g.objs.forEach((o, i) => this.balls!.byObj.has(o) && this.ballSlots.set(o, { im, i, m0: g.matrices[i] }));
    }
    for (const a of model.actors) this.addActor(a);
    if (first) this.view = parseView(model.view, { ...DEFAULT_VIEW, cy: 0 });
    if (this.style) this.setStyle(this.style);
    this.dirty = this.shadowDirty = true;
    this.kick();
  }

  private addActor(a: ActorModel) {
    const geo = toGeometry(a.asset.mesh);
    geo.setAttribute("aObj", new THREE.Float32BufferAttribute(new Array(a.asset.mesh.vertexCount).fill(a.obj), 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, a.asset.height / 2, 0), a.asset.height * 0.9);
    const roles = { value: new Float32Array(ROLES.length * 3) };
    const mats = makeMaterials(this.shared, roles, true);
    const mesh = new THREE.Mesh(geo, mats.color);
    mesh.userData.depth = mats.depth;
    mesh.userData.actor = a.id;
    this.scene.add(mesh);
    const sk = a.asset.skeleton!;
    const rt: ActorRT = {
      model: a, mesh, mats, mo: motionFor(a.asset), pos: [...a.pos], yaw: a.yaw, speed: 0, phase: Math.random(), action: a.action, actionTime: 0, actionWeight: a.action === "idle" ? 0 : 1,
      mood: String(a.params.mood ?? "neutral"), path: null, goal: null, drive: null, wantSpeed: 0, wanderT: 1 + (a.seed % 5), blinkT: 1 + (a.seed % 3), turn: 0, zones: new Set(), hidden: false, lastIntent: "",
      seatY: a.seatY, standAt: a.standAt, reachY: a.reachY,
    };
    this.actors.set(a.id, rt);
    this.poseActor(rt, 0);
  }

  private clearScene() {
    this.drag = null;
    this.settle = null;
    for (const o of [...this.scene.children]) {
      this.scene.remove(o);
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      if (m.material && m.material !== this.staticMats.color) (m.material as THREE.Material).dispose();
      (m.userData.depth as THREE.Material | undefined)?.dispose?.();
    }
    this.actors.clear();
    this.objectsByObj.clear();
    this.pickables = [];
    this.instanceObjs.clear();
  }

  /* ---------------- style ---------------- */

  setStyle(s: StyleTokens) {
    this.style = s;
    const c = resolveColors(s);
    this.roles.value.set(c.roles);
    for (const a of this.actors.values()) a.mats.uniforms.uRoles.value.set(resolveColors(s, a.model.asset.colors).roles);
    const D = Math.PI / 180;
    const az = s.lightAzimuth * D, el = clamp(s.lightElevation, 3, 89) * D;
    (this.shared.uSunDir.value as THREE.Vector3).set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
    const k = s.lightIntensity * (1 - s.night * 0.55);
    (this.shared.uSun.value as THREE.Color).setRGB(c.sun[0] * k * 1.05, c.sun[1] * k * 1.05, c.sun[2] * k * 1.05);
    (this.shared.uAmbSky.value as THREE.Color).setRGB(...c.ambientSky);
    (this.shared.uAmbGround.value as THREE.Color).setRGB(...c.ambientGround);
    (this.shared.uFogColor.value as THREE.Color).setRGB(...c.skyHorizon);
    this.shared.uFog.value = s.fog;
    this.shared.uFogHeight.value = s.fogHeight;
    this.shared.uShading.value = { flat: 0, toon: 1, soft: 2, lit: 3 }[s.shading];
    this.shared.uBands.value = s.bands;
    this.shared.uBandSoft.value = s.bandSoftness;
    this.shared.uBrush.value = s.brush;
    this.shared.uAOStrength.value = s.ao;
    this.shared.uTexture.value = s.texture;
    this.shared.uNight.value = s.night;
    this.shared.uLamps.value = s.lamps;
    this.shared.uRim.value = s.rim;
    this.shared.uDetail.value = s.detail;
    (this.shared.uRoleMat.value as Float32Array).set(encodeRoleFinishes(s.finishes));
    this.shared.uShadowStrength.value = s.shadows ? s.shadowStrength : 0;
    const pu = (this.post.material as THREE.ShaderMaterial).uniforms;
    pu.uOutline.value = s.outline;
    pu.uOutlineStrength.value = s.outlineStrength;
    const ink = c.roles.slice(27 * 3, 27 * 3 + 3);
    (pu.uInk.value as THREE.Color).setRGB(ink[0], ink[1], ink[2]);
    (pu.uSkyTop.value as THREE.Color).setRGB(...c.skyTop);
    (pu.uSkyHorizon.value as THREE.Color).setRGB(...c.skyHorizon);
    pu.uSkyOn.value = s.sky ? 1 : 0;
    pu.uGrain.value = s.grain;
    pu.uPaper.value = s.paper;
    pu.uVignette.value = s.vignette;
    // style pixel : obtenu par la cible de rendu basse résolution (voir applySize), pas par le post-traitement
    pu.uPixel.value = 0;
    this.stack.set(s.post, s.postQuality === "low" || (s.postQuality === "auto" && this.mobile));
    this.dirty = this.shadowDirty = true;
    this.resize();
    this.kick();
  }

  /** `reset` : repart de la vue par défaut (et du cadrage de la scène) au lieu de fusionner avec la vue courante. */
  setView(v: unknown, reset = false) {
    if (reset) this.extent = this.fitExtent;
    this.view = parseView(v, reset ? { ...DEFAULT_VIEW, cy: 0 } : this.view);
    this.followId = this.view.camera === "follow" ? String((v as Record<string, unknown>)?.actor ?? this.followId ?? [...this.actors.keys()][0] ?? "") : null;
    this.dirty = true;
    this.kick();
  }
  getView(): ViewState {
    return { ...this.view };
  }
  get cameraMode(): CameraMode {
    return this.view.camera;
  }

  /** Pan / zoom / rotation par l'utilisateur (déplacement en pixels). */
  interact(kind: "pan" | "rotate" | "zoom", dx: number, dy = 0) {
    const v = this.view;
    if (kind === "zoom") v.zoom = clamp(v.zoom * Math.exp(-dx * 0.0015), 0.15, 12);
    else if (kind === "rotate" && (v.camera === "perspective" || v.camera === "iso" || v.camera === "follow")) {
      v.yaw -= dx * 0.3;
      if (v.camera !== "iso") v.pitch = clamp(v.pitch + dy * 0.25, 4, 85);
    } else {
      const h = this.canvas.clientHeight || 1;
      const scale = ((this.extent * 1.24) / v.zoom) / h;
      const cam = this.camera;
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      if (v.camera === "perspective" || v.camera === "iso" || v.camera === "top") {
        up.y = 0;
        up.normalize();
        if (v.camera === "perspective") up.multiplyScalar(-1).negate();
      }
      v.cx -= right.x * dx * scale - up.x * dy * scale;
      v.cy += v.camera === "side" || v.camera === "front" || v.camera === "oblique" ? dy * scale : 0;
      v.cz -= right.z * dx * scale - up.z * dy * scale;
    }
    this.dirty = true;
    this.kick();
  }

  setAnim(a: { play?: boolean; speed?: number; time?: number }) {
    if (a.play !== undefined) this.play = !!a.play;
    if (Number.isFinite(a.speed)) this.speed = clamp(Number(a.speed), 0, 4);
    if (Number.isFinite(a.time)) this.time = Number(a.time);
    this.dirty = true;
    this.kick();
  }

  setHidden(ids: string[]) {
    this.hiddenIds = new Set(ids);
    for (const [id, a] of this.actors) a.mesh.visible = !this.hiddenIds.has(id);
    if (this.balls) {
      this.balls.hidden = new Set(ids.filter((id) => this.balls!.byId.has(id)));
      this.ballsDirty = true;
    }
    this.dirty = this.shadowDirty = true;
    this.kick();
  }

  select(objectId: string | null) {
    const o = objectId ? this.model?.objects.find((x) => x.id === objectId) : null;
    this.selectedObj = o?.obj ?? -1;
    this.shared.uIdBase.value = this.selectedObj;
    this.shared.uHighlight.value = this.selectedObj > 0 ? 1 : 0;
    this.dirty = true;
    this.kick();
    return o ?? null;
  }

  /** Intentions d'acteurs écrites par le jeu (jamais à 60 Hz : le composant interpole). */
  setActors(intents: Record<string, ActorIntent>) {
    for (const [id, it] of Object.entries(intents ?? {})) {
      const a = this.actors.get(id);
      if (!a || !it || typeof it !== "object") continue;
      const sig = JSON.stringify(it);
      if (sig === a.lastIntent) continue;
      a.lastIntent = sig;
      if (it.mood) a.mood = String(it.mood);
      const toSeat = typeof it.target === "string" && /\.sit\.\d+$/.test(it.target);
      const toBall = typeof it.target === "string" && !!this.balls?.byId.get(it.target);
      // boire, manger, dormir vers une cible : l'action commence à l'arrivée
      const atTarget = typeof it.target === "string" && !toBall && (it.action === "drink" || it.action === "eat" || it.action === "sleep");
      a.actionDur = Number.isFinite(it.duration) && Number(it.duration) > 0 ? Number(it.duration) : undefined;
      // en route vers une place (ou un ballon), l'acteur marche : il ne s'assied (ou ne tire) qu'à l'arrivée
      if (it.action && !(toSeat && it.action === "sit") && !atTarget && !(toBall && it.action === "kick") && (ACTIONS as readonly string[]).includes(it.action) && it.action !== "walk" && it.action !== "run") {
        if (a.action !== it.action) {
          if (it.action !== "sit") this.standUp(a);
          a.action = it.action as Action;
          a.actionTime = 0;
        }
      } else if (it.action === "idle") {
        this.standUp(a);
        a.action = "idle";
      }
      const run = it.run || it.action === "run";
      a.wantSpeed = Number.isFinite(it.speed) ? Number(it.speed) : run ? 3.6 * a.mo.legLength / 0.85 : 1.35 * a.mo.legLength / 0.85;
      if (Number.isFinite(it.vx) || Number.isFinite(it.vz)) {
        this.standUp(a);
        a.drive = { vx: Number(it.vx) || 0, vz: Number(it.vz) || 0 };
        a.goal = null;
        a.path = null;
      } else if (it.target || Number.isFinite(it.x) || Number.isFinite(it.z)) {
        let x = Number(it.x ?? a.pos[0]), z = Number(it.z ?? a.pos[2]);
        let seat: { x: number; y: number; z: number; yaw: number } | undefined;
        let kick: { ball: string; power: number; loft: number } | undefined;
        let then: { action: Action; spot: V3 } | undefined;
        const ball = typeof it.target === "string" ? this.balls?.byId.get(it.target) : undefined;
        if (ball) {
          // derrière le ballon, sur la ligne acteur → ballon ; le coup part à l'arrivée
          const dx = ball.pos[0] - a.pos[0], dz = ball.pos[2] - a.pos[2], d = Math.hypot(dx, dz) || 1;
          const back = ball.r + 0.32 * a.mo.legLength;
          x = ball.pos[0] - (dx / d) * back;
          z = ball.pos[2] - (dz / d) * back;
          if (it.action === "kick" || it.power !== undefined) kick = { ball: ball.id, power: Math.max(0, Math.min(30, Number.isFinite(it.power) ? Number(it.power) : 7)), loft: Math.max(0, Math.min(1.5, Number.isFinite(it.loft) ? Number(it.loft) : 0.15)) };
        } else if (it.target) {
          const o = this.model?.objects.find((ob) => ob.id === it.target || it.target!.startsWith(ob.id + "."));
          if (o) {
            const an = it.target.slice(o.id.length + 1);
            // place assise : on marche jusqu'à l'ancre « approach.N » (devant), puis on s'assied sur « sit.N »
            const sm = /^sit\.(\d+)$/.exec(an);
            const sp = sm ? o.anchors[an] : undefined;
            if (sp) seat = { x: sp[0], y: sp[1] - o.pos[1], z: sp[2], yaw: o.seatYaw?.[an] ?? o.yaw, ...(it.action === "sleep" ? { action: "sleep" as Action } : {}) };
            // point d'eau, gamelle : `spot.N` (ou le plus proche si la cible est l'objet seul), on arrive par `approach.N`
            let sa = an;
            if (!sa && atTarget && !o.anchors.door) {
              const spots = Object.keys(o.anchors).filter((k) => /^spot(\.\d+)?$/.test(k));
              sa = spots.sort((u, v) => Math.hypot(o.anchors[u][0] - a.pos[0], o.anchors[u][2] - a.pos[2]) - Math.hypot(o.anchors[v][0] - a.pos[0], o.anchors[v][2] - a.pos[2]))[0] ?? "";
            }
            const spm = /^spot(?:\.(\d+))?$/.exec(sa);
            const ap = spm ? o.anchors[spm[1] !== undefined ? `approach.${spm[1]}` : "approach"] : undefined;
            if (spm && atTarget) then = { action: it.action as Action, spot: o.anchors[sa] };
            const p = (sm && o.anchors[`approach.${sm[1]}`]) || ap || (sa && o.anchors[sa]) || o.anchors.door || o.pos;
            [x, z] = [p[0], p[2]];
          }
        }
        this.goto(a, x, z, it.target);
        if (a.goal && seat) a.goal.seat = seat;
        if (a.goal && kick) a.goal.kick = kick;
        if (a.goal && then) a.goal.then = then;
      }
      if (Number.isFinite(it.facing) && !a.goal && !a.drive) a.yaw = (Number(it.facing) * Math.PI) / 180;
    }
    this.kick();
  }

  /** Tir : l'acteur se tourne vers le ballon, lance le geste, le ballon part dans cette direction. */
  private doKick(a: ActorRT, k: { ball: string; power: number; loft: number; tries?: number }) {
    const b = this.balls?.byId.get(k.ball);
    if (!b) return;
    const dx = b.pos[0] - a.pos[0], dz = b.pos[2] - a.pos[2], d = Math.hypot(dx, dz) || 1;
    // le ballon a roulé entre-temps : l'acteur le rattrape (3 essais), sinon `blocked`
    const back = b.r + 0.32 * a.mo.legLength;
    if (d > back + 0.25) {
      const tries = (k.tries ?? 0) + 1;
      if (tries > 3) {
        this.onEvent({ type: "blocked", payload: { actor: a.model.id, reason: "ball-moved", target: b.id } });
        return;
      }
      this.goto(a, b.pos[0] - (dx / d) * back, b.pos[2] - (dz / d) * back, b.id);
      if (a.goal) a.goal.kick = { ...k, tries };
      return;
    }
    a.yaw = Math.atan2(dx, dz);
    a.action = "kick";
    a.actionTime = 0;
    this.balls!.kick(b.id, [(dx / d) * k.power, k.power * k.loft, (dz / d) * k.power]);
    this.onEvent({ type: "kick", payload: { actor: a.model.id, ball: b.id, power: k.power } });
  }

  /** Coup donné à un ballon sans acteur (`kick` du DataProvider) : vitesse en m/s. */
  kickBall(id: string, v: [number, number, number]): boolean {
    const ok = !!this.balls?.kick(id, v);
    if (ok) {
      this.onEvent({ type: "kick", payload: { actor: null, ball: id } });
      this.kick();
    }
    return ok;
  }

  /** Position et mouvement des ballons (publiés dans l'état). */
  ballState() {
    return this.balls?.snapshot() ?? {};
  }

  /** Quitte une place assise : retour au point libre devant l'assise (sinon l'acteur resterait dans l'obstacle). */
  private standUp(a: ActorRT) {
    if (a.standAt) {
      a.pos[0] = a.standAt[0];
      a.pos[2] = a.standAt[1];
      if (a.action === "sit" || (a.action === "sleep" && (a.seatY ?? 0) > 0)) a.action = "idle";
    }
    a.seatY = 0;
    a.standAt = undefined;
    a.reachY = undefined;
  }

  private goto(a: ActorRT, x: number, z: number, target?: string) {
    this.standUp(a);
    a.drive = null;
    const nav = this.model?.nav;
    const p = nav ? nav.path([a.pos[0], a.pos[2]], [x, z]) : [[a.pos[0], a.pos[2]], [x, z]] as [number, number][];
    if (!p) {
      a.goal = null;
      a.path = null;
      this.onEvent({ type: "blocked", payload: { actor: a.model.id, reason: "no-path", x, z, target: target ?? null } });
      return;
    }
    a.path = p.slice(1);
    a.goal = { x, z, target };
  }

  /* ---------------- édition au doigt ---------------- */

  /** Point du plan horizontal `y` sous le pointeur (mètres), `null` si le rayon ne le coupe pas devant la caméra. */
  groundPoint(clientX: number, clientY: number, y: number): [number, number] | null {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / Math.max(1, r.width)) * 2 - 1, -((clientY - r.top) / Math.max(1, r.height)) * 2 + 1);
    const o = new THREE.Vector3(ndc.x, ndc.y, -1).unproject(this.camera);
    const e = new THREE.Vector3(ndc.x, ndc.y, 1).unproject(this.camera);
    const d = e.sub(o);
    if (Math.abs(d.y) < 1e-9) return null;
    const t = (y - o.y) / d.y;
    if (!(t > 0)) return null;
    return [o.x + d.x * t, o.z + d.z * t];
  }

  /** Saisit un objet (instancié, fusionné dans sa tuile, ou acteur) ; faux si l'objet ne se déplace pas ainsi. */
  dragBegin(objectId: string): boolean {
    this.finishSettle();
    const o = this.model?.objects.find((x) => x.id === objectId);
    if (!o || o.generator === "ball") return false;
    const d: DragRT = { o, pos0: [...o.pos], yaw0: o.yaw, anchors0: Object.fromEntries(Object.entries(o.anchors).map(([k, v]) => [k, [...v] as V3])), ...(o.seatYaw ? { seatYaw0: { ...o.seatYaw } } : {}), cur: { x: o.pos[0], y: o.pos[1], z: o.pos[2], yaw: o.yaw } };
    if (o.mode === "actor") {
      const a = this.actors.get(o.id);
      if (!a) return false;
      d.actor = a;
      d.pos0 = [...a.pos];
      d.yaw0 = a.yaw;
      d.cur = { x: a.pos[0], y: a.pos[1], z: a.pos[2], yaw: a.yaw };
    } else if (o.mode === "instance") {
      for (const [im, objs] of this.instanceObjs) {
        const i = objs.indexOf(o.obj);
        if (i < 0) continue;
        const m0 = new THREE.Matrix4();
        im.getMatrixAt(i, m0);
        d.inst = { im, i, m0 };
        break;
      }
      if (!d.inst) return false;
    } else {
      d.tiles = [];
      for (const ob of this.pickables) {
        const mesh = ob as THREE.Mesh;
        if ((mesh as unknown as THREE.InstancedMesh).isInstancedMesh) continue;
        const attr = mesh.geometry?.getAttribute("aObj");
        if (!attr) continue;
        const ids = attr.array as ArrayLike<number>;
        let a = -1, b = -1;
        for (let k = 0; k < ids.length; k++) if (Math.abs(ids[k] - o.obj) < 0.5) (a < 0 && (a = k), (b = k));
        if (a < 0) continue;
        const pos = mesh.geometry.getAttribute("position").array as Float32Array, nrm = mesh.geometry.getAttribute("normal").array as Float32Array;
        d.tiles.push({ mesh, a, b: b + 1, pos0: pos.slice(a * 3, (b + 1) * 3), nrm0: nrm.slice(a * 3, (b + 1) * 3) });
        mesh.frustumCulled = false;
      }
      if (!d.tiles.length) return false;
    }
    this.drag = d;
    this.shared.uIdBase.value = o.obj;
    this.shared.uHighlight.value = 1;
    return true;
  }

  /** Pose courante de l'objet saisi (position de sa base, cap en radians) ; `invalid` : fantôme rouge. */
  dragTo(x: number, y: number, z: number, yaw: number, invalid = false) {
    const d = this.drag;
    if (!d) return;
    this.applyPose(d, x, y, z, yaw);
    this.shared.uHighlight.value = invalid ? 2 : 1;
    this.dirty = this.shadowDirty = true;
    this.kick();
  }

  /** Lâcher : `to` = pose finale (l'objet y retombe avec un petit rebond) ; `null` = retour à la place de départ. */
  dragEnd(to: { x: number; y: number; z: number; yaw: number } | null) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const fin = to ?? { x: d.pos0[0], y: d.pos0[1], z: d.pos0[2], yaw: d.yaw0 };
    this.applyPose(d, fin.x, d.cur.y, fin.z, fin.yaw);
    this.settle = { d, from: d.cur.y, to: fin.y, t0: performance.now() };
    this.select(this.selectedObj > 0 ? this.objectsByObj.get(this.selectedObj)?.id ?? null : null);
    this.dirty = this.shadowDirty = true;
    this.kick();
  }

  private stepSettle(now: number) {
    const s = this.settle!;
    const u = (now - s.t0) / 200;
    const y = u >= 1 ? s.to : s.to + (s.from - s.to) * (1 - u) * (1 - u) - Math.sin(Math.PI * u) * Math.min(0.015, Math.abs(s.from - s.to) * 0.25);
    this.applyPose(s.d, s.d.cur.x, y, s.d.cur.z, s.d.cur.yaw);
    this.dirty = this.shadowDirty = true;
    if (u >= 1) this.finishSettle();
  }

  private finishSettle() {
    const s = this.settle;
    if (!s) return;
    this.settle = null;
    this.applyPose(s.d, s.d.cur.x, s.to, s.d.cur.z, s.d.cur.yaw);
    for (const t of s.d.tiles ?? []) {
      t.mesh.geometry.computeBoundingSphere();
      t.mesh.geometry.computeBoundingBox();
      t.mesh.frustumCulled = true;
    }
    s.d.inst?.im.computeBoundingSphere();
  }

  /** Place l'objet saisi : (x, y, z) = position de sa base, `yaw` = cap ; ancres et infos suivent. */
  private applyPose(d: DragRT, x: number, y: number, z: number, yaw: number) {
    d.cur = { x, y, z, yaw };
    const da = yaw - d.yaw0;
    const c = Math.cos(da), s = Math.sin(da);
    const [px, py, pz] = d.pos0;
    const move = (vx: number, vy: number, vz: number): V3 => {
      const lx = vx - px, lz = vz - pz;
      return [x + lx * c + lz * s, y + (vy - py), z - lx * s + lz * c];
    };
    if (d.actor) {
      const a = d.actor;
      a.pos = [x, y, z];
      a.yaw = yaw;
      a.path = null;
      a.goal = null;
      a.speed = 0;
      this.poseActor(a, 0);
    } else if (d.inst) {
      const D = new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeRotationY(da)).multiply(new THREE.Matrix4().makeTranslation(-px, -py, -pz));
      d.inst.im.setMatrixAt(d.inst.i, D.multiply(d.inst.m0));
      d.inst.im.instanceMatrix.needsUpdate = true;
    } else
      for (const t of d.tiles ?? []) {
        const pa = t.mesh.geometry.getAttribute("position") as THREE.BufferAttribute, na = t.mesh.geometry.getAttribute("normal") as THREE.BufferAttribute;
        const P = pa.array as Float32Array, N = na.array as Float32Array;
        for (let k = 0; k < t.pos0.length; k += 3) {
          const q = move(t.pos0[k], t.pos0[k + 1], t.pos0[k + 2]);
          P[t.a * 3 + k] = q[0];
          P[t.a * 3 + k + 1] = q[1];
          P[t.a * 3 + k + 2] = q[2];
          const nx = t.nrm0[k], nz = t.nrm0[k + 2];
          N[t.a * 3 + k] = nx * c + nz * s;
          N[t.a * 3 + k + 1] = t.nrm0[k + 1];
          N[t.a * 3 + k + 2] = -nx * s + nz * c;
        }
        pa.clearUpdateRanges?.();
        pa.addUpdateRange?.(t.a * 3, t.pos0.length);
        pa.needsUpdate = true;
        na.clearUpdateRanges?.();
        na.addUpdateRange?.(t.a * 3, t.nrm0.length);
        na.needsUpdate = true;
      }
    const o = d.o;
    o.pos = [x, y, z];
    o.yaw = yaw;
    for (const [k, v] of Object.entries(d.anchors0)) o.anchors[k] = move(v[0], v[1], v[2]);
    if (d.seatYaw0) for (const [k, v] of Object.entries(d.seatYaw0)) o.seatYaw![k] = v + da;
  }

  /** Objet saisi (id) ou `null`. */
  get dragging(): string | null {
    return this.drag?.o.id ?? null;
  }

  /* ---------------- sélection ---------------- */

  pick(clientX: number, clientY: number): { objectId: string | null; generator: string | null; layer: string | null; x: number; y: number; z: number; actor: string | null; zone: string | null } | null {
    if (!this.model) return null;
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    if (this.view.camera === "oblique") {
      // la caméra cavalière cisaille la projection : rayon reconstruit depuis la matrice inverse
      const o = new THREE.Vector3(ndc.x, ndc.y, -1).unproject(this.camera);
      const e = new THREE.Vector3(ndc.x, ndc.y, 1).unproject(this.camera);
      ray.set(o, e.sub(o).normalize());
    }
    let actorHit: { id: string; d: number } | null = null;
    for (const [id, a] of this.actors) {
      if (!a.mesh.visible) continue;
      const base = new THREE.Vector3(a.pos[0], a.pos[1], a.pos[2]);
      const top = base.clone().add(new THREE.Vector3(0, a.model.asset.height, 0));
      const pt = new THREE.Vector3(), seg = new THREE.Vector3();
      const d2 = ray.ray.distanceSqToSegment(base, top, pt, seg);
      if (d2 < (a.model.asset.footprint.r * 0.9) ** 2) {
        const d = pt.distanceTo(ray.ray.origin);
        if (!actorHit || d < actorHit.d) actorHit = { id, d };
      }
    }
    const hits = ray.intersectObjects(this.pickables, false);
    let obj: ObjectInfo | null = null;
    let point = hits[0]?.point ?? null;
    for (const h of hits) {
      if ((h.object as THREE.InstancedMesh).isInstancedMesh && h.instanceId !== undefined) {
        const objs = this.instanceObjs.get(h.object as THREE.InstancedMesh);
        obj = objs ? this.objectsByObj.get(objs[h.instanceId]) ?? null : null;
      } else if (h.face) {
        const id = (h.object as THREE.Mesh).geometry.getAttribute("aObj").getX(h.face.a);
        obj = this.objectsByObj.get(Math.round(id)) ?? null;
      }
      point = h.point;
      break;
    }
    if (actorHit && (!hits[0] || actorHit.d < hits[0].distance)) {
      const a = this.actors.get(actorHit.id)!;
      obj = this.model.objects.find((o) => o.id === actorHit!.id) ?? null;
      point = new THREE.Vector3(a.pos[0], a.pos[1], a.pos[2]);
    }
    if (!point) return { objectId: null, generator: null, layer: null, x: 0, y: 0, z: 0, actor: null, zone: null };
    const zone = this.zoneAt(point.x, point.z);
    return { objectId: obj?.id ?? null, generator: obj?.generator ?? null, layer: obj?.layer ?? null, x: round(point.x), y: round(point.y), z: round(point.z), actor: actorHit && obj?.mode === "actor" ? obj.id : null, zone: zone?.id ?? null };
  }

  private zoneAt(x: number, z: number): Zone | null {
    for (const zn of this.model?.zones ?? []) {
      if (zn.box ? x >= zn.box[0] && x <= zn.box[2] && z >= zn.box[1] && z <= zn.box[3] : Math.hypot(x - zn.x, z - zn.z) <= zn.r) return zn;
    }
    return null;
  }

  /** Positions écran d'ancres (`"hero@head.top"`, `"maisons.2@door"`) en pixels CSS. */
  anchors(list: string[]): Record<string, { x: number; y: number; visible: boolean }> {
    const out: Record<string, { x: number; y: number; visible: boolean }> = {};
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    for (const key of list.slice(0, 32)) {
      const [id, an = "head.top"] = key.split("@");
      let p: V3 | null = null;
      const a = this.actors.get(id);
      if (a) {
        const anc = a.model.asset.anchors[an];
        if (anc && a.mesh.userData.world) {
          const sk = a.model.asset.skeleton!;
          const bi = sk.index[anc.bone ?? "root"] ?? 0;
          const W = (a.mesh.userData.world as Float64Array[])[bi];
          const local = m4Point(W, sub(anc.pos, sk.bones[bi].head));
          const v = new THREE.Vector3(...local).applyMatrix4(a.mesh.matrixWorld);
          p = [v.x, v.y, v.z];
        }
      } else {
        const o = this.model?.objects.find((ob) => ob.id === id);
        if (o) p = o.anchors[an] ?? [o.pos[0], o.pos[1] + o.height, o.pos[2]];
      }
      if (!p) continue;
      const v = new THREE.Vector3(...p).project(this.camera);
      out[key] = { x: round((v.x * 0.5 + 0.5) * w), y: round((-v.y * 0.5 + 0.5) * h), visible: v.z < 1 && Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05 };
    }
    return out;
  }

  /* ---------------- animation des acteurs ---------------- */

  private updateActor(a: ActorRT, dt: number) {
    const m = this.model!;
    const leg = a.mo.legLength;
    let vx = 0, vz = 0;
    let want = 0;
    if (a.drive) {
      const l = Math.hypot(a.drive.vx, a.drive.vz);
      if (l > 0.05) {
        want = Math.min(l, 1) * (a.wantSpeed || 1.4);
        vx = a.drive.vx / l;
        vz = a.drive.vz / l;
      }
    } else if (a.path && a.path.length) {
      const [tx, tz] = a.path[0];
      const dx = tx - a.pos[0], dz = tz - a.pos[2];
      const d = Math.hypot(dx, dz);
      if (d < 0.25 && a.path.length > 1) a.path.shift();
      else if (d < 0.12) {
        a.path.shift();
        if (!a.path.length) {
          const g = a.goal;
          a.path = null;
          a.goal = null;
          if (g?.kick) this.doKick(a, g.kick);
          if (g?.seat) {
            a.pos[0] = g.seat.x;
            a.pos[2] = g.seat.z;
            a.yaw = g.seat.yaw;
            a.seatY = g.seat.y;
            a.standAt = [g.x, g.z];
            a.speed = 0;
            const sa = g.seat.action ?? "sit";
            if (a.action !== sa) {
              a.action = sa;
              a.actionTime = 0;
            }
          }
          if (g?.then) {
            // face à la cible, la bouche au-dessus : boire au bassin, manger à la gamelle
            const sp = g.then.spot;
            let dx = sp[0] - a.pos[0], dz = sp[2] - a.pos[2];
            const d = Math.hypot(dx, dz) || 1;
            [dx, dz] = [dx / d, dz / d];
            const r = g.then.action === "sleep" ? 0 : reachOf(a.model.asset, g.then.action, sp[1] - groundHeight(m, sp[0] - dx * 0.5, sp[2] - dz * 0.5, a.pos[1]));
            a.standAt = [a.pos[0], a.pos[2]];
            if (d > r) {
              a.pos[0] = sp[0] - dx * r;
              a.pos[2] = sp[2] - dz * r;
            }
            a.yaw = Math.atan2(dx, dz);
            a.speed = 0;
            a.reachY = sp[1] - groundHeight(m, a.pos[0], a.pos[2], a.pos[1]);
            a.action = g.then.action;
            a.actionTime = 0;
          }
          if (g) this.onEvent({ type: "arrive", payload: { actor: a.model.id, x: round(a.pos[0]), z: round(a.pos[2]), target: g.target ?? null } });
        }
      } else {
        want = a.wantSpeed || 1.35;
        if (a.path.length === 1) want *= clamp(d / 0.8, 0.3, 1);
        vx = dx / d;
        vz = dz / d;
      }
    } else if ((a.model.behavior === "wander" || a.model.behavior === "patrol") && !(a.action === "sit" && (a.seatY ?? 0) > 0) && a.action !== "sleep") {
      a.wanderT -= dt;
      if (a.wanderT <= 0) {
        a.wanderT = 3 + ((a.model.seed * 7.3 + this.time) % 6);
        let tx: number, tz: number;
        const paths = m.terrain?.paths.filter((p) => p.kind !== "river") ?? [];
        if (a.model.behavior === "patrol" && paths.length) {
          const p = paths[0];
          const end = Math.hypot(a.pos[0] - p.points[0][0], a.pos[2] - p.points[0][1]) < 4 ? p.points[p.points.length - 1] : p.points[0];
          [tx, tz] = end;
        } else {
          const ang = (a.model.seed * 3.7 + this.time * 1.3) % (Math.PI * 2);
          const r = 3 + ((a.model.seed + this.time) % 5);
          tx = clamp(a.pos[0] + Math.cos(ang) * r, -m.size[0] / 2 + 1, m.size[0] / 2 - 1);
          tz = clamp(a.pos[2] + Math.sin(ang) * r, -m.size[1] / 2 + 1, m.size[1] / 2 - 1);
        }
        a.wantSpeed = (1.1 + ((a.model.seed * 13) % 1) * 0.4) * leg / 0.85;
        this.goto(a, tx, tz);
        if (!a.path) a.wanderT = 1;
      }
    }
    // vitesse et cap lissés
    a.speed += (want - a.speed) * (1 - Math.exp(-dt * (want > a.speed ? 4 : 6)));
    if (want > 0.01) {
      const targetYaw = Math.atan2(vx, vz);
      let dy = targetYaw - a.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      const turn = clamp(dy, -dt * 7, dt * 7);
      a.yaw += turn;
      a.turn = turn / Math.max(dt, 1e-3);
    } else a.turn *= 0.8;
    const step = a.speed * dt;
    if (step > 0) {
      const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
      const nx = a.pos[0] + fx * step, nz = a.pos[2] + fz * step;
      if (!m.nav || m.nav.free(nx, nz) || a.path || !a.drive) {
        a.pos[0] = nx;
        a.pos[2] = nz;
      } else this.onEvent({ type: "blocked", payload: { actor: a.model.id, reason: "wall" } });
      a.phase += step / (2 * a.mo.stepLength(Math.max(a.speed, 0.2)));
    }
    a.pos[1] = groundHeight(m, a.pos[0], a.pos[2], a.pos[1]);
    // actions
    const transient = a.action === "wave" || a.action === "cheer" || a.action === "jump" || a.action === "bow" || a.action === "point" || a.action === "kick";
    a.actionTime += dt;
    const target = a.action === "idle" ? 0 : 1;
    a.actionWeight += (target - a.actionWeight) * (1 - Math.exp(-dt * 6));
    if ((transient && a.actionDur === undefined && a.actionTime > (a.action === "jump" ? 1.1 : a.action === "bow" ? 1.4 : a.action === "kick" ? 0.7 : 2.6)) || (a.actionDur !== undefined && a.action !== "idle" && !a.goal && a.actionTime > a.actionDur)) {
      this.onEvent({ type: "actionEnd", payload: { actor: a.model.id, action: a.action } });
      a.actionDur = undefined;
      if (a.action === "sleep" && (a.seatY ?? 0) > 0) a.action = "sit";
      else {
        a.action = "idle";
        a.reachY = undefined;
      }
    }
    // clignement
    a.blinkT -= dt;
    let blink = 0;
    if (a.blinkT < 0.14) blink = Math.sin(clamp(1 - a.blinkT / 0.14, 0, 1) * Math.PI);
    if (a.blinkT <= 0) a.blinkT = 2 + ((a.model.seed * 17.1 + this.time) % 4);
    // endormi : yeux fermés
    a.mats.uniforms.uBlink.value = a.action === "sleep" ? Math.max(blink, a.actionWeight) : blink;
    // zones
    for (const zn of m.zones) {
      const inside = zn.box ? a.pos[0] >= zn.box[0] && a.pos[0] <= zn.box[2] && a.pos[2] >= zn.box[1] && a.pos[2] <= zn.box[3] : Math.hypot(a.pos[0] - zn.x, a.pos[2] - zn.z) <= zn.r;
      if (inside && !a.zones.has(zn.id)) {
        a.zones.add(zn.id);
        this.onEvent({ type: "enter", payload: { zone: zn.id, actor: a.model.id } });
      } else if (!inside && a.zones.has(zn.id)) {
        a.zones.delete(zn.id);
        this.onEvent({ type: "leave", payload: { zone: zn.id, actor: a.model.id } });
      }
    }
    this.poseActor(a, dt);
  }

  private poseActor(a: ActorRT, _dt: number) {
    const sk = a.model.asset.skeleton!;
    const st: MotionState = { speed: a.speed, phase: a.phase, time: this.time + a.model.seed, action: a.action, actionTime: a.actionTime, actionWeight: a.actionWeight, mood: a.mood, turn: a.turn, seed: a.model.seed, seatY: a.action === "sit" || a.action === "sleep" ? a.seatY : 0, reachY: a.action === "drink" || a.action === "eat" ? a.reachY : undefined };
    const { pose } = a.mo.pose(st);
    const W = sk.world(pose);
    a.mesh.userData.world = W;
    const S = sk.skinMatrices(W);
    const arr = a.mats.uniforms.uDQ.value as THREE.Vector4[];
    for (let i = 0; i < Math.min(S.length, MAX_BONES); i++) {
      const [r, d] = dualQuat(S[i]);
      arr[i * 2].set(r[0], r[1], r[2], r[3]);
      arr[i * 2 + 1].set(d[0], d[1], d[2], d[3]);
    }
    a.mesh.position.set(a.pos[0], a.pos[1], a.pos[2]);
    a.mesh.rotation.set(0, a.yaw, 0);
    a.mesh.updateMatrix();
  }

  /* ---------------- boucle ---------------- */

  setVisible(v: boolean) {
    this.visible = v;
    if (v) this.kick();
  }

  private get animated(): boolean {
    if (!this.model || !this.play) return false;
    return this.actors.size > 0 || !!this.balls?.moving || this.model.instances.some((g) => g.flex) || !!this.model.water || !!this.style?.grain || this.stack.animated;
  }

  private ballsDirty = false;
  private ballAwake = new Set<number>();

  private stepBalls(dt: number) {
    const m = this.model!;
    const bw = this.balls!;
    if (!bw.moving && !this.actors.size && !this.ballsDirty) return;
    const pushers = [...this.actors.values()].filter((a) => !a.hidden && !(a.action === "sit" && (a.seatY ?? 0) > 0)).map((a) => ({ id: a.model.id, pos: a.pos, vel: [Math.sin(a.yaw) * a.speed, 0, Math.cos(a.yaw) * a.speed] as V3, r: 0.18 * a.mo.legLength + 0.08, h: a.mo.legLength * 0.6 }));
    bw.step(dt, (x, z) => (m.terrain ? m.terrain.height(x, z) : 0), (x, z) => (m.nav ? m.nav.free(x, z) : true), pushers, (e) => this.onEvent(e));
    const touched = new Set<THREE.InstancedMesh>();
    const tmp = new THREE.Matrix4();
    // seuls les ballons en mouvement (et celui qui vient de s'arrêter) sont réécrits ; un ballon caché est réduit à rien
    const all = this.ballsDirty;
    this.ballsDirty = false;
    for (const b of bw.bodies) {
      const was = this.ballAwake.has(b.obj);
      if (b.awake) this.ballAwake.add(b.obj);
      else this.ballAwake.delete(b.obj);
      if (!all && !b.awake && !was) continue;
      const slot = this.ballSlots.get(b.obj);
      if (!slot) continue;
      if (bw.hidden.has(b.id)) tmp.makeScale(0, 0, 0);
      else tmp.fromArray(bw.matrix(b, slot.m0) as unknown as number[]);
      slot.im.setMatrixAt(slot.i, tmp);
      touched.add(slot.im);
    }
    for (const im of touched) {
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
    }
    if (touched.size) this.dirty = this.shadowDirty = true;
  }

  kick() {
    if (this.disposed || this.running || !this.visible) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  private loop = (now: number) => {
    if (this.disposed) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.settle) this.stepSettle(now);
    const anim = this.animated;
    if (anim) {
      this.time += dt * this.speed;
      for (const a of this.actors.values()) if (a !== this.drag?.actor && a !== this.settle?.d.actor) this.updateActor(a, dt * this.speed);
      if (this.actors.size) this.shadowDirty = true;
      if (this.balls) this.stepBalls(dt * this.speed);
    }
    if (anim || this.dirty) {
      const t0 = performance.now();
      this.render();
      this.governor(performance.now() - t0, dt, now / 1000);
      this.dirty = false;
      this.onFrame();
    }
    if ((anim || this.dirty) && this.visible) this.raf = requestAnimationFrame(this.loop);
    else this.running = false;
  };

  private governor(ms: number, dt: number, now: number) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 30) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((s, x) => s + x, 0) / this.frameTimes.length;
    this.fps = avg > 0 ? Math.round(1 / avg) : 0;
    const max = Math.min(this.maxDpr, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    const next = governDpr(this.gov, this.dpr, max, dt, ms, now);
    // nouvelle densité appliquée au début du prochain rendu, dans la même image que le dessin
    if (next !== this.dpr) {
      this.dpr = next;
      this.dirty = true;
    }
  }

  /**
   * Demande de redimensionnement (changement de mise en page, densité, style pixel) : appliquée au début du prochain
   * rendu, juste avant de dessiner. Redimensionner le canevas l'efface : le faire hors d'un rendu afficherait une
   * image vide (clignotement).
   */
  resize(_force = false) {
    this.dirty = true;
    this.kick();
  }

  /** Ajuste canevas et cible de rendu aux dimensions voulues ; rien si elles n'ont pas changé. */
  private applySize() {
    const w = Math.max(1, this.canvas.clientWidth | 0), h = Math.max(1, this.canvas.clientHeight | 0);
    const dpr = this.dpr;
    const pixel = this.style?.pixel ?? 0;
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    const vw = pixel > 0 ? Math.max(32, Math.round(w / pixel)) : pw, vh = pixel > 0 ? Math.max(18, Math.round(h / pixel)) : ph;
    // pixel accroché au monde : cible agrandie d'une marge (le reste sous-texel décale la lecture)
    const m = pixel > 0 && snapApplicable(this.view.camera, this.style?.pixelSnap !== false) ? SNAP_MARGIN : 0;
    this.snapReq = m ? { rw: vw, rh: vh, m } : null;
    const rw = vw + 2 * m, rh = vh + 2 * m;
    const key = `${w}x${h}@${dpr}|${rw}x${rh}|${pixel > 0 ? 1 : 0}`;
    if (this.rt && key === this.sizeKey) return;
    this.sizeKey = key;
    if (this.renderer.getPixelRatio() !== dpr) this.renderer.setPixelRatio(dpr);
    const cur = this.renderer.getSize(new THREE.Vector2());
    if (cur.x !== w || cur.y !== h || this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) this.renderer.setSize(w, h, false);
    if (!this.rt || this.rt.width !== rw || this.rt.height !== rh || this.rt.samples !== (pixel > 0 ? 0 : 4)) {
      this.rt?.dispose();
      this.rt = new THREE.WebGLRenderTarget(rw, rh, { count: 2, samples: pixel > 0 ? 0 : 4, type: THREE.HalfFloatType, depthBuffer: true });
      for (const t of this.rt.textures) {
        t.minFilter = t.magFilter = pixel > 0 ? THREE.NearestFilter : THREE.LinearFilter;
        t.generateMipmaps = false;
      }
    }
    const pu = (this.post.material as THREE.ShaderMaterial).uniforms;
    pu.tColor.value = this.rt.textures[0];
    pu.tData.value = this.rt.textures[1];
    (pu.uTexel.value as THREE.Vector2).set(1 / rw, 1 / rh);
    (pu.uResolution.value as THREE.Vector2).set(rw, rh);
    pu.uPixel.value = 0;
  }

  private updateLights(t: THREE.Vector3) {
    const L = this.model?.lights ?? [];
    const sorted = [...L].sort((a, b) => Math.hypot(a.pos[0] - t.x, a.pos[2] - t.z) - Math.hypot(b.pos[0] - t.x, b.pos[2] - t.z)).slice(0, 12);
    const P = this.shared.uLightPos.value as THREE.Vector4[], C = this.shared.uLightCol.value as THREE.Vector4[];
    const lampOn = 0.25 + (this.style?.night ?? 0) * (this.style?.lamps ?? 0.6);
    sorted.forEach((l, i) => {
      P[i].set(l.pos[0], l.pos[1], l.pos[2], l.radius * (l.kind === "fire" ? 1 : 0.6 + lampOn * 0.6));
      if (l.kind === "fire") C[i].set(1.6, 0.75, 0.3, 1);
      else C[i].set(1.3 * lampOn, 0.95 * lampOn, 0.55 * lampOn, 0);
    });
    this.shared.uLightCount.value = sorted.length;
  }

  private shadowPass() {
    const m = this.model!;
    const sun = this.shared.uSunDir.value as THREE.Vector3;
    const b = m.bounds;
    const c = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    const R = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2;
    const lc = new THREE.OrthographicCamera(-R, R, R, -R, 0.1, R * 4);
    lc.position.copy(c).addScaledVector(sun, R * 2);
    lc.lookAt(c);
    lc.updateMatrixWorld();
    lc.updateProjectionMatrix();
    (this.shared.uShadowMatrix.value as THREE.Matrix4).multiplyMatrices(lc.projectionMatrix, lc.matrixWorldInverse);
    const swap: [THREE.Mesh, THREE.Material][] = [];
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.userData.depth) {
        swap.push([mesh, mesh.material as THREE.Material]);
        mesh.material = mesh.userData.depth;
      }
    });
    this.shared.uShadowOn.value = 0;
    this.renderer.setRenderTarget(this.shadowRT);
    this.renderer.setClearColor(0xffffff, 1);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, lc);
    for (const [mesh, mat] of swap) mesh.material = mat;
    this.shared.uShadowOn.value = this.style?.shadows === false ? 0 : 1;
    this.shadowDirty = false;
  }

  render() {
    if (!this.model) return;
    this.applySize();
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.shared.uTime.value = this.time;
    this.shared.uWind.value = this.model.wind;
    let target: THREE.Vector3 | undefined;
    if (this.view.camera === "follow" && this.followId && this.actors.has(this.followId)) {
      const a = this.actors.get(this.followId)!;
      target = new THREE.Vector3(a.pos[0], a.pos[1] + a.model.asset.height * 0.6, a.pos[2]);
      this.view.yaw = (a.yaw * 180) / Math.PI + 180;
    }
    this.camera = applyView(this.view, w / h, this.extent, this.ortho, this.persp, target, this.snapReq ?? undefined, this.frame);
    (this.camera as THREE.Camera).updateMatrixWorld();
    const pu0 = (this.post.material as THREE.ShaderMaterial).uniforms;
    const xf = this.snapReq ? marginTransform(this.snapReq.rw, this.snapReq.rh, this.snapReq.m, this.frame.rx, this.frame.ry) : [1, 1, 0, 0];
    (pu0.uUvXf.value as THREE.Vector4).set(xf[0], xf[1], xf[2], xf[3]);
    const cam = this.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    this.shared.uFar.value = cam.far;
    const tgt = target ?? new THREE.Vector3(this.view.cx, this.view.cy, this.view.cz);
    const camDist = cam.position.distanceTo(tgt);
    this.focusDist = Math.max(1e-3, camDist);
    this.shared.uFogNear.value = Math.max(0, camDist - this.extent * 0.6);
    this.shared.uFogRange.value = this.extent * 2.2;
    this.renderer.info.reset();
    this.updateLights(tgt);
    if (this.style?.shadows !== false && this.shadowDirty) this.shadowPass();
    this.renderer.setRenderTarget(this.rt);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);
    this.lastInfo = { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles };
    if (this.snapReq) {
      // caméra réelle (sans arrondi ni marge) pour la sélection, les ancres et les gestes
      this.camera = applyView(this.view, w / h, this.extent, this.ortho, this.persp, target);
      this.camera.updateMatrixWorld();
    }
    // horizon : calé sur la direction de visée horizontale (même hauteur quel que soit le yaw)
    const pu = (this.post.material as THREE.ShaderMaterial).uniforms;
    pu.uHorizonY.value = horizonScreenY(cam, tgt, this.extent);
    pu.uTime.value = this.time;
    if (this.stack.active) {
      // pile d'effets : image de base dans une cible, puis passes jusqu'à l'écran
      const bw = this.canvas.width, bh = this.canvas.height;
      const base = this.stack.target("base", bw, bh);
      this.renderer.setRenderTarget(base);
      this.renderer.render(this.postScene, this.postCam);
      // grilles des effets accrochées au monde en orthographique (sauf `pixelSnap: false`)
      const ortho = this.camera === this.ortho && this.style?.pixelSnap !== false && this.frame.half > 0;
      const grid = ortho ? gridOffset(this.frame.a, this.frame.b, h / (2 * this.frame.half)) : ([0, 0] as [number, number]);
      this.stack.render({ base: base.texture, data: this.rt!.textures[1], dataXf: xf as [number, number, number, number], grid, w: bw, h: bh, cssW: w, cssH: h, time: this.time, depthK: cam.far / this.focusDist });
      if (this.stack.failed) {
        console.warn("procgen : pile de post-traitement désactivée (shader refusé)", this.stack.error);
        this.dirty = true;
      }
      return;
    }
    this.renderer.setRenderTarget(null);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.postScene, this.postCam);
  }

  private lastInfo = { calls: 0, triangles: 0 };
  stats() {
    return { drawCalls: this.lastInfo.calls, triangles: this.lastInfo.triangles, fps: this.fps, scale: this.dpr, ...(this.stack.active ? { postPasses: this.stack.passes } : {}), ...(this.stack.failed ? { postError: this.stack.error } : {}) };
  }

  actorState(id: string) {
    const a = this.actors.get(id);
    return a ? { x: round(a.pos[0]), y: round(a.pos[1]), z: round(a.pos[2]), yaw: Math.round((a.yaw * 180) / Math.PI), speed: round(a.speed), action: a.action, moving: !!a.path || a.speed > 0.05 } : null;
  }
  actorIds() {
    return [...this.actors.keys()];
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.clearScene();
    this.rt?.dispose();
    this.shadowRT.dispose();
    this.stack.dispose();
    this.renderer.dispose();
  }
}

const round = (x: number) => Math.round(x * 100) / 100;
