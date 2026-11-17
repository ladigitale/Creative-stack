import * as THREE from "three";
import type { PhotoSpec } from "../../shared/monde/format";
import { PaintFilter } from "./paint-filter";

/**
 * Rendu « photo » : quand la vue et la scène ne bougent plus depuis `attente` ms, l'image est recalculée en
 * lancer de rayons progressif (three-gpu-pathtracer, chargé à la demande). Tout changement rend la main au
 * rendu temps réel ; le calcul reprend à la prochaine pause.
 *
 * Le traceur ne connaît ni les copies instanciées, ni les squelettes, ni les lumières ambiantes : il travaille
 * sur une copie de la scène (copies dépliées, poses figées, matières converties) et reçoit un environnement
 * équirectangulaire qui tient lieu de lumière ambiante. Particules, traits et brume n'y figurent pas.
 */

type PT = typeof import("three-gpu-pathtracer");
type Tracer = InstanceType<PT["WebGLPathTracer"]>;

export type PhotoState = {
  etat: "arret" | "attente" | "calcul" | "fini" | "indisponible";
  echantillons: number;
  total: number;
  raison?: string;
};

/** Au-delà, la scène dépliée est trop lourde pour le traceur (mémoire du BVH). */
const MAX_TRIS = 2_500_000;

let modPromise: Promise<PT> | null = null;
function loadPT(): Promise<PT> {
  return (modPromise ??= import("three-gpu-pathtracer"));
}

export type EnvSource = { kind: "studio" | "exterieur" | "aucun"; scene: THREE.Scene | null; intensity: number };

export class PhotoMode {
  private spec: PhotoSpec | null = null;
  private mod: PT | null = null;
  private tracer: Tracer | null = null;
  private proxy: THREE.Scene | null = null;
  private owned: { geos: THREE.BufferGeometry[]; mats: THREE.Material[]; tex: THREE.Texture[] } = { geos: [], mats: [], tex: [] };
  private lastSig = NaN;
  private stillSince = 0;
  private active = false;
  private failed = "";
  private raf = 0;
  private lastFrame = 0;
  private stateSig = "";
  state: PhotoState = { etat: "arret", echantillons: 0, total: 0 };
  /** Source d'environnement du monde (scène procédurale rendue en cube pour le traceur). */
  envSource: (() => EnvSource) | null = null;
  onState: ((s: PhotoState) => void) | null = null;

  constructor(
    private renderer: THREE.WebGLRenderer,
    /** Redessine une image (le composant ne tourne pas forcément en continu). */
    private redraw: () => void,
  ) {}

  get enabled() {
    return this.spec !== null;
  }

  configure(spec: PhotoSpec | null) {
    const same = JSON.stringify(spec) === JSON.stringify(this.spec);
    if (same) return;
    this.spec = spec;
    this.stop();
    if (!spec) {
      this.setState({ etat: "arret", echantillons: 0, total: 0 });
      this.disposeTracer();
      return;
    }
    this.failed = "";
    this.lastSig = NaN;
    loadPT().then(
      (m) => {
        this.mod = m;
        this.schedule();
      },
      (e) => {
        this.failed = `module : ${e instanceof Error ? e.message : String(e)}`;
        this.setState({ etat: "indisponible", echantillons: 0, total: 0, raison: this.failed });
      },
    );
  }

  /** Change de vue ou de contenu : retour au temps réel. */
  invalidate() {
    this.lastSig = NaN;
  }

  /**
   * Une image. Rend `true` si l'image a été produite par le traceur (le rendu temps réel ne doit pas l'écraser).
   * `raster` dessine l'image temps réel (sert aussi de fond pendant le fondu).
   */
  frame(scene: THREE.Scene, camera: THREE.Camera, raster: () => void, now: number): boolean {
    this.lastFrame = now;
    if (!this.spec || this.failed) return false;
    const sig = signature(scene, camera);
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.stillSince = now;
      if (this.active) this.stop();
      this.setState({ etat: "attente", echantillons: 0, total: this.spec.echantillons });
      this.schedule();
      return false;
    }
    if (!this.active) {
      if (!this.mod || now - this.stillSince < this.spec.attente) {
        this.schedule();
        return false;
      }
      try {
        this.start(scene, camera, raster);
      } catch (e) {
        this.failed = e instanceof Error ? e.message : String(e);
        this.setState({ etat: "indisponible", echantillons: 0, total: 0, raison: this.failed });
        return false;
      }
      if (!this.active) return false;
    }
    const t = this.tracer!;
    const total = this.spec.echantillons;
    const before = t.samples;
    t.pausePathTracing = t.samples >= total;
    t.renderSample();
    const done = t.samples >= total;
    if (this.spec.filtre) this.drawFiltered(raster, t.samples !== before);
    this.setState({ etat: done ? "fini" : "calcul", echantillons: Math.min(total, Math.floor(t.samples)), total });
    // le fondu se termine même une fois le compte atteint
    if (!done || t.samples < total + 1) this.schedule();
    return true;
  }

  private paint: PaintFilter | null = null;
  private denoise: { quad: THREE.Mesh; scene: THREE.Scene; cam: THREE.Camera; mat: THREE.ShaderMaterial } | null = null;
  private painted: THREE.WebGLRenderTarget | null = null;
  private copy: { quad: THREE.Mesh; scene: THREE.Scene; cam: THREE.Camera; mat: THREE.ShaderMaterial } | null = null;

  /**
   * Image filtrée : `peinture` (tramage puis Kuwahara anisotrope, recalculé seulement quand un échantillon arrive,
   * recopié sinon) ; `lisse` (débruitage du traceur qui garde les arêtes). Avant le premier échantillon : temps réel.
   */
  private drawFiltered(raster: () => void, fresh: boolean) {
    const t = this.tracer!;
    const sp = this.spec!;
    const r = this.renderer;
    if (t.samples < 1) {
      raster();
      return;
    }
    const prev = r.getRenderTarget();
    if (sp.filtre === "lisse") {
      if (!this.denoise && this.mod) {
        const mat = new this.mod.DenoiseMaterial() as unknown as THREE.ShaderMaterial;
        // peu d'échantillons : bruit fort, seuil large (les arêtes nettes restent au-delà)
        mat.uniforms.sigma.value = 5;
        mat.uniforms.kSigma.value = 2;
        mat.uniforms.threshold.value = 0.25;
        this.denoise = fullscreen(mat);
      }
      const d = this.denoise!;
      (d.mat.uniforms.map as THREE.IUniform).value = t.target.texture;
      r.setRenderTarget(null);
      r.render(d.scene, d.cam);
      r.setRenderTarget(prev);
      return;
    }
    this.paint ??= new PaintFilter();
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    if (!this.painted || this.painted.width !== size.x || this.painted.height !== size.y) {
      this.painted?.dispose();
      this.painted = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
      fresh = true;
    }
    if (fresh) this.paint.render(r, t.target.texture, { radius: sp.touche, sharpness: 8, dither: sp.tramage, levels: sp.niveaux, hdr: true }, this.painted);
    if (!this.copy) {
      this.copy = fullscreen(
        new THREE.ShaderMaterial({
          vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
          fragmentShader: "varying vec2 vUv; uniform sampler2D map; void main() { gl_FragColor = texture2D(map, vUv); \n#include <colorspace_fragment>\n }",
          uniforms: { map: { value: null } },
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
        }),
      );
    }
    this.copy.mat.uniforms.map.value = this.painted.texture;
    r.setRenderTarget(null);
    r.render(this.copy.scene, this.copy.cam);
    r.setRenderTarget(prev);
  }

  private schedule() {
    if (this.raf || !this.spec) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      // le composant dessine déjà en continu : pas de seconde image dans la même trame
      if (performance.now() - this.lastFrame > 12) this.redraw();
    });
  }

  private start(scene: THREE.Scene, camera: THREE.Camera, raster: () => void) {
    const m = this.mod!;
    if (!this.tracer) {
      const t = new m.WebGLPathTracer(this.renderer);
      t.tiles.set(2, 2);
      t.minSamples = 3;
      t.fadeDuration = 400;
      t.renderDelay = 0;
      t.filterGlossyFactor = 0.5;
      this.tracer = t;
    }
    const t = this.tracer;
    const sp = this.spec!;
    t.bounces = sp.rebonds;
    // filtré : l'image reste dans la cible du traceur, le filtre la dessine (voir drawFiltered)
    t.renderToCanvas = !sp.filtre;
    t.renderScale = sp.echelle;
    t.tiles.set(sp.filtre ? 1 : 2, sp.filtre ? 1 : 2);
    t.rasterizeSceneCallback = () => raster();
    this.disposeProxy();
    const built = this.buildProxy(scene, m);
    if (!built) return;
    this.proxy = built;
    t.setScene(built, camera);
    this.active = true;
  }

  private stop() {
    this.active = false;
    this.disposeProxy();
  }

  private setState(s: PhotoState) {
    const sig = `${s.etat}|${s.echantillons}|${s.total}|${s.raison ?? ""}`;
    if (sig === this.stateSig) return;
    this.stateSig = sig;
    this.state = s;
    this.onState?.(s);
  }

  /* ------------------------------------------------------------ copie de la scène pour le traceur */

  private buildProxy(scene: THREE.Scene, m: PT): THREE.Scene | null {
    scene.updateMatrixWorld(true);
    const out = new THREE.Scene();
    out.background = scene.background instanceof THREE.Color ? scene.background.clone() : null;
    const matCache = new Map<string, THREE.Material>();
    let tris = 0;
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, world: THREE.Matrix4) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(world);
      mesh.matrixWorld.copy(world);
      out.add(mesh);
      tris += (geo.index ? geo.index.count : geo.getAttribute("position").count) / 3;
    };
    const convert = (src: THREE.Material, tint: THREE.Color | null): THREE.Material | null => {
      const key = `${src.uuid}|${tint ? tint.getHexString() : ""}`;
      const hit = matCache.get(key);
      if (hit) return hit;
      const mat = toTraceable(src, tint);
      if (!mat) return null;
      if (mat !== src) this.owned.mats.push(mat);
      matCache.set(key, mat);
      return mat;
    };
    const tmp = new THREE.Matrix4();
    const col = new THREE.Color();
    scene.traverseVisible((o) => {
      if (tris > MAX_TRIS) return;
      const light = o as THREE.Light;
      if ((light as THREE.DirectionalLight).isDirectionalLight || (light as THREE.PointLight).isPointLight || (light as THREE.SpotLight).isSpotLight) {
        if (light.intensity <= 0) return;
        const l = light.clone() as THREE.Light;
        l.matrixAutoUpdate = false;
        l.matrix.copy(light.matrixWorld);
        l.matrixWorld.copy(light.matrixWorld);
        const dl = l as THREE.DirectionalLight;
        if (dl.isDirectionalLight || (l as THREE.SpotLight).isSpotLight) {
          const tgt = new THREE.Object3D();
          tgt.position.setFromMatrixPosition((light as THREE.DirectionalLight).target.matrixWorld);
          tgt.updateMatrixWorld();
          dl.target = tgt;
        }
        out.add(l);
        return;
      }
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry?.getAttribute("position")) return;
      if (mesh.material === undefined || Array.isArray(mesh.material)) return;
      const src = mesh.material as THREE.Material;
      if ((src as THREE.ShaderMaterial).isShaderMaterial || src.visible === false) return;
      if (src.transparent && src.opacity < 0.02) return;
      const inst = mesh as THREE.InstancedMesh;
      if (inst.isInstancedMesh) {
        const geo = traceableGeometry(inst.geometry, this.owned.geos);
        for (let i = 0; i < inst.count; i++) {
          let tint: THREE.Color | null = null;
          if (inst.instanceColor) {
            inst.getColorAt(i, col);
            tint = col.clone();
          }
          const mat = convert(src, tint);
          if (!mat) return;
          inst.getMatrixAt(i, tmp);
          if (tmp.determinant() === 0) continue;
          add(geo, mat, new THREE.Matrix4().multiplyMatrices(inst.matrixWorld, tmp));
          if (tris > MAX_TRIS) return;
        }
        return;
      }
      const mat = convert(src, null);
      if (!mat) return;
      const skinned = mesh as THREE.SkinnedMesh;
      const geo = skinned.isSkinnedMesh || mesh.morphTargetInfluences?.length ? bakePose(mesh, this.owned.geos) : traceableGeometry(mesh.geometry, this.owned.geos);
      add(geo, mat, mesh.matrixWorld);
    });
    if (tris > MAX_TRIS) {
      this.failed = `scène trop lourde (${Math.round(tris / 1000)} k triangles)`;
      this.setState({ etat: "indisponible", echantillons: 0, total: 0, raison: this.failed });
      return null;
    }
    this.applyEnvironment(out, m);
    return out;
  }

  /** Environnement équirectangulaire : reflets de la sorte choisie plus la part de lumière ambiante. */
  private applyEnvironment(out: THREE.Scene, m: PT) {
    const src = this.envSource?.() ?? { kind: "aucun", scene: null, intensity: 0 };
    if (src.scene) {
      const rt = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
      const cam = new THREE.CubeCamera(0.05, 100, rt);
      cam.position.set(0, 1, 0);
      cam.update(this.renderer, src.scene);
      src.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        (mesh.material as THREE.Material | undefined)?.dispose?.();
      });
      // CubeToEquirect lit les faces : la texture cube suffit au traceur, qui la convertit
      out.environment = rt.texture;
      out.environmentIntensity = src.intensity;
      this.owned.tex.push(rt.texture);
      this.ownedTargets.push(rt);
    } else {
      const g = new m.GradientEquirectTexture(32);
      g.topColor.set(0xffffff);
      g.bottomColor.set(0xd8d4cc);
      g.update();
      out.environment = g;
      out.environmentIntensity = src.intensity;
      this.owned.tex.push(g);
    }
  }
  private ownedTargets: THREE.WebGLRenderTarget[] = [];

  private disposeProxy() {
    if (!this.proxy && !this.owned.geos.length && !this.owned.mats.length) return;
    for (const g of this.owned.geos) g.dispose();
    for (const mt of this.owned.mats) mt.dispose();
    for (const t of this.owned.tex) t.dispose();
    for (const r of this.ownedTargets) r.dispose();
    this.owned = { geos: [], mats: [], tex: [] };
    this.ownedTargets = [];
    this.proxy = null;
  }

  private disposeTracer() {
    this.tracer?.dispose();
    this.tracer = null;
  }

  dispose() {
    this.paint?.dispose();
    this.painted?.dispose();
    this.denoise?.mat.dispose();
    this.copy?.mat.dispose();
    this.paint = null;
    this.painted = null;
    this.denoise = null;
    this.copy = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.spec = null;
    this.disposeProxy();
    this.disposeTracer();
  }
}

/* ------------------------------------------------------------------ utilitaires */

function fullscreen(mat: THREE.ShaderMaterial) {
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  // la matière du débruiteur projette avec projectionMatrix * modelViewMatrix : une caméra orthographique unité
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  cam.position.z = 0.5;
  cam.updateMatrixWorld();
  return { quad, scene, cam, mat };
}

/** Empreinte de la vue et du contenu visible : un changement relance l'attente. */
export function signature(scene: THREE.Scene, camera: THREE.Camera): number {
  camera.updateMatrixWorld();
  let h = 0;
  const mix = (v: number) => {
    h = (h * 31 + v * 1000.123) % 1e12;
  };
  for (const v of camera.matrixWorld.elements) mix(v);
  for (const v of camera.projectionMatrix.elements) mix(v);
  scene.traverseVisible((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh && !(o as THREE.Light).isLight) return;
    const e = o.matrixWorld.elements;
    mix(e[0] + e[5] * 3 + e[10] * 7 + e[12] * 11 + e[13] * 13 + e[14] * 17 + e[1] * 19 + e[8] * 23);
    if ((o as THREE.Light).isLight) {
      mix((o as THREE.Light).intensity);
      return;
    }
    mix(mesh.geometry?.id ?? 0);
    const mt = mesh.material as THREE.MeshStandardMaterial;
    if (mt && !Array.isArray(mt)) {
      if ((mt as unknown as THREE.ShaderMaterial).isShaderMaterial) return;
      mix((mt as unknown as { id: number }).id + mt.version);
      if (mt.color) mix(mt.color.r + mt.color.g * 2 + mt.color.b * 3);
      if (mt.emissive) mix(mt.emissive.r + mt.emissive.g + mt.emissive.b + (mt.emissiveIntensity ?? 0));
      mix(mt.opacity);
    }
    const inst = mesh as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      mix(inst.count);
      mix(inst.instanceMatrix.version);
      if (inst.instanceColor) mix(inst.instanceColor.version);
    }
  });
  return h;
}

/** Le traceur exige des normales et des uv ; on n'altère pas la géométrie partagée. */
function traceableGeometry(g: THREE.BufferGeometry, owned: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (g.getAttribute("normal") && g.getAttribute("uv")) return g;
  const c = g.clone();
  if (!c.getAttribute("normal")) c.computeVertexNormals();
  if (!c.getAttribute("uv")) c.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(c.getAttribute("position").count * 2), 2));
  owned.push(c);
  return c;
}

/** Pose courante d'un maillage animé (squelette, cibles de morphose) figée en géométrie statique. */
function bakePose(mesh: THREE.Mesh, owned: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const src = mesh.geometry;
  const pos = src.getAttribute("position");
  const out = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const sk = mesh as THREE.SkinnedMesh;
  if (sk.isSkinnedMesh) sk.skeleton?.update();
  for (let i = 0; i < pos.count; i++) {
    // SkinnedMesh.getVertexPosition applique morphoses et os
    mesh.getVertexPosition(i, v);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(out, 3));
  const uv = src.getAttribute("uv");
  g.setAttribute("uv", uv ? uv.clone() : new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
  const color = src.getAttribute("color");
  if (color) g.setAttribute("color", color.clone());
  if (src.index) g.setIndex(src.index.clone());
  g.computeVertexNormals();
  owned.push(g);
  return g;
}

/**
 * Matière comprise par le traceur (standard ou physique). Toon, Lambert, Phong deviennent standard ;
 * une matière « basic » (non éclairée) devient émissive. `tint` : couleur d'une copie instanciée.
 */
export function toTraceable(src: THREE.Material, tint: THREE.Color | null): THREE.Material | null {
  const s = src as THREE.MeshStandardMaterial;
  if ((s as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
    if (!tint) return src;
    const c = (s as THREE.MeshPhysicalMaterial).clone();
    c.color.multiply(tint);
    return c;
  }
  const any = src as THREE.MeshBasicMaterial & Partial<THREE.MeshToonMaterial>;
  if (!("color" in any) || !any.color) return null;
  const color = any.color.clone();
  if (tint) color.multiply(tint);
  if ((src as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
    return new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: color,
      emissiveMap: any.map ?? null,
      emissiveIntensity: 1,
      transparent: src.transparent,
      opacity: src.opacity,
      side: src.side,
    });
  }
  return new THREE.MeshStandardMaterial({
    color,
    map: any.map ?? null,
    emissive: any.emissive?.clone() ?? new THREE.Color(0),
    emissiveIntensity: any.emissiveIntensity ?? 1,
    roughness: 0.85,
    metalness: 0,
    transparent: src.transparent,
    opacity: src.opacity,
    side: src.side,
    vertexColors: (src as THREE.MeshToonMaterial).vertexColors,
  });
}
