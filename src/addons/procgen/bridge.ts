/**
 * Pont procgen → format « monde » de `sonic-3d` : les modèles `{gen, params, seed}` sont construits par les générateurs
 * procgen (maillage continu, squelette, rôles de couleur) et dessinés avec le matériau procgen (bandes toon, AO cuite,
 * texture et relief procéduraux par rôle, contre-jour), plus un contour en coque inversée calé en pixels. Le reste de
 * la scène `sonic-3d` (glTF, lumières, post-traitement) n'est pas touché.
 *
 * Contour : épaisseur du style en pixels, affinée pour un objet petit à l'écran.
 * - `GenKit` : uniformes de style partagés (préréglage procgen ou jetons), cache des assets, fabrique d'acteurs.
 * - `GenActor` : une instance nommée ; locomotion procgen (foulée intégrée par la distance réellement parcourue, pieds
 *   plantés), actions du moteur et pistes d'os du format ajoutées à la pose ; skinning par quaternions duaux.
 * - `GenKit.instanced` : copies de décor d'un même modèle en un seul appel de dessin.
 */
import * as THREE from "three";
import { genRole } from "../../shared/monde/gen";
import { type Q, type V3, qEuler, qMul } from "./core/math";
import { Rng } from "./core/rng";
import { Issues, resolveParams } from "./core/schema";
import { resolveGeneratorId } from "./gen/index";
import type { Asset } from "./gen/types";
import { sharedUniforms, toGeometry, type Shared } from "./render/materials";
import { FRAGMENT, MAX_BONES, VERTEX } from "./render/shaders";
import { ACTIONS, type Action, type MotionState } from "./rig/locomotion";
import { type Motion, motionFor } from "./rig/motion";
import { dualQuat } from "./rig/skeleton";
import { ROLES } from "./style/roles";
import { resolveColors, resolveStyle, type StyleTokens } from "./style/style";

const SRGB = /* glsl */ `
uniform float uToSRGB;
uniform vec3 uGlowCol;
uniform float uGlow;
vec3 toSRGB(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
`;

/** Couleur procgen + éclat d'acteur + sortie sRGB quand `sonic-3d` dessine directement à l'écran. */
const GEN_FRAGMENT = FRAGMENT.replace("precision highp float;", `precision highp float;\n${SRGB}`).replace(
  "outColor = vec4(lit, 1.0);",
  "lit += uGlowCol * uGlow * (0.3 + 0.9 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.0));\n  outColor = vec4(uToSRGB > 0.5 ? toSRGB(lit) : lit, 1.0);",
);

/** Coque inversée : le sommet skinné est poussé le long de sa normale projetée, d'une épaisseur fixe en pixels. */
const OUTLINE_VERTEX = VERTEX.replace("uniform float uSkinned;", "uniform float uSkinned;\nuniform float uOutlinePx;\nuniform vec2 uResolution;").replace(
  "gl_Position = projectionMatrix * mv;",
  `gl_Position = projectionMatrix * mv;
  vec3 nvo = normalize(mat3(viewMatrix) * vNormalW);
  vec2 cn = (projectionMatrix * vec4(nvo, 0.0)).xy;
  float cl = length(cn);
  // trait affiné quand l'objet est petit à l'écran (2 cm par pixel de trait au plus) : un personnage lointain reste lisible
  float ppm = projectionMatrix[1][1] * 0.5 * uResolution.y / max(gl_Position.w, 1e-4);
  float px = min(uOutlinePx, ppm * 0.02 * uOutlinePx);
  if (cl > 1e-5) gl_Position.xy += cn / cl * px * 2.0 / max(uResolution, vec2(1.0)) * gl_Position.w;`,
);
const OUTLINE_FRAGMENT = /* glsl */ `
precision highp float;
${SRGB}
layout(location = 0) out vec4 outColor;
uniform vec3 uInk;
void main() { outColor = vec4(uToSRGB > 0.5 ? toSRGB(uInk) : uInk, 1.0); }
`;

/** Préréglage procgen du `look` du format quand le monde ne donne pas de `style`. */
const LOOK_STYLE: Record<string, string> = { doux: "doux", toon: "bd", brillant: "gouache" };

export type GenBuild = { asset: Asset | null; issues: { path: string; message: string }[] };

type GenInput = { id: string; params: Record<string, unknown>; seed: string };

const ACTOR_DETAIL: Record<string, unknown> = { detail: "crowd" };

export class GenKit {
  readonly shared: Shared;
  style: StyleTokens;
  private cache = new Map<string, GenBuild>();
  private geos = new Map<Asset, { g: THREE.BufferGeometry; refs: number }>();
  private live = new Set<Asset>();
  private size = new THREE.Vector2();

  private traits = 1;

  constructor(
    style: unknown,
    look: string,
    /** Assets gardés en cache (les plus anciens sont oubliés ; leur géométrie survit tant qu'elle est dessinée). */
    private maxCache = 96,
  ) {
    this.shared = sharedUniforms();
    Object.assign(this.shared, {
      uToSRGB: { value: 1 },
      uGlow: { value: 0 },
      uGlowCol: { value: new THREE.Color(1, 1, 1) },
      uInk: { value: new THREE.Color(0.08, 0.07, 0.07) },
      uOutlinePx: { value: 1.4 },
      uResolution: { value: new THREE.Vector2(1, 1) },
    });
    this.style = resolveStyle(style ?? LOOK_STYLE[look] ?? "doux");
    this.applyStyle();
  }

  /** Change le style (préréglage ou jetons) et l'importance des traits (0 aucun … 1 style … 3). */
  setStyle(style: unknown, look: string, traits = 1) {
    this.style = resolveStyle(style ?? LOOK_STYLE[look] ?? "doux");
    this.traits = Math.max(0, Math.min(3, traits));
    this.applyStyle();
  }

  private applyStyle() {
    const s = this.style;
    const c = resolveColors(s);
    const D = Math.PI / 180;
    const az = s.lightAzimuth * D, el = Math.min(89, Math.max(3, s.lightElevation)) * D;
    const u = this.shared;
    (u.uSunDir.value as THREE.Vector3).set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
    const k = s.lightIntensity * (1 - s.night * 0.55) * 1.05;
    (u.uSun.value as THREE.Color).setRGB(c.sun[0] * k, c.sun[1] * k, c.sun[2] * k);
    (u.uAmbSky.value as THREE.Color).setRGB(...c.ambientSky);
    (u.uAmbGround.value as THREE.Color).setRGB(...c.ambientGround);
    (u.uFogColor.value as THREE.Color).setRGB(...c.skyHorizon);
    u.uFog.value = 0;
    u.uShading.value = { flat: 0, toon: 1, soft: 2, lit: 3 }[s.shading];
    u.uBands.value = s.bands;
    u.uBandSoft.value = s.bandSoftness;
    u.uBrush.value = s.brush;
    u.uAOStrength.value = s.ao;
    u.uTexture.value = s.texture;
    u.uNight.value = s.night;
    u.uLamps.value = s.lamps;
    u.uRim.value = s.rim;
    u.uDetail.value = s.detail;
    u.uShadowStrength.value = s.shadows ? s.shadowStrength : 0;
    u.uShadowOn.value = 0;
    u.uOutlinePx.value = s.outline * s.outlineStrength * this.traits;
    const ink = c.roles.slice(27 * 3, 27 * 3 + 3);
    (u.uInk.value as THREE.Color).setRGB(ink[0] * 0.6, ink[1] * 0.6, ink[2] * 0.6);
  }

  /** Brume du monde (0 à 1) vers la couleur d'horizon du style. */
  setFog(amount: number) {
    this.shared.uFog.value = amount;
    this.shared.uFar.value = 200;
    this.shared.uFogNear.value = 4;
    this.shared.uFogRange.value = 80;
  }

  /** Avance le temps partagé (vent de la végétation, flammes, eau). */
  tick(time: number) {
    this.shared.uTime.value = time;
  }

  private key(g: GenInput, actor: boolean) {
    return `${g.id}|${g.seed}|${actor ? 1 : 0}|${JSON.stringify(g.params)}`;
  }

  /** Asset déjà construit (sans générer) : permet de reconstruire une instance sans attendre. */
  cached(g: GenInput, actor: boolean): GenBuild | undefined {
    return this.cache.get(this.key(g, actor));
  }

  /** Asset d'un modèle gen (mis en cache par générateur, paramètres et graine). */
  build(g: GenInput, actor: boolean): GenBuild {
    const key = this.key(g, actor);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const issues = new Issues();
    let out: GenBuild;
    const { gen, preset } = resolveGeneratorId(g.id);
    if (!gen) out = { asset: null, issues: [{ path: "gen", message: `générateur « ${g.id} » inconnu` }] };
    else {
      const rng = new Rng(g.seed);
      const input = { ...(actor && (gen.id === "character" || gen.id === "animal") ? ACTOR_DETAIL : {}), ...preset, ...g.params };
      const resolved = resolveParams(gen.schema, input, { rng, vars: {} }, issues, "params") as Record<string, unknown>;
      const vs = gen.schema.variant as { max?: number } | undefined;
      if (vs && resolved.variant === -1) resolved.variant = rng.int(0, vs.max ?? 3);
      try {
        out = { asset: gen.build(resolved as never, { rng, issues, path: "params" }), issues: [] };
      } catch (e) {
        out = { asset: null, issues: [{ path: "gen", message: `échec du générateur : ${(e as Error).message}` }] };
      }
      out.issues.push(...issues.list.map((i) => ({ path: i.path, message: i.message + (i.hint ? ` (${i.hint})` : "") })));
    }
    this.cache.set(key, out);
    if (out.asset) this.live.add(out.asset);
    if (this.cache.size > this.maxCache) {
      const old = this.cache.keys().next().value as string;
      const a = this.cache.get(old)?.asset;
      this.cache.delete(old);
      if (a) {
        this.live.delete(a);
        this.drop(a);
      }
    }
    return out;
  }

  /** Géométrie partagée d'un asset ; `retain` / `release` : libérée quand plus rien ne la dessine ni ne la garde en cache. */
  geometry(a: Asset): THREE.BufferGeometry {
    let e = this.geos.get(a);
    if (!e) {
      const g = toGeometry(a.mesh);
      if (a.skeleton) g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, a.height / 2, 0), a.height * 0.95);
      this.geos.set(a, (e = { g, refs: 0 }));
    }
    return e.g;
  }
  retain(a: Asset) {
    this.geometry(a);
    this.geos.get(a)!.refs++;
  }
  release(a: Asset) {
    const e = this.geos.get(a);
    if (!e) return;
    e.refs = Math.max(0, e.refs - 1);
    this.drop(a);
  }
  private drop(a: Asset) {
    const e = this.geos.get(a);
    if (e && e.refs === 0 && !this.live.has(a)) {
      e.g.dispose();
      this.geos.delete(a);
    }
  }

  /** Couleurs de rôles (linéaires) d'un asset, surchargées par les rôles du format (`maillot`, `peau`…). */
  roles(a: Asset, overrides: Record<string, string> | undefined, out?: Float32Array): Float32Array {
    const obj: Record<string, string> = { ...(a.colors as Record<string, string> | undefined) };
    if (overrides)
      for (const [k, v] of Object.entries(overrides)) {
        const r = genRole(k, ROLES);
        if (r && /^#[0-9a-f]{6}$/i.test(v)) obj[r] = v;
      }
    const res = resolveColors(this.style, obj as never).roles;
    if (out) {
      out.set(res);
      return out;
    }
    return res;
  }

  material(roles: { value: Float32Array }, skinned: boolean): { color: THREE.ShaderMaterial; outline: THREE.ShaderMaterial; uniforms: Record<string, THREE.IUniform> } {
    const uniforms: Record<string, THREE.IUniform> = {
      ...this.shared,
      uRoles: roles,
      uSkinned: { value: skinned ? 1 : 0 },
      uDQ: { value: Array.from({ length: MAX_BONES * 2 }, (_, i) => new THREE.Vector4(0, 0, 0, i % 2 ? 0 : 1)) },
      uBlink: { value: 0 },
      uGlow: { value: 0 },
      uGlowCol: { value: new THREE.Color(1, 1, 1) },
    };
    const color = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERTEX, fragmentShader: GEN_FRAGMENT, uniforms, side: THREE.DoubleSide });
    const outline = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: OUTLINE_VERTEX, fragmentShader: OUTLINE_FRAGMENT, uniforms, side: THREE.BackSide });
    return { color, outline, uniforms };
  }

  /** À appeler avant chaque dessin d'un maillage gen : sortie sRGB si l'écran est la cible, taille en pixels. */
  readonly beforeRender = (renderer: THREE.WebGLRenderer) => {
    this.shared.uToSRGB.value = renderer.getRenderTarget() === null ? 1 : 0;
    renderer.getDrawingBufferSize(this.size);
    (this.shared.uResolution.value as THREE.Vector2).copy(this.size);
  };

  /** Décor : `matrices` (colonne, 16 nombres) d'un même asset en un seul appel de dessin (+ contour). */
  instanced(a: Asset, matrices: ArrayLike<number>[], name: string, roleOverrides?: Record<string, string>): THREE.Group {
    const geo = this.geometry(a).clone();
    this.retain(a);
    const n = matrices.length;
    geo.setAttribute("aInstObj", new THREE.InstancedBufferAttribute(new Float32Array(n).map((_, i) => i + 1), 1));
    const roles = { value: this.roles(a, roleOverrides) };
    const mats = this.material(roles, false);
    const group = new THREE.Group();
    group.name = "";
    const m = new THREE.Matrix4();
    for (const [mat, order] of [
      [mats.outline, 0],
      [mats.color, 1],
    ] as const) {
      if (order === 0 && !(this.shared.uOutlinePx.value > 0)) continue;
      const im = new THREE.InstancedMesh(geo, mat, n);
      im.name = order ? name : "";
      matrices.forEach((mm, i) => im.setMatrixAt(i, m.fromArray(mm as number[])));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.onBeforeRender = this.beforeRender as never;
      if (order === 0) im.raycast = () => {};
      group.add(im);
    }
    group.userData.genRoles = roles;
    group.userData.genAsset = a;
    group.userData.genMats = mats;
    return group;
  }

  dispose() {
    for (const e of this.geos.values()) e.g.dispose();
    this.geos.clear();
    this.cache.clear();
    this.live.clear();
  }
}

/** État d'animation fourni par le format à chaque image. */
export type GenDrive = {
  /** Clip courant du format (locomotion / action du moteur, ou geste en pistes d'os). */
  clip: string;
  /** Vitesse imposée par le clip quand l'instance ne se déplace pas (m/s). */
  clipSpeed?: number;
  /** Action procgen du clip. */
  action?: string;
  /** Rotations ajoutées par os (radians, repère du personnage) et décalage de la racine (m). */
  bones: Map<string, [number, number, number]>;
  rootOff: [number, number, number];
};

const ACTION_SET = new Set<string>(ACTIONS);

export class GenActor {
  readonly object = new THREE.Group();
  readonly mesh: THREE.Mesh;
  private outline: THREE.Mesh;
  private mats: ReturnType<GenKit["material"]>;
  private roleBuf: { value: Float32Array };
  private mo: Motion | null;
  private phase = Math.random();
  private speed = 0;
  private last: THREE.Vector3 | null = null;
  private time = 0;
  private action: Action = "idle";
  private actionTime = 0;
  private actionWeight = 0;
  private blinkT = 1 + Math.random() * 3;
  private wp = new THREE.Vector3();
  private seed: number;

  constructor(
    private kit: GenKit,
    readonly asset: Asset,
    roles: Record<string, string> | undefined,
    seed: string,
  ) {
    this.object.name = "";
    this.seed = [...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 997, 7);
    this.roleBuf = { value: kit.roles(asset, roles) };
    const skinned = !!asset.skeleton;
    this.mats = kit.material(this.roleBuf, skinned);
    const geo = kit.geometry(asset);
    kit.retain(asset);
    this.mesh = new THREE.Mesh(geo, this.mats.color);
    this.mesh.name = "";
    this.mesh.onBeforeRender = kit.beforeRender as never;
    this.outline = new THREE.Mesh(geo, this.mats.outline);
    this.outline.name = "";
    this.outline.raycast = () => {};
    this.outline.onBeforeRender = kit.beforeRender as never;
    this.object.add(this.outline, this.mesh);
    this.outline.visible = kit.shared.uOutlinePx.value > 0;
    this.mo = skinned ? motionFor(asset) : null;
    if (this.mo) this.pose(null);
  }

  get height() {
    return this.asset.height;
  }

  setRoles(roles: Record<string, string> | undefined) {
    this.kit.roles(this.asset, roles, this.roleBuf.value);
  }

  setGlow(amount: number, color: string | undefined) {
    this.mats.uniforms.uGlow.value = Math.max(0, Math.min(2, amount));
    if (color && /^#[0-9a-f]{6}$/i.test(color)) (this.mats.uniforms.uGlowCol.value as THREE.Color).set(color).convertSRGBToLinear();
  }

  /**
   * Avance l'animation de `dt` secondes ; `holder` est l'objet placé par `nodes` (vitesse mesurée sur lui, ramenée à
   * l'échelle du personnage : un géant agrandi par `scale` fait des pas à sa taille).
   */
  update(dt: number, holder: THREE.Object3D, d: GenDrive, scale = 1): void {
    if (!this.mo) return;
    this.time += dt;
    holder.getWorldPosition(this.wp);
    let moved = 0;
    if (this.last) moved = Math.hypot(this.wp.x - this.last.x, this.wp.z - this.last.z);
    else this.last = new THREE.Vector3();
    this.last.copy(this.wp);
    if (moved > 2 * Math.max(scale, 1e-3)) moved = 0; // téléportation (remise en jeu) : pas de foulée géante
    moved /= Math.max(scale, 1e-3);
    const real = dt > 0 ? moved / dt : 0;
    const want = Math.max(real, d.clipSpeed ?? 0);
    this.speed += (want - this.speed) * (1 - Math.exp(-dt * 8));
    const step = Math.max(this.speed, 0.2) * dt;
    this.phase += step / (2 * this.mo.stepLength(Math.max(this.speed, 0.2)));
    const act = (d.action && ACTION_SET.has(d.action) ? d.action : "idle") as Action;
    if (act !== this.action) {
      this.action = act;
      this.actionTime = 0;
    }
    this.actionTime += dt;
    const target = act === "idle" ? 0 : 1;
    this.actionWeight += (target - this.actionWeight) * (1 - Math.exp(-dt * 6));
    this.blinkT -= dt;
    let blink = 0;
    if (this.blinkT < 0.14) blink = Math.sin(Math.min(1, Math.max(0, 1 - this.blinkT / 0.14)) * Math.PI);
    if (this.blinkT <= 0) this.blinkT = 2 + ((this.seed * 17.1 + this.time) % 4);
    this.mats.uniforms.uBlink.value = this.asset.blink ? blink : 0;
    this.pose(d);
  }

  private pose(d: GenDrive | null) {
    const sk = this.asset.skeleton!;
    const st: MotionState = { speed: this.speed, phase: this.phase, time: this.time + this.seed, action: this.action, actionTime: this.actionTime, actionWeight: this.actionWeight, mood: "neutral", turn: 0, seed: this.seed, seatY: 0 };
    const { pose } = this.mo!.pose(st);
    if (d) {
      for (const [bone, r] of d.bones) {
        if (!sk.has(bone)) continue;
        if (bone === "root") {
          const add = qEuler(r[0], r[1], r[2]);
          pose.rootRot = pose.rootRot ? qMul(pose.rootRot, add) : add;
          continue;
        }
        const cur: Q = pose.rot[bone] ?? [0, 0, 0, 1];
        pose.rot[bone] = qMul(cur, qEuler(r[0], r[1], r[2]));
      }
      const o = d.rootOff;
      if (o[0] || o[1] || o[2]) pose.root = [pose.root[0] + o[0], pose.root[1] + o[1], pose.root[2] + o[2]] as V3;
    }
    const W = sk.world(pose);
    const S = sk.skinMatrices(W);
    const arr = this.mats.uniforms.uDQ.value as THREE.Vector4[];
    for (let i = 0; i < Math.min(S.length, MAX_BONES); i++) {
      const [r, dq] = dualQuat(S[i]);
      arr[i * 2].set(r[0], r[1], r[2], r[3]);
      arr[i * 2 + 1].set(dq[0], dq[1], dq[2], dq[3]);
    }
  }

  dispose() {
    this.mats.color.dispose();
    this.mats.outline.dispose();
    this.object.removeFromParent();
    this.kit.release(this.asset);
  }
}

