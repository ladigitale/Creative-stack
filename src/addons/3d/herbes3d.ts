import * as THREE from "three";
import type { Monde } from "../../shared/monde/format";
import { HERBE_BUDGET, shares, sowField, type Foot, type HerbeField } from "../../shared/monde/herbes";

/**
 * Champs de brins dans sonic-3d : un maillage instancié par champ (un appel de dessin), éclairé comme le reste
 * (matière standard), avec le vent et le ploiement calculés dans le shader : rien ne bouge côté CPU à part
 * l'horloge et la position des instances qui couchent les brins (8 au plus).
 */

const MAX_PUSH = 8;

/** Brin : ruban effilé de 5 segments (et un épi, une massette ou une fleur selon la sorte), pied en y = 0, hauteur 1. */
function bladeGeometry(kind: HerbeField["kind"], width: number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], nrm: number[] = [], idx: number[] = [], head: number[] = [];
  const seg = kind === "gazon" ? 2 : 5;
  const stemTop = kind === "ble" ? 0.78 : kind === "roseau" ? 0.82 : kind === "fleurs" ? 0.92 : 1;
  const w0 = kind === "ble" || kind === "roseau" ? width * 0.6 : width;
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, y = t * stemTop;
    const w = w0 * (1 - t * (kind === "herbe" || kind === "gazon" ? 0.95 : 0.4));
    pos.push(-w / 2, y, 0, w / 2, y, 0);
    uv.push(0, y, 1, y);
    nrm.push(0, 0.3, 1, 0, 0.3, 1);
    head.push(0, 0);
    if (i < seg) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const quad = (cx: number, cy: number, hw: number, hh: number, ry: number, h: number) => {
    const b = pos.length / 3;
    const c = Math.cos(ry), s = Math.sin(ry);
    for (const [dx, dy] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) {
      pos.push(cx + dx * c, cy + dy, dx * s);
      uv.push(dx > 0 ? 1 : 0, cy + dy);
      nrm.push(-s, 0.4, c);
      head.push(h, h);
    }
    idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  };
  if (kind === "ble") for (let k = 0; k < 3; k++) quad(0, 0.89, width * 0.9, 0.11, (k * Math.PI) / 3, 1);
  if (kind === "roseau") for (let k = 0; k < 2; k++) quad(0, 0.9, width * 1.3, 0.08, (k * Math.PI) / 2, 1);
  if (kind === "fleurs") for (let k = 0; k < 2; k++) quad(0, 0.95, 0.045, 0.045, (k * Math.PI) / 2, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("head", new THREE.Float32BufferAttribute(head.filter((_, i) => i % 2 === 0), 1));
  // hauteur le long du brin (0 au pied, 1 à la pointe), indépendante des uv
  g.setAttribute("bh", new THREE.Float32BufferAttribute(uv.filter((_, i) => i % 2 === 1), 1));
  g.setIndex(idx);
  return g;
}

type Uniforms = { time: { value: number }; wind: { value: THREE.Vector3 }; push: { value: THREE.Vector4[] }; base: { value: THREE.Color }; tip: { value: THREE.Color }; sway: { value: number }; flowerHeads: { value: number } };

function material(f: HerbeField, shared: Pick<Uniforms, "time" | "wind" | "push">, look: Monde["look"]): THREE.Material {
  const m =
    look === "toon"
      ? new THREE.MeshToonMaterial({ color: 0xffffff, side: THREE.DoubleSide })
      : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  const u: Uniforms = { ...shared, base: { value: new THREE.Color(f.base) }, tip: { value: new THREE.Color(f.tip) }, sway: { value: f.sway }, flowerHeads: { value: f.flowers.length ? 1 : 0 } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float time; uniform vec3 wind; uniform vec4 push[${MAX_PUSH}]; uniform float sway;
attribute float head; attribute float bh; varying float vH; varying float vHead;`,
      )
      .replace(
        "#include <project_vertex>",
        `vec4 wp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
vec3 root = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
float hgt = length(vec3(instanceMatrix[1].xyz));
float k = clamp(bh, 0.0, 1.0);
k = k * k;
float gust = 0.55 + 0.45 * sin(time * 1.3 + dot(root.xz, vec2(0.35, 0.21))) * sin(time * 0.37 + root.x * 0.07);
float flick = sin(time * 4.1 + root.x * 3.1 + root.z * 2.3) * 0.15;
vec2 w = wind.xz * (gust + flick) * sway * 0.12;
for (int i = 0; i < ${MAX_PUSH}; i++) {
  vec2 d = root.xz - push[i].xy;
  float dist = length(d);
  float f = clamp(1.0 - dist / max(push[i].z, 0.001), 0.0, 1.0) * push[i].w;
  if (f > 0.0) w += (d / max(dist, 0.001)) * f * 1.6;
}
float bl = length(w);
if (bl > 1.2) w *= 1.2 / bl;
wp.xz += w * k * hgt;
wp.y -= dot(w, w) * k * hgt * 0.35;
vec4 mvPosition = viewMatrix * wp;
gl_Position = projectionMatrix * mvPosition;
vH = bh; vHead = head;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 base; uniform vec3 tip; uniform float flowerHeads; varying float vH; varying float vHead;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
vec3 g = mix(base, tip, smoothstep(0.0, 1.0, vH));
vec3 headCol = flowerHeads > 0.5 ? diffuseColor.rgb : tip * diffuseColor.rgb;
diffuseColor.rgb = mix(g * (flowerHeads > 0.5 ? vec3(1.0) : diffuseColor.rgb), headCol, vHead);`,
      );
  };
  m.customProgramCacheKey = () => `herbes|${look}`;
  return m;
}

export class HerbesLayer {
  readonly group = new THREE.Group();
  private shared = { time: { value: 0 }, wind: { value: new THREE.Vector3(1.2, 0, 0.5) }, push: { value: Array.from({ length: MAX_PUSH }, () => new THREE.Vector4(0, 0, 0, 0)) } };
  private meshes: THREE.InstancedMesh[] = [];
  private sig = "";
  count = 0;

  constructor() {
    this.group.name = "monde~herbes";
  }

  /** (Re)sème les champs ; rien ne bouge si les champs, le décor et le détail n'ont pas changé. */
  mount(m: Monde, feet: Foot[]) {
    const sig = JSON.stringify([m.herbes, m.detail, m.look, feet.length]);
    const v = m.vent;
    if (Math.hypot(v[0], v[2]) > 0.01) this.shared.wind.value.set(v[0], v[1], v[2]);
    else this.shared.wind.value.set(1.2, 0, 0.5);
    if (sig === this.sig) return;
    this.sig = sig;
    this.clear();
    if (!m.herbes.length) return;
    const parts = shares(m.herbes, HERBE_BUDGET[m.detail] ?? HERBE_BUDGET[1]);
    const mat4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color(), white = new THREE.Color(1, 1, 1);
    m.herbes.forEach((f, i) => {
      const blades = sowField(f, parts[i], feet);
      const n = blades.length / 6;
      if (!n) return;
      const im = new THREE.InstancedMesh(bladeGeometry(f.kind, f.width), material(f, this.shared, m.look), n);
      im.name = `herbes~${i}`;
      im.castShadow = false;
      im.receiveShadow = true;
      im.frustumCulled = false;
      const flowers = f.flowers.map((c) => new THREE.Color(c));
      for (let b = 0; b < n; b++) {
        const k = b * 6;
        p.set(blades[k], 0, blades[k + 1]);
        q.setFromAxisAngle(up, blades[k + 2]);
        const h = blades[k + 3];
        s.set(1, h, 1);
        im.setMatrixAt(b, mat4.compose(p, q, s));
        // teinte : légère variation de valeur ; fleurs : couleur de la corolle (la tige garde son dégradé)
        const t = blades[k + 4];
        // fleurs : seul un brin sur trois porte une corolle colorée, les autres restent des tiges
        if (flowers.length) col.copy(t < 0.35 ? flowers[Math.floor((t / 0.35) * flowers.length) % flowers.length] : white);
        else col.copy(white).multiplyScalar(0.82 + t * 0.3);
        im.setColorAt(b, col);
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      this.group.add(im);
      this.meshes.push(im);
      this.count += n;
    });
  }

  /** Horloge du vent et positions qui couchent les brins (instances nommées les plus proches de la caméra). */
  advance(time: number, pushers: { x: number; z: number; r: number }[]) {
    if (!this.meshes.length) return false;
    this.shared.time.value = time;
    const arr = this.shared.push.value;
    for (let i = 0; i < MAX_PUSH; i++) {
      const p = pushers[i];
      if (p) arr[i].set(p.x, p.z, p.r, 1);
      else arr[i].set(0, 0, 0, 0);
    }
    return true;
  }

  get active() {
    return this.meshes.length > 0;
  }

  clear() {
    for (const im of this.meshes) {
      im.geometry.dispose();
      (im.material as THREE.Material).dispose();
      im.removeFromParent();
      im.dispose();
    }
    this.meshes = [];
    this.count = 0;
  }

  dispose() {
    this.clear();
    this.sig = "";
  }
}
