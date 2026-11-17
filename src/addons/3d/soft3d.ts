import * as THREE from "three";
import type { Model } from "../../shared/monde/format";
import { geometryOf } from "../../shared/monde/geometry";
import { SoftSim, type V3 } from "../../shared/sim/soft";
import { HairSim } from "../../shared/sim/hair";

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

const RING = 6;

export function buildSoft(model: Model, part: number, detail: number, material: THREE.Material): SoftView | null {
  const p = model.parts[part];
  if (!p.soft) return null;
  const g = geometryOf(p, detail);
  if (!g) return null;
  const sim = new SoftSim(p.soft, bounds(g));
  const geo = new THREE.BufferGeometry();
  if (p.soft.kind === "jupe") {
    const { cols, rows } = sim;
    const uv: number[] = [], idx: number[] = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        uv.push(c / cols, 1 - r / (rows - 1));
        if (r + 1 < rows) {
          const a = r * cols + c, b = r * cols + ((c + 1) % cols);
          idx.push(a, a + cols, b, b, a + cols, b + cols);
        }
      }
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(sim.n * 3), 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
  } else if (p.soft.kind === "tissu") {
    const { cols, rows } = sim;
    const uv: number[] = [], idx: number[] = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        uv.push(c / (cols - 1), 1 - r / (rows - 1));
        if (r + 1 < rows && c + 1 < cols) {
          const a = r * cols + c;
          idx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
        }
      }
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(sim.n * 3), 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
  } else {
    const n = sim.n;
    const uv: number[] = [], idx: number[] = [];
    for (let i = 0; i < n; i++)
      for (let k = 0; k < RING; k++) {
        uv.push(k / RING, i / (n - 1));
        if (i + 1 < n) {
          const a = i * RING + k, b = i * RING + ((k + 1) % RING);
          idx.push(a, a + RING, b, b, a + RING, b + RING);
        }
      }
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * RING * 3), 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
  }
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
  const out = pos.array as Float32Array;
  const p = sv.sim.pos;
  if (sv.sim.spec.kind !== "chaine") out.set(p);
  else {
    // tube : un anneau autour de chaque point, orienté selon la chaîne (repère transporté)
    const n = sv.sim.n;
    let ux = 1, uy = 0, uz = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = p[b * 3] - p[a * 3], ty = p[b * 3 + 1] - p[a * 3 + 1], tz = p[b * 3 + 2] - p[a * 3 + 2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      // u ⟂ t (Gram-Schmidt sur le précédent), w = t × u
      const d = ux * tx + uy * ty + uz * tz;
      ux -= d * tx;
      uy -= d * ty;
      uz -= d * tz;
      let ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-4) {
        ux = Math.abs(tx) < 0.9 ? 1 : 0;
        uy = Math.abs(tx) < 0.9 ? 0 : 1;
        uz = 0;
        const d2 = ux * tx + uy * ty;
        ux -= d2 * tx;
        uy -= d2 * ty;
        uz -= d2 * tz;
        ul = Math.hypot(ux, uy, uz) || 1;
      }
      ux /= ul;
      uy /= ul;
      uz /= ul;
      const wx = ty * uz - tz * uy, wy = tz * ux - tx * uz, wz = tx * uy - ty * ux;
      // effilé vers le bout libre
      const r = sv.sim.radius * (1 - 0.6 * (i / Math.max(1, n - 1)));
      for (let q = 0; q < RING; q++) {
        const ang = (q / RING) * Math.PI * 2, c = Math.cos(ang) * r, s = Math.sin(ang) * r;
        const o = (i * RING + q) * 3;
        out[o] = p[i * 3] + ux * c + wx * s;
        out[o + 1] = p[i * 3 + 1] + uy * c + wy * s;
        out[o + 2] = p[i * 3 + 2] + uz * c + wz * s;
      }
    }
  }
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
  const per = sim.per, n = sim.strands;
  const uv: number[] = [], idx: number[] = [];
  for (let s = 0; s < n; s++)
    for (let k = 0; k < per; k++) {
      uv.push(0, k / (per - 1), 1, k / (per - 1));
      if (k + 1 < per) {
        const a = (s * per + k) * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * per * 2 * 3), 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
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
  const out = pos.array as Float32Array;
  const p = hv.sim.pos, per = hv.sim.per, w0 = hv.sim.spec.width;
  // centre de la tête (côté des rubans : perpendiculaire à la mèche et au rayon)
  j.updateWorldMatrix(true, false);
  const hx = j.matrixWorld.elements[12], hy = j.matrixWorld.elements[13], hz = j.matrixWorld.elements[14];
  for (let s = 0; s < hv.sim.strands; s++)
    for (let k = 0; k < per; k++) {
      const i = s * per + k;
      const a = s * per + Math.max(0, k - 1), b = s * per + Math.min(per - 1, k + 1);
      const tx = p[b * 3] - p[a * 3], ty = p[b * 3 + 1] - p[a * 3 + 1], tz = p[b * 3 + 2] - p[a * 3 + 2];
      const rx = p[i * 3] - hx, ry = p[i * 3 + 1] - hy, rz = p[i * 3 + 2] - hz;
      let sx = ty * rz - tz * ry, sy = tz * rx - tx * rz, sz = tx * ry - ty * rx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      const w = (w0 / 2) * (1 - 0.45 * (k / (per - 1)));
      const wav = hv.sim.waveAt(s, k);
      sx = (sx / sl) * w;
      sy = (sy / sl) * w;
      sz = (sz / sl) * w;
      const o = i * 6;
      const cx = p[i * 3] + (sx / Math.max(w, 1e-6)) * wav, cy = p[i * 3 + 1] + (sy / Math.max(w, 1e-6)) * wav, cz = p[i * 3 + 2] + (sz / Math.max(w, 1e-6)) * wav;
      out[o] = cx - sx;
      out[o + 1] = cy - sy;
      out[o + 2] = cz - sz;
      out[o + 3] = cx + sx;
      out[o + 4] = cy + sy;
      out[o + 5] = cz + sz;
    }
  pos.needsUpdate = true;
  hv.mesh.geometry.computeVertexNormals();
  return true;
}

export function disposeHair(hv: HairView) {
  hv.mesh.removeFromParent();
  hv.mesh.geometry.dispose();
  (hv.mesh.material as THREE.Material).dispose();
}
