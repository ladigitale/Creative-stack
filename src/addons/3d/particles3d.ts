/**
 * Particules du monde dans `sonic-3d` : un appel de dessin par système (quads instanciés face caméra).
 *
 * Le mouvement est calculé dans le vertex shader (forme close : `positionAt` de shared/sim/particles) ; le processeur
 * n'envoie que les plages du tampon circulaire écrites depuis l'image précédente. Pas de tri : fusion additive pour
 * le feu et la lumière, transparence sans écriture de profondeur pour la fumée.
 */
import * as THREE from "three";
import type { Monde } from "../../shared/monde/format";
import { ParticleSet } from "../../shared/sim/particle-set";
import { accelOf, rgbOf, type ParticleSystem } from "../../shared/sim/particles";

const SPRITES = { disque: 0, flocon: 1, goutte: 2, eclat: 3, trait: 4, volute: 5 } as const;

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
uniform float uStretch;
uniform float uSpin;
uniform float uFloor;
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
  if (uFloor > 0.5) p.y = max(p.y, 0.0);
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
  float size = max(1e-4, mix(uSize.x, uSize.y, k) * aT.w);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec2 c = position.xy;
  float ang = uSpin * t * 6.2831853 + aT.z * 6.2831853;
  c = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * c;
  if (uStretch > 0.0) {
    vec4 mv2 = modelViewMatrix * vec4(posAt(t + 0.02), 1.0);
    vec2 d = (mv2.xy - mv.xy) / 0.02;
    float sp = length(d);
    if (sp > 1e-4) {
      vec2 dir = d / sp;
      vec2 nrm = vec2(-dir.y, dir.x);
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
  vCol = vec4(col, mix(uOpacity.x, uOpacity.y, k));
}
`;

const FRAG = /* glsl */ `
uniform float uSprite;
uniform float uHard;
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
    float w = 0.75 + 0.25 * sin(an_(q) * 3.0 + vSeed * 20.0);
    a = pow(max(0.0, 1.0 - d / w), 1.6);
  }
  a *= vCol.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vCol.rgb, a);
}
`.replace("an_(q)", "atan(q.y, q.x)");

type Drawn = { sys: ParticleSystem; mesh: THREE.Mesh; geo: THREE.InstancedBufferGeometry; mat: THREE.ShaderMaterial; attrs: { p0: THREE.InstancedBufferAttribute; v0: THREE.InstancedBufferAttribute; t: THREE.InstancedBufferAttribute; tint: THREE.InstancedBufferAttribute }; tbuf: Float32Array };

export class ParticleLayer extends ParticleSet {
  readonly group = new THREE.Group();
  private drawn: Drawn[] = [];
  private lightPool: THREE.PointLight[] = [];
  private quad: THREE.BufferGeometry;

  constructor() {
    super();
    this.group.name = "monde~particles";
    this.quad = new THREE.PlaneGeometry(1, 1);
  }

  mount(m: Monde) {
    this.clearMeshes();
    this.set(m);
    const hard = m.look === "toon" ? 1 : 0;
    this.drawn = this.systems.map((sys) => {
      const s = sys.spec;
      const geo = new THREE.InstancedBufferGeometry();
      geo.index = this.quad.index;
      geo.setAttribute("position", this.quad.getAttribute("position"));
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
      const colors = [0, 1, 2, 3].map((i) => new THREE.Vector3(...rgbOf(s.color[Math.min(i, s.color.length - 1)])));
      const acc = accelOf(s, this.vent);
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: s.blend === "add" ? THREE.AdditiveBlending : THREE.NormalBlending,
        uniforms: {
          uNow: { value: this.now },
          uAcc: { value: new THREE.Vector3(...acc) },
          uDrag: { value: s.drag },
          uTurb: { value: s.turbulence },
          uSize: { value: new THREE.Vector2(s.size[0], s.size[1]) },
          uColors: { value: colors },
          uN: { value: s.color.length },
          uOpacity: { value: new THREE.Vector2(s.opacity[0], s.opacity[1]) },
          uStretch: { value: s.stretch },
          uSpin: { value: s.spin },
          uFloor: { value: s.floor ? 1 : 0 },
          uSprite: { value: SPRITES[s.sprite] },
          uHard: { value: hard },
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `${s.id}~particles`;
      mesh.frustumCulled = false;
      mesh.renderOrder = s.blend === "add" ? 20 : 10;
      // les rayons de sélection traversent les particules
      mesh.raycast = () => {};
      this.group.add(mesh);
      const d: Drawn = { sys, mesh, geo, mat, attrs: { p0, v0, t, tint }, tbuf };
      sys.dirty = [0, s.max];
      this.upload(d);
      return d;
    });
    if (this.systems.some((sys) => sys.spec.light))
      for (let i = 0; i < 4; i++) {
        const pl = new THREE.PointLight(0xffffff, 0, 6, 2);
        this.lightPool.push(pl);
        this.group.add(pl);
      }
  }

  private upload(d: Drawn) {
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
      attr.clearUpdateRanges();
      attr.addUpdateRange(a * n, (b - a) * n);
      attr.needsUpdate = true;
    }
  }

  /** Avance l'horloge, envoie les naissances, place les lumières ; vrai si quelque chose bouge. */
  advance(dt: number): boolean {
    if (!this.drawn.length) return false;
    this.step(dt);
    for (const d of this.drawn) {
      this.upload(d);
      d.mat.uniforms.uNow.value = this.now;
    }
    this.placeLights();
    return this.active;
  }

  /**
   * Lumières des systèmes : un jeu fixe de 4 lumières ponctuelles créé une fois (allumer ou éteindre une lumière
   * changerait le nombre de lumières de la scène et ferait recompiler tous les matériaux) ; éteinte = intensité 0.
   */
  private placeLights() {
    if (!this.lightPool.length) return;
    const ls = this.lights();
    this.lightPool.forEach((pl, i) => {
      const l = ls[i];
      if (!l) {
        pl.intensity = 0;
        return;
      }
      pl.color.set(l.color);
      pl.intensity = l.intensity;
      pl.distance = l.radius;
      pl.position.set(l.at[0], l.at[1], l.at[2]);
    });
  }

  private clearMeshes() {
    for (const d of this.drawn) {
      d.geo.dispose();
      d.mat.dispose();
    }
    this.drawn = [];
    this.group.clear();
    this.lightPool = [];
  }

  dispose() {
    this.clearMeshes();
    this.quad.dispose();
    super.dispose();
  }
}
