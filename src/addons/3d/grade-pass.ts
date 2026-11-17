import * as THREE from "three";
import type { Grade } from "../../shared/monde/ambiance";

/**
 * Étalonnage de l'image du monde (ambiances) : la scène est rendue dans une cible HDR avec sa profondeur, puis une
 * passe plein écran applique, après le tone mapping : pixels, contours (ruptures de profondeur), silhouettes
 * (aplats sombres éclaircis par la distance), halo (seuil + flou à quart de résolution), aberration, couleurs
 * (saturation, contraste, luminosité, teinte, noir et blanc, sépia, niveaux), lignes, grain et vignette.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
#include <common>
#include <packing>
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tBloom;
uniform vec2 res;
uniform float near, far, ortho, time;
uniform float saturation, contrast, brightness, bw, sepia, grain, vignette, pixel, posterize;
uniform float silhouette, outline, bloom, aberration, scanlines, haze;
uniform vec3 tint, outlineColor, sky;

float linDepth(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  if (ortho > 0.5) return near + d * (far - near);
  return perspectiveDepthToViewZ(d, near, far) * -1.0;
}
float rawDepth(vec2 uv) { return texture2D(tDepth, uv).x; }
float rand2(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  if (pixel > 1.0) {
    vec2 cell = pixel / res;
    uv = (floor(uv / cell) + 0.5) * cell;
  }
  vec3 hdr;
  if (aberration > 0.0) {
    vec2 dir = (uv - 0.5) * aberration * 0.012;
    hdr = vec3(texture2D(tColor, uv + dir).r, texture2D(tColor, uv).g, texture2D(tColor, uv - dir).b);
  } else hdr = texture2D(tColor, uv).rgb;
  if (bloom > 0.0) hdr += texture2D(tBloom, uv).rgb * bloom;

  float dRaw = rawDepth(uv);
  bool geo = dRaw < 0.99999;
  if (silhouette > 0.0) {
    // aplats : sombres de près, fondus vers le ciel au loin ; le ciel garde sa lumière
    vec3 skyLin = sky;
    if (geo) {
      float z = linDepth(uv);
      float h = 1.0 - exp(-z * haze);
      vec3 sil = mix(vec3(0.006), skyLin * 0.8, clamp(h * h * 1.6, 0.0, 0.9));
      hdr = mix(hdr, sil, silhouette);
    } else {
      float glow = 1.0 - length(vUv - vec2(0.5, 0.62)) * 0.9;
      hdr = mix(hdr, skyLin * (0.75 + 0.45 * glow), silhouette);
    }
  }

  gl_FragColor = vec4(hdr, 1.0);
  #include <tonemapping_fragment>
  vec3 c = gl_FragColor.rgb;

  if (outline > 0.0) {
    vec2 px = max(pixel, 1.0) / res;
    float z = linDepth(uv);
    float e = 0.0;
    float zr = linDepth(uv + vec2(px.x, 0.0)), zl = linDepth(uv - vec2(px.x, 0.0));
    float zu = linDepth(uv + vec2(0.0, px.y)), zd = linDepth(uv - vec2(0.0, px.y));
    float m = min(min(zr, zl), min(zu, zd));
    if (geo || m < far * 0.99) e = clamp((max(max(zr, zl), max(zu, zd)) - m) / max(m, 0.05) * 6.0 - 0.25, 0.0, 1.0);
    c = mix(c, outlineColor, e * outline);
  }

  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, saturation);
  c = mix(c, vec3(l), bw);
  vec3 sep = vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131)));
  c = mix(c, sep, sepia);
  c *= tint;
  c *= brightness;
  c = (c - 0.5) * contrast + 0.5;
  if (posterize > 1.0) c = floor(c * posterize + 0.5) / posterize;
  if (scanlines > 0.0) c *= 1.0 - scanlines * 0.35 * (0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159));
  if (vignette > 0.0) {
    float v = smoothstep(0.85, 0.2, length(vUv - 0.5) * 1.25);
    c *= mix(1.0, v, vignette);
  }
  if (grain > 0.0) c += (rand2(gl_FragCoord.xy + fract(time) * 117.0) - 0.5) * grain * 0.35;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  #include <colorspace_fragment>
}
`;

const BLUR = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 dir;
uniform float threshold;
uniform float first;
vec3 pick(vec2 uv) {
  vec3 c = texture2D(tSrc, uv).rgb;
  if (first > 0.5) { float l = max(c.r, max(c.g, c.b)); c *= smoothstep(threshold, threshold + 0.35, l); }
  return c;
}
void main() {
  vec3 s = pick(vUv) * 0.227;
  s += (pick(vUv + dir * 1.385) + pick(vUv - dir * 1.385)) * 0.316;
  s += (pick(vUv + dir * 3.231) + pick(vUv - dir * 3.231)) * 0.070;
  gl_FragColor = vec4(s, 1.0);
}
`;

export class GradePass {
  private target: THREE.WebGLRenderTarget;
  private bloomA: THREE.WebGLRenderTarget;
  private bloomB: THREE.WebGLRenderTarget;
  private mat: THREE.ShaderMaterial;
  private blur: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private grade: Grade | null = null;
  private w = 1;
  private h = 1;

  constructor() {
    const depth = new THREE.DepthTexture(1, 1);
    depth.type = THREE.UnsignedIntType;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthTexture: depth, samples: 4 });
    this.bloomA = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.bloomB = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: depth },
        tBloom: { value: this.bloomA.texture },
        res: { value: new THREE.Vector2(1, 1) },
        near: { value: 0.1 },
        far: { value: 100 },
        ortho: { value: 0 },
        time: { value: 0 },
        saturation: { value: 1 },
        contrast: { value: 1 },
        brightness: { value: 1 },
        bw: { value: 0 },
        sepia: { value: 0 },
        grain: { value: 0 },
        vignette: { value: 0 },
        pixel: { value: 0 },
        posterize: { value: 0 },
        silhouette: { value: 0 },
        outline: { value: 0 },
        bloom: { value: 0 },
        aberration: { value: 0 },
        scanlines: { value: 0 },
        haze: { value: 0.05 },
        tint: { value: new THREE.Color(1, 1, 1) },
        outlineColor: { value: new THREE.Color(0, 0, 0) },
        sky: { value: new THREE.Color(1, 1, 1) },
      },
    });
    this.blur = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BLUR,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      uniforms: { tSrc: { value: null }, dir: { value: new THREE.Vector2() }, threshold: { value: 0.75 }, first: { value: 0 } },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  get enabled() {
    return this.grade !== null;
  }

  set(grade: Grade | null, sky: string, brume: number) {
    this.grade = grade;
    if (!grade) return;
    const u = this.mat.uniforms;
    u.saturation.value = grade.saturation;
    u.contrast.value = grade.contrast;
    u.brightness.value = grade.brightness;
    u.bw.value = grade.bw;
    u.sepia.value = grade.sepia;
    u.grain.value = grade.grain;
    u.vignette.value = grade.vignette;
    u.pixel.value = grade.pixel;
    u.posterize.value = grade.posterize;
    u.silhouette.value = grade.silhouette;
    u.outline.value = grade.outline;
    u.bloom.value = grade.bloom;
    u.aberration.value = grade.aberration;
    u.scanlines.value = grade.scanlines;
    (u.tint.value as THREE.Color).set(grade.tint || "#ffffff");
    (u.outlineColor.value as THREE.Color).set(grade.outlineColor).convertSRGBToLinear();
    (u.sky.value as THREE.Color).set(sky || "#d9d7cf");
    u.haze.value = 0.004 + brume * 0.02;
    this.blur.uniforms.threshold.value = grade.bloomThreshold;
  }

  setSize(w: number, h: number) {
    this.w = Math.max(1, Math.floor(w));
    this.h = Math.max(1, Math.floor(h));
    this.target.setSize(this.w, this.h);
    const bw = Math.max(1, Math.floor(this.w / 4)), bh = Math.max(1, Math.floor(this.h / 4));
    this.bloomA.setSize(bw, bh);
    this.bloomB.setSize(bw, bh);
    (this.mat.uniforms.res.value as THREE.Vector2).set(this.w, this.h);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, time: number) {
    const g = this.grade!;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (size.x !== this.w || size.y !== this.h) this.setSize(size.x, size.y);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    if (g.bloom > 0) {
      const b = this.blur.uniforms;
      this.quad.material = this.blur;
      const step = (src: THREE.Texture, dst: THREE.WebGLRenderTarget, dx: number, dy: number, first: number) => {
        b.tSrc.value = src;
        (b.dir.value as THREE.Vector2).set(dx / dst.width, dy / dst.height);
        b.first.value = first;
        renderer.setRenderTarget(dst);
        renderer.render(this.scene, this.cam);
      };
      step(this.target.texture, this.bloomA, 1.5, 0, 1);
      step(this.bloomA.texture, this.bloomB, 0, 1.5, 0);
      step(this.bloomB.texture, this.bloomA, 2.5, 0, 0);
      step(this.bloomA.texture, this.bloomB, 0, 2.5, 0);
      step(this.bloomB.texture, this.bloomA, 0, 0, 0);
      this.quad.material = this.mat;
    }
    const u = this.mat.uniforms;
    const cam = camera as THREE.PerspectiveCamera & THREE.OrthographicCamera;
    u.near.value = cam.near ?? 0.1;
    u.far.value = cam.far ?? 100;
    u.ortho.value = cam.isOrthographicCamera ? 1 : 0;
    u.time.value = time;
    renderer.setRenderTarget(prev);
    renderer.render(this.scene, this.cam);
  }

  dispose() {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.bloomA.dispose();
    this.bloomB.dispose();
    this.mat.dispose();
    this.blur.dispose();
    this.quad.geometry.dispose();
  }
}
