/**
 * Exécution three.js de la pile de post-traitement (`post.ts`, `postglsl.ts`).
 *
 * Chaîne ping-pong : l'image de base (ciel, contours, papier, grain, vignette du style, déjà en sRGB) est rendue dans
 * une cible, puis chaque passe lit la précédente ; la dernière écrit à l'écran. Cibles réutilisées d'une image à
 * l'autre (réallouées seulement quand la taille change). Passes annexes : tenseur de structure lissé (Kuwahara
 * anisotrope) et image floutée au quart de la résolution (bloom, halo, miniature). Shaders mis en cache par suite
 * d'effets : changer un réglage ne touche que des uniformes, changer la liste compose (ou retrouve) les shaders.
 */
import * as THREE from "three";
import { type PlanPass, type PostFx, POST_FX, packFx, planPasses, postAnimated } from "./post";
import { AUX_BLUR, AUX_EXTRACT, AUX_TENSOR, COPY, POST_STACK_VERTEX, passFragment } from "./postglsl";

type Frame = {
  /** Texture de l'image de base (sRGB). */
  base: THREE.Texture;
  /** Normales, profondeur, identifiant. */
  data: THREE.Texture;
  /** Taille de la cible de sortie (px de l'appareil) et de l'écran (px CSS). */
  w: number;
  h: number;
  cssW: number;
  cssH: number;
  time: number;
  /** far / distance du point visé : profondeur relative (1 = point visé). */
  depthK: number;
  /** Écran → cible des données (marge du rendu pixel accroché) ; origine des grilles (px CSS). */
  dataXf: [number, number, number, number];
  grid: [number, number];
};

const MAX_CACHE = 24;

export class PostStack {
  private list: PostFx[] = [];
  private plan: PlanPass[] = [];
  private packed: { F: THREE.Vector4[]; M: THREE.Vector4[] }[] = [];
  private cache = new Map<string, THREE.ShaderMaterial>();
  private targets = new Map<string, THREE.WebGLRenderTarget>();
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private aux: Record<"tensor" | "blur" | "extract" | "copy", THREE.ShaderMaterial>;
  private low = false;
  /** Shader refusé par le pilote : la pile est désactivée (image de base seule). */
  failed = false;
  error = "";

  constructor(private renderer: THREE.WebGLRenderer) {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    const mk = (fs: string, uniforms: Record<string, THREE.IUniform>) => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: POST_STACK_VERTEX, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
    this.aux = {
      tensor: mk(AUX_TENSOR, { tSrc: { value: null }, uStep: { value: new THREE.Vector2() } }),
      blur: mk(AUX_BLUR, { tSrc: { value: null }, uStep: { value: new THREE.Vector2() }, uSigma: { value: 1 } }),
      extract: mk(AUX_EXTRACT, { tSrc: { value: null }, uStep: { value: new THREE.Vector2() }, uThreshold: { value: 0 } }),
      copy: mk(COPY, { tSrc: { value: null } }),
    };
  }

  get active(): boolean {
    return this.plan.length > 0 && !this.failed;
  }
  get animated(): boolean {
    return this.active && postAnimated(this.list);
  }
  /** Nombre de passes plein écran (hors annexes), pour les mesures. */
  get passes(): number {
    return this.plan.length;
  }

  /** Nouvelle pile (déjà validée) ; `low` : passes lourdes à demi-résolution. */
  set(list: PostFx[], low: boolean) {
    const sig = (l: PostFx[]) => l.map((f) => f.fx).join(",");
    const same = sig(list) === sig(this.list) && low === this.low;
    this.list = list;
    this.low = low;
    if (!same) {
      this.plan = planPasses(list, low);
      this.failed = false;
      // shaders inutilisés retirés du cache au-delà de MAX_CACHE
      const keep = new Set(this.plan.map((p) => p.key));
      for (const [k, m] of this.cache) if (this.cache.size > MAX_CACHE && !keep.has(k)) (m.dispose(), this.cache.delete(k));
    }
    this.packed = list.map((f) => {
      const { F, M } = packFx(f);
      const v4 = (a: number[]) => Array.from({ length: a.length / 4 }, (_, i) => new THREE.Vector4(a[i * 4], a[i * 4 + 1], a[i * 4 + 2], a[i * 4 + 3]));
      return { F: v4(F), M: v4(M) };
    });
    if (!list.length) this.releaseTargets();
  }

  private material(p: PlanPass): THREE.ShaderMaterial {
    let m = this.cache.get(p.key);
    if (m) {
      // en tête du cache (le plus récent)
      this.cache.delete(p.key);
      this.cache.set(p.key, m);
      return m;
    }
    const uniforms: Record<string, THREE.IUniform> = {
      tIn: { value: null }, tData: { value: null }, uTexel: { value: new THREE.Vector2() }, uCss: { value: new THREE.Vector2() }, uPx: { value: 1 }, uTime: { value: 0 }, uDepthK: { value: 1 },
      uGrid: { value: new THREE.Vector2() }, uDataXf: { value: new THREE.Vector4(1, 1, 0, 0) },
    };
    p.stages.forEach((s, k) => {
      uniforms[`uF${k}`] = { value: Array.from({ length: POST_FX[s.fx].slots }, () => new THREE.Vector4()) };
      uniforms[`uM${k}`] = { value: [new THREE.Vector4(), new THREE.Vector4()] };
    });
    if (p.aux) uniforms.tAux = { value: null };
    m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: POST_STACK_VERTEX, fragmentShader: passFragment(p), uniforms, depthTest: false, depthWrite: false });
    this.cache.set(p.key, m);
    return m;
  }

  /** Cible réutilisée (réallouée si la taille change). */
  target(name: string, w: number, h: number, half = false): THREE.WebGLRenderTarget {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    let t = this.targets.get(name);
    if (t && (t.width !== w || t.height !== h)) {
      t.dispose();
      t = undefined;
    }
    if (!t) {
      t = new THREE.WebGLRenderTarget(w, h, { type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
      this.targets.set(name, t);
    }
    return t;
  }

  private draw(m: THREE.Material, to: THREE.WebGLRenderTarget | null) {
    this.quad.material = m;
    this.renderer.setRenderTarget(to);
    this.renderer.render(this.scene, this.cam);
    if (!m.userData.checked) {
      // shader refusé (pilote) : pile désactivée plutôt qu'un écran noir
      m.userData.checked = true;
      const prog = (this.renderer.properties.get(m) as { currentProgram?: { diagnostics?: { runnable: boolean; fragmentShader?: { log: string } } } }).currentProgram;
      if (prog?.diagnostics && !prog.diagnostics.runnable) {
        this.failed = true;
        this.error = prog.diagnostics.fragmentShader?.log ?? "shader refusé";
      }
    }
  }

  private runAux(p: PlanPass, src: THREE.WebGLRenderTarget | THREE.Texture, f: Frame): THREE.Texture {
    const tex = (src as THREE.WebGLRenderTarget).isRenderTarget ? (src as THREE.WebGLRenderTarget).texture : (src as THREE.Texture);
    const sw = (tex.image as { width: number }).width, sh = (tex.image as { height: number }).height;
    const fx = this.list[p.aux!.index];
    const def = POST_FX[fx.fx];
    const ap = def.auxPack?.(fx.params) ?? { threshold: 0, radius: 1 };
    const A = this.aux;
    if (p.aux!.kind === "tensor") {
      // tenseur à la résolution de la passe, lissé d'un σ ≈ rayon / 3 (en texels de cette résolution)
      const w = f.w * p.scale, h = f.h * p.scale;
      const t0 = this.target("tensor0", w, h, true), t1 = this.target("tensor1", w, h, true);
      A.tensor.uniforms.tSrc.value = tex;
      (A.tensor.uniforms.uStep.value as THREE.Vector2).set(1 / sw, 1 / sh);
      this.draw(A.tensor, t0);
      const sigma = Math.max(1, (ap.radius * (w / f.cssW)) / 3);
      A.blur.uniforms.uSigma.value = sigma;
      A.blur.uniforms.tSrc.value = t0.texture;
      (A.blur.uniforms.uStep.value as THREE.Vector2).set(1 / t0.width, 0);
      this.draw(A.blur, t1);
      A.blur.uniforms.tSrc.value = t1.texture;
      (A.blur.uniforms.uStep.value as THREE.Vector2).set(0, 1 / t1.height);
      this.draw(A.blur, t0);
      return t0.texture;
    }
    // image floutée au quart : réduction + seuil, puis flou séparable (σ en fraction du petit côté)
    const w = f.w / 4, h = f.h / 4;
    const q0 = this.target("blur0", w, h), q1 = this.target("blur1", w, h);
    A.extract.uniforms.tSrc.value = tex;
    (A.extract.uniforms.uStep.value as THREE.Vector2).set(1 / sw, 1 / sh);
    A.extract.uniforms.uThreshold.value = ap.threshold;
    this.draw(A.extract, q0);
    A.blur.uniforms.uSigma.value = Math.max(0.6, ap.radius * Math.min(q0.width, q0.height));
    A.blur.uniforms.tSrc.value = q0.texture;
    (A.blur.uniforms.uStep.value as THREE.Vector2).set(1 / q0.width, 0);
    this.draw(A.blur, q1);
    A.blur.uniforms.tSrc.value = q1.texture;
    (A.blur.uniforms.uStep.value as THREE.Vector2).set(0, 1 / q1.height);
    this.draw(A.blur, q0);
    return q0.texture;
  }

  /** Rend la pile depuis l'image de base jusqu'à l'écran (cible `null`). */
  render(f: Frame) {
    let src: THREE.Texture = f.base;
    let sw = f.w, sh = f.h;
    this.plan.forEach((p, i) => {
      const last = i === this.plan.length - 1;
      const auxTex = p.aux ? this.runAux(p, src, f) : null;
      const m = this.material(p);
      const u = m.uniforms;
      u.tIn.value = src;
      u.tData.value = f.data;
      (u.uTexel.value as THREE.Vector2).set(1 / sw, 1 / sh);
      (u.uCss.value as THREE.Vector2).set(f.cssW, f.cssH);
      u.uPx.value = sw / f.cssW;
      u.uTime.value = f.time;
      u.uDepthK.value = f.depthK;
      (u.uGrid.value as THREE.Vector2).set(f.grid[0], f.grid[1]);
      (u.uDataXf.value as THREE.Vector4).set(...f.dataXf);
      if (auxTex) u.tAux.value = auxTex;
      p.stages.forEach((s, k) => {
        const pk = this.packed[s.index];
        (u[`uF${k}`].value as THREE.Vector4[]).forEach((v, j) => v.copy(pk.F[j]));
        (u[`uM${k}`].value as THREE.Vector4[]).forEach((v, j) => v.copy(pk.M[j]));
      });
      const ow = f.w * p.scale, oh = f.h * p.scale;
      const to = last && p.scale === 1 ? null : this.target(`pp${i % 2}@${p.scale}`, ow, oh);
      this.draw(m, to);
      if (to) {
        src = to.texture;
        sw = to.width;
        sh = to.height;
      }
      if (last && to) {
        this.aux.copy.uniforms.tSrc.value = src;
        this.draw(this.aux.copy, null);
      }
    });
  }

  private releaseTargets() {
    for (const t of this.targets.values()) t.dispose();
    this.targets.clear();
  }

  dispose() {
    this.releaseTargets();
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
    for (const m of Object.values(this.aux)) m.dispose();
    this.quad.geometry.dispose();
  }
}
