import * as THREE from "three";

/**
 * Filtre « peinture » : tramage optionnel puis filtre de Kuwahara anisotrope (Kyprianidis et al., poids
 * polynomiaux). Les touches suivent les contours de l'image : le bruit d'un lancer de rayons à peu d'échantillons, ou
 * le grain d'un tramage, devient une matière de pinceau, les arêtes restent nettes.
 *
 * Passes : préparation (tone mapping si l'entrée est HDR, tramage ordonné) → tenseur de structure → lissage du
 * tenseur (deux passes) → Kuwahara anisotrope vers l'écran (ou une cible).
 */

export type PaintOptions = {
  /** Rayon des touches (px, 1 à 12 ; 0 : tramage seul). */
  radius: number;
  /** Netteté des secteurs (q, 4 à 16 ; haut = touches plus franches). */
  sharpness: number;
  /** Tramage avant le filtre : force (0 = aucun) et niveaux par couleur. */
  dither: number;
  levels: number;
  /** Entrée en lumière linéaire HDR (lancer de rayons, scène brute) : tone mapping dans la préparation. */
  hdr: boolean;
};

/** Tone mapping ACES de three (même courbe que le rendu direct), utilisable vers une cible intermédiaire. */
export const ACES_GLSL = /* glsl */ `
vec3 acesTone(vec3 color, float exposure) {
  const mat3 IN = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 OUT = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color *= exposure / 0.6;
  color = IN * color;
  vec3 a = color * (color + 0.0245786) - 0.000090537;
  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  color = OUT * (a / b);
  return clamp(color, 0.0, 1.0);
}
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const PREP = /* glsl */ `
${ACES_GLSL}
varying vec2 vUv;
uniform sampler2D tSrc;
uniform float hdr, exposure, dither, levels;
float bayer8(vec2 p) {
  ivec2 q = ivec2(mod(p, 8.0));
  int m[64] = int[64](0,32,8,40,2,34,10,42,48,16,56,24,50,18,58,26,12,44,4,36,14,46,6,38,60,28,52,20,62,30,54,22,
    3,35,11,43,1,33,9,41,51,19,59,27,49,17,57,25,15,47,7,39,13,45,5,37,63,31,55,23,61,29,53,21);
  return (float(m[q.y * 8 + q.x]) + 0.5) / 64.0;
}
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb;
  if (hdr > 0.5) c = acesTone(c, exposure);
  if (dither > 0.0) {
    float n = max(levels, 2.0) - 1.0;
    float t = bayer8(gl_FragCoord.xy) - 0.5;
    vec3 q = floor(c * n + 0.5 + t * dither) / n;
    c = mix(c, clamp(q, 0.0, 1.0), clamp(dither, 0.0, 1.0));
  }
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}
`;

const TENSOR = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 px;
void main() {
  vec3 a = texture2D(tSrc, vUv + px * vec2(-1.0, -1.0)).rgb, b = texture2D(tSrc, vUv + px * vec2(0.0, -1.0)).rgb, c = texture2D(tSrc, vUv + px * vec2(1.0, -1.0)).rgb;
  vec3 d = texture2D(tSrc, vUv + px * vec2(-1.0, 0.0)).rgb, f = texture2D(tSrc, vUv + px * vec2(1.0, 0.0)).rgb;
  vec3 g = texture2D(tSrc, vUv + px * vec2(-1.0, 1.0)).rgb, h = texture2D(tSrc, vUv + px * vec2(0.0, 1.0)).rgb, i = texture2D(tSrc, vUv + px * vec2(1.0, 1.0)).rgb;
  vec3 sx = (c + 2.0 * f + i - a - 2.0 * d - g) / 4.0;
  vec3 sy = (g + 2.0 * h + i - a - 2.0 * b - c) / 4.0;
  gl_FragColor = vec4(dot(sx, sx), dot(sy, sy), dot(sx, sy), 1.0);
}
`;

const BLUR = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 dir;
void main() {
  vec4 s = texture2D(tSrc, vUv) * 0.2270;
  s += (texture2D(tSrc, vUv + dir * 1.3846) + texture2D(tSrc, vUv - dir * 1.3846)) * 0.3162;
  s += (texture2D(tSrc, vUv + dir * 3.2308) + texture2D(tSrc, vUv - dir * 3.2308)) * 0.0703;
  gl_FragColor = s;
}
`;

const KUWAHARA = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform sampler2D tTensor;
uniform vec2 px;
uniform float radius, q;
const int N = 8;
void main() {
  vec3 t = texture2D(tTensor, vUv).xyz;
  float E = t.x, G = t.y, F = t.z;
  float lambda1 = 0.5 * (G + E + sqrt(max(0.0, (G - E) * (G - E) + 4.0 * F * F)));
  float lambda2 = 0.5 * (G + E - sqrt(max(0.0, (G - E) * (G - E) + 4.0 * F * F)));
  vec2 v = vec2(lambda1 - E, -F);
  vec2 dir = length(v) > 0.0 ? normalize(v) : vec2(0.0, 1.0);
  float phi = -atan(dir.y, dir.x);
  float A = (lambda1 + lambda2 > 0.0) ? (lambda1 - lambda2) / (lambda1 + lambda2) : 0.0;
  float alpha = 1.0;
  float a = radius * clamp((alpha + A) / alpha, 0.1, 2.0);
  float b = radius * clamp(alpha / (alpha + A), 0.1, 2.0);
  float cp = cos(phi), sp = sin(phi);
  mat2 R = mat2(cp, -sp, sp, cp);
  mat2 S = mat2(0.5 / a, 0.0, 0.0, 0.5 / b);
  mat2 SR = S * R;
  int maxX = int(sqrt(a * a * cp * cp + b * b * sp * sp));
  int maxY = int(sqrt(a * a * sp * sp + b * b * cp * cp));
  float zeta = 2.0 / radius;
  float zeroCross = 0.58;
  float sinZero = sin(zeroCross), eta = (zeta + cos(zeroCross)) / (sinZero * sinZero);
  vec4 m[N];
  vec3 s[N];
  for (int k = 0; k < N; ++k) { m[k] = vec4(0.0); s[k] = vec3(0.0); }
  for (int y = -maxY; y <= maxY; ++y) {
    for (int x = -maxX; x <= maxX; ++x) {
      vec2 vv = SR * vec2(float(x), float(y));
      if (dot(vv, vv) <= 0.25) {
        vec3 c = texture2D(tSrc, vUv + vec2(float(x), float(y)) * px).rgb;
        float sum = 0.0;
        float w[8];
        float z, vxx, vyy;
        vxx = zeta - eta * vv.x * vv.x; vyy = zeta - eta * vv.y * vv.y;
        z = max(0.0, vv.y + vxx); w[0] = z * z; sum += w[0];
        z = max(0.0, -vv.x + vyy); w[2] = z * z; sum += w[2];
        z = max(0.0, -vv.y + vxx); w[4] = z * z; sum += w[4];
        z = max(0.0, vv.x + vyy); w[6] = z * z; sum += w[6];
        vv = sqrt(2.0) / 2.0 * vec2(vv.x - vv.y, vv.x + vv.y);
        vxx = zeta - eta * vv.x * vv.x; vyy = zeta - eta * vv.y * vv.y;
        z = max(0.0, vv.y + vxx); w[1] = z * z; sum += w[1];
        z = max(0.0, -vv.x + vyy); w[3] = z * z; sum += w[3];
        z = max(0.0, -vv.y + vxx); w[5] = z * z; sum += w[5];
        z = max(0.0, vv.x + vyy); w[7] = z * z; sum += w[7];
        float g = exp(-3.125 * dot(vv, vv)) / max(sum, 1e-6);
        for (int k = 0; k < 8; ++k) {
          float wk = w[k] * g;
          m[k] += vec4(c * wk, wk);
          s[k] += c * c * wk;
        }
      }
    }
  }
  vec4 outc = vec4(0.0);
  for (int k = 0; k < N; ++k) {
    m[k].rgb /= max(m[k].w, 1e-6);
    s[k] = abs(s[k] / max(m[k].w, 1e-6) - m[k].rgb * m[k].rgb);
    float sigma2 = s[k].r + s[k].g + s[k].b;
    // poids très petits aux arêtes franches : jamais de garde qui assombrisse (division exacte)
    float wk = 1.0 / (1.0 + pow(min(1000.0 * sigma2, 1e4), 0.5 * q));
    outc += vec4(m[k].rgb * wk, wk);
  }
  vec3 res = outc.w > 1e-30 ? outc.rgb / outc.w : texture2D(tSrc, vUv).rgb;
  gl_FragColor = vec4(clamp(res, 0.0, 1.0), 1.0);
  #include <colorspace_fragment>
}
`;

export class PaintFilter {
  private prep: THREE.WebGLRenderTarget;
  private tensor: THREE.WebGLRenderTarget;
  private tmp: THREE.WebGLRenderTarget;
  private mats: Record<"prep" | "tensor" | "blur" | "kuwa", THREE.ShaderMaterial>;
  private quad: THREE.Mesh;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private w = 1;
  private h = 1;

  constructor() {
    const rt = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.prep = rt();
    this.tensor = rt();
    this.tmp = rt();
    const mat = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false });
    this.mats = {
      prep: mat(PREP, { tSrc: { value: null }, hdr: { value: 0 }, exposure: { value: 1 }, dither: { value: 0 }, levels: { value: 6 } }),
      tensor: mat(TENSOR, { tSrc: { value: null }, px: { value: new THREE.Vector2() } }),
      blur: mat(BLUR, { tSrc: { value: null }, dir: { value: new THREE.Vector2() } }),
      kuwa: mat(KUWAHARA, { tSrc: { value: null }, tTensor: { value: null }, px: { value: new THREE.Vector2() }, radius: { value: 6 }, q: { value: 8 } }),
    };
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mats.prep);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  private pass(renderer: THREE.WebGLRenderer, m: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = m;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.cam);
  }

  /** Filtre `src` vers `target` (null : l'écran). Taille de calcul : celle de `target`, sinon celle du dessin du rendu. */
  render(renderer: THREE.WebGLRenderer, src: THREE.Texture, o: PaintOptions, target: THREE.WebGLRenderTarget | null = null) {
    const size = target ? new THREE.Vector2(target.width, target.height) : renderer.getDrawingBufferSize(new THREE.Vector2());
    if (size.x !== this.w || size.y !== this.h) {
      this.w = Math.max(1, size.x);
      this.h = Math.max(1, size.y);
      for (const t of [this.prep, this.tensor, this.tmp]) t.setSize(this.w, this.h);
    }
    const prev = renderer.getRenderTarget();
    const px = new THREE.Vector2(1 / this.w, 1 / this.h);
    const m = this.mats;
    m.prep.uniforms.tSrc.value = src;
    m.prep.uniforms.hdr.value = o.hdr ? 1 : 0;
    m.prep.uniforms.exposure.value = renderer.toneMappingExposure;
    m.prep.uniforms.dither.value = o.dither;
    m.prep.uniforms.levels.value = o.levels;
    // sans touches (rayon 0) : tramage seul, droit vers la sortie
    if (o.radius <= 0) {
      this.pass(renderer, m.prep, target);
      renderer.setRenderTarget(prev);
      return;
    }
    this.pass(renderer, m.prep, this.prep);
    m.tensor.uniforms.tSrc.value = this.prep.texture;
    (m.tensor.uniforms.px.value as THREE.Vector2).copy(px);
    this.pass(renderer, m.tensor, this.tensor);
    m.blur.uniforms.tSrc.value = this.tensor.texture;
    (m.blur.uniforms.dir.value as THREE.Vector2).set(px.x * 1.5, 0);
    this.pass(renderer, m.blur, this.tmp);
    m.blur.uniforms.tSrc.value = this.tmp.texture;
    (m.blur.uniforms.dir.value as THREE.Vector2).set(0, px.y * 1.5);
    this.pass(renderer, m.blur, this.tensor);
    m.kuwa.uniforms.tSrc.value = this.prep.texture;
    m.kuwa.uniforms.tTensor.value = this.tensor.texture;
    (m.kuwa.uniforms.px.value as THREE.Vector2).copy(px);
    m.kuwa.uniforms.radius.value = Math.max(1, Math.min(12, o.radius));
    m.kuwa.uniforms.q.value = Math.max(2, Math.min(16, o.sharpness));
    this.pass(renderer, m.kuwa, target);
    renderer.setRenderTarget(prev);
  }

  dispose() {
    for (const t of [this.prep, this.tensor, this.tmp]) t.dispose();
    for (const m of Object.values(this.mats)) m.dispose();
    this.quad.geometry.dispose();
  }
}
