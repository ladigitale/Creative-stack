/**
 * `ProcgenView` : rendu three.js d'un `SceneModel`, acteurs animés, sélection, événements de jeu.
 *
 * Passes : ombre (profondeur, seulement quand la scène ou un acteur bouge) → scène en MRT avec MSAA ×4
 * (couleur + normales/profondeur/id) → image de base (ciel, contours, papier, grain, vignette, sRGB) → pile d'effets
 * `post` facultative (`poststack.ts`, dans l'ordre donné), absente quand `post` est vide : l'image de base va alors
 * directement à l'écran.
 * Rendu à la demande : aucune image tant que rien ne bouge ; densité de pixels adaptée à la charge.
 * Rendu soigné (`photo`, `render/photo.ts`) : scène immobile → image tracée ou accumulée à la place de la couleur de
 * la scène dans l'image de base, affinée image après image puis plus rien ; le premier geste rend la main.
 */
import { encodeRoleFinishes } from "../style/finishes";
import { HeightBank, RoleFinTable } from "./finish-maps";
import * as THREE from "three";
import { BallWorld } from "../scene/balls";
import { loadRapier, type BodyPose, type RigidState } from "../../../shared/sim/rigid-core";
import { type LocalBounds, ProcgenRigid, meshBounds } from "../scene/rigid";
import { ProcgenEmitterLayer, tagsOf } from "./emitters";
import type { ProcgenEmitters } from "../scene/emitters";
import type { Aabb } from "../../../shared/sim/grid";
import type { Hit } from "../../../shared/sim/emitter";
import { type M4, type V3, clamp, m4Compose, m4Point, qAxis, qMul, sub } from "../core/math";
import { FaceState, bindExpr } from "./expr";
import { StateLayer } from "./states";
import { type ActorModel, type ObjectInfo, type PointLight, type SceneModel, type Zone, groundHeight, reachOf } from "../scene/compose";
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
import { MeadowLayer } from "./meadows";
import { SOFT_BUDGET, SoftLayer, type SoftRT, yawMatrix } from "./soft";
import { type PostFx, MAX_POST, normalizeFx } from "./post";
import { type ProcgenPhotoSpec, type ProcgenPhotoState, type ProxyLights, ProcgenPhoto, halton, pickEngine, rasterFrames } from "./photo";
import { SNAP_MARGIN, gridOffset, marginTransform, snapApplicable } from "./pixelsnap";
import type { OrthoFrame, SnapRequest } from "./camera";
import { Issues } from "../core/schema";
import { type FxInput, SceneFx } from "../scene/fx";
import { createParticleMesh, disposeParticleMesh, particleQuad, uploadParticles, type ParticleMesh } from "../../../shared/sim/particles-gl";
import { InfiniteGpu } from "./infinite-gpu";
import type { TileWorld } from "../scene/infinite";
import type { NavGrid } from "../scene/nav";
import type { Terrain } from "../scene/terrain";
import { type DriveInput, type DriveState, type Route, type SeatPose, type VehicleSpec, ObstacleSet, doorFor, obbOverlap, followRoute, newDriveState, newRoute, obstaclesOf, planRoute, readInput, seatFor, seatNames, sideApproach, stepDrive, steerPartValue, vehicleSpecOf, wheelPartValue } from "../scene/drive";
import { worldRoads } from "../scene/world-roads";

export type ActorIntent = { x?: number; z?: number; target?: string; vx?: number; vz?: number; action?: string; speed?: number; run?: boolean; facing?: number; look?: string; mood?: string; /** Coup de pied (cible ballon) : vitesse donnée (m/s) et part verticale. */ power?: number; loft?: number; /** Durée de l'action (s) : `actionEnd` puis repos. */ duration?: number; /** Conduite : place visée (`board`), destination (`drive`). */ seat?: string | number; to?: unknown };
export type GameEvent = { type: "pick" | "select" | "arrive" | "blocked" | "enter" | "leave" | "actionEnd" | "kick" | "hit" | "rest" | "place" | "dragstart" | "dragRefused" | "placeFree" | "contact" | "settle" | "splash" | "drop" | "impact" | "expire" | "exit" | "state" | "board" | "alight" | "bump"; payload: Record<string, unknown> };
/** État publié de la physique : chargement, erreur, ou corps (10 fois par seconde au plus tant que ça bouge). */
export type PhysicsOut = ({ status: "loading" | "error"; error?: string } | ({ status: "ready" } & RigidState)) | null;

/** Objet saisi : de quoi le déplacer sans recomposer (matrice d'instance, sommets de sa tuile, ou acteur). */
type DragRT = {
  o: ObjectInfo;
  pos0: V3;
  yaw0: number;
  anchors0: Record<string, V3>;
  seatYaw0?: Record<string, number>;
  inst?: { im: THREE.InstancedMesh; i: number; m0: THREE.Matrix4 };
  tiles?: { mesh: THREE.Mesh; a: number; b: number; pos0: Float32Array; nrm0: Float32Array; /** Origine de la tuile du monde infini (maillage en repère local). */ off: [number, number] }[];
  actor?: ActorRT;
  /** Corps dynamique saisi : il suit le doigt (cinématique), décalage pied → origine du corps, rotation gardée. */
  body?: { off: V3; q: BodyPose["q"]; trail: { x: number; y: number; z: number; t: number }[] };
  /** Obstacle du moteur physique saisi (figé, rendu cinématique pendant le geste). */
  obstacle?: boolean;
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
    /** Monter dans un véhicule (ou sur une monture) à l'arrivée. */
    board?: { veh: string; seat: string; door: string | null };
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
  /** Dans un véhicule ou sur une monture : place, étape (portière qui s'ouvre, assis, descente), pose. */
  ride?: RideRT;
  /** Ordre `drive` reçu pendant la montée : joué une fois assis. */
  pendingDrive?: ActorIntent;
  /** Pieds d'un occupant assis (plancher, étriers, pédales). */
  seatFoot?: MotionState["seatFoot"];
  wantSpeed: number;
  wanderT: number;
  blinkT: number;
  /** Visage : poids des morphs d'expression ; cible du regard (`look`). */
  face: FaceState;
  look: string;
  turn: number;
  zones: Set<string>;
  hidden: boolean;
  lastIntent: string;
};

type RideRT = { veh: string; seat: string; door: string | null; phase: "open" | "enter" | "seated" | "exit"; t: number; pose: SeatPose; /** Départ du passage portière → place (monde). */ from?: V3 };

/** Véhicule ou monture conduit : état du modèle bicyclette, poignée de déplacement, occupants, itinéraire. */
type VehRT = {
  id: string;
  spec: VehicleSpec;
  o: ObjectInfo | null;
  actor: ActorRT | null;
  s: DriveState;
  y: number;
  tilt: [number, number];
  mover: DragRT | null;
  /** Commande directe (`drive.<id>`). */
  input: DriveInput | null;
  route: (Route & { goal: { x: number; z: number; target: string | null }; driver: string | null; tries: number }) | null;
  /** Place → acteur (assis ou en train de monter). */
  occ: Map<string, string>;
  lastHit: string | null;
  hitT: number;
  /** En mouvement depuis la dernière immobilisation (emprise mobile retirée de la grille, corps cinématique). */
  rolling: boolean;
  wheels: { name: string; r: number }[];
  steers: string[];
  /** Train : segment de voie (monde) sur lequel il glisse. */
  rail: { x: number; z: number; dx: number; dz: number; t0: number; t1: number } | null;
  /** Montgolfière : altitude au-dessus du sol. */
  alt: number;
  /** Portières qui se referment (rendues aux états demandés une fois fermées). */
  closing: string[];
};

export class ProcgenView {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private ortho = new THREE.OrthographicCamera();
  private persp = new THREE.PerspectiveCamera();
  private camera: THREE.Camera = this.ortho;
  private shared: Shared = sharedUniforms();
  /** Finis texturés : banque de hauteurs des motifs et table par rôle (vides tant qu'aucun fini ne s'en sert). */
  private finBank: HeightBank | null = null;
  private finTable: RoleFinTable | null = null;
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
  /** Parties mobiles (couvercles, portières…) : instances à part, animées sans recomposer. */
  readonly states = new StateLayer();
  /** Prairies (brins instanciés, vent et ploiement dans le shader). */
  readonly meadows = new MeadowLayer();
  /** Ballons dynamiques et leur emplacement dans les maillages instanciés. */
  balls: BallWorld | null = null;
  private ballSlots = new Map<number, { im: THREE.InstancedMesh; i: number; m0: M4 }>();
  /** Émetteurs (projectiles et nuées), gardés d'une scène à l'autre. */
  readonly emitters: ProcgenEmitterLayer;
  private emitHits: (Hit & { t: number })[] = [];
  /** Physique 3D (Rapier, chargé à la demande quand la recette la demande). */
  rigid: ProcgenRigid | null = null;
  private rigidTok = 0;
  private rigidSlots = new Map<string, { im: THREE.InstancedMesh; i: number; scale: number; pos: ArrayLike<number> }>();
  private objectsById = new Map<string, ObjectInfo>();
  /** Poses des corps reprises d'une composition à l'autre (même objet au même départ). */
  private carry = new Map<string, { key: string; pose: BodyPose }>();
  private spawnKey = new Map<string, string>();
  private pendingKicks: [string, [number, number, number]][] = [];
  private pendingForces: unknown = null;
  private firstForces: unknown = null;
  private querySpec: Record<string, unknown> = {};
  private queryN = new Map<string, number>();
  /** Réponses aux requêtes (`queries.<id>`). */
  queryOut: Record<string, unknown> = {};
  physOut: PhysicsOut = null;
  private lastPhys = 0;
  /** Augmente quand des corps s'arrêtent (liste des objets à republier). */
  physVersion = 0;
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
  /** Particules (météo, fumées, feux, embruns) : scène à part, dessinée après la scène dans la même cible. */
  readonly fx = new SceneFx();
  private fxGroup = new THREE.Group();
  private fxMeshes: ParticleMesh[] = [];
  private fxQuad = particleQuad();
  private fxInput: FxInput = {};
  /** Problèmes de la dernière lecture des particules (publiés dans `status.issues`). */
  fxIssues: Issues["list"] = [];
  private selectedObj = -1;
  onEvent: (e: GameEvent) => void = () => {};
  onFrame: () => void = () => {};
  private disposed = false;
  private drag: DragRT | null = null;
  private settle: { d: DragRT; from: number; to: number; t0: number } | null = null;
  private stack: PostStack;
  private mobile = false;
  /** Écran tactile ou petite fenêtre : ombres, post-traitement et émetteurs réduits. */
  get isMobile() {
    return this.mobile;
  }
  /** Distance caméra → point visé (profondeur relative des masques et de l'effet miniature). */
  private focusDist = 1;
  /** Rendu pixel accroché au monde : texels visibles et marge (null sinon). */
  private snapReq: SnapRequest | null = null;
  /** Rendu soigné : réglages, moteur, dernier geste ou changement, réveil programmé, pile `post` en cours. */
  private photo: ProcgenPhoto | null = null;
  private lastTouch = 0;
  private photoTimer = 0;
  private photoPost = false;
  /** Version du contenu (objets, poses, style) : le rendu soigné garde sa copie traçable tant qu'elle ne change pas. */
  private contentVersion = 0;
  /** Fin de rendu soigné publiée (`state-out.photo`). */
  onPhoto: (s: ProcgenPhotoState) => void = () => {};
  private frame: OrthoFrame = { a: 0, b: 0, half: 0, rx: 0, ry: 0 };
  /** Tissus et mèches simulés (capes, jupes, cheveux, drapeaux, linge) ; matrices d'attache des objets. */
  private softs: SoftLayer | null = null;
  private softObjM = new Map<number, Float64Array>();
  private frustum = new THREE.Frustum();
  /** Monde infini : tuiles chargées autour du point suivi (null : scène finie). */
  /** Conduite : véhicules et montures actifs, inclinaisons de caisse, véhicules détachés de leur tuile (monde infini). */
  private vehicles = new Map<string, VehRT>();
  private tilts = new Map<string, [number, number]>();
  private detachedIms = new Map<string, THREE.InstancedMesh>();
  private detachedObjs = new Set<number>();
  private obstacleCache: { key: unknown; set: ObstacleSet; vehs: ObjectInfo[] } | null = null;
  private vehCarry: { id: string; key: string; x: number; z: number; yaw: number; y: number; occ: [string, string][] }[] = [];
  /** Suivi caméra : position et cap lissés, décalage de cap donné par l'utilisateur (degrés). */
  private followCam: { id: string; x: number; y: number; z: number; yaw: number; t: number } | null = null;
  private followOff = 0;
  private inf: { world: TileWorld; gpu: InfiniteGpu; follow: string; base: { objects: ObjectInfo[]; lights: SceneModel["lights"] }; lowSince: number; at: string; upload: number; uploadMax: number; pumpMax: number } | null = null;
  /** Les tuiles montées ont changé (objets, ids). */
  onTiles: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // particules dessinées dans la passe de la scène, après les objets opaques (transparentes, sans écriture de profondeur)
    this.fxGroup.name = "procgen~particles";
    this.scene.add(this.fxGroup);
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
        tColor: { value: null }, tData: { value: null }, uTexel: { value: new THREE.Vector2() }, uOutline: { value: 1.5 }, uOutlineStrength: { value: 0.8 }, uOutlineFade: { value: new THREE.Vector2(2, 3) }, uInk: { value: new THREE.Color() },
        uSkyTop: { value: new THREE.Color() }, uSkyHorizon: { value: new THREE.Color() }, uSkyOn: { value: 1 }, uHorizonY: { value: 0.35 }, uGrain: { value: 0 }, uPaper: { value: 0 }, uVignette: { value: 0 },
        uTime: { value: 0 }, uPixel: { value: 0 }, uResolution: { value: new THREE.Vector2() }, uUvXf: { value: new THREE.Vector4(1, 1, 0, 0) },
        tPhoto: { value: null }, uPhotoMix: { value: 0 }, uPhotoFog: { value: 0 }, uFogColor: { value: new THREE.Color() }, uFogK: { value: new THREE.Vector4() },
      },
    });
    this.post = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat);
    this.post.frustumCulled = false;
    this.postScene.add(this.post);
    this.stack = new PostStack(this.renderer);
    this.emitters = new ProcgenEmitterLayer(this.shared, this.staticMats);
    const em = this.emitters;
    em.poseOf = (name) => this.poseOf(name);
    em.dynamic = () => this.dynamicBoxes();
    em.onHits = (hits) => this.onEmitHits(hits);
    em.onExpire = (e) => this.onEvent({ type: "expire", payload: e });
    em.onExit = (e) => this.onEvent({ type: "exit", payload: e });
    this.states.onState = (e) => this.onEvent({ type: "state", payload: e });
    this.states.objMatrix = (o) => this.objMatrixOf(o);
    this.fx.actorPos = (id) => {
      const a = this.actors.get(id);
      return a && !a.hidden ? a.pos : null;
    };
  }

  /* ---------------- états des objets ---------------- */

  /** Matrice monde courante d'un objet : pose du corps physique, sinon position, cap et échelle (glisser compris). */
  private objMatrixOf(o: ObjectInfo): M4 {
    const p = this.rigid?.isDynamic(o.id) ? this.rigid.pose(o.id) : null;
    if (p) return m4Compose([p.x, p.y, p.z], [p.q.x, p.q.y, p.q.z, p.q.w], o.scale);
    const t = this.tilts.get(o.id);
    if (t) return m4Compose(o.pos, qMul(qMul(qAxis([0, 1, 0], o.yaw), qAxis([1, 0, 0], t[0])), qAxis([0, 0, 1], t[1])), o.scale);
    return m4Compose(o.pos, qAxis([0, 1, 0], o.yaw), o.scale);
  }

  /** États voulus (parties 0…1, états libres), lus et validés par `scene/states.ts` ; animés en `speed` s par course. */
  setStates(values: Record<string, Record<string, number>>, speed: number, lights: PointLight[]) {
    if (this.model) for (const o of this.model.objects) if (!o.joints) o.states = values[o.id] ? { ...values[o.id] } : undefined;
    const moving = this.states.set(values, this.play ? speed : 0, lights);
    this.dirty = true;
    if (moving) this.touch();
    else this.kick();
  }

  private finishIms(touched: Set<THREE.InstancedMesh>) {
    const tiles = this.states.tilesTouched.size;
    this.states.tilesTouched.clear();
    if (!touched.size && !tiles) return;
    for (const im of touched) {
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
    }
    this.dirty = this.shadowDirty = true;
    this.contentVersion++;
  }

  /* ---------------- émetteurs ---------------- */

  /** Monte les émetteurs lus (recette et DataProvider) ; ceux qui n'ont pas changé gardent leurs copies. */
  setEmitters(built: ProcgenEmitters) {
    if (built.key === this.emitters.key && this.emitters.count === built.specs.length) return;
    this.emitters.mount(built);
    if (this.style) this.emitters.setStyle(this.style);
    // traînées : les systèmes de particules nommés dans `trail` ne naissent plus qu'au passage des copies
    this.fx.trailed = new Set(built.specs.map((e) => e.trail).filter((t) => !!t));
    this.dirty = true;
    this.kick();
  }

  /** Ordres `emit.<id>` du DataProvider (salves, `clear`, `kill`). */
  emitOrders(spec: unknown) {
    if (this.emitters.orders(spec)) {
      this.dirty = true;
      this.kick();
    }
  }

  emitState() {
    return { emitters: this.emitters.count ? this.emitters.stats() : {}, impacts: this.emitHits.slice(-16) };
  }

  /** Position d'une instance nommée : acteur (position animée), ballon (position courante), objet. */
  private poseOf(name: string): { x: number; y: number; z: number; ry: number } | null {
    const a = this.actors.get(name);
    if (a) return a.hidden ? null : { x: a.pos[0], y: a.pos[1], z: a.pos[2], ry: a.yaw };
    const b = this.balls?.byId.get(name);
    if (b) return { x: b.pos[0], y: b.pos[1], z: b.pos[2], ry: 0 };
    if (this.hiddenIds.has(name)) return null;
    const o = this.objectsById.get(name);
    return o ? { x: o.pos[0], y: o.pos[1], z: o.pos[2], ry: o.yaw } : null;
  }

  /** Boîtes mobiles visées par les masques : acteurs (étiquettes : id, calque, `acteur`) et ballons. */
  private dynamicBoxes(): Aabb[] {
    const out: Aabb[] = [];
    for (const a of this.actors.values()) {
      if (a.hidden) continue;
      const r = Math.max(0.15, a.model.asset.footprint.r * 0.6), h = a.model.asset.height;
      out.push({ name: a.model.id, tags: [a.model.id, a.model.layer ?? "actors", a.model.asset.generator, "acteur", ...(a.model.asset.generator === "animal" ? ["animal"] : ["personnage"])], lo: [a.pos[0] - r, a.pos[1], a.pos[2] - r], hi: [a.pos[0] + r, a.pos[1] + h, a.pos[2] + r] });
    }
    // corps physiques mobiles (Rapier) : à leur pose courante
    for (const o of this.model?.objects ?? []) {
      if (!o.body || o.body.kind === "static" || this.hiddenIds.has(o.id)) continue;
      const c = this.rigid?.center(o.id);
      const r = Math.max(o.footprint.hx, o.footprint.hz, 0.05);
      const pos = c ? c.pos : [o.pos[0], o.pos[1] + o.height / 2, o.pos[2]];
      const hh = c ? Math.max(c.r, 0.05) : o.height / 2;
      out.push({ name: o.id, tags: tagsOf(o), lo: [pos[0] - r, pos[1] - hh, pos[2] - r], hi: [pos[0] + r, pos[1] + hh, pos[2] + r] });
    }
    for (const b of this.balls?.bodies ?? []) {
      if (this.balls!.hidden.has(b.id)) continue;
      out.push({ name: b.id, tags: [b.id, "ball", "ballon"], lo: [b.pos[0] - b.r, b.pos[1] - b.r, b.pos[2] - b.r], hi: [b.pos[0] + b.r, b.pos[1] + b.r, b.pos[2] + b.r] });
    }
    return out;
  }

  /** Touches de l'image : un seul événement `impact` ; `push` pousse un ballon touché. */
  private onEmitHits(hits: Hit[]) {
    const t = Math.round(this.time * 1000) / 1000;
    for (const h of hits) {
      const sim = this.emitters.sim(h.emitter);
      const push = sim?.spec.push ?? 0;
      if (push > 0 && h.dir) {
        // ballon ou corps physique touché : impulsion dans la direction du tir (vitesse = impulsion / masse)
        const ball = this.balls?.byId.get(h.target);
        const o = this.objectsById.get(h.target);
        const mass = ball ? ball.mass : o?.body && o.body.kind !== "static" ? o.body.mass : 0;
        if (mass > 0) {
          const k = push / Math.max(0.01, mass);
          if (this.kickAny(h.target, [h.dir[0] * k, Math.max(0.5, h.dir[1] * k + k * 0.15), h.dir[2] * k])) this.kick();
        }
      }
      if (sim?.spec.burst) this.fx.impact(sim.spec.burst, [h.x, h.y, h.z]);
      this.emitHits.push({ ...h, x: round(h.x), y: round(h.y), z: round(h.z), t });
    }
    if (this.emitHits.length > 16) this.emitHits.splice(0, this.emitHits.length - 16);
    this.onEvent({ type: "impact", payload: { hits: hits.slice(0, 64).map((h) => ({ emitter: h.emitter, id: h.id, target: h.target, ...(h.copy !== undefined ? { copy: h.copy } : {}), tags: h.tags, x: round(h.x), y: round(h.y), z: round(h.z) })), t } });
  }

  /* ---------------- scène ---------------- */

  setModel(model: SceneModel) {
    // ancien modèle remplacé dans la même tâche : aucune image vide entre les deux
    const first = !this.model;
    this.keepPoses();
    this.keepVehicles();
    this.clearScene();
    this.model = model;
    const b = model.bounds;
    this.fitExtent = Math.max(4, Math.hypot(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2, (b.max[1] - b.min[1]) * 0.8);
    // vue de la recette au premier modèle ; ensuite la vue courante (orbite, pan, zoom de l'utilisateur) et le cadrage
    // sont conservés tant que la taille de la scène ne change pas beaucoup
    this.extent = first ? this.fitExtent : keepFrame(this.extent, this.fitExtent);
    this.shared.uGroundY.value = 0;
    this.shared.uWaterY.value = model.terrain?.spec.water ?? -1000;
    // nouveau modèle : l'ancien monde infini est démonté (le composant en remonte un avec `setInfinite`)
    this.dropInfinite();
    this.shared.uFar.value = this.extent * 6;
    for (const o of model.objects) {
      this.objectsByObj.set(o.obj, o);
      this.objectsById.set(o.id, o);
    }
    this.spawnKey = new Map(model.physics ? model.objects.filter((o) => o.body && o.body.kind !== "static").map((o) => [o.id, JSON.stringify([o.generator, o.params, o.pos.map((v) => Math.round(v * 100)), Math.round(o.yaw * 100)])]) : []);
    const addStatic = (m: import("../geom/mesh").Mesh | null, pick = true) => {
      if (!m || !m.vertexCount) return;
      const mesh = new THREE.Mesh(toGeometry(m), this.staticMats.color);
      mesh.userData.depth = this.staticMats.depth;
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      if (pick) this.pickables.push(mesh);
      return mesh;
    };
    addStatic(model.ground);
    addStatic(model.roads);
    addStatic(model.water);
    const tileMeshes = model.tiles.map((t) => addStatic(t));
    // parties mobiles des objets fusionnés (porte, volets d'un bâtiment) : sommets réécrits dans leur tuile
    for (const o of model.objects) {
      const jt = o.jointTile;
      const tm = jt && jt.tile >= 0 ? tileMeshes[jt.tile] : undefined;
      if (jt && tm) this.states.addTile(o, tm, jt.ranges);
    }
    // avec la physique, les ballons qui ont un corps passent par Rapier
    const bw = new BallWorld(model, model.physics ? (o) => !!o.body && o.body.kind !== "static" : undefined);
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
      if (g.joint) {
        this.states.add(im, g.joint, g.objs, this.objectsByObj);
        continue;
      }
      if (this.balls) g.objs.forEach((o, i) => this.balls!.byObj.has(o) && this.ballSlots.set(o, { im, i, m0: g.matrices[i] }));
      if (model.physics)
        g.objs.forEach((ob, i) => {
          const o = this.objectsByObj.get(ob);
          if (o?.body && o.body.kind !== "static") this.rigidSlots.set(o.id, { im, i, scale: o.scale, pos: g.mesh.pos });
        });
    }
    this.meadows.mount(model.meadows ?? [], this.shared, this.roles);
    if (this.meadows.active) this.scene.add(this.meadows.group);
    this.finishIms(this.states.mounted());
    for (const a of model.actors) this.addActor(a);
    this.restoreVehicles();
    this.mountRigid(model);
    this.buildSofts(model);
    this.applyFx();
    this.scene.add(this.emitters.group);
    this.emitters.setModel(model);
    if (first) this.view = parseView(model.view, { ...DEFAULT_VIEW, cy: 0 });
    if (this.style) this.setStyle(this.style);
    this.dirty = this.shadowDirty = true;
    this.contentVersion++;
    this.touch();
  }

  /** Tissus des objets (repère de l'objet) et des acteurs (portés par leurs os), posés dans leur drapé de repos. */
  private buildSofts(model: SceneModel) {
    this.softObjM.clear();
    const hasActorSoft = model.actors.some((a) => a.asset.soft?.length);
    if (!model.softs?.length && !hasActorSoft) {
      this.softs = null;
      return;
    }
    const layer = new SoftLayer(this.scene, (rt, bone, out) => this.softAttach(rt, bone, out), this.mobile ? SOFT_BUDGET.mobile : SOFT_BUDGET.desktop);
    this.softs = layer;
    layer.setWind(this.windVector());
    for (const it of model.softs ?? []) {
      this.softObjM.set(it.obj, Float64Array.from(it.matrix));
      for (const p of it.pieces) {
        const rt = layer.add(p, this.staticMats, { actor: null, obj: it.obj });
        if (rt) layer.settle(rt);
      }
    }
    for (const a of this.actors.values()) {
      const pieces = a.model.asset.soft;
      if (!pieces?.length) continue;
      // matière non skinnée qui partage les couleurs de l'acteur
      const mats = makeMaterials(this.shared, a.mats.uniforms.uRoles as { value: Float32Array }, false);
      for (const p of pieces) {
        const rt = layer.add(p, mats, { actor: a.model.id, obj: a.model.obj });
        if (rt) layer.settle(rt, 60);
      }
    }
  }

  /** Matrice monde d'attache d'une pièce : os de l'acteur (pose courante) ou repère de l'objet. */
  private softAttach(rt: SoftRT, bone: string | undefined, out: Float64Array): boolean {
    if (rt.actor === null) {
      const m = this.softObjM.get(rt.obj);
      if (!m) return false;
      out.set(m);
      return true;
    }
    const a = this.actors.get(rt.actor);
    if (!a) return false;
    const am = a.mesh.matrix.elements;
    const S = a.mesh.userData.skin as M4[] | undefined;
    const i = bone ? a.model.asset.skeleton?.index[bone] : undefined;
    if (!S || i === undefined) {
      out.set(am);
      return true;
    }
    const b = S[i];
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) out[c * 4 + r] = am[r] * b[c * 4] + am[4 + r] * b[c * 4 + 1] + am[8 + r] * b[c * 4 + 2] + am[12 + r] * b[c * 4 + 3];
    return true;
  }

  /** Vent de la recette en m/s : direction `windDir` (0 = vers +z, 90° = vers +x), force `wind`. */
  private windVector(): V3 {
    const m = this.model;
    const w = Math.max(0, m?.wind ?? 1) * 1.6;
    const d = m?.windDir ?? (67 * Math.PI) / 180;
    return [Math.sin(d) * w, 0, Math.cos(d) * w];
  }

  private softShown = (rt: SoftRT): boolean => {
    if (rt.actor !== null) {
      const a = this.actors.get(rt.actor);
      return !!a && a.mesh.visible && !this.hiddenIds.has(rt.actor);
    }
    const o = this.objectsByObj.get(rt.obj);
    return !o || !this.hiddenIds.has(o.id);
  };

  /** Pixels par mètre à une position (taille à l'écran d'une pièce). */
  private pxPerM = (p: THREE.Vector3): number => {
    const h = this.canvas.clientHeight || 1;
    const cam = this.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const pc = cam as THREE.PerspectiveCamera;
      const d = Math.max(0.1, pc.position.distanceTo(p));
      return h / (2 * Math.tan((pc.fov * Math.PI) / 360) * d);
    }
    const oc = cam as THREE.OrthographicCamera;
    return (h * oc.zoom) / Math.max(1e-3, oc.top - oc.bottom);
  };

  private stepSofts(dt: number) {
    const L = this.softs;
    if (!L) return;
    const cam = this.camera;
    cam.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    if (L.update(dt, this.frustum, this.pxPerM, this.softShown)) {
      this.dirty = this.shadowDirty = true;
      this.contentVersion++;
    }
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
    bindExpr(mats.uniforms, a.asset);
    if (a.asset.expr) geo.userData.expr = a.asset.expr;
    this.scene.add(mesh);
    const sk = a.asset.skeleton!;
    const rt: ActorRT = {
      model: a, mesh, mats, mo: motionFor(a.asset), pos: [...a.pos], yaw: a.yaw, speed: 0, phase: Math.random(), action: a.action, actionTime: 0, actionWeight: a.action === "idle" ? 0 : 1,
      mood: String(a.params.mood ?? "neutral"), path: null, goal: null, drive: null, wantSpeed: 0, wanderT: 1 + (a.seed % 5), blinkT: 1 + (a.seed % 3), turn: 0,
      face: new FaceState(a.asset, baseMoodOf(a), a.seed), look: "", zones: new Set(), hidden: false, lastIntent: "",
      seatY: a.seatY, standAt: a.standAt, reachY: a.reachY,
    };
    this.actors.set(a.id, rt);
    this.poseActor(rt, 0);
  }

  private clearScene() {
    this.meadows.clear();
    this.drag = null;
    this.softs = null;
    this.softObjM.clear();
    this.settle = null;
    for (const o of [...this.scene.children]) {
      // particules : gardées d'un modèle à l'autre (relues par applyFx)
      if (o === this.fxGroup) continue;
      this.scene.remove(o);
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      if (m.material && m.material !== this.staticMats.color) (m.material as THREE.Material).dispose();
      (m.userData.depth as THREE.Material | undefined)?.dispose?.();
    }
    this.actors.clear();
    this.vehicles.clear();
    this.tilts.clear();
    this.obstacleCache = null;
    this.detachedIms.clear();
    this.detachedObjs.clear();
    // suivi caméra gardé : pas de saut de vue à la recomposition
    this.waterCache = null;
    this.objectsByObj.clear();
    this.objectsById.clear();
    this.rigidSlots.clear();
    this.rigid?.dispose();
    this.rigid = null;
    this.rigidTok++;
    this.pickables = [];
    this.instanceObjs.clear();
    this.states.clear();
  }

  /* ---------------- particules ---------------- */

  /** Clés de particules (recette : `weather`, `fx`, `particles`, `wind`, `windDir`, `layers[].fx`). */
  setFx(input: FxInput) {
    this.fxInput = input;
    this.applyFx();
  }

  private applyFx() {
    if (!this.model) return;
    const iss = new Issues();
    const changed = this.fx.configure(this.fxInput, this.model, { mobile: this.mobile }, iss);
    this.fxIssues = iss.list;
    if (changed) {
      for (const d of this.fxMeshes) disposeParticleMesh(d);
      this.fxGroup.clear();
      this.fxMeshes = this.fx.systems.map((s) => {
        const d = createParticleMesh(s.sys, this.fxQuad, { mrt: true, hard: this.style?.shading === "toon", vent: this.fx.vent, floorY: this.fx.floorY, minPx: 1.3 });
        this.fxGroup.add(d.mesh);
        return d;
      });
    }
    this.dirty = true;
    this.kick();
  }

  private fxCtx() {
    return { target: [this.view.cx, this.view.cy, this.view.cz] as V3, extent: this.extent / Math.max(0.05, this.view.zoom || 1), hidden: this.hiddenIds };
  }

  /** Ordres `fx.<id>` du DataProvider (salves). */
  fxOrders(spec: unknown) {
    if (this.fx.applyOrders(spec, this.fxCtx())) {
      this.dirty = true;
      this.kick();
    }
  }

  private stepFx(dt: number) {
    if (!this.fxMeshes.length) return;
    this.fx.step(dt, this.fxCtx());
    for (const d of this.fxMeshes) {
      uploadParticles(d);
      d.mat.uniforms.uNow.value = this.fx.now;
    }
  }

  /** Avance les particules sans écran (captures, tests) : `seconds` à `fps` images par seconde. */
  stepParticles(seconds: number, fps = 30) {
    for (let i = 0; i < Math.round(seconds * fps); i++) this.stepFx(1 / fps);
    this.dirty = true;
    this.kick();
  }

  /* ---------------- monde infini ---------------- */

  /**
   * Monte un monde infini sur le modèle courant (acteurs, zones) : le sol, la navigation et la liste d'objets du modèle
   * deviennent ceux des tuiles chargées (façades), mis à jour à chaque tuile montée.
   */
  setInfinite(world: TileWorld | null, follow = "camera") {
    this.dropInfinite();
    const m = this.model;
    if (!world || !m) return;
    const gpu = new InfiniteGpu(this.staticMats, (add, rem) => {
      if (rem.length) this.pickables = this.pickables.filter((p) => !rem.includes(p));
      this.pickables.push(...add);
    });
    this.scene.add(gpu.group);
    this.inf = { world, gpu, follow, base: { objects: m.objects, lights: m.lights }, lowSince: 0, at: "", upload: 0, uploadMax: 0, pumpMax: 0 };
    const w = world;
    const terrain = {
      spec: { size: [1e6, 1e6], water: w.waterLevel, surface: "grass", relief: 0, scale: 18, mountains: 0, seed: 0 },
      get paths() {
        return w.pathsNear(w.center[0], w.center[1]);
      },
      height: (x: number, z: number) => w.height(x, z),
      normal: (x: number, z: number) => w.normal(x, z),
      pathInfo: (x: number, z: number) => w.pathInfo(x, z),
    };
    m.terrain = terrain as unknown as Terrain;
    m.nav = { free: (x: number, z: number) => w.free(x, z), path: (a: [number, number], b: [number, number]) => w.path(a, b), pathWide: (a: [number, number], b: [number, number], c: number) => w.path(a, b, c) } as unknown as NavGrid;
    m.size = [1e6, 1e6];
    this.shared.uWaterY.value = w.waterLevel ?? -1000;
    this.adoptTiles(true);
    this.dirty = this.shadowDirty = true;
    this.kick();
  }

  private dropInfinite() {
    const f = this.inf;
    if (!f) return;
    this.inf = null;
    // véhicules détachés de leurs tuiles : partent avec le monde
    for (const [id, im] of this.detachedIms) {
      im.removeFromParent();
      im.geometry.dispose();
      this.instanceObjs.delete(im);
      this.vehicles.delete(id);
    }
    this.pickables = this.pickables.filter((p) => ![...this.detachedIms.values()].includes(p as THREE.InstancedMesh));
    this.detachedIms.clear();
    this.detachedObjs.clear();
    f.gpu.dispose();
    for (const im of f.gpu.instanceObjs.keys()) this.instanceObjs.delete(im);
    f.world.dispose();
    for (const o of this.objectsByObj.values()) if (!f.base.objects.includes(o)) this.objectsByObj.delete(o.obj);
  }

  /** Monde infini courant (état, retouches). */
  get infinite(): TileWorld | null {
    return this.inf?.world ?? null;
  }

  /** Pose suivie par la caméra : acteur (ou le véhicule où il est assis), véhicule ; hauteur de visée comprise. */
  private followPose(id: string): { id: string; x: number; y: number; z: number; yaw: number } | null {
    const a = this.actors.get(id);
    const vid = a?.ride ? a.ride.veh : a ? null : id;
    if (vid) {
      const v = this.vehicles.get(vid);
      const o = v?.o ?? this.objectsById.get(vid) ?? this.model?.objects.find((x) => x.id === vid);
      const va = v?.actor ?? (vid !== id ? this.actors.get(vid) : undefined);
      if (va) return { id: vid, x: va.pos[0], y: va.pos[1] + va.model.asset.height * 0.9, z: va.pos[2], yaw: va.yaw };
      if (o) return { id: vid, x: o.pos[0], y: o.pos[1] + Math.min(o.height, 4) * 0.6, z: o.pos[2], yaw: v ? v.s.yaw : o.yaw };
    }
    if (!a) return null;
    return { id, x: a.pos[0], y: a.pos[1] + a.model.asset.height * 0.6, z: a.pos[2], yaw: a.yaw };
  }

  /** Centre suivi : acteur suivi, sinon centre de la vue. */
  private infCenter(): [number, number] {
    const f = this.inf!;
    const a = f.follow !== "camera" ? this.followPose(f.follow) : null;
    if (a) return [a.x, a.z];
    const b = this.view.camera === "follow" && this.followId ? this.followPose(this.followId) : null;
    if (b) return [b.x, b.z];
    return [this.view.cx, this.view.cz];
  }

  /** Une image du monde infini : composition dans le budget, montage d'une tuile au plus (jamais pendant un glisser). */
  private stepInfinite(now: number) {
    const f = this.inf!;
    // qualité auto : rayon réduit tant que la densité de pixels a dû baisser (ou sur mobile)
    const low = this.mobile || this.dpr < Math.min(1, this.maxDpr) * 0.8;
    if (low) f.lowSince ||= now;
    else f.lowSince = 0;
    f.world.setLow(this.mobile || (!!f.lowSince && now - f.lowSince > 2000));
    const [x, z] = this.infCenter();
    const budget = this.mobile ? Math.min(f.world.spec.budget, 2.5) : f.world.spec.budget;
    f.world.update(x, z, budget);
    if (!this.drag && !this.settle) {
      const t0 = performance.now();
      const T = f.world.spec.tile;
      const here = `${Math.floor(x / T)},${Math.floor(z / T)},${f.world.radius}`;
      if (this.adoptTiles(false, here !== f.at) || here !== f.at) {
        f.at = here;
        const ms = performance.now() - t0;
        f.upload = ms;
        f.uploadMax = Math.max(f.uploadMax, ms);
      }
    }
    f.pumpMax = Math.max(f.pumpMax, f.world.state().ms);
  }

  /** Monte les tuiles composées (une par image, toutes au premier montage), démonte les relâchées. */
  private adoptTiles(all: boolean, moved = false): boolean {
    const f = this.inf!;
    const w = f.world;
    let changed = false;
    for (const t of w.removed) {
      // une tuile remplacée (retouche) reste affichée jusqu'au montage de la nouvelle (`mount` remplace)
      if (f.gpu.rec(t.key) !== t || w.tiles.has(t.key)) continue;
      f.gpu.unmount(t.key);
      changed = true;
    }
    w.removed = [];
    let n = 0;
    while (w.added.length && (all || n < 1)) {
      const t = w.added.shift()!;
      if (w.tiles.get(t.key) !== t) continue;
      f.gpu.mount(t);
      n++;
      changed = true;
    }
    if (!changed && !moved) return false;
    const [cx, cz] = this.infCenter().map((v) => Math.floor(v / w.spec.tile));
    f.gpu.rebuildInstances(cx, cz, w.radius < w.spec.radius);
    this.hideDetached();
    f.gpu.farGround((x, z) => w.rawHeight(x, z), w.spec.tile, cx, cz, w.radius + 6);
    for (const im of f.gpu.instanceObjs.keys()) this.instanceObjs.set(im, f.gpu.instanceObjs.get(im)!);
    for (const im of [...this.instanceObjs.keys()]) if (im.userData.depth === this.staticMats.depth && !im.parent) this.instanceObjs.delete(im);
    const m = this.model!;
    const tileObjs: ObjectInfo[] = [];
    const lights = [...f.base.lights];
    for (const k of [...this.objectsByObj.keys()]) if (!f.base.objects.includes(this.objectsByObj.get(k)!)) this.objectsByObj.delete(k);
    for (const t of w.tiles.values())
      if (f.gpu.rec(t.key) === t) {
        for (const o of t.model.objects) {
          if (this.detachedObjs.has(o.obj)) continue;
          tileObjs.push(o);
          this.objectsByObj.set(o.obj, o);
        }
        lights.push(...t.model.lights);
      }
    m.objects = [...f.base.objects, ...tileObjs];
    m.lights = lights;
    if (this.selectedObj > 0 && !this.objectsByObj.has(this.selectedObj)) this.selectedObj = -1;
    this.dirty = this.shadowDirty = true;
    this.onTiles?.();
    return true;
  }

  /** Mesure du monde infini (état des tuiles, triangles et appels du sol et du peuplement). */
  infiniteState() {
    const f = this.inf;
    if (!f) return null;
    const r = (v: number) => Math.round(v * 10) / 10;
    // temps du fil principal : composition (budget par image) et envoi d'une tuile à la carte graphique
    return { ...f.world.state(), mounted: f.gpu.size, uploadMs: r(f.upload), uploadMaxMs: r(f.uploadMax), pumpMaxMs: r(f.pumpMax), gpu: f.gpu.stats() };
  }

  /* ---------------- style ---------------- */

  setStyle(s: StyleTokens) {
    this.style = s;
    const c = resolveColors(s);
    this.roles.value.set(c.roles);
    for (const a of this.actors.values()) a.mats.uniforms.uRoles.value.set(resolveColors(s, a.model.asset.colors).roles);
    this.meadows.setStyle(s);
    this.emitters.setStyle(s);
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
    this.shared.uEnv.value = s.environment === "studio" ? 1 : s.environment === "aucun" ? -1 : 0;
    (this.shared.uRoleMat.value as Float32Array).set(encodeRoleFinishes(s.finishes));
    if (Object.keys(s.finishes).length || this.finTable) {
      this.finBank ??= new HeightBank(this.shared.uHeights, this.mobile ? 128 : 256);
      this.finTable ??= new RoleFinTable(this.shared.uRoleFin, this.shared.uFinOn);
      this.finTable.set(this.finBank, s.postQuality === "low" || (s.postQuality === "auto" && this.mobile) ? 1 : 2, s.finishes);
    }
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
    this.photoPost = false;
    this.stack.set(s.post, this.postLow);
    this.dirty = this.shadowDirty = true;
    this.contentVersion++;
    this.resize();
    this.touch();
  }

  /** `reset` : repart de la vue par défaut (et du cadrage de la scène) au lieu de fusionner avec la vue courante. */
  setView(v: unknown, reset = false) {
    if (reset) this.extent = this.fitExtent;
    this.view = parseView(v, reset ? { ...DEFAULT_VIEW, cy: 0 } : this.view);
    const vo = (v ?? {}) as Record<string, unknown>;
    const want = vo.actor ?? (typeof vo.follow === "string" ? vo.follow : undefined);
    this.followId = this.view.camera === "follow" ? String(want ?? this.followId ?? [...this.actors.keys()][0] ?? "") : null;
    if (reset) this.followOff = 0;
    this.dirty = true;
    this.touch();
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
      // suivi : on tourne autour de ce qui est suivi (décalage gardé), le cap lissé continue de le suivre
      if (v.camera === "follow") this.followOff -= dx * 0.3;
      else v.yaw -= dx * 0.3;
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
    this.touch();
  }

  setAnim(a: { play?: boolean; speed?: number; time?: number }) {
    if (a.play !== undefined) this.play = !!a.play;
    if (Number.isFinite(a.speed)) this.speed = clamp(Number(a.speed), 0, 4);
    if (Number.isFinite(a.time)) this.time = Number(a.time);
    this.dirty = true;
    this.touch();
  }

  setHidden(ids: string[]) {
    this.hiddenIds = new Set(ids);
    for (const [id, a] of this.actors) a.mesh.visible = !this.hiddenIds.has(id);
    if (this.balls) {
      this.balls.hidden = new Set(ids.filter((id) => this.balls!.byId.has(id)));
      this.ballsDirty = true;
    }
    if (this.rigid) this.syncRigidHidden();
    if (this.softs) for (const rt of this.softs.items) rt.mesh.visible = this.softShown(rt);
    this.dirty = this.shadowDirty = true;
    this.contentVersion++;
    this.touch();
  }

  select(objectId: string | null) {
    const o = objectId ? this.model?.objects.find((x) => x.id === objectId) : null;
    this.selectedObj = o?.obj ?? -1;
    this.shared.uIdBase.value = this.selectedObj;
    this.shared.uHighlight.value = this.selectedObj > 0 ? 1 : 0;
    this.dirty = true;
    this.touch();
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
      if (it.look !== undefined) a.look = typeof it.look === "string" ? it.look : "";
      // conduite : monter, descendre, conduire (le reste de l'intention est ignoré)
      if (it.action === "board") {
        this.orderBoard(a, it);
        continue;
      }
      if (it.action === "alight") {
        this.orderAlight(a);
        continue;
      }
      if (it.action === "drive" || it.action === "ride") {
        this.orderDrive(a, it);
        continue;
      }
      // à bord, tout autre ordre de déplacement fait d'abord descendre (sans portière)
      if (a.ride && (it.target || Number.isFinite(it.x) || Number.isFinite(it.z) || Number.isFinite(it.vx) || Number.isFinite(it.vz))) this.dropRide(a);
      const toSeat = typeof it.target === "string" && /\.sit\.\d+$/.test(it.target);
      const toBall = typeof it.target === "string" && !!this.ballAt(it.target);
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
        const ball = typeof it.target === "string" ? this.ballAt(it.target) : null;
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
    this.touch();
  }

  /** Tir : l'acteur se tourne vers le ballon, lance le geste, le ballon part dans cette direction. */
  private doKick(a: ActorRT, k: { ball: string; power: number; loft: number; tries?: number }) {
    const b = this.ballAt(k.ball);
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
    this.kickAny(b.id, [(dx / d) * k.power, k.power * k.loft, (dz / d) * k.power]);
    this.onEvent({ type: "kick", payload: { actor: a.model.id, ball: b.id, power: k.power } });
  }

  /** Coup donné à un ballon sans acteur (`kick` du DataProvider) : vitesse en m/s. */
  kickBall(id: string, v: [number, number, number]): boolean {
    const ok = this.kickAny(id, v);
    if (ok) {
      this.onEvent({ type: "kick", payload: { actor: null, ball: id } });
      this.touch();
    }
    return ok;
  }

  /** Position et mouvement des ballons (publiés dans l'état). */
  ballState() {
    const out: Record<string, { x: number; y: number; z: number; moving: boolean }> = this.balls?.snapshot() ?? {};
    const w = this.rigid;
    if (w) {
      const st = this.physOut && this.physOut.status === "ready" ? this.physOut.bodies : null;
      for (const id of w.dynamicIds) {
        if (!w.isBall(id) || this.hiddenIds.has(id) || Object.keys(out).length >= 200) continue;
        const c = w.center(id);
        if (c) out[id] = { x: round3(c.pos[0]), y: round3(c.pos[1]), z: round3(c.pos[2]), moving: !!st?.[id]?.awake };
      }
    }
    return out;
  }

  /** Ballon visé (simulé par Rapier ou par les ballons simples) : id, centre, rayon. */
  private ballAt(id: string): { id: string; pos: V3; r: number } | null {
    const w = this.rigid;
    if (w?.isBall(id)) {
      const c = w.center(id);
      return c ? { id, pos: c.pos, r: c.r } : null;
    }
    const b = this.balls?.byId.get(id);
    if (b) return { id, pos: b.pos, r: b.r };
    // moteur encore en chargement : le ballon est à sa place de départ
    const o = this.objectsById.get(id);
    if (o && o.generator === "ball" && o.body && o.body.kind === "dynamic") {
      const c = o.anchors.center ?? [o.pos[0], o.pos[1] + o.height / 2, o.pos[2]];
      return { id, pos: [...c] as V3, r: o.height / 2 };
    }
    return null;
  }

  /** Coup : par la physique si l'objet est un corps (ordre gardé tant que le moteur charge), sinon ballon simple. */
  private kickAny(id: string, v: [number, number, number]): boolean {
    if (this.rigid?.isDynamic(id)) return this.rigid.kickBody(id, v);
    const o = this.objectsById.get(id);
    if (this.model?.physics && o?.body?.kind === "dynamic") {
      if (this.pendingKicks.length < 32) this.pendingKicks.push([id, v]);
      return true;
    }
    return !!this.balls?.kick(id, v);
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


  /* ---------------- conduite : véhicules et montures ---------------- */

  /** Point local (repère de l'objet, sans échelle) → monde. */
  private toWorldOf(pos: V3, yaw: number, scale: number, l: V3): V3 {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return [pos[0] + (l[0] * c + l[2] * s) * scale, pos[1] + l[1] * scale, pos[2] + (-l[0] * s + l[2] * c) * scale];
  }
  /** Point monde → repère de l'objet (sans échelle). */
  private toLocalOf(pos: V3, yaw: number, scale: number, w: V3): V3 {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const dx = w[0] - pos[0], dz = w[2] - pos[2];
    return [(dx * c - dz * s) / scale, (w[1] - pos[1]) / scale, (dx * s + dz * c) / scale];
  }
  private frameOf(v: VehRT): { pos: V3; yaw: number; scale: number } {
    return v.actor ? { pos: v.actor.pos, yaw: v.actor.yaw, scale: 1 } : { pos: v.o!.pos, yaw: v.o!.yaw, scale: v.o!.scale || 1 };
  }
  private anchorKeys(v: VehRT): string[] {
    return v.actor ? Object.keys(v.actor.model.asset.anchors) : Object.keys(v.o!.anchors);
  }
  /** Place (repère du véhicule, sans échelle). */
  private seatLocal(v: VehRT, seat: string): V3 | null {
    if (v.actor) {
      const an = v.actor.model.asset.anchors[seat];
      return an ? ([...an.pos] as V3) : null;
    }
    const w = v.o!.anchors[seat];
    if (!w) return null;
    const f = this.frameOf(v);
    return this.toLocalOf(f.pos, f.yaw, f.scale, w);
  }
  private seatWorld(v: VehRT, seat: string): V3 | null {
    const l = this.seatLocal(v, seat);
    if (!l) return null;
    const f = this.frameOf(v);
    return this.toWorldOf(f.pos, f.yaw, f.scale, l);
  }

  /** Véhicule ou monture `id` (créé à la première demande) ; `null` si l'objet ne se conduit pas. */
  private vehicle(id: string): VehRT | null {
    const have = this.vehicles.get(id);
    if (have) return have;
    const m = this.model;
    if (!m) return null;
    const a = this.actors.get(id) ?? null;
    let o: ObjectInfo | null = null;
    let spec: VehicleSpec | null = null;
    if (a) spec = a.mo.kind === "animal" ? vehicleSpecOf({ generator: "animal", params: a.model.params, footprint: a.model.asset.footprint, scale: 1 }) : null;
    else {
      o = this.objectsById.get(id) ?? m.objects.find((x) => x.id === id) ?? null;
      if (o && o.mode !== "actor") spec = vehicleSpecOf(o);
    }
    if (!spec) return null;
    // monde infini : le véhicule quitte sa tuile (il en sortira peut-être), il est dessiné à part
    if (o && this.inf && !this.inf.base.objects.includes(o) && !this.detach(o)) return null;
    const pos = a ? a.pos : o!.pos, yaw = a ? a.yaw : o!.yaw;
    const v: VehRT = { id, spec, o, actor: a, s: newDriveState(pos[0], pos[2], yaw), y: pos[1], tilt: [0, 0], mover: null, input: null, route: null, occ: new Map(), lastHit: null, hitT: -10, rolling: false, wheels: [], steers: [], rail: null, alt: 0, closing: [] };
    if (o) {
      for (const j of o.joints ?? []) {
        if (/^wheel\.\d+(\.[lr])?$/.test(j.name)) v.wheels.push({ name: j.name, r: Math.max(0.1, j.pivot[1]) });
        if (j.name.startsWith("steer.")) v.steers.push(j.name);
      }
      if (spec.medium === "rails") v.rail = this.railUnder(o);
      if (spec.medium === "air") v.alt = Math.max(0, o.pos[1] - groundHeight(m, o.pos[0], o.pos[2], o.pos[1]));
    }
    if (a) {
      a.path = null;
      a.goal = null;
      a.drive = null;
    }
    this.vehicles.set(id, v);
    return v;
  }

  /** Voie ferrée sous un train (`structure` à ancres `end.0` / `end.1`). */
  private railUnder(o: ObjectInfo): VehRT["rail"] {
    for (const r of this.model!.objects) {
      const a = r.anchors["end.0"], b = r.anchors["end.1"];
      if (r.generator !== "structure" || !a || !b) continue;
      const dx = b[0] - a[0], dz = b[2] - a[2], L = Math.hypot(dx, dz);
      if (L < 1) continue;
      const ux = dx / L, uz = dz / L;
      const t = (o.pos[0] - a[0]) * ux + (o.pos[2] - a[2]) * uz;
      const lat = Math.abs((o.pos[0] - a[0]) * uz - (o.pos[2] - a[2]) * ux);
      if (lat < 1.5 && t > -1 && t < L + 1) return { x: a[0], z: a[2], dx: ux, dz: uz, t0: 0, t1: L };
    }
    return null;
  }

  /** Monde infini : copie le véhicule hors de sa tuile (instances à part, parties comprises) ; la tuile le retire. */
  private detach(o: ObjectInfo): boolean {
    const f = this.inf!;
    let rec: import("../scene/infinite").TileRec | null = null;
    for (const t of f.world.tiles.values())
      if (t.model.objects.includes(o)) {
        rec = t;
        break;
      }
    if (!rec) return false;
    this.objectsByObj.set(o.obj, o);
    this.objectsById.set(o.id, o);
    const joints: [THREE.InstancedMesh, string][] = [];
    for (const g of rec.model.instances) {
      const i = g.objs.indexOf(o.obj);
      if (i < 0 || !g.mesh.vertexCount) continue;
      const geo = toGeometry(g.mesh);
      geo.setAttribute("aInstObj", new THREE.InstancedBufferAttribute(new Float32Array([o.obj]), 1));
      const im = new THREE.InstancedMesh(geo, this.staticMats.color, 1);
      im.userData.depth = this.staticMats.depth;
      im.frustumCulled = false;
      im.setMatrixAt(0, new THREE.Matrix4().fromArray(g.matrices[i] as unknown as number[]));
      im.instanceMatrix.needsUpdate = true;
      this.scene.add(im);
      this.pickables.push(im);
      this.instanceObjs.set(im, [o.obj]);
      const hash = g.key.indexOf("#");
      if (hash >= 0) joints.push([im, g.key.slice(hash + 1)]);
      else this.detachedIms.set(o.id, im);
    }
    if (!this.detachedIms.has(o.id)) return false;
    for (const [im, name] of joints) this.states.add(im, name, [o.obj], this.objectsByObj);
    if (joints.length) this.finishIms(this.states.sync(o.id));
    f.base.objects.push(o);
    f.world.detach(o.id, rec.key);
    this.detachedObjs.add(o.obj);
    this.hideDetached();
    return true;
  }

  /** Copies restées dans les instances partagées des tuiles : réduites à rien. */
  private hideDetached() {
    if (!this.inf || !this.detachedObjs.size) return;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const [im, objs] of this.inf.gpu.instanceObjs) {
      let hit = false;
      objs.forEach((ob, i) => {
        if (this.detachedObjs.has(ob) && i < im.count) ((hit = true), im.setMatrixAt(i, zero));
      });
      if (hit) im.instanceMatrix.needsUpdate = true;
    }
  }

  /** Emprises qui arrêtent les véhicules (hors véhicules, testés à leur pose courante). */
  private obstacles(): { set: ObstacleSet; vehs: ObjectInfo[] } {
    const m = this.model!;
    const key = this.inf ? `${this.inf.world.version}|${this.inf.base.objects.length}` : m;
    if (this.obstacleCache?.key === key) return this.obstacleCache;
    const objs = this.inf ? [...this.inf.base.objects, ...this.inf.world.objects()] : m.objects;
    const vehs = objs.filter((o) => o.generator === "vehicle" && !(this.inf && this.detachedObjs.has(o.obj) && !this.inf.base.objects.includes(o)));
    const c = { key, set: new ObstacleSet(obstaclesOf(objs, (o) => o.generator === "vehicle")), vehs };
    this.obstacleCache = c;
    return c;
  }

  /**
   * Surface navigable sous (x, z) : eau du terrain (fond assez bas) ou plan d'eau posé (mare, bassin, piscine), sinon
   * `null`.
   */
  private waterAt(x: number, z: number): number | null {
    const m = this.model!;
    const wl = this.inf ? this.inf.world.waterLevel : m.terrain?.spec.water ?? null;
    if (wl !== null && this.bed(x, z) < wl - 0.15) return wl;
    for (const o of this.waterObjs()) {
      const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
      const dx = x - o.pos[0], dz = z - o.pos[2];
      if (Math.abs(dx * c - dz * s) < o.footprint.hx * 0.8 && Math.abs(dx * s + dz * c) < o.footprint.hz * 0.8) return (o.anchors.center ?? o.pos)[1];
    }
    return null;
  }
  private waterCache: { m: unknown; list: ObjectInfo[] } | null = null;
  private waterObjs(): ObjectInfo[] {
    const m = this.model!;
    if (this.waterCache?.m !== m) this.waterCache = { m, list: m.objects.filter((o) => o.generator === "water" && String(o.params.kind ?? "pond") !== "cascade") };
    return this.waterCache.list;
  }

  /** Sol sans tablier (fond de l'eau) : bateaux. */
  private bed(x: number, z: number): number {
    if (this.inf) return this.inf.world.groundOnly(x, z);
    return this.model!.terrain ? this.model!.terrain.height(x, z) : 0;
  }

  /** Ce qui gêne la pose (x, z, cap) du véhicule : bord, eau ou rive, emprise, autre véhicule. */
  private blockedFn(v: VehRT): (x: number, z: number, yaw: number) => string | null {
    const m = this.model!;
    const sp = v.spec;
    const { set, vehs } = this.obstacles();
    const wl = this.inf ? this.inf.world.waterLevel : m.terrain?.spec.water ?? null;
    const W = m.size[0] / 2, D = m.size[1] / 2;
    const box = (x: number, z: number, yaw: number) => ({ x, z, hx: sp.hx * 0.92, hz: sp.hz * 0.92, yaw });
    // ce qui chevauche déjà la pose courante ne retient pas le véhicule (il peut s'en dégager)
    const here = new Set(set.hits(box(v.s.x, v.s.z, v.s.yaw)));
    if (v.actor) here.add(v.id);
    return (x, z, yaw) => {
      if (!this.inf && (Math.abs(x) > W - 0.3 || Math.abs(z) > D - 0.3)) return "edge";
      if (sp.medium === "air") return null;
      const b = box(x, z, yaw);
      const c = Math.cos(yaw), s = Math.sin(yaw);
      if (wl !== null && sp.medium === "ground")
        for (const [u, w] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1], [0, 1], [0, -1]]) {
          const px = x + u * b.hx * c + w * b.hz * s, pz = z - u * b.hx * s + w * b.hz * c;
          if (groundHeight(m, px, pz, wl) < wl - 0.05) return "water";
        }
      if (sp.medium === "water")
        for (const [u, w] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const px = x + u * b.hx * c + w * b.hz * s, pz = z - u * b.hx * s + w * b.hz * c;
          if (this.waterAt(px, pz) === null) return "shore";
        }
      if (sp.medium === "water") {
        // bateau : seuls les ouvrages (piles, garde-corps) et les autres bateaux gênent
        const hit = set.hit(b, (id) => here.has(id) || this.objectsById.get(id)?.generator !== "structure");
        if (hit) return hit;
      } else {
        const hit = set.hit(b, (id) => here.has(id));
        if (hit) return hit;
      }
      for (const o of vehs) {
        if (o.id === v.id || this.hiddenIds.has(o.id)) continue;
        if (Math.hypot(o.pos[0] - x, o.pos[2] - z) > Math.hypot(sp.hx, sp.hz) + o.footprint.r + 0.2) continue;
        if (obbOverlap(b, { x: o.pos[0], z: o.pos[2], hx: o.footprint.hx * 0.95, hz: o.footprint.hz * 0.95, yaw: o.yaw })) return o.id;
      }
      return null;
    };
  }

  /** Le véhicule commandé ou en route est-il en train de rouler ? (boucle d'images, physique, ballons) */
  private get vehRolling(): boolean {
    for (const v of this.vehicles.values()) if (v.rolling || v.route || (v.input && (v.input.throttle || v.input.steer)) || v.closing.length) return true;
    return false;
  }

  /** Commande directe (`drive` du DataProvider) : `{<id>: {throttle, steer, brake}}` ; rend les ids inconnus. */
  setDrive(spec: unknown): string[] {
    const o = spec && typeof spec === "object" && !Array.isArray(spec) ? (spec as Record<string, unknown>) : {};
    for (const v of this.vehicles.values()) if (v.input && !(v.id in o)) v.input = null;
    const unknown: string[] = [];
    for (const [id, raw] of Object.entries(o)) {
      const v = this.vehicle(id);
      if (!v) {
        unknown.push(id);
        continue;
      }
      const inp = readInput(raw);
      v.input = inp;
      if (inp && (inp.throttle || inp.steer || inp.brake)) v.route = null;
    }
    this.touch();
    return unknown;
  }

  /** Point où l'on monte (et descend) : devant la portière de la place, sinon à côté de la place. */
  private approachOf(v: VehRT, seat: string, from: [number, number]): { x: number; z: number; door: string | null } {
    const f = this.frameOf(v);
    const local = this.seatLocal(v, seat) ?? [0, 0, 0];
    if (v.o && v.spec.doors) {
      const locals: Record<string, [number, number, number]> = {};
      for (const [k, w] of Object.entries(v.o.anchors)) if (k.startsWith("approach.door")) locals[k] = this.toLocalOf(f.pos, f.yaw, f.scale, w);
      const d = doorFor(local, locals, (v.o.joints ?? []).map((j) => j.name));
      if (d) {
        const w = v.o.anchors[d.approach];
        return { x: w[0], z: w[2], door: this.states.has(v.id, d.door) ? d.door : null };
      }
    }
    const fr = this.toLocalOf(f.pos, f.yaw, f.scale, [from[0], 0, from[1]]);
    const [lx, lz] = sideApproach(local, v.spec.hx / f.scale, [fr[0], fr[2]]);
    const w = this.toWorldOf(f.pos, f.yaw, f.scale, [lx, 0, lz]);
    return { x: w[0], z: w[2], door: null };
  }

  private driverSeat(v: VehRT): string | null {
    return seatNames(this.anchorKeys(v))[0] ?? null;
  }

  /** `{target, action: "board", seat}` : marche jusqu'à la portière (ou à côté de la place), puis monte. */
  private orderBoard(a: ActorRT, it: ActorIntent) {
    const id = String(it.target ?? "");
    const v = this.vehicle(id);
    const blocked = (reason: string) => this.onEvent({ type: "blocked", payload: { actor: a.model.id, reason, target: id, vehicle: v?.id ?? null } });
    if (!v) return blocked("no-vehicle");
    if (a.mo.kind !== "humanoid") return blocked("not-rider");
    if (a.ride) {
      if (a.ride.veh === v.id) return;
      this.dropRide(a);
    }
    const seat = seatFor(it.seat, seatNames(this.anchorKeys(v)));
    if (!seat) return blocked("no-seat");
    const who = v.occ.get(seat);
    if (who && who !== a.model.id) return blocked("seat-taken");
    for (const [k, w] of v.occ) if (w === a.model.id) v.occ.delete(k);
    v.occ.set(seat, a.model.id);
    const ap = this.approachOf(v, seat, [a.pos[0], a.pos[2]]);
    this.goto(a, ap.x, ap.z, v.id);
    if (a.goal) a.goal.board = { veh: v.id, seat, door: ap.door };
    else v.occ.delete(seat);
  }

  /** Arrivé à la portière : elle s'ouvre (l'acteur attend face au véhicule), sinon il monte tout de suite. */
  private startBoard(a: ActorRT, b: { veh: string; seat: string; door: string | null }) {
    const v = this.vehicles.get(b.veh);
    if (!v || v.occ.get(b.seat) !== a.model.id) return;
    const pose = b.seat === this.driverSeat(v) ? v.spec.pose : v.spec.passengerPose;
    a.ride = { veh: v.id, seat: b.seat, door: b.door, phase: "open", t: 0, pose };
    const P = this.seatWorld(v, b.seat);
    if (P) a.yaw = Math.atan2(P[0] - a.pos[0], P[2] - a.pos[2]);
    a.speed = 0;
    if (b.door) this.finishIms(this.states.hold(v.id, { [b.door]: 1 }, this.stateSpeed() === 0));
  }

  private stateSpeed(): number {
    return this.play ? this.states.speed : 0;
  }

  /** Assis à sa place : pose de conduite, la portière se referme, `board`. */
  private seatRider(a: ActorRT, v: VehRT) {
    const rd = a.ride!;
    rd.phase = "seated";
    rd.t = 0;
    a.path = null;
    a.goal = null;
    a.drive = null;
    a.standAt = undefined;
    a.reachY = undefined;
    a.action = rd.pose === "stand" ? (v.spec.kind === "handcart" ? "carry" : "idle") : rd.pose;
    a.actionTime = 0;
    a.actionWeight = 1;
    this.placeRider(a, v);
    if (rd.door) {
      this.finishIms(this.states.hold(v.id, { [rd.door]: 0 }, this.stateSpeed() === 0));
      v.closing.push(rd.door);
    }
    this.onEvent({ type: "board", payload: { actor: a.model.id, vehicle: v.id, seat: rd.seat, driver: rd.seat === this.driverSeat(v) } });
    const pd = a.pendingDrive;
    a.pendingDrive = undefined;
    if (pd) this.orderDrive(a, pd);
  }

  /** Occupant posé à sa place, dans le repère du véhicule (bassin à l'ancre, pieds au plancher, aux étriers…). */
  private placeRider(a: ActorRT, v: VehRT) {
    const rd = a.ride!;
    const P = this.seatWorld(v, rd.seat);
    if (!P) return;
    const yaw = this.frameOf(v).yaw;
    // le rameur tourne le dos à l'avant
    a.yaw = yaw + (rd.pose === "row" ? Math.PI : 0);
    if (rd.pose === "stand") {
      a.pos = [P[0], P[1], P[2]];
      a.seatY = 0;
      a.seatFoot = undefined;
      a.speed = v.spec.kind === "handcart" ? Math.abs(v.s.speed) : 0;
      return;
    }
    const sY = a.mo.legLength * 0.55;
    a.seatY = sY;
    const info = a.mo.kind === "humanoid" ? a.mo.info : null;
    // le bassin à l'ancre de la place (un peu enfoncé dans un siège), pas au-dessus
    const top = sY + (info ? info.thigh * 0.18 : 0) + (rd.pose === "ride" ? 0 : 0.1);
    a.pos = [P[0], P[1] - top, P[2]];
    a.speed = 0;
    if (!info) return;
    const sc = this.frameOf(v).scale;
    if (rd.pose === "ride") {
      a.seatFoot = v.spec.pedal ? { y: top - 0.56 * sc, spread: info.hipX * 0.9, fwd: 0.19 * sc, pedal: v.s.dist / (sc * 5.3), r: 0.17 * sc } : { y: top - a.mo.legLength * 0.78, spread: Math.max(info.hipX * 1.3, v.spec.hx * 0.8), fwd: 0.05 };
      return;
    }
    const local = this.seatLocal(v, rd.seat) ?? [0, 0.5, 0];
    const drop = Math.min(Math.max(0.1, local[1] * sc - 0.05), 0.38);
    a.seatFoot = { y: top - drop, spread: info.hipX * 1.1, fwd: info.thigh };
  }

  /** `{action: "alight"}` : la portière s'ouvre, l'acteur descend devant elle (ou à côté de sa place), `alight`. */
  private orderAlight(a: ActorRT) {
    const rd = a.ride;
    if (!rd) {
      // en route vers une place : la réservation tombe
      if (a.goal?.board) {
        this.vehicles.get(a.goal.board.veh)?.occ.delete(a.goal.board.seat);
        a.goal.board = undefined;
      }
      return;
    }
    const v = this.vehicles.get(rd.veh);
    if (!v) return this.dropRide(a);
    if (rd.phase === "open") {
      if (rd.door) this.finishIms(this.states.hold(v.id, { [rd.door]: null }, false));
      v.occ.delete(rd.seat);
      a.ride = undefined;
      return;
    }
    if (rd.phase === "exit") return;
    const ap = this.approachOf(v, rd.seat, [a.pos[0], a.pos[2]]);
    rd.door = ap.door;
    rd.phase = "exit";
    rd.t = 0;
    if (rd.door) this.finishIms(this.states.hold(v.id, { [rd.door]: 1 }, this.stateSpeed() === 0));
    else this.leaveSeat(a, v);
  }

  private leaveSeat(a: ActorRT, v: VehRT) {
    const rd = a.ride!;
    const local = this.seatLocal(v, rd.seat) ?? [0, 0, 0];
    const f = this.frameOf(v);
    // côté de la place (gauche par défaut)
    const out = this.toWorldOf(f.pos, f.yaw, f.scale, [local[0] + (local[0] < -0.05 ? -5 : 5), 0, local[2]]);
    const ap = this.approachOf(v, rd.seat, [out[0], out[2]]);
    const m = this.model!;
    let [x, z] = [ap.x, ap.z];
    const nav = m.nav as NavGrid | null;
    if (nav && !nav.free(x, z) && typeof nav.nearestFree === "function") {
      const c = nav.nearestFree(x, z);
      if (c) [x, z] = nav.center(c[0], c[1]);
    }
    a.pos = [x, groundHeight(m, x, z, a.pos[1]), z];
    a.yaw = f.yaw + (local[0] < -0.05 ? -Math.PI / 2 : Math.PI / 2);
    a.seatY = 0;
    a.seatFoot = undefined;
    a.action = "idle";
    a.actionTime = 0;
    a.speed = 0;
    v.occ.delete(rd.seat);
    if (rd.door) {
      this.finishIms(this.states.hold(v.id, { [rd.door]: 0 }, this.stateSpeed() === 0));
      v.closing.push(rd.door);
    }
    if (v.route?.driver === a.model.id) v.route = null;
    a.ride = undefined;
    this.poseActor(a, 0);
    this.onEvent({ type: "alight", payload: { actor: a.model.id, vehicle: v.id, seat: rd.seat, x: round(x), z: round(z) } });
  }

  /** Occupant retiré sans cérémonie (saisi au doigt, autre ordre de montée). */
  private dropRide(a: ActorRT) {
    const rd = a.ride;
    if (!rd) return;
    const v = this.vehicles.get(rd.veh);
    if (v?.occ.get(rd.seat) === a.model.id) v.occ.delete(rd.seat);
    a.ride = undefined;
    a.seatY = 0;
    a.seatFoot = undefined;
    a.action = "idle";
  }

  /** Occupant : étapes de la montée et de la descente, puis il suit sa place. Faux s'il n'est plus à bord. */
  private updateRider(a: ActorRT, dt: number): boolean {
    const rd = a.ride!;
    const v = this.vehicles.get(rd.veh);
    if (!v) {
      a.ride = undefined;
      return false;
    }
    rd.t += dt;
    if (rd.phase === "open") {
      const val = rd.door ? this.states.value(v.id, rd.door) ?? 1 : 1;
      if (val > 0.9 || rd.t > 2.5) {
        // on se glisse de la portière à sa place (0,7 s), en s'asseyant
        rd.phase = "enter";
        rd.t = 0;
        rd.from = [...a.pos] as V3;
        a.path = null;
        a.goal = null;
        a.action = rd.pose === "stand" ? (v.spec.kind === "handcart" ? "carry" : "idle") : rd.pose;
        a.actionTime = 0;
      } else {
        a.speed = 0;
        this.poseActor(a, dt);
        return true;
      }
    }
    if (rd.phase === "enter") {
      const u = Math.min(1, rd.t / 0.7);
      const e = u * u * (3 - 2 * u);
      const from = rd.from ?? a.pos;
      const yaw0 = a.yaw;
      this.placeRider(a, v);
      const to = [...a.pos] as V3;
      a.pos = [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e, from[2] + (to[2] - from[2]) * e];
      let dy = a.yaw - yaw0;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      a.yaw = yaw0 + dy * Math.min(1, e * 1.5 + 0.1);
      a.actionWeight = e;
      if (u >= 1) this.seatRider(a, v);
      this.poseActor(a, dt);
      return true;
    } else if (rd.phase === "exit") {
      const val = rd.door ? this.states.value(v.id, rd.door) ?? 1 : 1;
      if (val > 0.9 || rd.t > 2.5) {
        this.leaveSeat(a, v);
        return true;
      }
    }
    this.placeRider(a, v);
    // charrette : on marche en la tirant ; vélo : les pédales tournent
    if (a.speed > 0) a.phase += (a.speed * dt) / (2 * a.mo.stepLength(Math.max(a.speed, 0.2)));
    a.actionTime += dt;
    a.actionWeight = 1;
    this.poseActor(a, dt);
    return true;
  }

  /** `{action: "drive", to}` : le conducteur emmène son véhicule (ou sa monture) par les routes ou la grille. */
  private orderDrive(a: ActorRT, it: ActorIntent) {
    const rd = a.ride;
    const v = rd ? this.vehicles.get(rd.veh) : undefined;
    const blocked = (reason: string) => this.onEvent({ type: "blocked", payload: { actor: a.model.id, reason, vehicle: v?.id ?? null } });
    // en train de monter à la place du conducteur : l'ordre attend qu'il soit assis
    const boarding = rd ? rd.phase === "open" || rd.phase === "enter" : !!a.goal?.board;
    const bv = rd ? v : a.goal?.board ? this.vehicles.get(a.goal.board.veh) : undefined;
    if (boarding && bv && (rd ? rd.seat : a.goal!.board!.seat) === this.driverSeat(bv)) {
      a.pendingDrive = it;
      return;
    }
    if (!v || !rd || rd.phase !== "seated" || rd.seat !== this.driverSeat(v)) return blocked("not-driver");
    const m = this.model!;
    const to = it.to ?? (Number.isFinite(it.x) || Number.isFinite(it.z) ? { x: it.x, z: it.z } : undefined);
    let x = NaN, z = NaN, target: string | null = null, arriveR = Math.max(0.8, v.spec.hz * 0.3);
    if (to && typeof to === "object" && !Array.isArray(to)) {
      x = Number((to as { x?: unknown }).x);
      z = Number((to as { z?: unknown }).z);
    } else if (Array.isArray(to)) [x, z] = [Number(to[0]), Number(to[1])];
    else if (typeof to === "string") {
      target = to;
      const zn = m.zones.find((q) => q.id === to);
      const o = this.objectsById.get(to) ?? m.objects.find((q) => q.id === to);
      const b = this.actors.get(to);
      if (zn) {
        [x, z] = zn.box ? [(zn.box[0] + zn.box[2]) / 2, (zn.box[1] + zn.box[3]) / 2] : [zn.x, zn.z];
        arriveR = Math.max(arriveR, zn.box ? Math.min(zn.box[2] - zn.box[0], zn.box[3] - zn.box[1]) * 0.3 : zn.r * 0.6);
      } else if (o) {
        [x, z] = [o.pos[0], o.pos[2]];
        arriveR = Math.max(o.footprint.hx, o.footprint.hz) + v.spec.hz + 0.8;
      } else if (b) {
        [x, z] = [b.pos[0], b.pos[2]];
        arriveR = v.spec.hz + 1.5;
      }
    }
    if (!Number.isFinite(x) || !Number.isFinite(z)) return blocked("no-target");
    const cruise = Math.min(v.spec.maxSpeed, Number.isFinite(it.speed) && Number(it.speed) > 0 ? Number(it.speed) : v.spec.maxSpeed * (v.spec.mount ? (it.run ? 0.9 : 0.45) : 0.6));
    this.driveTo(v, a.model.id, x, z, target, arriveR, cruise);
  }

  private routeCtx(v: VehRT, from: [number, number], to: [number, number]): import("../scene/drive").RouteCtx {
    const m = this.model!;
    const pad = 40;
    const b = this.inf
      ? { x0: Math.min(from[0], to[0]) - pad, z0: Math.min(from[1], to[1]) - pad, x1: Math.max(from[0], to[0]) + pad, z1: Math.max(from[1], to[1]) + pad }
      : { x0: -m.size[0] / 2, z0: -m.size[1] / 2, x1: m.size[0] / 2, z1: m.size[1] / 2 };
    const roads = this.inf ? worldRoads(this.inf.world.spec, b.x0, b.z0, b.x1, b.z1).concat(m.terrain?.paths ?? []) : m.terrain?.paths ?? [];
    const wl = this.inf ? this.inf.world.waterLevel : m.terrain?.spec.water ?? null;
    return {
      roads: roads.filter((p) => p.kind !== "river"),
      nav: m.nav as never,
      water: wl === null && !this.waterObjs().length ? undefined : (x, z) => this.waterAt(x, z) !== null,
      bounds: b,
      self: v.id,
    };
  }

  private driveTo(v: VehRT, driver: string | null, x: number, z: number, target: string | null, arriveR: number, cruise: number) {
    if (v.rail) {
      // train : point visé ramené sur la voie
      const r = v.rail;
      const t = clamp((x - r.x) * r.dx + (z - r.z) * r.dz, r.t0 + v.spec.hz, r.t1 - v.spec.hz);
      [x, z] = [r.x + r.dx * t, r.z + r.dz * t];
    }
    const from: [number, number] = [v.s.x, v.s.z];
    const pts = planRoute(v.spec, from, [x, z], this.routeCtx(v, from, [x, z]));
    if (!pts || pts.length < 2) {
      this.onEvent({ type: "blocked", payload: { actor: driver, vehicle: v.id, reason: "no-path", x: round(x), z: round(z), target } });
      return;
    }
    v.route = { ...newRoute(pts, arriveR, cruise), goal: { x, z, target }, driver, tries: v.route?.goal.x === x && v.route?.goal.z === z ? v.route.tries : 0 };
    v.input = null;
    this.touch();
  }

  /** En route : l'emprise mobile quitte la grille, l'obstacle du moteur physique suit la caisse (il pousse). */
  private startRolling(v: VehRT) {
    v.rolling = true;
    const nav = this.model?.nav as NavGrid | null;
    if (v.o && nav && typeof nav.dynClear === "function") nav.dynClear(v.id);
    if (v.o) this.rigid?.grab(v.id, true);
  }

  /** Arrêt : l'emprise reprend sa place dans la grille (les piétons contournent), l'obstacle se refige. */
  private stopRolling(v: VehRT) {
    v.rolling = false;
    if (!v.o) return;
    const nav = this.model?.nav as NavGrid | null;
    if (nav && typeof nav.dynBox === "function") nav.dynBox(v.id, v.s.x, v.s.z, v.spec.hx, v.spec.hz, v.s.yaw, 0.25);
    const y2 = v.s.yaw / 2;
    this.rigid?.release(v.id, undefined, { x: v.s.x, y: v.y, z: v.s.z, q: { x: 0, y: Math.sin(y2), z: 0, w: Math.cos(y2) } });
  }

  private stepVehicles(dt: number) {
    if (!this.vehicles.size || !this.model) return;
    for (const v of this.vehicles.values()) {
      // portières qui se referment : rendues aux états demandés une fois fermées
      if (v.closing.length) v.closing = v.closing.filter((d) => {
        if ((this.states.value(v.id, d) ?? 0) > 0.02) return true;
        this.finishIms(this.states.hold(v.id, { [d]: null }, false));
        return false;
      });
      this.stepVehicle(v, dt);
    }
  }

  private stepVehicle(v: VehRT, dt: number) {
    if (v.actor?.hidden || (v.o && this.hiddenIds.has(v.id))) return;
    if (this.drag && ((v.o && this.drag.o === v.o) || (v.actor && this.drag.actor === v.actor))) return;
    if (this.settle && ((v.o && this.settle.d.o === v.o) || (v.actor && this.settle.d.actor === v.actor))) return;
    const direct = v.input && (v.input.throttle || v.input.steer || v.input.brake) ? v.input : null;
    let inp: DriveInput | null = direct;
    let arrived = false, stuck = false;
    if (!inp && v.route) {
      const f = followRoute(v.spec, v.s, v.route, dt);
      inp = f.input;
      arrived = f.done;
      stuck = f.stuck;
    }
    if (!inp && v.s.speed === 0) {
      if (v.rolling) this.stopRolling(v);
      return;
    }
    const r = stepDrive(v.spec, v.s, inp ?? { throttle: 0, steer: 0, brake: 0.4 }, dt, this.blockedFn(v));
    if (v.rail) {
      const R = v.rail;
      const t = (v.s.x - R.x) * R.dx + (v.s.z - R.z) * R.dz;
      const tc = clamp(t, R.t0 + v.spec.hz, R.t1 - v.spec.hz);
      if (tc !== t) {
        v.s.speed = 0;
        if (v.lastHit !== "rails-end") this.onEvent({ type: "bump", payload: { vehicle: v.id, hit: "rails-end", x: round(v.s.x), z: round(v.s.z) } });
        v.lastHit = "rails-end";
      }
      v.s.x = R.x + R.dx * tc;
      v.s.z = R.z + R.dz * tc;
    }
    if (r.hit) {
      if (v.lastHit !== r.hit || this.time - v.hitT > 1.5) this.onEvent({ type: "bump", payload: { vehicle: v.id, hit: r.hit, x: round(v.s.x), z: round(v.s.z) } });
      v.lastHit = r.hit;
      v.hitT = this.time;
    } else if (r.moved && v.lastHit !== "rails-end") v.lastHit = null;
    if (r.moved && !v.rolling) this.startRolling(v);
    this.poseVehicle(v, dt);
    if (arrived && v.route) {
      const g = v.route.goal;
      this.onEvent({ type: "arrive", payload: { actor: v.route.driver, vehicle: v.id, x: round(v.s.x), z: round(v.s.z), target: g.target } });
      v.route = null;
    } else if (stuck && v.route) {
      const rt = v.route;
      // coincé : un nouvel itinéraire depuis là, une fois ; puis `blocked`
      if (rt.tries < 1) {
        this.driveTo(v, rt.driver, rt.goal.x, rt.goal.z, rt.goal.target, rt.arriveR, rt.cruise);
        if (v.route) v.route.tries = rt.tries + 1;
      } else {
        this.onEvent({ type: "blocked", payload: { actor: rt.driver, vehicle: v.id, reason: v.lastHit ? "wall" : "stuck", hit: v.lastHit } });
        v.route = null;
      }
    }
    if (!v.route && !direct && Math.abs(v.s.speed) < 1e-3 && v.rolling) this.stopRolling(v);
  }

  /** Caisse posée : sur le relief (tangage, roulis, inclinaison dans les virages), sur l'eau, sur la voie, en l'air. */
  private poseVehicle(v: VehRT, dt: number) {
    const m = this.model!;
    const sp = v.spec, s = v.s;
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw), lx = Math.cos(s.yaw), lz = -Math.sin(s.yaw);
    let y = v.y, pitch = 0, roll = 0;
    if (sp.medium === "water") {
      const wl = this.waterAt(s.x, s.z) ?? (this.inf ? this.inf.world.waterLevel ?? 0 : m.terrain?.spec.water ?? v.y + 0.15);
      y = wl - 0.15 + Math.sin(this.time * 1.7 + s.x) * 0.025;
      pitch = Math.sin(this.time * 1.3 + s.z) * 0.015 + clamp(-s.lon * 0.02, -0.04, 0.04);
      roll = Math.sin(this.time * 1.1 + 1) * 0.02 + clamp(-s.lat / 9.81, -1, 1) * sp.lean;
    } else if (sp.medium === "air") {
      const g = groundHeight(m, s.x, s.z, v.y);
      const want = v.route || Math.abs(s.speed) > 0.2 ? 7 : v.route === null && v.input === null ? Math.max(0, v.alt - 0.5) : v.alt;
      v.alt += (want - v.alt) * (1 - Math.exp(-dt * 0.5));
      y = g + v.alt;
    } else if (sp.medium === "ground") {
      const H = (x: number, z: number) => groundHeight(m, x, z, v.y);
      const a = sp.hz * 0.7, b = sp.hx * 0.8;
      const hf = H(s.x + fx * a, s.z + fz * a), hb = H(s.x - fx * a, s.z - fz * a), hl = H(s.x + lx * b, s.z + lz * b), hr = H(s.x - lx * b, s.z - lz * b);
      y = Math.max(H(s.x, s.z), (hf + hb) / 2) - 0.02;
      if (!sp.mount) {
        pitch = -Math.atan2(hf - hb, 2 * a) + clamp(-s.lon * 0.006, -0.03, 0.03);
        roll = Math.atan2(hl - hr, 2 * b);
        // vélo : penché vers l'intérieur du virage ; voiture : la caisse roule vers l'extérieur
        roll += sp.pedal ? -clamp(Math.atan(s.lat / 9.81), -sp.lean, sp.lean) : clamp(s.lat / 6, -1, 1) * sp.lean;
      }
    }
    const k = 1 - Math.exp(-dt * 8);
    v.tilt = [v.tilt[0] + (pitch - v.tilt[0]) * k, v.tilt[1] + (roll - v.tilt[1]) * k];
    v.y = y;
    if (v.o) {
      if (!v.mover) v.mover = this.moverOf(v.o);
      if (v.mover) this.applyPose(v.mover, s.x, y, s.z, s.yaw, v.tilt, true);
      if (v.wheels.length || v.steers.length) {
        const vals: Record<string, number> = {};
        const sc = v.o.scale || 1;
        for (const w of v.wheels) vals[w.name] = wheelPartValue(s.dist / sc, w.r);
        for (const n of v.steers) vals[n] = steerPartValue(s.steer);
        this.finishIms(this.states.hold(v.o.id, vals, true));
      }
    } else if (v.actor) {
      const a = v.actor;
      a.pos = [s.x, y, s.z];
      a.turn = (s.yaw - a.yaw) / Math.max(dt, 1e-3);
      a.yaw = s.yaw;
      a.speed = Math.abs(s.speed);
    }
    this.dirty = this.shadowDirty = true;
    this.contentVersion++;
  }

  /** Monture conduite : son allure suit la vitesse, elle ne vaque plus à ses occupations. */
  private updateMount(a: ActorRT, dt: number) {
    if (a.speed > 0) a.phase += (a.speed * dt) / (2 * a.mo.stepLength(Math.max(a.speed, 0.2)));
    if (a.action !== "idle" && a.action !== "walk" && a.action !== "run") a.action = "idle";
    a.actionWeight += (0 - a.actionWeight) * (1 - Math.exp(-dt * 6));
    this.poseActor(a, dt);
  }

  /** Véhicule ou monture déplacé hors conduite (glisser) : état et occupants suivent, emprise de la grille aussi. */
  private afterMove(id: string) {
    const v = this.vehicles.get(id);
    const o = v?.o ?? this.objectsById.get(id) ?? null;
    if (o && o.generator === "vehicle") {
      const nav = this.model?.nav as NavGrid | null;
      if (nav && typeof nav.dynBox === "function") nav.dynBox(o.id, o.pos[0], o.pos[2], o.footprint.hx, o.footprint.hz, o.yaw, 0.25);
    }
    if (!v) return;
    const f = this.frameOf(v);
    v.s.x = f.pos[0];
    v.s.z = f.pos[2];
    v.s.yaw = f.yaw;
    v.s.speed = 0;
    v.y = f.pos[1];
    v.route = null;
    v.mover = null;
    for (const aid of v.occ.values()) {
      const a = this.actors.get(aid);
      if (a?.ride?.veh === v.id && a.ride.phase === "seated") {
        this.placeRider(a, v);
        this.poseActor(a, 0);
      }
    }
  }

  /** Recomposition : véhicules déplacés et occupants gardés (même objet, mêmes paramètres). */
  private keepVehicles() {
    this.vehCarry = [];
    for (const v of this.vehicles.values()) {
      const occ = [...v.occ].filter(([, aid]) => this.actors.get(aid)?.ride?.phase === "seated");
      if (!v.o && !occ.length) continue;
      if (v.o && this.inf) continue;
      const f = this.frameOf(v);
      this.vehCarry.push({ id: v.id, key: v.o ? JSON.stringify([v.o.generator, v.o.params]) : "", x: f.pos[0], z: f.pos[2], yaw: f.yaw, y: f.pos[1], occ });
    }
  }

  private restoreVehicles() {
    const carry = this.vehCarry;
    this.vehCarry = [];
    for (const c of carry) {
      const o = this.objectsById.get(c.id);
      if (c.key && (!o || JSON.stringify([o.generator, o.params]) !== c.key)) continue;
      const v = this.vehicle(c.id);
      if (!v) continue;
      if (v.o) {
        v.s = newDriveState(c.x, c.z, c.yaw);
        v.y = c.y;
        v.mover = this.moverOf(v.o);
        if (v.mover) this.applyPose(v.mover, c.x, c.y, c.z, c.yaw, undefined, true);
        const nav = this.model?.nav as NavGrid | null;
        if (nav && typeof nav.dynBox === "function") nav.dynBox(v.id, c.x, c.z, v.spec.hx, v.spec.hz, c.yaw, 0.25);
      }
      for (const [seat, aid] of c.occ) {
        const a = this.actors.get(aid);
        if (!a || a.mo.kind !== "humanoid") continue;
        v.occ.set(seat, aid);
        a.ride = { veh: v.id, seat, door: null, phase: "seated", t: 0, pose: seat === this.driverSeat(v) ? v.spec.pose : v.spec.passengerPose };
        a.action = a.ride.pose === "stand" ? (v.spec.kind === "handcart" ? "carry" : "idle") : a.ride.pose;
        a.actionWeight = 1;
        this.placeRider(a, v);
        this.poseActor(a, 0);
      }
    }
  }

  /** Places et occupants d'un véhicule ou d'une monture (sélection, `vehicles`). */
  vehicleSeats(id: string): { seats: string[]; occupants: Record<string, string> } | null {
    const v = this.vehicles.get(id);
    const o = v?.o ?? (this.actors.has(id) ? null : this.objectsById.get(id) ?? this.model?.objects.find((x) => x.id === id) ?? null);
    const a = v?.actor ?? this.actors.get(id) ?? null;
    if (!v) {
      const sp = a ? (a.mo.kind === "animal" ? vehicleSpecOf({ generator: "animal", params: a.model.params, footprint: a.model.asset.footprint, scale: 1 }) : null) : o ? vehicleSpecOf(o) : null;
      if (!sp) return null;
    }
    const keys = a ? Object.keys(a.model.asset.anchors) : Object.keys(o?.anchors ?? {});
    const occupants: Record<string, string> = {};
    for (const [k, aid] of v?.occ ?? []) if (this.actors.get(aid)?.ride?.veh === id) occupants[k] = aid;
    return { seats: seatNames(keys), occupants };
  }

  /** `state-out.vehicles` : véhicules et montures (64 au plus) avec position, cap, vitesse, conducteur, places. */
  vehicleState(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const m = this.model;
    if (!m) return out;
    let n = 0;
    const put = (id: string, x: number, z: number, yaw: number) => {
      if (n >= 64) return;
      const info = this.vehicleSeats(id);
      if (!info) return;
      n++;
      const v = this.vehicles.get(id);
      const driverSeat = info.seats[0];
      const driver = driverSeat ? info.occupants[driverSeat] ?? null : null;
      out[id] = { x: round(x), z: round(z), yaw: Math.round((yaw * 180) / Math.PI), speed: round(v ? v.s.speed : 0), driver, passengers: Object.entries(info.occupants).filter(([k]) => k !== driverSeat).map(([, a]) => a), seats: Object.fromEntries(info.seats.map((k) => [k, info.occupants[k] ?? null])), ...(v?.route ? { to: { x: round(v.route.goal.x), z: round(v.route.goal.z), target: v.route.goal.target } } : {}) };
    };
    for (const o of m.objects) if (o.generator === "vehicle" && !this.hiddenIds.has(o.id)) put(o.id, o.pos[0], o.pos[2], o.yaw);
    for (const a of this.actors.values()) if (a.mo.kind === "animal" && !a.hidden) put(a.model.id, a.pos[0], a.pos[2], a.yaw);
    return out;
  }

  /* ---------------- physique 3D ---------------- */

  /** Poses des corps de la scène courante, reprises par la prochaine composition (même objet, même départ). */
  private keepPoses() {
    const w = this.rigid;
    if (!w) return;
    this.carry.clear();
    for (const id of w.dynamicIds) {
      const k = this.spawnKey.get(id);
      const p = w.pose(id);
      if (k && p) this.carry.set(id, { key: k, pose: p });
    }
  }

  /** Moteur chargé à la demande, puis monde physique construit ; ordres et coups arrivés entre-temps joués. */
  private mountRigid(model: SceneModel) {
    const tok = ++this.rigidTok;
    if (!model.physics) {
      this.physOut = null;
      this.carry.clear();
      return;
    }
    this.physOut = { status: "loading" };
    this.firstForces = this.pendingForces;
    const cache = new Map<string, LocalBounds>();
    const bounds = (o: ObjectInfo) => {
      const s = this.rigidSlots.get(o.id);
      if (!s) return null;
      const key = `${o.generator}|${JSON.stringify(o.params)}|${s.scale}|${s.pos.length}`;
      let b = cache.get(key);
      if (!b) cache.set(key, (b = meshBounds(s.pos, s.scale)));
      return b;
    };
    loadRapier().then(
      (R) => {
        if (tok !== this.rigidTok || this.model !== model || this.disposed) return;
        try {
          const w = new ProcgenRigid(R, model, {
            actorPose: (id) => {
              const a = this.actors.get(id);
              return a ? { x: a.pos[0], y: a.pos[1], z: a.pos[2], yaw: a.yaw, hidden: !a.mesh.visible } : null;
            },
            objectPose: (id) => {
              const o = this.objectsById.get(id);
              return o ? { x: o.pos[0], y: o.pos[1], z: o.pos[2], yaw: o.yaw } : null;
            },
          }, bounds);
          this.rigid = w;
          for (const msg of w.issues) model.issues.push({ path: "physics", code: "info", message: msg });
          // même scène recomposée : les corps reprennent leur pose (endormis)
          for (const [id, c] of this.carry) if (this.spawnKey.get(id) === c.key) w.restore(id, c.pose);
          this.carry.clear();
          for (const id of w.dynamicIds) this.syncSlot(id);
          this.syncRigidHidden();
          const first = this.firstForces ?? this.pendingForces;
          if (first) w.applyOrders(first);
          if (this.pendingForces && this.pendingForces !== first) w.applyOrders(this.pendingForces);
          this.firstForces = null;
          for (const [id, v] of this.pendingKicks.splice(0)) w.kickBody(id, v);
          this.physOut = { status: "ready", ...w.snapshot() };
          this.answerQueries(true);
          this.dirty = this.shadowDirty = true;
          this.kick();
        } catch (e) {
          this.physOut = { status: "error", error: e instanceof Error ? e.message : String(e) };
        }
      },
      (e) => {
        if (tok === this.rigidTok) this.physOut = { status: "error", error: `moteur : ${e instanceof Error ? e.message : String(e)}` };
      },
    );
  }

  private syncRigidHidden() {
    this.rigid?.setHidden(new Set([...this.hiddenIds].filter((id) => this.rigid!.isDynamic(id))));
    for (const id of this.rigid?.dynamicIds ?? []) this.syncSlot(id);
  }

  private tmpM = new THREE.Matrix4();
  private tmpP = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpS = new THREE.Vector3();
  /** Matrice d'instance d'un corps : pose du corps à l'échelle de l'objet (caché : réduit à rien). */
  private syncSlot(id: string) {
    const s = this.rigidSlots.get(id);
    const p = this.rigid?.pose(id);
    if (!s || !p) return;
    if (this.hiddenIds.has(id)) this.tmpM.makeScale(0, 0, 0);
    else this.tmpM.compose(this.tmpP.set(p.x, p.y, p.z), this.tmpQ.set(p.q.x, p.q.y, p.q.z, p.q.w), this.tmpS.setScalar(s.scale));
    s.im.setMatrixAt(s.i, this.tmpM);
    s.im.instanceMatrix.needsUpdate = true;
    if (this.hiddenIds.has(id)) return;
    const o = this.objectsById.get(id);
    if (o?.joints) for (const im of this.states.sync(id)) im.instanceMatrix.needsUpdate = true;
  }

  /** Ordres `forces.<id>` (vitesse, force, impulsion, téléportation) ; gardés tant que le moteur charge. */
  applyForces(spec: unknown) {
    this.pendingForces = spec;
    if (!this.rigid) {
      this.firstForces ??= spec;
      return;
    }
    this.rigid.applyOrders(spec);
    this.kick();
  }

  /** Requêtes `queries.<id>` : réponse à chaque hausse de `n`, ou à chaque pas avec `live: true` (16 au plus). */
  applyQueries(spec: unknown) {
    this.querySpec = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : {};
    this.answerQueries(false);
  }

  private answerQueries(all: boolean): boolean {
    const w = this.rigid;
    if (!w) return false;
    let any = false;
    for (const [id, raw] of Object.entries(this.querySpec).slice(0, 16)) {
      if (!raw || typeof raw !== "object") continue;
      const q = raw as Record<string, unknown>;
      const n = typeof q.n === "number" ? q.n : 0;
      if (!(q.live === true || all || n !== this.queryN.get(id))) continue;
      this.queryN.set(id, n);
      this.queryOut = { ...this.queryOut, [id]: { n, ...w.query(q) } };
      any = true;
    }
    return any;
  }

  /** Avance la physique, réécrit les matrices des corps qui bougent, envoie chocs et événements. */
  private stepRigid(dt: number, now: number) {
    const w = this.rigid!;
    if (!w.moving && !this.actors.size && !this.drag && !this.vehRolling) return;
    const moved = w.stepScene(dt);
    const touched = new Set<THREE.InstancedMesh>();
    for (const id of moved) {
      this.syncSlot(id);
      const s = this.rigidSlots.get(id);
      if (s) touched.add(s.im);
    }
    for (const im of touched) im.computeBoundingSphere();
    if (touched.size) {
      this.dirty = this.shadowDirty = true;
      this.contentVersion++;
    }
    for (const c of w.takeContacts()) this.onEvent({ type: "contact", payload: c });
    for (const e of w.takeEvents()) {
      if (e.type === "rest") this.physVersion++;
      this.onEvent(e);
    }
    if (w.rested) {
      this.physVersion++;
      this.onEvent({ type: "settle", payload: { bodies: w.rested } });
      w.rested = null;
    }
    if (Object.values(this.querySpec).some((q) => !!q && typeof q === "object" && (q as { live?: unknown }).live === true)) this.answerQueries(false);
    if ((moved.length || this.physOut?.status !== "ready") && now - this.lastPhys >= 100) {
      this.lastPhys = now;
      this.physOut = { status: "ready", ...w.snapshot() };
    }
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
    if (!o) return false;
    // corps dynamique : il suit le doigt par la physique (pousse les autres), puis retombe au lâcher
    if (this.rigid?.isDynamic(o.id)) {
      const p = this.rigid.pose(o.id);
      if (!p || !this.rigid.grab(o.id)) return false;
      this.drag = { o, pos0: [...o.pos], yaw0: o.yaw, anchors0: {}, cur: { x: o.pos[0], y: o.pos[1], z: o.pos[2], yaw: o.yaw }, body: { off: [p.x - o.pos[0], p.y - o.pos[1], p.z - o.pos[2]], q: p.q, trail: [] } };
      this.rigid.dragTarget.set(o.id, p);
      this.shared.uIdBase.value = o.obj;
      this.shared.uHighlight.value = 1;
      this.kick();
      return true;
    }
    if (o.generator === "ball" && !o.body) return false;
    let d: DragRT | null;
    if (o.mode === "actor") {
      const a = this.actors.get(o.id);
      if (!a) return false;
      // un passager saisi descend (sans portière) ; une monture saisie emmène son cavalier
      if (a.ride) this.dropRide(a);
      d = { o, pos0: [...a.pos], yaw0: a.yaw, anchors0: Object.fromEntries(Object.entries(o.anchors).map(([k, v]) => [k, [...v] as V3])), actor: a, cur: { x: a.pos[0], y: a.pos[1], z: a.pos[2], yaw: a.yaw } };
    } else d = this.moverOf(o);
    if (!d) return false;
    this.drag = d;
    // obstacle du moteur : rendu cinématique pendant le geste (il pousse les corps)
    if (this.rigid?.grab(o.id, true)) d.obstacle = true;
    this.shared.uIdBase.value = o.obj;
    this.shared.uHighlight.value = 1;
    return true;
  }

  /**
   * Poignée de déplacement d'un objet sans recomposer : instance (matrice réécrite) ou sommets de sa tuile. Sert au
   * glisser et à la conduite (même pose absolue depuis la pose de départ).
   */
  private moverOf(o: ObjectInfo): DragRT | null {
    const d: DragRT = { o, pos0: [...o.pos], yaw0: o.yaw, anchors0: Object.fromEntries(Object.entries(o.anchors).map(([k, v]) => [k, [...v] as V3])), ...(o.seatYaw ? { seatYaw0: { ...o.seatYaw } } : {}), cur: { x: o.pos[0], y: o.pos[1], z: o.pos[2], yaw: o.yaw } };
    const det = this.detachedIms.get(o.id);
    if (det) {
      const m0 = new THREE.Matrix4();
      det.getMatrixAt(0, m0);
      d.inst = { im: det, i: 0, m0 };
      return d;
    }
    if (o.mode === "instance") {
      for (const [im, objs] of this.instanceObjs) {
        // instances des parties mobiles : déplacées par la couche d'états (matrice objet × partie), pas ici
        if (this.states.partOf.has(im)) continue;
        const i = objs.indexOf(o.obj);
        if (i < 0) continue;
        const m0 = new THREE.Matrix4();
        im.getMatrixAt(i, m0);
        d.inst = { im, i, m0 };
        break;
      }
      if (!d.inst) return null;
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
        d.tiles.push({ mesh, a, b: b + 1, pos0: pos.slice(a * 3, (b + 1) * 3), nrm0: nrm.slice(a * 3, (b + 1) * 3), off: [mesh.position.x, mesh.position.z] });
        mesh.frustumCulled = false;
      }
      if (!d.tiles.length) return null;
    }
    return d;
  }

  /** Pose courante de l'objet saisi (position de sa base, cap en radians) ; `invalid` : fantôme rouge. */
  dragTo(x: number, y: number, z: number, yaw: number, invalid = false) {
    const d = this.drag;
    if (!d) return;
    if (d.body) {
      const b = d.body;
      const t = { x: x + b.off[0], y: y + b.off[1], z: z + b.off[2], q: b.q };
      this.rigid?.dragTarget.set(d.o.id, t);
      b.trail.push({ x: t.x, y: t.y, z: t.z, t: performance.now() });
      if (b.trail.length > 6) b.trail.shift();
      d.cur = { x, y, z, yaw };
      this.dirty = this.shadowDirty = true;
      this.kick();
      return;
    }
    this.applyPose(d, x, y, z, yaw);
    this.shared.uHighlight.value = invalid ? 2 : 1;
    this.dirty = this.shadowDirty = true;
    this.contentVersion++;
    this.touch();
  }

  /** Lâcher : `to` = pose finale (l'objet y retombe avec un petit rebond) ; `null` = retour à la place de départ. */
  dragEnd(to: { x: number; y: number; z: number; yaw: number } | null) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.body) {
      // lâcher : le corps reprend la physique, lancé à la vitesse du geste (15 m/s au plus)
      const tr = d.body.trail;
      let vel: V3 = [0, 0, 0];
      if (tr.length >= 2) {
        const a = tr[0], b = tr[tr.length - 1], dt = Math.max(0.016, (b.t - a.t) / 1000);
        vel = [(b.x - a.x) / dt, (b.y - a.y) / dt, (b.z - a.z) / dt];
        const sp = Math.hypot(vel[0], vel[1], vel[2]);
        if (sp > 15) vel = vel.map((v) => (v * 15) / sp) as V3;
        if (performance.now() - b.t > 150) vel = [0, 0, 0];
      }
      this.rigid?.dragTarget.delete(d.o.id);
      this.rigid?.release(d.o.id, vel);
      this.select(this.selectedObj > 0 ? this.objectsByObj.get(this.selectedObj)?.id ?? null : null);
      this.dirty = this.shadowDirty = true;
      this.kick();
      return;
    }
    const fin = to ?? { x: d.pos0[0], y: d.pos0[1], z: d.pos0[2], yaw: d.yaw0 };
    this.applyPose(d, fin.x, d.cur.y, fin.z, fin.yaw);
    this.settle = { d, from: d.cur.y, to: fin.y, t0: performance.now() };
    this.select(this.selectedObj > 0 ? this.objectsByObj.get(this.selectedObj)?.id ?? null : null);
    this.dirty = this.shadowDirty = true;
    this.contentVersion++;
    this.touch();
  }

  private stepSettle(now: number) {
    const s = this.settle!;
    const u = (now - s.t0) / 200;
    const y = u >= 1 ? s.to : s.to + (s.from - s.to) * (1 - u) * (1 - u) - Math.sin(Math.PI * u) * Math.min(0.015, Math.abs(s.from - s.to) * 0.25);
    this.applyPose(s.d, s.d.cur.x, y, s.d.cur.z, s.d.cur.yaw);
    this.dirty = this.shadowDirty = true;
    this.contentVersion++;
    if (u >= 1) this.finishSettle();
  }

  private finishSettle() {
    const s = this.settle;
    if (!s) return;
    this.settle = null;
    this.applyPose(s.d, s.d.cur.x, s.to, s.d.cur.z, s.d.cur.yaw);
    if (s.d.obstacle) {
      const y2 = s.d.cur.yaw / 2;
      this.rigid?.release(s.d.o.id, undefined, { x: s.d.cur.x, y: s.to, z: s.d.cur.z, q: { x: 0, y: Math.sin(y2), z: 0, w: Math.cos(y2) } });
    }
    for (const t of s.d.tiles ?? []) {
      t.mesh.geometry.computeBoundingSphere();
      t.mesh.geometry.computeBoundingBox();
      t.mesh.frustumCulled = true;
    }
    s.d.inst?.im.computeBoundingSphere();
  }

  /** Place l'objet saisi : (x, y, z) = position de sa base, `yaw` = cap ; ancres et infos suivent. */
  private applyPose(d: DragRT, x: number, y: number, z: number, yaw: number, tilt?: [number, number], fromDrive = false) {
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
      const D = new THREE.Matrix4().makeTranslation(x, y, z);
      // conduite : caisse inclinée (tangage, roulis) dans son propre repère
      if (tilt && (tilt[0] || tilt[1])) D.multiply(new THREE.Matrix4().makeRotationY(yaw)).multiply(new THREE.Matrix4().makeRotationX(tilt[0])).multiply(new THREE.Matrix4().makeRotationZ(tilt[1])).multiply(new THREE.Matrix4().makeRotationY(-d.yaw0));
      else D.multiply(new THREE.Matrix4().makeRotationY(da));
      D.multiply(new THREE.Matrix4().makeTranslation(-px, -py, -pz));
      d.inst.im.setMatrixAt(d.inst.i, D.multiply(d.inst.m0));
      d.inst.im.instanceMatrix.needsUpdate = true;
    } else
      for (const t of d.tiles ?? []) {
        const pa = t.mesh.geometry.getAttribute("position") as THREE.BufferAttribute, na = t.mesh.geometry.getAttribute("normal") as THREE.BufferAttribute;
        const P = pa.array as Float32Array, N = na.array as Float32Array;
        for (let k = 0; k < t.pos0.length; k += 3) {
          const q = move(t.pos0[k] + t.off[0], t.pos0[k + 1], t.pos0[k + 2] + t.off[1]);
          P[t.a * 3 + k] = q[0] - t.off[0];
          P[t.a * 3 + k + 1] = q[1];
          P[t.a * 3 + k + 2] = q[2] - t.off[1];
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
    const sm = d.actor ? undefined : this.softObjM.get(o.obj);
    if (sm) yawMatrix(x, y, z, yaw, sm);
    o.pos = [x, y, z];
    o.yaw = yaw;
    for (const [k, v] of Object.entries(d.anchors0)) o.anchors[k] = move(v[0], v[1], v[2]);
    if (d.seatYaw0) for (const [k, v] of Object.entries(d.seatYaw0)) o.seatYaw![k] = v + da;
    if (tilt && (tilt[0] || tilt[1])) this.tilts.set(o.id, tilt);
    else this.tilts.delete(o.id);
    // parties mobiles : suivent l'objet (ancres de partie recalculées)
    if (o.joints) this.finishIms(this.states.sync(o.id));
    // véhicule ou monture glissé au doigt : son état de conduite et ses occupants suivent
    if (!fromDrive) this.afterMove(d.actor ? d.actor.model.id : o.id);
  }

  /** Objet saisi (id) ou `null`. */
  get dragging(): string | null {
    return this.drag?.o.id ?? null;
  }

  /* ---------------- sélection ---------------- */

  pick(clientX: number, clientY: number): { objectId: string | null; generator: string | null; layer: string | null; x: number; y: number; z: number; actor: string | null; zone: string | null; part?: string } | null {
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
    let part: string | null = null;
    let point = hits[0]?.point ?? null;
    for (const h of hits) {
      if ((h.object as THREE.InstancedMesh).isInstancedMesh && h.instanceId !== undefined) {
        part = this.states.partOf.get(h.object as THREE.InstancedMesh) ?? null;
        const objs = this.instanceObjs.get(h.object as THREE.InstancedMesh);
        obj = objs ? this.objectsByObj.get(objs[h.instanceId]) ?? null : null;
      } else if (h.face) {
        const id = (h.object as THREE.Mesh).geometry.getAttribute("aObj").getX(h.face.a);
        obj = this.objectsByObj.get(Math.round(id)) ?? null;
        if (obj?.jointTile) part = this.states.partAt(obj, h.object, h.face.a);
      }
      point = h.point;
      break;
    }
    if (actorHit && (!hits[0] || actorHit.d < hits[0].distance)) {
      const a = this.actors.get(actorHit.id)!;
      obj = this.model.objects.find((o) => o.id === actorHit!.id) ?? null;
      point = new THREE.Vector3(a.pos[0], a.pos[1], a.pos[2]);
      part = null;
    }
    if (!point) return { objectId: null, generator: null, layer: null, x: 0, y: 0, z: 0, actor: null, zone: null };
    const zone = this.zoneAt(point.x, point.z);
    return { objectId: obj?.id ?? null, generator: obj?.generator ?? null, layer: obj?.layer ?? null, x: round(point.x), y: round(point.y), z: round(point.z), actor: actorHit && obj?.mode === "actor" ? obj.id : null, zone: zone?.id ?? null, ...(part && obj ? { part } : {}) };
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
    // à bord d'un véhicule : suit sa place ; monture conduite : son allure suit la conduite
    if (a.ride && this.updateRider(a, dt)) return void this.updateFace(a, dt);
    const mv = a.mo.kind === "animal" ? this.vehicles.get(a.model.id) : undefined;
    if (mv && (mv.occ.size || mv.route || mv.input || mv.rolling)) return this.updateMount(a, dt);
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
          if (g?.board) this.startBoard(a, g.board);
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
    this.updateFace(a, dt);
  }

  /** Visage : humeur (transition douce), bouche selon l'action, regard vers la cible `look`. */
  private updateFace(a: ActorRT, dt: number) {
    if (!a.face.active) return;
    a.face.step(dt, a.mood, a.action === "idle" && a.speed > 2.5 ? "run" : a.action, this.lookAngles(a), a.model.seed);
    a.face.write(a.mats.uniforms);
  }

  /** Direction de la cible `look` en repère de la tête : [vers la gauche du personnage, vers le haut] (radians). */
  private lookAngles(a: ActorRT): [number, number] | null {
    if (!a.look || a.look === "none" || a.action === "sleep") return null;
    const W = a.mesh.userData.world as Float64Array[] | undefined;
    const sk = a.model.asset.skeleton;
    const hc = a.model.asset.anchors["head.center"];
    if (!W || !sk || !hc) return null;
    let tp: THREE.Vector3 | null = null;
    if (a.look === "camera") tp = this.camera.getWorldPosition(new THREE.Vector3());
    else {
      const other = this.actors.get(a.look);
      if (other && other !== a) {
        const oh = other.model.asset.anchors["head.center"];
        const ow = other.mesh.userData.world as Float64Array[] | undefined;
        if (oh && ow) {
          const osk = other.model.asset.skeleton!;
          const ob = osk.index[oh.bone ?? "root"] ?? 0;
          tp = new THREE.Vector3(...m4Point(ow[ob], sub(oh.pos, osk.bones[ob].head))).applyMatrix4(other.mesh.matrixWorld);
        } else tp = new THREE.Vector3(other.pos[0], other.pos[1] + other.model.asset.height * 0.9, other.pos[2]);
      } else {
        const o = this.model?.objects.find((ob) => ob.id === a.look);
        if (o) tp = new THREE.Vector3(...(o.anchors.center ?? [o.pos[0], o.pos[1] + Math.min(o.height, 2) * 0.6, o.pos[2]]));
      }
    }
    if (!tp) return null;
    const hb = sk.index[hc.bone ?? "head"] ?? 0;
    const Wh = W[hb];
    a.mesh.updateMatrixWorld();
    const head = new THREE.Vector3(...m4Point(Wh, sub(hc.pos, sk.bones[hb].head))).applyMatrix4(a.mesh.matrixWorld);
    // repère de la tête : rotation de l'os puis de l'acteur
    const R = new THREE.Matrix4().set(Wh[0], Wh[4], Wh[8], 0, Wh[1], Wh[5], Wh[9], 0, Wh[2], Wh[6], Wh[10], 0, 0, 0, 0, 1);
    R.premultiply(new THREE.Matrix4().extractRotation(a.mesh.matrixWorld));
    const d = tp.sub(head).applyMatrix4(R.clone().invert()).normalize();
    // derrière la tête : on ne force pas les yeux
    if (d.z < 0.15) return null;
    return [Math.atan2(d.x, d.z), Math.atan2(d.y, Math.hypot(d.x, d.z))];
  }

  private poseActor(a: ActorRT, _dt: number) {
    const sk = a.model.asset.skeleton!;
    const st: MotionState = { speed: a.speed, phase: a.phase, time: this.time + a.model.seed, action: a.action, actionTime: a.actionTime, actionWeight: a.actionWeight, mood: a.mood, turn: a.turn, seed: a.model.seed, seatY: a.action === "sit" || a.action === "sleep" || a.action === "drive" || a.action === "ride" || a.action === "row" ? a.seatY : 0, ...(a.ride && a.seatFoot ? { seatFoot: a.seatFoot } : {}), reachY: a.action === "drink" || a.action === "eat" ? a.reachY : undefined };
    const { pose } = a.mo.pose(st);
    const W = sk.world(pose);
    a.mesh.userData.world = W;
    const S = sk.skinMatrices(W);
    a.mesh.userData.skin = S;
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

  /* ---------------- rendu soigné ---------------- */

  private get postLow() {
    const q = this.style?.postQuality ?? "auto";
    return q === "low" || (q === "auto" && this.mobile);
  }

  /** Réglages du rendu soigné (`null` : désactivé, aucun coût). */
  setPhoto(spec: ProcgenPhotoSpec | null) {
    if (!spec && !this.photo) return;
    if (!this.photo) {
      this.photo = new ProcgenPhoto(this.renderer);
      this.photo.onState = (st) => this.onPhoto(st);
      this.photo.onReady = () => this.kick();
    }
    const before = JSON.stringify(this.photo.spec);
    this.photo.configure(spec);
    if (JSON.stringify(spec) !== before) this.touch();
    if (!spec) {
      this.photo.dispose();
      this.photo = null;
      this.onPhoto({ etat: "arret", echantillons: 0, total: 0, moteur: "", progression: 0 });
    }
  }

  /**
   * Un geste, un changement de vue, de scène ou de style : retour au temps réel, et le rendu soigné attendra de
   * nouveau `attente` ms d'immobilité.
   */
  touch() {
    this.lastTouch = performance.now();
    if (this.photo?.active) {
      this.photo.stop();
      (this.post.material as THREE.ShaderMaterial).uniforms.uPhotoMix.value = 0;
      if (this.photoPost && this.style) this.stack.set(this.style.post, this.postLow);
      this.photoPost = false;
      this.dirty = this.shadowDirty = true;
    }
    this.kick();
  }

  /** Le rendu soigné est-il de mise maintenant (scène immobile, ou figée par `render: "photo"`) ? */
  private photoWanted(now: number): boolean {
    const sp = this.photo?.spec;
    if (!sp || !this.model || !this.visible || this.drag || this.settle) return false;
    if (now - this.lastTouch < sp.attente) return false;
    return sp.force || !this.moving;
  }

  /** La scène elle-même bouge-t-elle (acteurs, ballons, végétation au vent, eau) ? Le grain animé ne compte pas. */
  private get moving(): boolean {
    if (!this.model || !this.play) return false;
    return this.actors.size > 0 || this.vehRolling || this.fx.active || !!this.balls?.moving || !!this.rigid?.moving || this.model.instances.some((g) => g.flex) || (this.meadows.active && this.model.wind > 0) || (!!this.softs && (this.model.wind > 0 || this.actors.size > 0)) || !!this.model.water;
  }

  /** Réveil à la fin de l'attente (la boucle est arrêtée quand rien ne bouge). */
  private armPhotoTimer(now: number) {
    const sp = this.photo?.spec;
    if (!sp || this.photo!.active || this.photoTimer) return;
    const wait = Math.max(16, sp.attente - (now - this.lastTouch) + 5);
    this.photoTimer = window.setTimeout(() => {
      this.photoTimer = 0;
      this.kick();
    }, wait);
  }

  /** Lumières de la copie traçable, lues dans les uniformes courants. */
  private proxyLights(): ProxyLights {
    const sh = this.shared;
    const pu = (this.post.material as THREE.ShaderMaterial).uniforms;
    const P = sh.uLightPos.value as THREE.Vector4[], C = sh.uLightCol.value as THREE.Vector4[];
    const points: ProxyLights["points"] = [];
    for (let i = 0; i < (sh.uLightCount.value as number); i++) {
      const night = this.style?.night ?? 0;
      // feux toujours, lampes la nuit seulement (de jour leur apport est noyé)
      if (C[i].w < 0.5 && night < 0.3) continue;
      points.push({ pos: [P[i].x, P[i].y, P[i].z], radius: P[i].w, color: [C[i].x, C[i].y, C[i].z] });
    }
    return {
      sunDir: (sh.uSunDir.value as THREE.Vector3).clone(),
      sun: (sh.uSun.value as THREE.Color).clone(),
      ambSky: (sh.uAmbSky.value as THREE.Color).clone(),
      ambGround: (sh.uAmbGround.value as THREE.Color).clone(),
      horizon: (pu.uSkyHorizon.value as THREE.Color).clone(),
      environment: this.style?.environment ?? "exterieur",
      night: this.style?.night ?? 0,
      lamps: this.style?.lamps ?? 0.6,
      points,
    };
  }

  /** Une image du rendu soigné ; vrai tant qu'il reste à calculer. */
  private photoFrame(now: number): boolean {
    const ph = this.photo!;
    const sp = ph.spec!;
    const s = this.style;
    if (!ph.active) {
      const engine = pickEngine(sp, { mobile: this.mobile, shading: s?.shading ?? "toon", pixel: s?.pixel ?? 0 });
      ph.prepare(engine);
      if (!ph.ready(engine)) return false; // le module arrive : onReady relance la boucle
      // pleine densité de pixels pour l'image soignée (ordinateur)
      const max = Math.min(this.maxDpr, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
      if (!this.mobile && this.dpr < max) this.dpr = max;
      this.render();
      ph.start(engine, this.scene, this.camera, this.proxyLights(), this.contentVersion);
      // filtre peinture : Kuwahara anisotrope (pré-tramé) en tête de la pile, sur l'image soignée seulement
      if (sp.filtre === "peinture" && s) {
        const k = normalizeFx({ fx: "kuwahara-aniso", radius: Math.max(2, sp.touche), dither: sp.tramage, levels: Math.max(2, Math.min(32, sp.niveaux)), pattern: "bruit-bleu" }, "photo.filtre");
        this.stack.set([k as PostFx, ...s.post].slice(0, MAX_POST), this.postLow);
        this.photoPost = true;
      }
    }
    const pu = (this.post.material as THREE.ShaderMaterial).uniforms;
    if (ph.engine === "rayons") {
      const r = ph.traceStep(now);
      pu.tPhoto.value = r.tex;
      pu.uPhotoMix.value = r.mix;
      pu.uPhotoFog.value = 1;
      (pu.uFogColor.value as THREE.Color).copy(this.shared.uFogColor.value as THREE.Color);
      (pu.uFogK.value as THREE.Vector4).set(this.shared.uFar.value, this.shared.uFogNear.value, this.shared.uFogRange.value, this.shared.uFog.value);
      this.present();
      return !r.done;
    }
    const total = rasterFrames(sp, this.mobile);
    if (ph.frames >= total) {
      // déjà fini (réveil sans changement) : l'image accumulée est seulement remontrée
      this.present();
      return false;
    }
    this.render(ph.frames);
    return !ph.rasterProgress(total);
  }

  private get animated(): boolean {
    if (!this.model || !this.play) return false;
    return this.actors.size > 0 || this.vehRolling || this.fx.active || !!this.balls?.moving || this.emitters.active || !!this.rigid?.moving || (!!this.drag && !!this.rigid) || this.model.instances.some((g) => g.flex) || !!this.inf?.gpu.flex || (this.meadows.active && this.model.wind > 0) || (!!this.softs && (this.model.wind > 0 || this.actors.size > 0)) || !!this.model.water || !!this.style?.grain || this.stack.animated;
  }

  private ballsDirty = false;
  private ballAwake = new Set<number>();

  private stepBalls(dt: number) {
    const m = this.model!;
    const bw = this.balls!;
    if (!bw.moving && !this.actors.size && !this.ballsDirty && !this.vehRolling) return;
    const pushers = [...this.actors.values()].filter((a) => !a.hidden && !a.ride && !(a.action === "sit" && (a.seatY ?? 0) > 0)).map((a) => ({ id: a.model.id, pos: a.pos, vel: [Math.sin(a.yaw) * a.speed, 0, Math.cos(a.yaw) * a.speed] as V3, r: 0.18 * a.mo.legLength + 0.08, h: a.mo.legLength * 0.6 }));
    // véhicules qui roulent : une file de disques le long de la caisse pousse les ballons
    for (const v of this.vehicles.values()) {
      if (!v.o || !v.rolling || v.spec.medium === "air") continue;
      const fx = Math.sin(v.s.yaw), fz = Math.cos(v.s.yaw);
      const n = Math.max(1, Math.round(v.spec.hz / Math.max(0.2, v.spec.hx)));
      for (let k = 0; k < n; k++) {
        const t = n === 1 ? 0 : -v.spec.hz + v.spec.hx + ((2 * (v.spec.hz - v.spec.hx)) * k) / (n - 1);
        pushers.push({ id: v.id, pos: [v.s.x + fx * t, v.y, v.s.z + fz * t] as V3, vel: [fx * v.s.speed, 0, fz * v.s.speed] as V3, r: v.spec.hx, h: v.o.height * 0.6 });
      }
    }
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
    if (touched.size) {
      this.dirty = this.shadowDirty = true;
      this.contentVersion++;
    }
  }

  kick() {
    if (this.disposed || this.running || !this.visible) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  private loop = (now: number) => {
    if (this.disposed) return;
    // horodatage d'image parfois antérieur au réveil (première image) : jamais de pas négatif
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    if (this.settle) this.stepSettle(now);
    // monde infini : composition et montage des tuiles avant les acteurs (le sol est là quand ils y marchent)
    const busy = !!this.inf && (this.inf.world.busy || this.inf.world.added.length > 0);
    if (this.inf && this.model) this.stepInfinite(now);
    // rendu soigné : l'animation est figée, chaque image affine le résultat ; plus rien une fois fini
    if (!busy && this.photo?.spec && this.photoWanted(now)) {
      const more = this.photoFrame(now);
      this.dirty = false;
      this.onFrame();
      if (more && this.visible) this.raf = requestAnimationFrame(this.loop);
      else this.running = false;
      return;
    }
    // parties mobiles : passage doux vers l'état voulu (même à l'arrêt de l'animation)
    if (this.states.moving) this.finishIms(this.states.step(this.play ? dt : 1e6));
    const anim = this.animated;
    if (anim) {
      this.time += dt * this.speed;
      this.stepVehicles(dt * this.speed);
      for (const a of this.actors.values()) if (a !== this.drag?.actor && a !== this.settle?.d.actor) this.updateActor(a, dt * this.speed);
      if (this.actors.size) {
        this.shadowDirty = true;
        this.contentVersion++;
      }
      if (this.balls) this.stepBalls(dt * this.speed);
      if (this.rigid) this.stepRigid(dt * this.speed, now);
      this.stepFx(dt * this.speed);
      this.stepSofts(dt * this.speed);
      if (this.emitters.count) {
        this.emitters.syncInfinite(this.inf?.world ?? null);
        this.emitters.advance(dt * this.speed, this.time);
        for (const sim of this.emitters.sims) if (sim.spec.trail) this.fx.trail(sim.spec.trail, sim, dt * this.speed);
      }
    } else if (this.dirty && this.softs) this.stepSofts(0);
    if (anim || this.dirty) {
      const t0 = performance.now();
      this.render();
      this.governor(performance.now() - t0, dt, now / 1000);
      this.dirty = false;
      this.onFrame();
    }
    if ((anim || this.dirty || busy || this.states.moving) && this.visible) this.raf = requestAnimationFrame(this.loop);
    else {
      this.running = false;
      if (this.photo?.spec && this.visible) this.armPhotoTimer(now);
    }
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
    this.touch();
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
    const L = this.states.lights.length ? [...(this.model?.lights ?? []), ...this.states.lights] : this.model?.lights ?? [];
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

  /** Ce qui couche les brins : acteurs, objet glissé, ballons qui roulent ; les 8 plus proches du point visé. */
  private meadowPushers(t: THREE.Vector3): { x: number; z: number; r: number }[] {
    const out: { x: number; z: number; r: number }[] = [];
    for (const a of this.actors.values()) if (!a.hidden && a.mesh.visible) out.push({ x: a.pos[0], z: a.pos[2], r: Math.max(0.35, a.mo.legLength * 0.55 + 0.25) });
    const d = this.drag ?? this.settle?.d;
    if (d && !d.actor) out.push({ x: d.cur.x, z: d.cur.z, r: Math.max(0.4, Math.hypot(d.o.footprint.hx, d.o.footprint.hz) * 1.05) });
    if (this.balls)
      for (const b of this.balls.bodies) {
        if (!b.awake || this.balls.hidden.has(b.id)) continue;
        out.push({ x: b.pos[0], z: b.pos[2], r: Math.max(0.25, b.r * 2.5) });
      }
    // corps physiques qui bougent (ou saisis) : ils couchent l'herbe sur leur passage
    if (this.rigid && this.physOut?.status === "ready")
      for (const [id, p] of Object.entries(this.physOut.bodies)) {
        if (!p.awake || this.hiddenIds.has(id)) continue;
        const o = this.objectsById.get(id);
        if (o) out.push({ x: o.pos[0], z: o.pos[2], r: Math.max(0.25, Math.hypot(o.footprint.hx, o.footprint.hz) * 1.2) });
      }
    if (out.length > 8) out.sort((a, b) => Math.hypot(a.x - t.x, a.z - t.z) - Math.hypot(b.x - t.x, b.z - t.z));
    return out.slice(0, 8);
  }

  private shadowPass() {
    const m = this.model!;
    const sun = this.shared.uSunDir.value as THREE.Vector3;
    const b = m.bounds;
    let c = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    let R = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2;
    if (this.inf) {
      // monde infini : ombres autour du point suivi, sur la portée de la vue (texels calés pour ne pas scintiller)
      R = Math.min(this.inf.world.spec.tile * (this.inf.world.radius + 0.5), Math.max(20, this.extent * 1.6));
      const [x, z] = this.infCenter();
      const q = (2 * R) / this.shadowRT.width;
      c = new THREE.Vector3(Math.round(x / q) * q, this.inf.world.height(x, z), Math.round(z / q) * q);
    }
    const lc = new THREE.OrthographicCamera(-R, R, R, -R, 0.1, R * 4);
    lc.position.copy(c).addScaledVector(sun, R * 2);
    lc.lookAt(c);
    lc.updateMatrixWorld();
    lc.updateProjectionMatrix();
    (this.shared.uShadowMatrix.value as THREE.Matrix4).multiplyMatrices(lc.projectionMatrix, lc.matrixWorldInverse);
    // prairies : pas d'ombre portée (des dizaines de milliers de brins), mais elles reçoivent celles du décor
    const mv = this.meadows.group.visible;
    this.meadows.group.visible = false;
    const swap: [THREE.Mesh, THREE.Material][] = [];
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.userData.depth) {
        swap.push([mesh, mesh.material as THREE.Material]);
        mesh.material = mesh.userData.depth;
      }
    });
    this.shared.uShadowOn.value = 0;
    this.fxGroup.visible = false;
    // les copies des émetteurs ne portent pas d'ombre : la carte n'est pas refaite pour elles
    const emitVis = this.emitters.group.visible;
    this.emitters.group.visible = false;
    this.renderer.setRenderTarget(this.shadowRT);
    this.renderer.setClearColor(0xffffff, 1);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, lc);
    for (const [mesh, mat] of swap) mesh.material = mat;
    this.meadows.group.visible = mv;
    this.fxGroup.visible = true;
    this.emitters.group.visible = emitVis;
    this.shared.uShadowOn.value = this.style?.shadows === false ? 0 : 1;
    this.shadowDirty = false;
  }

  /** `jitter` : rang d'une image accumulée du rendu soigné (sous-pixel décalé, soleil décalé dans un cône). */
  render(jitter?: number) {
    if (!this.model) return;
    this.applySize();
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.shared.uTime.value = this.time;
    this.shared.uWind.value = this.model.wind;
    // balancement des feuillages dans la direction du vent ; 67° (défaut) : direction historique (1, 0,4) exacte
    const wd = this.model.windDir ?? (67 * Math.PI) / 180;
    const legacy = Math.abs(wd - (67 * Math.PI) / 180) < 1e-9;
    (this.shared.uWindDir.value as THREE.Vector2).set(legacy ? 1 : Math.sin(wd) * 1.077, legacy ? 0.4 : Math.cos(wd) * 1.077);
    let target: THREE.Vector3 | undefined;
    const fp = this.view.camera === "follow" && this.followId ? this.followPose(this.followId) : null;
    if (fp) {
      // suivi doux derrière l'acteur ou le véhicule : position et cap lissés (jamais de saut), décalage de l'utilisateur
      const now = performance.now();
      let c = this.followCam;
      if (!c || c.id !== fp.id) c = this.followCam = { id: fp.id, x: fp.x, y: fp.y, z: fp.z, yaw: fp.yaw, t: now };
      const dt = Math.min(0.1, Math.max(0, (now - c.t) / 1000));
      c.t = now;
      const k = 1 - Math.exp(-dt * 6), ky = 1 - Math.exp(-dt * 2.2);
      c.x += (fp.x - c.x) * k;
      c.y += (fp.y - c.y) * k;
      c.z += (fp.z - c.z) * k;
      let dy = fp.yaw - c.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      c.yaw += dy * ky;
      target = new THREE.Vector3(c.x, c.y, c.z);
      this.view.yaw = (c.yaw * 180) / Math.PI + 180 + this.followOff;
      if (Math.abs(fp.x - c.x) + Math.abs(fp.z - c.z) + Math.abs(dy) > 0.002) this.dirty = true;
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
    if (this.inf) {
      // monde infini : le brouillard atteint son plein avant le bord des tuiles chargées (pas de bord visible)
      const reach = this.inf.world.spec.tile * (this.inf.world.radius + 0.25);
      const fog = Math.max(this.style?.fog ?? 0.5, 0.45);
      this.shared.uFog.value = fog;
      this.shared.uFogNear.value = Math.max(0, camDist + reach * 0.1);
      this.shared.uFogRange.value = Math.max(4, (reach * 0.85 * fog * 1.6) / 2);
      if (this.shadowFollow(tgt)) this.shadowDirty = true;
    }
    {
      // contours fondus dans le brouillard du monde infini (rien en scène finie)
      const fade = (this.post.material as THREE.ShaderMaterial).uniforms.uOutlineFade.value as THREE.Vector2;
      if (this.inf) fade.set((this.shared.uFogNear.value + this.shared.uFogRange.value * 0.15) / cam.far, (this.shared.uFogNear.value + this.shared.uFogRange.value * 0.7) / cam.far);
      else fade.set(2, 3);
    }
    this.renderer.info.reset();
    this.updateLights(tgt);
    if (this.meadows.active) this.meadows.advance(this.model.wind, this.model.windDir ?? 1.17, this.meadowPushers(tgt));
    const sun = this.shared.uSunDir.value as THREE.Vector3;
    const sun0 = jitter !== undefined ? sun.clone() : null;
    if (jitter !== undefined) {
      // ombres douces : soleil décalé dans un cône de 2,5° (carte d'ombre refaite) ; anticrénelage : sous-pixel décalé
      if (jitter > 0) {
        const a = halton(jitter, 2) * Math.PI * 2, r = Math.sqrt(halton(jitter, 3) + 0.5) * 0.044;
        const t1 = new THREE.Vector3(0, 1, 0).cross(sun).normalize(), t2 = sun.clone().cross(t1).normalize();
        sun.addScaledVector(t1, Math.cos(a) * r).addScaledVector(t2, Math.sin(a) * r).normalize();
        this.shadowDirty = true;
        if (!this.snapReq) {
          const rt = this.rt!;
          cam.projectionMatrix.premultiply(new THREE.Matrix4().makeTranslation((halton(jitter, 2) * 2) / rt.width, (halton(jitter, 3) * 2) / rt.height, 0));
        }
      }
    }
    if (this.style?.shadows !== false && this.shadowDirty) this.shadowPass();
    for (const d of this.fxMeshes) d.mat.uniforms.uViewH.value = this.rt!.height;
    this.renderer.setRenderTarget(this.rt);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);
    this.lastInfo = { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles };
    const pu1 = (this.post.material as THREE.ShaderMaterial).uniforms;
    if (sun0) {
      sun.copy(sun0);
      cam.updateProjectionMatrix();
      // image accumulée : la moyenne remplace la couleur de la scène (la brume y est déjà)
      pu1.tPhoto.value = this.photo!.accumulate(this.rt!.textures[0], this.rt!.width, this.rt!.height);
      pu1.uPhotoMix.value = 1;
      pu1.uPhotoFog.value = 0;
      // la carte d'ombre du soleil réel sera refaite au retour au temps réel
      this.shadowDirty = true;
    } else if (!this.photo?.active) pu1.uPhotoMix.value = 0;
    if (this.snapReq) {
      // caméra réelle (sans arrondi ni marge) pour la sélection, les ancres et les gestes
      this.camera = applyView(this.view, w / h, this.extent, this.ortho, this.persp, target);
      this.camera.updateMatrixWorld();
    }
    // horizon : calé sur la direction de visée horizontale (même hauteur quel que soit le yaw)
    const pu = (this.post.material as THREE.ShaderMaterial).uniforms;
    pu.uHorizonY.value = horizonScreenY(cam, tgt, this.extent);
    pu.uTime.value = this.time;
    this.present();
  }

  /** Image de base (ciel, contours, papier, vignette, sRGB ; image soignée s'il y en a une) puis pile `post` ou écran. */
  private present() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    const cam = this.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const xf = this.snapReq ? marginTransform(this.snapReq.rw, this.snapReq.rh, this.snapReq.m, this.frame.rx, this.frame.ry) : [1, 1, 0, 0];
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

  private shadowAt = "";
  /** Le centre des ombres a bougé d'un pas (monde infini) ? */
  private shadowFollow(t: THREE.Vector3): boolean {
    const k = `${Math.round(t.x / 4)},${Math.round(t.z / 4)}`;
    if (k === this.shadowAt) return false;
    this.shadowAt = k;
    return true;
  }

  private lastInfo = { calls: 0, triangles: 0 };
  stats() {
    return { drawCalls: this.lastInfo.calls, triangles: this.lastInfo.triangles, fps: this.fps, scale: this.dpr, ...(this.softs ? { soft: this.softs.stats() } : {}), ...(this.stack.active ? { postPasses: this.stack.passes } : {}), ...(this.stack.failed ? { postError: this.stack.error } : {}), ...(this.photo?.active ? { photoMs: this.photo.buildMs } : {}) };
  }

  actorState(id: string) {
    const a = this.actors.get(id);
    return a ? { x: round(a.pos[0]), y: round(a.pos[1]), z: round(a.pos[2]), yaw: Math.round((a.yaw * 180) / Math.PI), speed: round(a.speed), action: a.action, moving: !!a.path || a.speed > 0.05, ...(a.ride ? { vehicle: a.ride.veh, seat: a.ride.seat, boarding: a.ride.phase !== "seated" } : {}) } : null;
  }
  actorIds() {
    return [...this.actors.keys()];
  }

  dispose() {
    this.finBank?.dispose();
    this.finTable?.dispose();
    this.disposed = true;
    this.rigidTok++;
    cancelAnimationFrame(this.raf);
    this.dropInfinite();
    this.clearScene();
    for (const d of this.fxMeshes) disposeParticleMesh(d);
    this.fxMeshes = [];
    this.fxQuad.dispose();
    this.fx.clear();
    this.emitters.dispose();
    this.rt?.dispose();
    this.shadowRT.dispose();
    this.stack.dispose();
    this.photo?.dispose();
    clearTimeout(this.photoTimer);
    this.renderer.dispose();
  }
}

const round = (x: number) => Math.round(x * 100) / 100;
const baseMoodOf = (a: ActorModel) => String((a.asset.extra?.look as { mood?: string } | undefined)?.mood ?? a.params.mood ?? "neutral");
const round3 = (x: number) => Math.round(x * 1000) / 1000;
