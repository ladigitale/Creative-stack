/**
 * Rendu three.js d'un `monde` (src/shared/monde) dans `sonic-3d`.
 *
 * - Instance nommée : un `Object3D` du nom de l'instance (pilotable par `nodes`, comme un nœud glTF), une
 *   articulation `<instance>_<pièce>` par pièce (hiérarchie du modèle), la forme en enfant. Les clips posent
 *   les articulations à chaque image (pilote partagé avec `sonic-2d`).
 * - Décor sans nom : `InstancedMesh` par pièce de modèle (un appel de dessin par pièce, quel que soit le nombre
 *   de copies), couleur par copie.
 * - Géométries et matières partagées (cache par forme / couleur) : dix joueurs = dix fois moins de mémoire.
 */
import * as THREE from "three";
import { geometryOf, type Geo } from "../../shared/monde/geometry";
import { m4, m4Compose, m4Mul } from "../../shared/monde/math";
import { partColor, partTex, type Model, type Monde, type Placement } from "../../shared/monde/format";
import { TEX_SIZE, texKey, texPixels, type TexSpec } from "../../shared/monde/textures";
import { MondeDriver, type InstanceState } from "../../shared/monde/driver";
import { STRIDE } from "../../shared/monde/pose";
import type { NodesSpec } from "./nodes";

type Look = Monde["look"];

const geoCache = new WeakMap<Geo, THREE.BufferGeometry>();
function bufferOf(g: Geo): THREE.BufferGeometry {
  let b = geoCache.get(g);
  if (!b) {
    b = new THREE.BufferGeometry();
    b.setAttribute("position", new THREE.BufferAttribute(g.pos, 3));
    b.setAttribute("normal", new THREE.BufferAttribute(g.nrm, 3));
    b.setAttribute("uv", new THREE.BufferAttribute(g.uv, 2));
    b.setIndex(new THREE.BufferAttribute(g.idx, 1));
    b.computeBoundingSphere();
    geoCache.set(g, b);
  }
  return b;
}

let toonRamp: THREE.DataTexture | null = null;
function ramp(): THREE.DataTexture {
  if (!toonRamp) {
    toonRamp = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 170, 170, 170, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat);
    toonRamp.minFilter = toonRamp.magFilter = THREE.NearestFilter;
    toonRamp.needsUpdate = true;
  }
  return toonRamp;
}

/** Matières partagées par (aspect, couleur, éclat, texture, instanciée). */
class Materials {
  private map = new Map<string, THREE.Material>();
  private texs = new Map<string, THREE.DataTexture>();
  constructor(private look: Look) {}
  private texture(t: TexSpec, base: string): THREE.DataTexture {
    const key = texKey(t, base);
    let tx = this.texs.get(key);
    if (!tx) {
      tx = new THREE.DataTexture(texPixels(t, base), TEX_SIZE, TEX_SIZE, THREE.RGBAFormat);
      tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
      tx.magFilter = THREE.LinearFilter;
      tx.minFilter = THREE.LinearMipmapLinearFilter;
      tx.generateMipmaps = true;
      tx.colorSpace = THREE.SRGBColorSpace;
      tx.repeat.set(t.scale, t.scale);
      tx.center.set(0.5, 0.5);
      tx.rotation = (t.angle * Math.PI) / 180;
      tx.needsUpdate = true;
      this.texs.set(key, tx);
    }
    return tx;
  }
  /** `instanced` : couleur portée par chaque copie (la texture est alors en niveaux de blanc). */
  get(color: string, glow: number, tex: TexSpec | null, instanced = false): THREE.Material {
    const key = `${color}|${glow}|${instanced}|${tex ? texKey(tex, "") + tex.scale + "/" + tex.angle : ""}`;
    let m = this.map.get(key);
    if (m) return m;
    const map = tex ? this.texture(tex, instanced ? "#ffffff" : color) : null;
    const c = new THREE.Color(instanced || map ? "#ffffff" : color);
    const em = glow > 0 ? new THREE.Color(color).multiplyScalar(glow) : new THREE.Color(0);
    if (this.look === "toon") m = new THREE.MeshToonMaterial({ color: c, map, gradientMap: ramp(), emissive: em });
    else m = new THREE.MeshStandardMaterial({ color: c, map, roughness: this.look === "brillant" ? 0.28 : 0.72, metalness: 0, emissive: em });
    this.map.set(key, m);
    return m;
  }
  dispose() {
    for (const m of this.map.values()) m.dispose();
    for (const t of this.texs.values()) t.dispose();
    this.map.clear();
    this.texs.clear();
  }
}

type Built = {
  inst: InstanceState;
  joints: THREE.Object3D[];
  meshes: (THREE.Mesh | null)[];
  shadow: THREE.Mesh | null;
  rolesRev: number;
};

const SHADOW_GEO = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
let shadowMat: THREE.MeshBasicMaterial | null = null;

export class Monde3d {
  readonly driver = new MondeDriver();
  readonly group = new THREE.Group();
  private mats: Materials = new Materials("doux");
  private built = new Map<string, Built>();
  private statics: THREE.InstancedMesh[] = [];
  private monde: Monde | null = null;
  private tmp = m4();
  private tmp2 = m4();

  constructor() {
    this.group.name = "monde";
  }

  get issues() {
    return this.monde?.issues ?? [];
  }

  get instanceNames(): string[] {
    return [...this.built.keys()];
  }

  /** (Re)construit la scène ; les instances inchangées gardent leur état de pilotage. */
  set(m: Monde, now: number) {
    this.clear();
    this.monde = m;
    this.mats.dispose();
    this.mats = new Materials(m.look);
    this.driver.setMonde(m, now);
    for (const inst of this.driver.instances.values()) this.buildInstance(m, inst);
    this.buildStatics(m);
  }

  private buildInstance(m: Monde, inst: InstanceState) {
    const pl = inst.placement;
    const root = new THREE.Object3D();
    root.name = inst.name;
    root.position.set(pl.at[0], pl.at[1], pl.at[2]);
    root.rotation.set(pl.rot[0], pl.rot[1], pl.rot[2]);
    root.scale.set(pl.scale[0], pl.scale[1], pl.scale[2]);
    root.visible = !pl.hidden;
    const model = inst.model;
    const joints: THREE.Object3D[] = [];
    const meshes: (THREE.Mesh | null)[] = [];
    model.parts.forEach((p, i) => {
      const j = new THREE.Object3D();
      j.name = `${inst.name}_${p.name}`;
      j.position.set(p.at[0], p.at[1], p.at[2]);
      j.rotation.set(p.rot[0], p.rot[1], p.rot[2]);
      j.scale.set(p.scale[0], p.scale[1], p.scale[2]);
      j.visible = !p.hidden;
      (p.parent >= 0 ? joints[p.parent] : root).add(j);
      joints.push(j);
      const g = geometryOf(p, m.detail);
      if (g) {
        const mesh = new THREE.Mesh(bufferOf(g), this.mats.get(partColor(model, p, inst.roles, m.palette), p.glow, partTex(m, p)));
        mesh.name = `${j.name}~`;
        j.add(mesh);
        meshes.push(mesh);
      } else meshes.push(null);
    });
    let shadow: THREE.Mesh | null = null;
    if (m.shadows) {
      shadowMat ??= new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false });
      shadow = new THREE.Mesh(SHADOW_GEO, shadowMat);
      shadow.name = `${inst.name}~ombre`;
      shadow.renderOrder = -1;
      const r = radiusOf(model) * Math.max(pl.scale[0], pl.scale[2]);
      shadow.scale.set(r, 1, r);
      this.group.add(shadow);
    }
    this.group.add(root);
    this.built.set(inst.name, { inst, joints, meshes, shadow, rolesRev: inst.rolesRev });
  }

  private buildStatics(m: Monde) {
    const byModel = new Map<string, Placement[]>();
    for (const pl of m.place) {
      if (pl.name || pl.hidden) continue;
      const list = byModel.get(pl.model) ?? [];
      list.push(pl);
      byModel.set(pl.model, list);
    }
    const mat = this.tmp;
    for (const [name, list] of byModel) {
      const model = m.models.get(name)!;
      // matrices de repos des pièces (repère du modèle)
      const offs = new Float32Array(model.parts.length * STRIDE);
      for (let i = 6; i < offs.length; i += STRIDE) offs[i] = 1;
      const world = restWorld(model, offs);
      model.parts.forEach((p, i) => {
        const g = geometryOf(p, m.detail);
        if (!g || p.hidden) return;
        const im = new THREE.InstancedMesh(bufferOf(g), this.mats.get(partColor(model, p, undefined, m.palette), p.glow, partTex(m, p), true), list.length);
        im.name = `${name}~decor~${p.name}`;
        const color = new THREE.Color();
        const pm = new THREE.Matrix4();
        list.forEach((pl, k) => {
          m4Compose(mat, pl.at[0], pl.at[1], pl.at[2], pl.rot[0], pl.rot[1], pl.rot[2], pl.scale[0], pl.scale[1], pl.scale[2]);
          m4Mul(this.tmp2, mat, world.subarray(i * 16, i * 16 + 16));
          pm.fromArray(this.tmp2);
          im.setMatrixAt(k, pm);
          color.set(partColor(model, p, pl.roles, m.palette));
          if (p.glow > 0) color.multiplyScalar(1 + p.glow * 0.5);
          im.setColorAt(k, color);
        });
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.computeBoundingSphere();
        this.group.add(im);
        this.statics.push(im);
      });
    }
  }

  /**
   * Patchs `nodes` d'instances : clip et couleurs ici ; position / orientation laissées à `NodeOverrides`
   * (l'instance est un nœud nommé comme un autre).
   */
  applyNodes(spec: NodesSpec, now: number): boolean {
    let any = false;
    for (const [name, p] of Object.entries(spec)) {
      if (name === "$reset") continue;
      const r = this.driver.apply(name, p, now, true, false);
      if (r && (r.pose || r.roles)) any = true;
    }
    return any;
  }

  /** Avance les clips et reporte poses, couleurs et ombres ; true si l'image doit être redessinée. */
  step(now: number): boolean {
    if (!this.monde) return false;
    const busy = this.driver.step(now);
    let changed = busy;
    for (const b of this.built.values()) {
      const inst = b.inst;
      if (inst.poseChanged) {
        inst.poseChanged = false;
        changed = true;
        const parts = inst.model.parts;
        const o = inst.offs;
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i], j = b.joints[i], k = i * STRIDE;
          j.position.set(p.at[0] + o[k + 3], p.at[1] + o[k + 4], p.at[2] + o[k + 5]);
          j.rotation.set(p.rot[0] + o[k], p.rot[1] + o[k + 1], p.rot[2] + o[k + 2]);
          const s = o[k + 6];
          j.scale.set(p.scale[0] * s, p.scale[1] * s, p.scale[2] * s);
        }
      }
      if (b.rolesRev !== inst.rolesRev) {
        b.rolesRev = inst.rolesRev;
        changed = true;
        inst.model.parts.forEach((p, i) => {
          const mesh = b.meshes[i];
          if (mesh) mesh.material = this.mats.get(partColor(inst.model, p, inst.roles, this.monde!.palette), p.glow, partTex(this.monde!, p));
        });
      }
      if (b.shadow) {
        const root = b.joints[0]?.parent;
        if (root) {
          b.shadow.position.set(root.position.x, 0.005, root.position.z);
          b.shadow.visible = root.visible;
        }
      }
    }
    return changed;
  }

  clear() {
    for (const b of this.built.values()) {
      b.shadow?.removeFromParent();
    }
    for (const im of this.statics) im.dispose();
    this.statics = [];
    this.built.clear();
    this.group.clear();
  }

  dispose() {
    this.clear();
    this.mats.dispose();
  }
}

function restWorld(model: Model, offs: Float32Array): Float32Array {
  const world = new Float32Array(model.parts.length * 16);
  const tmp = m4();
  const id = m4();
  model.parts.forEach((p, i) => {
    const o = i * STRIDE;
    m4Compose(tmp, p.at[0] + offs[o + 3], p.at[1] + offs[o + 4], p.at[2] + offs[o + 5], p.rot[0], p.rot[1], p.rot[2], p.scale[0], p.scale[1], p.scale[2]);
    m4Mul(world.subarray(i * 16, i * 16 + 16), p.parent >= 0 ? world.subarray(p.parent * 16, p.parent * 16 + 16) : id, tmp);
  });
  return world;
}

/** Rayon au sol approximatif d'un modèle (pour l'ombre). */
export function radiusOf(model: Model): number {
  let r = 0.15;
  const offs = new Float32Array(model.parts.length * STRIDE);
  for (let i = 6; i < offs.length; i += STRIDE) offs[i] = 1;
  const w = restWorld(model, offs);
  model.parts.forEach((p, i) => {
    if (!p.shape) return;
    const x = w[i * 16 + 12], z = w[i * 16 + 14];
    const s = p.shape.a[0] ?? 0.1;
    r = Math.max(r, Math.min(3, Math.hypot(x, z) + Math.min(s, 1) * 0.6));
  });
  return r * 0.85;
}
