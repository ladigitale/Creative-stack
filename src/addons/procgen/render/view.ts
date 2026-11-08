/**
 * `ProcgenView` : rendu three.js d'un `SceneModel`, acteurs animés, sélection, événements de jeu.
 *
 * Passes : ombre (profondeur, seulement quand la scène ou un acteur bouge) → scène en MRT avec MSAA ×4
 * (couleur + normales/profondeur/id) → post-traitement (ciel, contours, papier, grain, vignette, pixel).
 * Rendu à la demande : aucune image tant que rien ne bouge ; densité de pixels adaptée à la charge.
 */
import * as THREE from "three";
import { type V3, clamp, m4Point, sub } from "../core/math";
import type { ActorModel, ObjectInfo, SceneModel, Zone } from "../scene/compose";
import { ACTIONS, type Action, type MotionState } from "../rig/locomotion";
import { type Motion, motionFor } from "../rig/motion";
import { dualQuat } from "../rig/skeleton";
import { type StyleTokens, resolveColors } from "../style/style";
import { ROLES } from "../style/roles";
import { type CameraMode, DEFAULT_VIEW, type ViewState, applyView, parseView } from "./camera";
import { type MaterialPair, type Shared, makeMaterials, sharedUniforms, toGeometry } from "./materials";
import { MAX_BONES, POST_FRAGMENT, POST_VERTEX } from "./shaders";

export type ActorIntent = { x?: number; z?: number; target?: string; vx?: number; vz?: number; action?: string; speed?: number; run?: boolean; facing?: number; look?: string; mood?: string };
export type GameEvent = { type: "pick" | "select" | "arrive" | "blocked" | "enter" | "leave" | "actionEnd"; payload: Record<string, unknown> };

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
  goal: { x: number; z: number; target?: string; seat?: { x: number; y: number; z: number; yaw: number } } | null;
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
  private rt: THREE.WebGLRenderTarget | null = null;
  private shadowRT: THREE.WebGLRenderTarget;
  private post: THREE.Mesh;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private actors = new Map<string, ActorRT>();
  private objectsByObj = new Map<number, ObjectInfo>();
  private pickables: THREE.Object3D[] = [];
  private instanceObjs = new Map<THREE.InstancedMesh, number[]>();
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
  fps = 0;
  private followId: string | null = null;
  private hiddenIds = new Set<string>();
  private selectedObj = -1;
  onEvent: (e: GameEvent) => void = () => {};
  onFrame: () => void = () => {};
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: false });
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.staticMats = makeMaterials(this.shared, this.roles, false);
    // ombres : 4096 sur ordinateur, 2048 sur mobile (écran tactile ou petite fenêtre)
    const mobile = typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches || Math.min(window.screen?.width ?? 2000, window.screen?.height ?? 2000) < 700);
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
        uTime: { value: 0 }, uPixel: { value: 0 }, uResolution: { value: new THREE.Vector2() },
      },
    });
    this.post = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat);
    this.post.frustumCulled = false;
    this.postScene.add(this.post);
  }

  /* ---------------- scène ---------------- */

  setModel(model: SceneModel) {
    this.clearScene();
    this.model = model;
    const b = model.bounds;
    this.extent = Math.max(4, Math.hypot(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2, (b.max[1] - b.min[1]) * 0.8);
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
    }
    for (const a of model.actors) this.addActor(a);
    this.view = parseView(model.view, { ...DEFAULT_VIEW, cy: 0 });
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
    };
    this.actors.set(a.id, rt);
    this.poseActor(rt, 0);
  }

  private clearScene() {
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
    pu.uPixel.value = s.pixel;
    this.dirty = this.shadowDirty = true;
    this.resize(true);
    this.kick();
  }

  setView(v: unknown) {
    this.view = parseView(v, this.view);
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
      // en route vers une place, l'acteur marche : il ne s'assied qu'à l'arrivée
      if (it.action && !(toSeat && it.action === "sit") && (ACTIONS as readonly string[]).includes(it.action) && it.action !== "walk" && it.action !== "run") {
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
        if (it.target) {
          const o = this.model?.objects.find((ob) => ob.id === it.target || it.target!.startsWith(ob.id + "."));
          if (o) {
            const an = it.target.slice(o.id.length + 1);
            // place assise : on marche jusqu'à l'ancre « approach.N » (devant), puis on s'assied sur « sit.N »
            const sm = /^sit\.(\d+)$/.exec(an);
            const sp = sm ? o.anchors[an] : undefined;
            if (sp) seat = { x: sp[0], y: sp[1] - o.pos[1], z: sp[2], yaw: o.yaw };
            const p = (sm && o.anchors[`approach.${sm[1]}`]) || (an && o.anchors[an]) || o.anchors.door || o.pos;
            [x, z] = [p[0], p[2]];
          }
        }
        this.goto(a, x, z, it.target);
        if (a.goal && seat) a.goal.seat = seat;
      }
      if (Number.isFinite(it.facing) && !a.goal && !a.drive) a.yaw = (Number(it.facing) * Math.PI) / 180;
    }
    this.kick();
  }

  /** Quitte une place assise : retour au point libre devant l'assise (sinon l'acteur resterait dans l'obstacle). */
  private standUp(a: ActorRT) {
    if ((a.seatY ?? 0) > 0 && a.standAt) {
      a.pos[0] = a.standAt[0];
      a.pos[2] = a.standAt[1];
      if (a.action === "sit") a.action = "idle";
    }
    a.seatY = 0;
    a.standAt = undefined;
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
          if (g?.seat) {
            a.pos[0] = g.seat.x;
            a.pos[2] = g.seat.z;
            a.yaw = g.seat.yaw;
            a.seatY = g.seat.y;
            a.standAt = [g.x, g.z];
            a.speed = 0;
            if (a.action !== "sit") {
              a.action = "sit";
              a.actionTime = 0;
            }
          }
          if (g) this.onEvent({ type: "arrive", payload: { actor: a.model.id, x: round(a.pos[0]), z: round(a.pos[2]), target: g.target ?? null } });
        }
      } else {
        want = a.wantSpeed || 1.35;
        if (a.path.length === 1) want *= clamp(d / 0.8, 0.3, 1);
        vx = dx / d;
        vz = dz / d;
      }
    } else if ((a.model.behavior === "wander" || a.model.behavior === "patrol") && !(a.action === "sit" && (a.seatY ?? 0) > 0)) {
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
    a.pos[1] = m.terrain ? m.terrain.height(a.pos[0], a.pos[2]) : a.pos[1];
    // actions
    const transient = a.action === "wave" || a.action === "cheer" || a.action === "jump" || a.action === "bow" || a.action === "point";
    a.actionTime += dt;
    const target = a.action === "idle" ? 0 : 1;
    a.actionWeight += (target - a.actionWeight) * (1 - Math.exp(-dt * 6));
    if (transient && a.actionTime > (a.action === "jump" ? 1.1 : a.action === "bow" ? 1.4 : 2.6)) {
      this.onEvent({ type: "actionEnd", payload: { actor: a.model.id, action: a.action } });
      a.action = "idle";
    }
    // clignement
    a.blinkT -= dt;
    let blink = 0;
    if (a.blinkT < 0.14) blink = Math.sin(clamp(1 - a.blinkT / 0.14, 0, 1) * Math.PI);
    if (a.blinkT <= 0) a.blinkT = 2 + ((a.model.seed * 17.1 + this.time) % 4);
    a.mats.uniforms.uBlink.value = blink;
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
    const st: MotionState = { speed: a.speed, phase: a.phase, time: this.time + a.model.seed, action: a.action, actionTime: a.actionTime, actionWeight: a.actionWeight, mood: a.mood, turn: a.turn, seed: a.model.seed, seatY: a.action === "sit" ? a.seatY : 0 };
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
    return this.actors.size > 0 || this.model.instances.some((g) => g.flex) || !!this.model.water || !!this.style?.grain;
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
    const anim = this.animated;
    if (anim) {
      this.time += dt * this.speed;
      for (const a of this.actors.values()) this.updateActor(a, dt * this.speed);
      if (this.actors.size) this.shadowDirty = true;
    }
    if (anim || this.dirty) {
      const t0 = performance.now();
      this.render();
      this.governor(performance.now() - t0, dt);
      this.dirty = false;
      this.onFrame();
    }
    if ((anim || this.dirty) && this.visible) this.raf = requestAnimationFrame(this.loop);
    else this.running = false;
  };

  private governor(ms: number, dt: number) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 30) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((s, x) => s + x, 0) / this.frameTimes.length;
    this.fps = avg > 0 ? Math.round(1 / avg) : 0;
    if (this.frameTimes.length === 30) {
      if (avg > 1 / 40 && this.dpr > 0.75) {
        this.dpr = Math.max(0.75, this.dpr - 0.25);
        this.frameTimes = [];
        this.resize(true);
      } else if (avg < 1 / 58 && ms < 8 && this.dpr < Math.min(this.maxDpr, window.devicePixelRatio || 1)) {
        this.dpr = Math.min(this.maxDpr, this.dpr + 0.25);
        this.frameTimes = [];
        this.resize(true);
      }
    }
  }

  resize(force = false) {
    const w = Math.max(1, this.canvas.clientWidth | 0), h = Math.max(1, this.canvas.clientHeight | 0);
    const dpr = this.dpr;
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (!force && this.rt && this.rt.width === pw && this.rt.height === ph) return;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    const pixel = this.style?.pixel ?? 0;
    const rw = pixel > 0 ? Math.max(32, Math.round(w / pixel)) : pw, rh = pixel > 0 ? Math.max(18, Math.round(h / pixel)) : ph;
    this.rt?.dispose();
    this.rt = new THREE.WebGLRenderTarget(rw, rh, { count: 2, samples: pixel > 0 ? 0 : 4, type: THREE.HalfFloatType, depthBuffer: true });
    for (const t of this.rt.textures) {
      t.minFilter = t.magFilter = pixel > 0 ? THREE.NearestFilter : THREE.LinearFilter;
      t.generateMipmaps = false;
    }
    const pu = (this.post.material as THREE.ShaderMaterial).uniforms;
    pu.tColor.value = this.rt.textures[0];
    pu.tData.value = this.rt.textures[1];
    (pu.uTexel.value as THREE.Vector2).set(1 / rw, 1 / rh);
    (pu.uResolution.value as THREE.Vector2).set(rw, rh);
    pu.uPixel.value = 0;
    this.dirty = true;
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
    this.resize();
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.shared.uTime.value = this.time;
    this.shared.uWind.value = this.model.wind;
    let target: THREE.Vector3 | undefined;
    if (this.view.camera === "follow" && this.followId && this.actors.has(this.followId)) {
      const a = this.actors.get(this.followId)!;
      target = new THREE.Vector3(a.pos[0], a.pos[1] + a.model.asset.height * 0.6, a.pos[2]);
      this.view.yaw = (a.yaw * 180) / Math.PI + 180;
    }
    this.camera = applyView(this.view, w / h, this.extent, this.ortho, this.persp, target);
    (this.camera as THREE.Camera).updateMatrixWorld();
    const cam = this.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    this.shared.uFar.value = cam.far;
    const tgt = target ?? new THREE.Vector3(this.view.cx, this.view.cy, this.view.cz);
    const camDist = cam.position.distanceTo(tgt);
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
    // horizon : position écran d'un point lointain à hauteur de la cible
    const pu = (this.post.material as THREE.ShaderMaterial).uniforms;
    const far = new THREE.Vector3(this.view.cx, 0, this.view.cz - this.extent * 4);
    const hp = far.project(this.camera);
    pu.uHorizonY.value = clamp(hp.y * 0.5 + 0.5, -0.5, 0.95);
    pu.uTime.value = this.time;
    this.renderer.setRenderTarget(null);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.postScene, this.postCam);
  }

  private lastInfo = { calls: 0, triangles: 0 };
  stats() {
    return { drawCalls: this.lastInfo.calls, triangles: this.lastInfo.triangles, fps: this.fps, scale: this.dpr };
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
    this.renderer.dispose();
  }
}

const round = (x: number) => Math.round(x * 100) / 100;
