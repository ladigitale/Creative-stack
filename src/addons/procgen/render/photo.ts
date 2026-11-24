/**
 * Rendu soigné de procgen : quand la scène est immobile, l'image s'affine image après image, et s'interrompt au
 * premier geste. Deux moteurs :
 *
 * - `rayons` : lancer de rayons progressif (three-gpu-pathtracer, le même que le rendu photo du format monde, chargé
 *   à la demande par `shared/three/pathtrace.ts`). Les matériaux procgen (rôles de couleur, finis par rôle, squelettes
 *   en quaternions duaux, instances) sont convertis en une copie traçable : une matière physique par rôle et par
 *   fini, couleurs de rôle dans les sommets, pose courante figée, lampes et feux émissifs ; le soleil devient une
 *   lumière directionnelle, le ciel ambiant un environnement en dégradé (ou un studio) ; la brume est reposée sur
 *   l'image tracée par la passe de base. Ombres douces, occlusion, lumière indirecte et reflets justes.
 * - `raster` : accumulation du rendu temps réel (sous-pixels décalés : anticrénelage ; soleil décalé dans un cône :
 *   ombres douces ; carte d'ombre recalculée à chaque image). Pour les styles à aplats (`toon`, `flat`), les pixels
 *   et le mobile, où le lancer de rayons n'apporte rien ou coûte trop.
 *
 * Le résultat remplace la couleur de la scène dans la passe de base (ciel, contours, papier, vignette, sRGB) puis
 * passe par la pile `post` : l'étalonnage et les effets s'appliquent à l'image soignée comme à l'image temps réel.
 */
import * as THREE from "three";
import { type PhotoSpec, readPhoto } from "../../../shared/monde/format";
import { MAX_TRACE_TRIS, type PT, type PhotoState, type Tracer, fullscreen, isHandheld, loadPathTracer, photoStateSig, tracingBudget } from "../../../shared/three/pathtrace";
import { ROLES } from "../style/roles";

export type PhotoEngine = "rayons" | "raster";

export type ProcgenPhotoSpec = PhotoSpec & {
  /** `auto` : rayons sur ordinateur (ombrage `soft` ou `lit`, sans pixels), raster sinon et sur mobile. */
  moteur: "auto" | PhotoEngine;
  /** `render: "photo"` : l'animation se fige pendant le rendu soigné (sinon il attend une scène immobile). */
  force: boolean;
};

export type ProcgenPhotoState = PhotoState & { moteur: PhotoEngine | ""; progression: number };

const ENGINES = ["auto", "rayons", "raster"];

/** Réglages du rendu soigné (`photo` du DataProvider) ; `force` : clé ou attribut `render: "photo"`. */
export function readProcgenPhoto(v: unknown, force: boolean, issue?: (path: string, message: string) => void): ProcgenPhotoSpec | null {
  if (!force && (v === undefined || v === null || v === false)) return null;
  const base = readPhoto(v === undefined || v === null || v === false ? true : v)!;
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  let moteur: ProcgenPhotoSpec["moteur"] = "auto";
  if (o.moteur !== undefined) {
    if (ENGINES.includes(String(o.moteur))) moteur = o.moteur as ProcgenPhotoSpec["moteur"];
    else issue?.("photo.moteur", `moteur « ${String(o.moteur)} » inconnu (${ENGINES.join(", ")})`);
  }
  for (const k of Object.keys(o)) if (!["echantillons", "rebonds", "attente", "filtre", "tramage", "niveaux", "touche", "echelle", "moteur"].includes(k)) issue?.(`photo.${k}`, `clé « ${k} » inconnue`);
  if (o.filtre !== undefined && o.filtre !== "" && base.filtre === "") issue?.("photo.filtre", `filtre « ${String(o.filtre)} » inconnu (peinture, lisse)`);
  return { ...base, moteur, force };
}

/** Moteur retenu : `auto` choisit le lancer de rayons sur ordinateur pour un ombrage modelé sans pixels. */
export function pickEngine(spec: ProcgenPhotoSpec, o: { mobile: boolean; shading: string; pixel: number }): PhotoEngine {
  if (o.pixel > 0) return "raster";
  if (spec.moteur !== "auto") return spec.moteur;
  if (o.mobile) return "raster";
  return o.shading === "soft" || o.shading === "lit" ? "rayons" : "raster";
}

/** Images accumulées par le moteur raster (mobile : très réduit). */
export const rasterFrames = (spec: ProcgenPhotoSpec, mobile: boolean) => Math.max(1, Math.min(spec.echantillons, mobile ? 8 : 32));

/** Suite de Halton (base 2 / 3) recentrée : décalages sous-pixel bien répartis. */
export function halton(i: number, b: number): number {
  let f = 1, r = 0;
  for (let k = i + 1; k > 0; k = Math.floor(k / b)) {
    f /= b;
    r += f * (k % b);
  }
  return r - 0.5;
}

/* ---------------------------------------------------------------- copie traçable */

export type ProxyLights = {
  sunDir: THREE.Vector3;
  sun: THREE.Color;
  ambSky: THREE.Color;
  ambGround: THREE.Color;
  horizon: THREE.Color;
  environment: "exterieur" | "studio" | "aucun";
  night: number;
  lamps: number;
  points: { pos: [number, number, number]; radius: number; color: [number, number, number] }[];
};

type Split = { role: number; geo: THREE.BufferGeometry; tris: number }[];

/** Rugosité par défaut (rôles sans fini) : sol mat, pierre, bois, feuillage un peu satiné, eau et verre lisses. */
const ROUGH: Partial<Record<string, number>> = { water: 0.05, glass: 0.08, metal: 0.45, leaf: 0.7, leaf2: 0.7, eye: 0.25, eyeWhite: 0.3, mouth: 0.5, skin: 0.6, hair: 0.65, lamp: 0.3, roof: 0.8 };
const EMISSIVE = new Set(["lamp", "fire"]);

const hashRoles = (a: Float32Array, b: Float32Array) => {
  let h = 0;
  for (let i = 0; i < a.length; i++) h = (h * 31 + Math.round(a[i] * 4096)) | 0;
  for (let i = 0; i < b.length; i++) h = (h * 31 + Math.round(b[i] * 4096)) | 0;
  return h;
};

/** Pose courante d'un maillage procgen à squelette (quaternions duaux, comme le shader de sommets). */
export function skinPositions(geo: THREE.BufferGeometry, dq: THREE.Vector4[], blink = 0, exprW?: THREE.Vector4[]): { pos: Float32Array; nrm: Float32Array } {
  const P = geo.getAttribute("position").array as ArrayLike<number>;
  const N = geo.getAttribute("normal").array as ArrayLike<number>;
  const I = geo.getAttribute("aSkinIdx").array as ArrayLike<number>;
  const W = geo.getAttribute("aSkinW").array as ArrayLike<number>;
  const M = geo.getAttribute("aMorph")?.array as ArrayLike<number> | undefined;
  const n = P.length / 3;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  const r = [0, 0, 0, 0], d = [0, 0, 0, 0];
  // morphs d'expression du visage (mêmes poids que le shader)
  const E = geo.userData.expr as { base: number; count: number; channels: readonly string[]; data: Float32Array } | undefined;
  const ew = E && exprW ? E.channels.map((_, c) => exprW[c >> 2]?.getComponent(c & 3) ?? 0) : null;
  const rot = (q: number[], vx: number, vy: number, vz: number, out: Float32Array, o: number) => {
    // v + 2 q.xyz × (q.xyz × v + w v)
    const cx = q[1] * vz - q[2] * vy + q[3] * vx, cy = q[2] * vx - q[0] * vz + q[3] * vy, cz = q[0] * vy - q[1] * vx + q[3] * vz;
    out[o] = vx + 2 * (q[1] * cz - q[2] * cy);
    out[o + 1] = vy + 2 * (q[2] * cx - q[0] * cz);
    out[o + 2] = vz + 2 * (q[0] * cy - q[1] * cx);
  };
  for (let v = 0; v < n; v++) {
    r.fill(0);
    d.fill(0);
    const b0 = Math.round(I[v * 4]);
    const r0 = dq[b0 * 2];
    for (let k = 0; k < 4; k++) {
      const w = W[v * 4 + k];
      if (w <= 0) continue;
      const bi = Math.round(I[v * 4 + k]);
      const qr = dq[bi * 2], qd = dq[bi * 2 + 1];
      if (!qr || !qd) continue;
      const s = qr.x * r0.x + qr.y * r0.y + qr.z * r0.z + qr.w * r0.w < 0 ? -w : w;
      r[0] += qr.x * s; r[1] += qr.y * s; r[2] += qr.z * s; r[3] += qr.w * s;
      d[0] += qd.x * s; d[1] += qd.y * s; d[2] += qd.z * s; d[3] += qd.w * s;
    }
    const l = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
    for (let k = 0; k < 4; k++) (r[k] /= l), (d[k] /= l);
    let px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2];
    if (M && blink) (px += M[v * 3] * blink), (py += M[v * 3 + 1] * blink), (pz += M[v * 3 + 2] * blink);
    if (E && ew && v >= E.base && v < E.base + E.count)
      for (let c = 0; c < ew.length; c++) {
        if (!ew[c]) continue;
        const o = (c * E.count + v - E.base) * 3;
        (px += E.data[o] * ew[c]), (py += E.data[o + 1] * ew[c]), (pz += E.data[o + 2] * ew[c]);
      }
    rot(r, px, py, pz, pos, v * 3);
    // t = 2 (r.w d.xyz − d.w r.xyz + r.xyz × d.xyz)
    pos[v * 3] += 2 * (r[3] * d[0] - d[3] * r[0] + (r[1] * d[2] - r[2] * d[1]));
    pos[v * 3 + 1] += 2 * (r[3] * d[1] - d[3] * r[1] + (r[2] * d[0] - r[0] * d[2]));
    pos[v * 3 + 2] += 2 * (r[3] * d[2] - d[3] * r[2] + (r[0] * d[1] - r[1] * d[0]));
    rot(r, N[v * 3], N[v * 3 + 1], N[v * 3 + 2], nrm, v * 3);
  }
  return { pos, nrm };
}

/**
 * Découpe un maillage procgen par rôle : géométries compactes (position, normale, couleur du rôle, uv nuls), une par
 * rôle présent. `roles` : couleurs linéaires (`uRoles`) ; `skin` : pose figée (acteurs).
 */
export function splitByRole(geo: THREE.BufferGeometry, roles: Float32Array, skin?: { pos: Float32Array; nrm: Float32Array }): Split {
  const P = skin?.pos ?? (geo.getAttribute("position").array as ArrayLike<number>);
  const N = skin?.nrm ?? (geo.getAttribute("normal").array as ArrayLike<number>);
  const R = geo.getAttribute("aRole").array as ArrayLike<number>;
  const B = geo.getAttribute("aBlend")?.array as ArrayLike<number> | undefined;
  const idx = geo.index ? (geo.index.array as ArrayLike<number>) : Array.from({ length: P.length / 3 }, (_, i) => i);
  const byRole = new Map<number, number[]>();
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const role = Math.round(R[idx[t]]);
    let l = byRole.get(role);
    if (!l) byRole.set(role, (l = []));
    l.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  const out: Split = [];
  for (const [role, tri] of byRole) {
    const remap = new Map<number, number>();
    const index = new Uint32Array(tri.length);
    for (let i = 0; i < tri.length; i++) {
      let k = remap.get(tri[i]);
      if (k === undefined) remap.set(tri[i], (k = remap.size));
      index[i] = k;
    }
    const n = remap.size;
    const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (const [v, k] of remap) {
      for (let j = 0; j < 3; j++) {
        pos[k * 3 + j] = P[v * 3 + j];
        nrm[k * 3 + j] = N[v * 3 + j];
      }
      const r = Math.round(R[v]);
      let c0 = roles[r * 3], c1 = roles[r * 3 + 1], c2 = roles[r * 3 + 2];
      const bl = B ? B[v] : 0;
      if (bl > 0.001) {
        const r2 = Math.floor(bl + 0.0005);
        let t = Math.max(0, Math.min(1, bl - r2));
        t = t * t * (3 - 2 * t);
        c0 += (roles[r2 * 3] - c0) * t;
        c1 += (roles[r2 * 3 + 1] - c1) * t;
        c2 += (roles[r2 * 3 + 2] - c2) * t;
      }
      col[k * 3] = c0;
      col[k * 3 + 1] = c1;
      col[k * 3 + 2] = c2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    out.push({ role, geo: g, tris: tri.length / 3 });
  }
  return out;
}

/** Matière traçable d'un rôle : fini du style (`uRoleMat` : rugosité + 1, métal, tissu, vernis) ou rugosité par défaut. */
export function roleMaterial(role: number, roleMat: Float32Array, roles: Float32Array, light: { night: number; lamps: number }): THREE.MeshPhysicalMaterial {
  const name = ROLES[role] ?? "";
  const rm = [roleMat[role * 4], roleMat[role * 4 + 1], roleMat[role * 4 + 2], roleMat[role * 4 + 3]];
  const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: ROUGH[name] ?? 0.88, metalness: 0, side: THREE.DoubleSide });
  if (rm[0] > 0.5) {
    m.roughness = Math.max(0.03, Math.min(1, rm[0] - 1));
    m.metalness = rm[1];
    m.sheen = rm[2];
    m.sheenRoughness = 0.6;
    m.clearcoat = rm[3];
    m.clearcoatRoughness = 0.08;
  }
  if (EMISSIVE.has(name)) {
    const k = name === "fire" ? 2.2 : 0.8 + light.night * light.lamps * 2;
    m.emissive.setRGB(roles[role * 3] * k, roles[role * 3 + 1] * k, roles[role * 3 + 2] * k);
  }
  return m;
}

/** Environnement du traceur : dégradé sol → ciel ambiant (extérieur), pièce claire à deux boîtes à lumière (studio). */
function makeEnvironment(m: PT, L: ProxyLights): THREE.Texture {
  const g = new m.GradientEquirectTexture(64);
  // la passe temps réel éclaire l'ambiant à 0,62 : même part ici (luminance de l'environnement)
  const k = 0.62;
  if (L.environment === "studio") {
    const dir = new THREE.Vector3();
    g.generationCallback = (polar: THREE.Spherical, _uv: THREE.Vector2, _c: THREE.Vector2, color: THREE.Color) => {
      dir.setFromSpherical(polar);
      const t = Math.max(0, Math.min(1, (dir.y + 0.3) / 0.8));
      const v = 0.22 + (0.85 - 0.22) * t * t * (3 - 2 * t);
      const box = Math.abs(dir.x) > 0.93 && dir.y > 0 ? 2.4 : 0;
      color.setRGB(v + box, v + box, v + box);
    };
  } else {
    g.topColor.setRGB(L.ambSky.r * k, L.ambSky.g * k, L.ambSky.b * k);
    g.bottomColor.setRGB(L.ambGround.r * k, L.ambGround.g * k, L.ambGround.b * k);
    g.exponent = 1;
  }
  g.update();
  return g;
}

/* ---------------------------------------------------------------- moteur */

export class ProcgenPhoto {
  spec: ProcgenPhotoSpec | null = null;
  engine: PhotoEngine | "" = "";
  state: ProcgenPhotoState = { etat: "arret", echantillons: 0, total: 0, moteur: "", progression: 0 };
  onState: ((s: ProcgenPhotoState) => void) | null = null;
  /** Le module du traceur vient d'arriver : le composant relance sa boucle. */
  onReady: (() => void) | null = null;
  private stateSig = "";
  private mod: PT | null = null;
  private loading = false;
  private failed = "";
  private tracer: Tracer | null = null;
  private proxy: THREE.Scene | null = null;
  /** Version du contenu de la scène copiée : une vue qui change seule garde la copie et son BVH. */
  private proxyVersion = -1;
  private owned: { geos: THREE.BufferGeometry[]; mats: THREE.Material[]; tex: THREE.Texture[] } = { geos: [], mats: [], tex: [] };
  private splitCache = new Map<string, Split>();
  private accum: THREE.WebGLRenderTarget | null = null;
  private blend: ReturnType<typeof fullscreen> | null = null;
  private denoise: ReturnType<typeof fullscreen> | null = null;
  private smooth: THREE.WebGLRenderTarget | null = null;
  /** Images accumulées (raster) ; début du fondu (rayons). */
  frames = 0;
  private fadeT0 = 0;
  /** Coût mesuré du démarrage (copie et BVH, ms) et de la dernière image (ms). */
  buildMs = 0;

  constructor(private renderer: THREE.WebGLRenderer) {}

  configure(spec: ProcgenPhotoSpec | null) {
    if (JSON.stringify(spec) === JSON.stringify(this.spec)) return;
    this.spec = spec;
    this.stop();
    this.disposeProxy();
    this.proxyVersion = -1;
    this.failed = "";
    if (!spec) {
      this.setState("arret", 0, 0);
      this.disposeAll();
    } else this.setState("attente", 0, 0);
  }

  /** Charge le traceur si le moteur `rayons` peut servir (rien sinon : zéro coût). */
  prepare(engine: PhotoEngine) {
    if (engine !== "rayons" || this.mod || this.loading || this.failed) return;
    this.loading = true;
    loadPathTracer().then(
      (m) => {
        this.mod = m;
        this.loading = false;
        this.onReady?.();
      },
      (e) => {
        this.loading = false;
        this.failed = `module : ${e instanceof Error ? e.message : String(e)}`;
        this.onReady?.();
      },
    );
  }

  /** Le traceur est-il prêt (ou en échec : on passe alors au raster) ? */
  ready(engine: PhotoEngine): boolean {
    return engine === "raster" || !!this.mod || !!this.failed;
  }

  get active() {
    return this.engine !== "";
  }

  get running() {
    return this.state.etat === "calcul";
  }

  /**
   * Commence un rendu soigné ; rend le moteur réellement utilisé (le traceur se rabat sur le raster en cas d'échec).
   * `version` : version du contenu de la scène (objets, poses, style) ; la même version ne recopie rien.
   */
  start(engine: PhotoEngine, scene: THREE.Scene, camera: THREE.Camera, lights: ProxyLights, version: number): PhotoEngine {
    this.stop();
    const t0 = performance.now();
    if (engine === "rayons") {
      if (this.failed || !this.mod) engine = "raster";
      else {
        try {
          const ok = this.startTrace(scene, camera, lights, version);
          if (!ok) engine = "raster";
        } catch (e) {
          this.failed = e instanceof Error ? e.message : String(e);
          this.disposeProxy();
          engine = "raster";
        }
      }
    }
    this.buildMs = Math.round(performance.now() - t0);
    this.engine = engine;
    this.frames = 0;
    this.fadeT0 = 0;
    const total = engine === "rayons" ? this.spec!.echantillons : 0;
    this.setState("calcul", 0, total);
    return engine;
  }

  /** Retour au temps réel ; la copie traçable est gardée pour une simple reprise de vue. */
  stop() {
    this.engine = "";
    this.frames = 0;
    if (this.spec && this.state.etat !== "attente") this.setState("attente", 0, 0);
  }

  /* ------------------------------------------------ rayons */

  private startTrace(scene: THREE.Scene, camera: THREE.Camera, L: ProxyLights, version: number): boolean {
    const m = this.mod!;
    const sp = this.spec!;
    if (this.tracer && this.proxy && version === this.proxyVersion) {
      // même contenu, autre vue : rien à recopier ni à reconstruire
      this.tracer.setCamera(camera);
      this.tracer.reset();
      return true;
    }
    this.disposeProxy();
    this.proxyVersion = -1;
    const proxy = this.buildProxy(scene, L);
    if (!proxy) return false;
    if (!this.tracer) {
      const t = new m.WebGLPathTracer(this.renderer);
      t.renderToCanvas = false;
      t.renderDelay = 0;
      t.minSamples = 1;
      t.fadeDuration = 0;
      t.filterGlossyFactor = 0.5;
      this.tracer = t;
    }
    const t = this.tracer;
    t.bounces = sp.rebonds;
    // budget du format monde : pixels tracés plafonnés et passes en tuiles (téléphone)
    const b = tracingBudget(this.renderer, sp.echelle, isHandheld());
    t.renderScale = b.scale;
    t.tiles.set(b.tiles, b.tiles);
    this.proxy = proxy;
    t.setScene(proxy, camera);
    t.reset();
    this.proxyVersion = version;
    return true;
  }

  /**
   * Un échantillon du traceur ; rend la texture à montrer (linéaire) et le poids de fondu (0 : temps réel encore),
   * ou `null` quand tout est calculé (rien à refaire).
   */
  traceStep(now: number): { tex: THREE.Texture; mix: number; done: boolean } {
    const t = this.tracer!;
    const sp = this.spec!;
    const total = sp.echantillons;
    t.pausePathTracing = t.samples >= total;
    t.renderSample();
    const samples = Math.min(total, Math.floor(t.samples));
    const min = sp.filtre ? 1 : 3;
    if (samples >= min && !this.fadeT0) this.fadeT0 = now;
    const mix = this.fadeT0 ? Math.min(1, (now - this.fadeT0) / 350) : 0;
    let tex: THREE.Texture = t.target.texture;
    if (sp.filtre === "lisse" && samples >= 1) tex = this.denoised(t.target.texture, t.target.width, t.target.height);
    const done = t.samples >= total && mix >= 1;
    this.setState(done ? "fini" : "calcul", samples, total);
    return { tex, mix, done };
  }

  /** Débruitage du traceur (garde les arêtes) vers une cible. */
  private denoised(src: THREE.Texture, w: number, h: number): THREE.Texture {
    const r = this.renderer;
    if (!this.denoise && this.mod) {
      const mat = new this.mod.DenoiseMaterial() as unknown as THREE.ShaderMaterial;
      mat.uniforms.sigma.value = 5;
      mat.uniforms.kSigma.value = 2;
      mat.uniforms.threshold.value = 0.25;
      this.denoise = fullscreen(mat);
    }
    if (!this.smooth || this.smooth.width !== w || this.smooth.height !== h) {
      this.smooth?.dispose();
      this.smooth = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
    }
    const d = this.denoise!;
    (d.mat.uniforms.map as THREE.IUniform).value = src;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.smooth);
    r.render(d.scene, d.cam);
    r.setRenderTarget(prev);
    return this.smooth.texture;
  }

  private buildProxy(scene: THREE.Scene, L: ProxyLights): THREE.Scene | null {
    scene.updateMatrixWorld(true);
    const out = new THREE.Scene();
    out.background = L.horizon.clone();
    const mats = new Map<string, THREE.Material>();
    let tris = 0;
    const tmp = new THREE.Matrix4();
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, world: THREE.Matrix4) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(world);
      mesh.matrixWorld.copy(world);
      out.add(mesh);
    };
    const used = new Set<string>();
    let over = false;
    scene.traverseVisible((o) => {
      if (over) return;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.userData.depth) return;
      const U = (mesh.material as THREE.ShaderMaterial).uniforms;
      const roles = U.uRoles.value as Float32Array;
      const roleMat = U.uRoleMat.value as Float32Array;
      const skinned = U.uSkinned?.value > 0.5;
      const rk = hashRoles(roles, roleMat);
      // acteurs : pose courante (jamais en cache) ; sinon découpe gardée tant que la géométrie et le style restent
      let split: Split;
      if (skinned) {
        split = splitByRole(mesh.geometry, roles, skinPositions(mesh.geometry, U.uDQ.value as THREE.Vector4[], U.uBlink?.value ?? 0, U.uExprW?.value as THREE.Vector4[] | undefined));
        for (const s of split) this.owned.geos.push(s.geo);
      } else {
        // version des positions : tuile d'un objet glissé, tissu souple réécrits sur place
        const key = `${mesh.geometry.uuid}|${(mesh.geometry.getAttribute("position") as THREE.BufferAttribute).version}|${rk}`;
        used.add(key);
        split = this.splitCache.get(key) ?? splitByRole(mesh.geometry, roles);
        this.splitCache.set(key, split);
      }
      const matOf = (role: number) => {
        const k = `${rk}|${role}`;
        let mt = mats.get(k);
        if (!mt) {
          mt = roleMaterial(role, roleMat, roles, L);
          this.owned.mats.push(mt);
          mats.set(k, mt);
        }
        return mt;
      };
      const inst = mesh as THREE.InstancedMesh;
      if (inst.isInstancedMesh) {
        for (let i = 0; i < inst.count; i++) {
          inst.getMatrixAt(i, tmp);
          if (Math.abs(tmp.determinant()) < 1e-12) continue;
          const w = new THREE.Matrix4().multiplyMatrices(inst.matrixWorld, tmp);
          for (const s of split) {
            add(s.geo, matOf(s.role), w);
            tris += s.tris;
          }
          if (tris > MAX_TRACE_TRIS) return void (over = true);
        }
        return;
      }
      for (const s of split) {
        add(s.geo, matOf(s.role), mesh.matrixWorld);
        tris += s.tris;
      }
      if (tris > MAX_TRACE_TRIS) over = true;
    });
    // découpes d'une ancienne scène ou d'un ancien style : libérées
    for (const [k, s] of this.splitCache) if (!used.has(k)) (this.splitCache.delete(k), s.forEach((x) => x.geo.dispose()));
    if (over) {
      this.failed = `scène trop lourde pour le lancer de rayons (${Math.round(tris / 1000)} k triangles)`;
      return null;
    }
    // soleil : la passe temps réel donne albedo × soleil × n·l ; three (unités physiques) divise par π
    const sun = new THREE.DirectionalLight(0xffffff, Math.PI);
    sun.color.copy(L.sun);
    sun.position.copy(L.sunDir).multiplyScalar(100);
    sun.target.position.set(0, 0, 0);
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    out.add(sun, sun.target);
    // lampes et feux (la nuit surtout)
    for (const p of L.points.slice(0, 12)) {
      const pl = new THREE.PointLight(0xffffff, Math.PI * 1.5, p.radius * 1.5, 2);
      pl.color.setRGB(p.color[0], p.color[1], p.color[2]);
      pl.position.set(p.pos[0], p.pos[1], p.pos[2]);
      pl.updateMatrixWorld();
      out.add(pl);
    }
    // l'environnement tient lieu de lumière ambiante (même sans reflets : `aucun` garde le dégradé du ciel)
    const env = makeEnvironment(this.mod!, L);
    out.environment = env;
    out.environmentIntensity = L.environment === "studio" ? 0.8 : 1;
    this.owned.tex.push(env);
    return out;
  }

  /* ------------------------------------------------ raster (accumulation) */

  /** Ajoute l'image temps réel `src` (couleur linéaire de la scène) à la moyenne ; rend la texture accumulée. */
  accumulate(src: THREE.Texture, w: number, h: number): THREE.Texture {
    const r = this.renderer;
    if (!this.accum || this.accum.width !== w || this.accum.height !== h) {
      this.accum?.dispose();
      this.accum = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
      this.accum.texture.minFilter = this.accum.texture.magFilter = THREE.NearestFilter;
      this.frames = 0;
    }
    if (!this.blend) {
      this.blend = fullscreen(
        new THREE.ShaderMaterial({
          glslVersion: THREE.GLSL3,
          vertexShader: "out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
          fragmentShader: "precision highp float; in vec2 vUv; uniform sampler2D map; uniform float w; layout(location = 0) out vec4 o; void main() { o = vec4(texture(map, vUv).rgb, w); }",
          uniforms: { map: { value: null }, w: { value: 1 } },
          depthTest: false,
          depthWrite: false,
          transparent: true,
          blending: THREE.CustomBlending,
          blendSrc: THREE.SrcAlphaFactor,
          blendDst: THREE.OneMinusSrcAlphaFactor,
          blendSrcAlpha: THREE.OneFactor,
          blendDstAlpha: THREE.ZeroFactor,
        }),
      );
    }
    const b = this.blend;
    b.mat.uniforms.map.value = src;
    b.mat.uniforms.w.value = 1 / (this.frames + 1);
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.accum);
    r.render(b.scene, b.cam);
    r.setRenderTarget(prev);
    this.frames++;
    return this.accum.texture;
  }

  /** Avancement du raster (après `accumulate`). */
  rasterProgress(total: number) {
    this.setState(this.frames >= total ? "fini" : "calcul", this.frames, total);
    return this.frames >= total;
  }

  get rasterTexture(): THREE.Texture | null {
    return this.accum?.texture ?? null;
  }

  /* ------------------------------------------------ état, nettoyage */

  private setState(etat: PhotoState["etat"], echantillons: number, total: number) {
    const s: ProcgenPhotoState = { etat, echantillons, total, moteur: this.engine, progression: total ? Math.round((echantillons / total) * 100) / 100 : etat === "fini" ? 1 : 0, ...(this.failed ? { raison: this.failed } : {}) };
    const sig = photoStateSig(s) + s.moteur;
    if (sig === this.stateSig) return;
    this.stateSig = sig;
    this.state = s;
    this.onState?.(s);
  }

  private disposeProxy() {
    for (const g of this.owned.geos) g.dispose();
    for (const m of this.owned.mats) m.dispose();
    for (const t of this.owned.tex) t.dispose();
    this.owned = { geos: [], mats: [], tex: [] };
    this.proxy = null;
  }

  private disposeAll() {
    this.disposeProxy();
    for (const s of this.splitCache.values()) for (const x of s) x.geo.dispose();
    this.splitCache.clear();
    this.tracer?.dispose();
    this.tracer = null;
    this.accum?.dispose();
    this.accum = null;
    this.smooth?.dispose();
    this.smooth = null;
    this.blend?.mat.dispose();
    this.blend = null;
    this.denoise?.mat.dispose();
    this.denoise = null;
  }

  dispose() {
    this.spec = null;
    this.disposeAll();
  }
}
