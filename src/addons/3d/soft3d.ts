import * as THREE from "three";
import type { Model } from "../../shared/monde/format";
import { geometryOf } from "../../shared/monde/geometry";
import { SoftSim, type V3 } from "../../shared/sim/soft";
import { HairSim } from "../../shared/sim/hair";
import { hairTopology, softTopology, writeHairPositions, writeSoftPositions } from "../../shared/sim/soft-mesh";

/**
 * Pièces souples dans sonic-3d : un maillage déformable par pièce (grille pour un tissu, tube pour une chaîne),
 * posé dans le repère du monde et recalculé à chaque image depuis la simulation. Les autres pièces du modèle
 * deviennent des sphères qui repoussent le tissu (une cape ne traverse pas le dos).
 */

type Collider = { joint: number; c: V3; r: number };

export type SoftView = { part: number; sim: SoftSim; mesh: THREE.Mesh; colliders: Collider[]; spheres: Float32Array };

function bounds(g: { pos: Float32Array }): { c: V3; h: V3 } {
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < g.pos.length; k += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], g.pos[k + a]);
      hi[a] = Math.max(hi[a], g.pos[k + a]);
    }
  return { c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], h: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2] };
}

/** Sphères qui approchent une pièce rigide : alignées sur sa plus grande dimension. */
function spheresOf(joint: number, c: V3, h: V3, out: Collider[]) {
  const long = h[0] >= h[1] && h[0] >= h[2] ? 0 : h[1] >= h[2] ? 1 : 2;
  const others = [0, 1, 2].filter((a) => a !== long).map((a) => h[a]);
  const r = Math.max(0.02, (others[0] + others[1]) / 2);
  const n = Math.min(5, Math.max(1, Math.round(h[long] / r)));
  for (let i = 0; i < n; i++) {
    const p: V3 = [c[0], c[1], c[2]];
    p[long] = n === 1 ? c[long] : c[long] - h[long] + r + ((2 * h[long] - 2 * r) * i) / (n - 1);
    out.push({ joint, c: p, r });
  }
}

/** Rayons du corps d'un personnage gen par os (m, à l'échelle 1) : la cape glisse sur le dos, la jupe sur les hanches. */
const BODY: [RegExp, number, number][] = [
  [/^(torse|dos)$/, 0.17, 0.08],
  [/^bassin$/, 0.16, 0.04],
  [/^tete$/, 0.12, 0.1],
  [/^cou$/, 0.06, 0.03],
  [/^cuisse[LR]$/, 0.085, -0.15],
  [/^mollet[LR]$/, 0.06, -0.15],
  [/^bras[LR]$/, 0.06, -0.1],
];

/** Sphères de collision d'un corps gen, portées par ses os (centre décalé le long de l'os). */
export function genBodyColliders(model: Model): Collider[] {
  const out: Collider[] = [];
  model.parts.forEach((p, i) => {
    if (p.accessory) return;
    for (const [re, r, dy] of BODY) if (re.test(p.name)) out.push({ joint: i, c: [0, dy, 0], r });
  });
  return out;
}

export function buildSoft(model: Model, part: number, detail: number, material: THREE.Material): SoftView | null {
  const p = model.parts[part];
  if (!p.soft) return null;
  const g = geometryOf(p, detail);
  if (!g) return null;
  const sim = new SoftSim(p.soft, bounds(g));
  const geo = new THREE.BufferGeometry();
  const topo = softTopology(sim);
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(topo.verts * 3), 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(topo.uv, 2));
  geo.setIndex(topo.idx);
  // matière de l'instance (recolorée avec elle) ; un tissu se voit des deux côtés
  material.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  const colliders: Collider[] = [];
  if (p.soft.collide)
    model.parts.forEach((q, i) => {
      if (i === part || q.soft || q.hidden || colliders.length >= 24) return;
      const gq = geometryOf(q, 0);
      if (!gq) return;
      const b = bounds(gq);
      spheresOf(i, b.c, b.h, colliders);
    });
  return { part, sim, mesh, colliders: colliders.slice(0, 24), spheres: new Float32Array(Math.min(24, colliders.length) * 4) };
}

const v = new THREE.Vector3();
const e = new THREE.Vector3();

/** Avance une pièce souple et met à jour son maillage ; rend vrai si elle a bougé. */
export function stepSoft(sv: SoftView, joints: THREE.Object3D[], dt: number, gravity: V3, wind: V3): boolean {
  const j = joints[sv.part];
  if (!j) return false;
  j.updateWorldMatrix(true, false);
  sv.mesh.visible = j.visible && isShown(j);
  let k = 0;
  for (const c of sv.colliders) {
    const jo = joints[c.joint];
    if (!jo) continue;
    jo.updateWorldMatrix(true, false);
    v.set(c.c[0], c.c[1], c.c[2]).applyMatrix4(jo.matrixWorld);
    e.setFromMatrixScale(jo.matrixWorld);
    sv.spheres[k] = v.x;
    sv.spheres[k + 1] = v.y;
    sv.spheres[k + 2] = v.z;
    sv.spheres[k + 3] = c.r * Math.max(e.x, e.y, e.z);
    k += 4;
  }
  const moved = sv.sim.step(dt, j.matrixWorld.elements, gravity, wind, sv.colliders.length ? sv.spheres : null);
  if (!moved) return false;
  const pos = sv.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
  writeSoftPositions(sv.sim, pos.array as Float32Array);
  pos.needsUpdate = true;
  sv.mesh.geometry.computeVertexNormals();
  return true;
}

function isShown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

export function disposeSoft(sv: SoftView) {
  sv.mesh.removeFromParent();
  sv.mesh.geometry.dispose();
}

/* ------------------------------------------------------------------ chevelures */

export type HairView = { part: number; sim: HairSim; mesh: THREE.Mesh };

/** Chevelure d'une pièce : un seul maillage de rubans (deux sommets par point de mèche). */
export function buildHair(model: Model, part: number, detail: number, material: THREE.Material, color: string): HairView | null {
  const p = model.parts[part];
  if (!p.hair) return null;
  const g = geometryOf(p, detail);
  if (!g) return null;
  const b = bounds(g);
  const sim = new HairSim(p.hair, b.c, Math.max(b.h[0], b.h[1], b.h[2]));
  const topo = hairTopology(sim);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(topo.verts * 3), 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(topo.uv, 2));
  geo.setIndex(topo.idx);
  const mat = (material as THREE.MeshStandardMaterial).clone();
  mat.side = THREE.DoubleSide;
  mat.map = null;
  if (color) mat.color.set(color);
  else if ("color" in mat) mat.color.multiplyScalar(0.85);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  return { part, sim, mesh };
}

export function stepHair(hv: HairView, joints: THREE.Object3D[], dt: number, gravity: V3, wind: V3): boolean {
  const j = joints[hv.part];
  if (!j) return false;
  j.updateWorldMatrix(true, false);
  hv.mesh.visible = isShown(j);
  if (!hv.sim.step(dt, j.matrixWorld.elements, gravity, wind)) return false;
  const pos = hv.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
  // centre de la tête (côté des rubans : perpendiculaire à la mèche et au rayon)
  j.updateWorldMatrix(true, false);
  const e = j.matrixWorld.elements;
  writeHairPositions(hv.sim, e[12], e[13], e[14], pos.array as Float32Array);
  pos.needsUpdate = true;
  hv.mesh.geometry.computeVertexNormals();
  return true;
}

export function disposeHair(hv: HairView) {
  hv.mesh.removeFromParent();
  hv.mesh.geometry.dispose();
  (hv.mesh.material as THREE.Material).dispose();
}
