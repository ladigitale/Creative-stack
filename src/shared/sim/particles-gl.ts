/**
 * Dessin three.js d'un système de particules (`ParticleSystem`) : un appel de dessin par système, quads instanciés face
 * caméra. Partagé par le format monde de `sonic-3d` et par `sonic-procgen`.
 *
 * Le mouvement est calculé dans le vertex shader (forme close : `positionAt` de shared/sim/particles) ; le processeur
 * n'envoie que les plages du tampon circulaire écrites depuis l'image précédente. Pas de tri : fusion additive pour
 * le feu et la lumière, transparence sans écriture de profondeur pour la fumée.
 *
 * Variante `mrt` (rendu à deux cibles de procgen : couleur + normales/profondeur/id) : GLSL3, couleur
 * prémultipliée (fusion `ONE, ONE_MINUS_SRC_ALPHA` ou `ONE, ONE`), et zéro écrit dans la seconde cible, ce qui la
 * laisse intacte avec ces fusions (contours, masques et brume du post-traitement ignorent les grains).
 */
import * as THREE from "three";
import { accelOf, rgbOf, type ParticleSystem, type V3 } from "./particles";

export const PARTICLE_SPRITES = { disque: 0, flocon: 1, goutte: 2, eclat: 3, trait: 4, volute: 5 } as const;

const VERT = /* glsl */ `
attribute vec3 aP0;
attribute vec3 aV0;
attribute vec4 aT;
attribute float aTint;
uniform float uNow;
uniform vec3 uAcc;
uniform float uDrag;
uniform float uTurb;
uniform vec2 uSize;
uniform vec3 uColors[4];
uniform float uN;
uniform vec2 uOpacity;
uniform vec2 uFade;
uniform float uStretch;
uniform float uSpin;
uniform float uFloor;
uniform float uFloorY;
uniform float uSizeK;
uniform float uMinPx;
uniform float uViewH;
varying vec2 vUv;
varying vec4 vCol;
varying float vSeed;

vec3 posAt(float t) {
  float f, g;
  if (uDrag > 1e-4) { f = (1.0 - exp(-uDrag * t)) / uDrag; g = (t - f) / uDrag; }
  else { f = t; g = 0.5 * t * t; }
  float sd = aT.z * 6.2831853;
  float tu = uTurb * t;
  vec3 p = aP0 + aV0 * f + uAcc * g + vec3(sin(t * 1.7 + sd) * tu * 0.35, sin(t * 2.3 + sd * 1.3) * tu * 0.2, cos(t * 1.9 + sd * 0.7) * tu * 0.35);
  if (uFloor > 0.5) p.y = max(p.y, uFloorY);
  return p;
}

vec3 ramp(float k) {
  if (uN < 1.5) return uColors[0];
  float x = clamp(k, 0.0, 0.9999) * (uN - 1.0);
  float i = floor(x);
  float f = x - i;
  vec3 a = i < 0.5 ? uColors[0] : i < 1.5 ? uColors[1] : uColors[2];
  vec3 b = i < 0.5 ? uColors[1] : i < 1.5 ? uColors[2] : uColors[3];
  return mix(a, b, f);
}

void main() {
  float t = uNow - aT.x;
  float life = aT.y;
  vUv = position.xy + 0.5;
  vSeed = aT.z;
  if (t < 0.0 || t > life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vCol = vec4(0.0); return; }
  float k = t / life;
  vec3 p = posAt(t);
  float size = max(1e-4, mix(uSize.x, uSize.y, k) * aT.w * uSizeK);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  // taille minimale à l'écran (pluie, flocons vus de loin) : élargi, et plus transparent d'autant
  float fade = 1.0;
  if (uMinPx > 0.0) {
    float ppm = projectionMatrix[1][1] * uViewH * 0.5 / (projectionMatrix[3][3] > 0.5 ? 1.0 : max(0.01, -mv.z));
    float minS = uMinPx / max(1e-4, ppm);
    if (size < minS) { fade = mix(1.0, size / minS, 0.45); size = minS; }
  }
  vec2 c = position.xy;
  float ang = uSpin * t * 6.2831853 + aT.z * 6.2831853;
  c = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * c;
  if (uStretch > 0.0) {
    // vitesse à l'âge t (dérivée de la forme close, turbulence négligée), dans le repère de la vue
    vec3 vel = uDrag > 1e-4 ? aV0 * exp(-uDrag * t) + uAcc * (1.0 - exp(-uDrag * t)) / uDrag : aV0 + uAcc * t;
    vec2 d = (modelViewMatrix * vec4(vel, 0.0)).xy;
    float sp = length(d);
    if (sp > 1e-4) {
      vec2 dir = d / sp;
      // repère direct (nrm, dir) : un repère inversé retournait le quad, éliminé comme face arrière
      vec2 nrm = vec2(dir.y, -dir.x);
      c = dir * position.y * (1.0 + sp * uStretch / size) + nrm * position.x;
    }
  }
  mv.xy += c * size;
  gl_Position = projectionMatrix * mv;
  vec3 col = ramp(k);
  if (aTint > 0.5) {
    float n = aTint - 1.0;
    vec3 tint = vec3(floor(n / 65536.0), mod(floor(n / 256.0), 256.0), mod(n, 256.0)) / 255.0;
    col = mix(col, tint, 0.75);
  }
  // fondus d'entrée et de sortie (fraction de la vie) : un grain de fumée ou de brume ne surgit pas plein
  float env = 1.0;
  if (uFade.x > 0.0) env *= smoothstep(0.0, uFade.x, k);
  if (uFade.y > 0.0) env *= 1.0 - smoothstep(1.0 - uFade.y, 1.0, k);
  vCol = vec4(col, mix(uOpacity.x, uOpacity.y, k) * fade * env);
}
`;

const FRAG = /* glsl */ `
uniform float uSprite;
uniform float uHard;
uniform float uOpacityK;
varying vec2 vUv;
varying vec4 vCol;
varying float vSeed;
void main() {
  vec2 q = vUv * 2.0 - 1.0;
  float d = length(q);
  float a;
  if (uSprite < 0.5) a = 1.0 - smoothstep(mix(0.45, 0.9, uHard), 1.0, d);
  else if (uSprite < 1.5) {
    float an = atan(q.y, q.x);
    float r = 0.55 + 0.4 * abs(cos(3.0 * an));
    a = 1.0 - smoothstep(r - 0.12, r, d);
  } else if (uSprite < 2.5) {
    vec2 e = vec2(q.x * 1.6, q.y + 0.25 * (1.0 - q.y * q.y));
    a = 1.0 - smoothstep(0.75, 0.95, length(e));
  } else if (uSprite < 3.5) {
    a = step(abs(q.x) + abs(q.y) * 0.6, 0.9);
  } else if (uSprite < 4.5) {
    a = 1.0 - smoothstep(0.5, 1.0, length(vec2(q.x * 2.0, q.y)));
  } else {
    float w = 0.75 + 0.25 * sin(atan(q.y, q.x) * 3.0 + vSeed * 20.0);
    a = pow(max(0.0, 1.0 - d / w), 1.6);
  }
  a *= vCol.a * uOpacityK;
  if (a < 0.01) discard;
  OUTPUT
}
`;

const OUT_PLAIN = "gl_FragColor = vec4(vCol.rgb, a);";
const OUT_MRT = "outColor = uAdd > 0.5 ? vec4(vCol.rgb * a, 0.0) : vec4(vCol.rgb * a, a);\n  outData = vec4(0.0);";

/** Shaders GLSL1 (rendu à une cible) ou GLSL3 à deux sorties (`mrt`). */
export function particleShaders(mrt: boolean): { vertexShader: string; fragmentShader: string } {
  if (!mrt) return { vertexShader: VERT, fragmentShader: FRAG.replace("OUTPUT", OUT_PLAIN) };
  const vertexShader = VERT.replace(/^attribute /gm, "in ").replace(/^varying /gm, "out ");
  const fragmentShader =
    "precision highp float;\nlayout(location = 0) out vec4 outColor;\nlayout(location = 1) out vec4 outData;\nuniform float uAdd;\n" + FRAG.replace(/^varying /gm, "in ").replace("OUTPUT", OUT_MRT);
  return { vertexShader, fragmentShader };
}

export type ParticleMesh = {
  sys: ParticleSystem;
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  mat: THREE.ShaderMaterial;
  attrs: { p0: THREE.InstancedBufferAttribute; v0: THREE.InstancedBufferAttribute; t: THREE.InstancedBufferAttribute; tint: THREE.InstancedBufferAttribute };
  tbuf: Float32Array;
};

export type ParticleMeshOptions = {
  /** Contour franc des disques (rendu `toon`). */
  hard?: boolean;
  /** Vent (m/s) appliqué selon la sensibilité `wind` du système. */
  vent?: V3;
  /** Rendu à deux cibles (procgen). */
  mrt?: boolean;
  /** Hauteur du sol des grains `floor` (m, 0 par défaut). */
  floorY?: number;
  /** Taille minimale à l'écran (px de la cible ; `uViewH` = hauteur de la cible, à tenir à jour). 0 : aucune. */
  minPx?: number;
};

/** Quad partagé par tous les systèmes d'une couche. */
export function particleQuad(): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(1, 1);
}

/** Maillage d'un système (tampons liés à ceux du système : seules les plages écrites sont renvoyées au GPU). */
export function createParticleMesh(sys: ParticleSystem, quad: THREE.BufferGeometry, o: ParticleMeshOptions = {}): ParticleMesh {
  const s = sys.spec;
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute("position", quad.getAttribute("position"));
  const p0 = new THREE.InstancedBufferAttribute(sys.p0, 3).setUsage(THREE.DynamicDrawUsage);
  const v0 = new THREE.InstancedBufferAttribute(sys.v0, 3).setUsage(THREE.DynamicDrawUsage);
  const tbuf = new Float32Array(s.max * 4);
  const t = new THREE.InstancedBufferAttribute(tbuf, 4).setUsage(THREE.DynamicDrawUsage);
  const tint = new THREE.InstancedBufferAttribute(sys.tint, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aP0", p0);
  geo.setAttribute("aV0", v0);
  geo.setAttribute("aT", t);
  geo.setAttribute("aTint", tint);
  geo.instanceCount = s.max;
  const add = s.blend === "add";
  const sh = particleShaders(!!o.mrt);
  const mat = new THREE.ShaderMaterial({
    ...(o.mrt ? { glslVersion: THREE.GLSL3 } : {}),
    vertexShader: sh.vertexShader,
    fragmentShader: sh.fragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // MRT : couleur prémultipliée, fusion explicite (la seconde cible reçoit zéro et reste intacte)
    ...(o.mrt
      ? { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: add ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: add ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor }
      : { blending: add ? THREE.AdditiveBlending : THREE.NormalBlending }),
    uniforms: {
      uNow: { value: 0 },
      uAcc: { value: new THREE.Vector3() },
      uDrag: { value: 0 },
      uTurb: { value: 0 },
      uSize: { value: new THREE.Vector2() },
      uColors: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
      uN: { value: 1 },
      uOpacity: { value: new THREE.Vector2() },
      uFade: { value: new THREE.Vector2() },
      uStretch: { value: 0 },
      uSpin: { value: 0 },
      uFloor: { value: 0 },
      uFloorY: { value: o.floorY ?? 0 },
      uSizeK: { value: 1 },
      uMinPx: { value: o.minPx ?? 0 },
      uViewH: { value: 600 },
      uOpacityK: { value: 1 },
      uSprite: { value: 0 },
      uHard: { value: o.hard ? 1 : 0 },
      uAdd: { value: add ? 1 : 0 },
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `${s.id}~particles`;
  mesh.frustumCulled = false;
  mesh.renderOrder = add ? 20 : 10;
  // les rayons de sélection traversent les particules
  mesh.raycast = () => {};
  const d: ParticleMesh = { sys, mesh, geo, mat, attrs: { p0, v0, t, tint }, tbuf };
  syncParticleUniforms(d, o.vent ?? [0, 0, 0]);
  sys.dirty = [0, s.max];
  uploadParticles(d);
  return d;
}

/** Recopie les réglages du système dans les uniformes (après une relecture qui garde le tampon). */
export function syncParticleUniforms(d: ParticleMesh, vent: V3) {
  const s = d.sys.spec;
  const u = d.mat.uniforms;
  (u.uAcc.value as THREE.Vector3).set(...accelOf(s, vent));
  u.uDrag.value = s.drag;
  u.uTurb.value = s.turbulence;
  (u.uSize.value as THREE.Vector2).set(s.size[0], s.size[1]);
  (u.uColors.value as THREE.Vector3[]).forEach((c, i) => c.set(...rgbOf(s.color[Math.min(i, s.color.length - 1)])));
  u.uN.value = s.color.length;
  (u.uOpacity.value as THREE.Vector2).set(s.opacity[0], s.opacity[1]);
  (u.uFade.value as THREE.Vector2).set(s.fade[0], s.fade[1]);
  u.uStretch.value = s.stretch;
  u.uSpin.value = s.spin;
  u.uFloor.value = s.floor ? 1 : 0;
  u.uSprite.value = PARTICLE_SPRITES[s.sprite];
}

/** Horloge du dessin : instant courant et montée du système (`appear`). */
export function tickParticleMesh(d: ParticleMesh, now: number) {
  d.mat.uniforms.uNow.value = now;
  d.mat.uniforms.uOpacityK.value = d.sys.presence(now);
}

/** Envoie au GPU la plage du tampon circulaire écrite depuis le dernier envoi. */
export function uploadParticles(d: ParticleMesh) {
  const sys = d.sys;
  if (!sys.dirty) return;
  const [a, b] = sys.dirty;
  sys.dirty = null;
  for (let i = a; i < b; i++) {
    d.tbuf[i * 4] = sys.born[i];
    d.tbuf[i * 4 + 1] = sys.life[i];
    d.tbuf[i * 4 + 2] = sys.seed[i];
    d.tbuf[i * 4 + 3] = sys.scale[i];
  }
  const { p0, v0, t, tint } = d.attrs;
  for (const [attr, n] of [[p0, 3], [v0, 3], [t, 4], [tint, 1]] as const) {
    // plusieurs envois avant un rendu (pas de simulation sans image) : union des plages, pas de perte
    let start = a * n, end = b * n;
    const prev = attr.updateRanges[0];
    if (prev) {
      start = Math.min(start, prev.start);
      end = Math.max(end, prev.start + prev.count);
    }
    attr.clearUpdateRanges();
    attr.addUpdateRange(start, end - start);
    attr.needsUpdate = true;
  }
}

export function disposeParticleMesh(d: ParticleMesh) {
  d.geo.dispose();
  d.mat.dispose();
}
