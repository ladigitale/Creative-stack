/**
 * Tissus et mèches simulés dans le rendu procgen : un maillage déformable par pièce (`SoftPiece` des générateurs),
 * recalculé à chaque image depuis le moteur commun (`shared/sim`). Les pièces d'un acteur suivent ses os ; celles
 * d'un objet (drapeau, linge, rideau) suivent l'objet.
 *
 * Budget : seules les pièces visibles et assez grandes à l'écran sont simulées, les plus grandes d'abord, dans une
 * limite de points (plus basse sur mobile) ; les autres sont figées et suivent leur attache sans calcul de tissu.
 */
import * as THREE from "three";
import type { M4, V3 } from "../core/math";
import { type PieceSim, makePieceSim, pieceCost, pieceTopology, writePiece } from "../gen/soft";
import type { SoftPiece } from "../gen/types";
import type { MaterialPair } from "./materials";

/** Points simulés au plus par image, nombre de pièces au plus (ordinateur / mobile). */
export const SOFT_BUDGET = { desktop: { points: 9000, pieces: 32 }, mobile: { points: 2600, pieces: 10 } };
/** Taille minimale à l'écran (px) pour simuler une pièce. */
export const SOFT_MIN_PX = 14;

type Col = NonNullable<SoftPiece["colliders"]>[number];

export type SoftRT = {
  piece: SoftPiece;
  ps: PieceSim;
  mesh: THREE.Mesh;
  /** Propriétaire : acteur (os) ou objet (repère fixe). */
  actor: string | null;
  obj: number;
  cost: number;
  spheres: Float32Array | null;
  /** Rayon approximatif de la pièce (m) : visibilité, taille à l'écran. */
  extent: number;
  /** Simulée cette image (sinon figée). */
  active: boolean;
  /** Figée : matrice d'attache, positions et normales au moment du gel (monde). */
  frozenAt: Float64Array | null;
  pos0: Float32Array | null;
  nrm0: Float32Array | null;
  /** Dernière matrice d'attache utilisée. */
  m: Float64Array;
  started: boolean;
};

export type AttachFn = (rt: SoftRT, bone: string | undefined, out: Float64Array) => boolean;

const tmpM = new THREE.Matrix4(), tmpI = new THREE.Matrix4(), tmpV = new THREE.Vector3(), tmpN = new THREE.Matrix3();
const G: V3 = [0, -9.81, 0];

function geometryFor(ps: PieceSim, role: number, obj: number): THREE.BufferGeometry {
  const topo = pieceTopology(ps);
  const n = topo.verts;
  const g = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  pos.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute("position", pos);
  const nrm = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  nrm.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute("normal", nrm);
  g.setAttribute("aRole", new THREE.BufferAttribute(new Float32Array(n).fill(role), 1));
  g.setAttribute("aAO", new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
  g.setAttribute("aFlex", new THREE.BufferAttribute(new Float32Array(n), 1));
  g.setAttribute("aObj", new THREE.BufferAttribute(new Float32Array(n).fill(obj), 1));
  g.setAttribute("aSkinIdx", new THREE.BufferAttribute(new Float32Array(n * 4), 4));
  const w = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) w[i * 4] = 1;
  g.setAttribute("aSkinW", new THREE.BufferAttribute(w, 4));
  g.setAttribute("aMorph", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("aBlend", new THREE.BufferAttribute(new Float32Array(n), 1));
  g.setIndex(topo.idx);
  return g;
}

function extentOf(p: SoftPiece): number {
  if (p.box) return Math.max(p.box.h[0], p.box.h[1], p.box.h[2]) * (p.cloth?.kind === "jupe" ? 1.3 : 1.1);
  if (p.hair && p.head) return p.head.r + p.hair.length;
  return 0.5;
}

export class SoftLayer {
  readonly items: SoftRT[] = [];
  /** Prochain choix des pièces simulées (ms, horloge de la page). */
  private evalT = 0;
  /** Pièces simulées à l'image précédente. */
  activeCount = 0;
  private wind: V3 = [0.6, 0, 0.24];

  constructor(
    private scene: THREE.Scene,
    private attach: AttachFn,
    private budget: { points: number; pieces: number },
  ) {}

  /** Vent en m/s (direction et force de la recette). */
  setWind(w: V3) {
    this.wind = w;
  }

  add(piece: SoftPiece, mats: MaterialPair, owner: { actor: string | null; obj: number }): SoftRT | null {
    const ps = makePieceSim(piece);
    if (!ps) return null;
    const mesh = new THREE.Mesh(geometryFor(ps, piece.role, owner.obj), mats.color);
    mesh.userData.depth = mats.depth;
    mesh.userData.soft = true;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);
    const rt: SoftRT = {
      piece, ps, mesh, actor: owner.actor, obj: owner.obj, cost: pieceCost(ps), extent: extentOf(piece),
      spheres: piece.colliders?.length ? new Float32Array(piece.colliders.length * 4) : null,
      active: false, frozenAt: null, pos0: null, nrm0: null, m: new Float64Array(16), started: false,
    };
    this.items.push(rt);
    return rt;
  }

  /** Premier placement et drapé de repos (`ticks` pas de 1/60 s) dans la pose courante. */
  settle(rt: SoftRT, ticks = 90) {
    if (!this.attach(rt, rt.piece.bone, rt.m)) return;
    this.updateSpheres(rt);
    for (let i = 0; i < ticks; i += 3) this.stepSim(rt, 0.05);
    rt.started = true;
    this.write(rt);
  }

  private updateSpheres(rt: SoftRT) {
    const cols = rt.piece.colliders;
    if (!cols || !rt.spheres) return;
    const m = new Float64Array(16);
    let k = 0;
    let lastBone: string | undefined | null = null;
    for (const c of cols as Col[]) {
      if (c.bone !== lastBone) {
        if (!this.attach(rt, c.bone, m)) continue;
        lastBone = c.bone;
      }
      const x = c.c[0], y = c.c[1], z = c.c[2];
      rt.spheres[k] = m[0] * x + m[4] * y + m[8] * z + m[12];
      rt.spheres[k + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      rt.spheres[k + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      rt.spheres[k + 3] = c.r;
      k += 4;
    }
  }

  private stepSim(rt: SoftRT, dt: number): boolean {
    const ps = rt.ps;
    if (ps.kind === "hair") return ps.sim.step(dt, rt.m, G, this.wind, rt.spheres);
    return ps.sim.step(dt, rt.m, G, this.wind, rt.spheres);
  }

  /** Positions du maillage depuis la simulation, normales recalculées. */
  private write(rt: SoftRT) {
    const g = rt.mesh.geometry;
    const pa = g.getAttribute("position") as THREE.BufferAttribute;
    let head: V3 | undefined;
    if (rt.piece.head) {
      const c = rt.piece.head.c, m = rt.m;
      head = [m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12], m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13], m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14]];
    }
    writePiece(rt.ps, rt.piece, pa.array as Float32Array, head);
    pa.needsUpdate = true;
    g.computeVertexNormals();
  }

  /**
   * Choix des pièces simulées : visibles (`frustum`), propriétaire montré, au moins `SOFT_MIN_PX` à l'écran ; les plus
   * grandes d'abord, dans le budget. `pxPerM(p)` : pixels par mètre à la position `p`.
   */
  private choose(frustum: THREE.Frustum, pxPerM: (p: THREE.Vector3) => number, shown: (rt: SoftRT) => boolean) {
    const cand: { rt: SoftRT; px: number }[] = [];
    const sph = new THREE.Sphere();
    for (const rt of this.items) {
      rt.mesh.visible = shown(rt);
      const want = rt.mesh.visible && this.attach(rt, rt.piece.bone, rt.m);
      if (!want) {
        rt.active = false;
        continue;
      }
      tmpV.set(rt.m[12], rt.m[13], rt.m[14]);
      sph.set(tmpV, rt.extent * 1.5 + 0.3);
      if (!frustum.intersectsSphere(sph)) {
        rt.active = false;
        continue;
      }
      const px = rt.extent * pxPerM(tmpV);
      if (px < SOFT_MIN_PX) {
        rt.active = false;
        continue;
      }
      cand.push({ rt, px });
    }
    cand.sort((a, b) => b.px - a.px);
    let pts = 0, n = 0;
    const on = new Set<SoftRT>();
    for (const c of cand) {
      if (n >= this.budget.pieces || pts + c.rt.cost > this.budget.points) continue;
      on.add(c.rt);
      pts += c.rt.cost;
      n++;
    }
    for (const rt of this.items) rt.active = on.has(rt);
  }

  /**
   * Une image : simulation des pièces choisies, pièces figées recalées sur leur attache. Rend vrai si quelque chose
   * a bougé (rendu et ombres à refaire).
   */
  update(dt: number, frustum: THREE.Frustum, pxPerM: (p: THREE.Vector3) => number, shown: (rt: SoftRT) => boolean): boolean {
    if (!this.items.length) return false;
    const t0 = performance.now();
    try {
      return this.update1(dt, frustum, pxPerM, shown);
    } finally {
      this.ms = this.ms * 0.9 + (performance.now() - t0) * 0.1;
    }
  }

  private update1(dt: number, frustum: THREE.Frustum, pxPerM: (p: THREE.Vector3) => number, shown: (rt: SoftRT) => boolean): boolean {
    // choix des pièces simulées 4 fois par seconde (temps réel : indépendant de la vitesse d'animation)
    const now = performance.now();
    if (now >= this.evalT) {
      this.evalT = now + 250;
      this.choose(frustum, pxPerM, shown);
    }
    let moved = false;
    let count = 0;
    for (const rt of this.items) {
      if (!rt.mesh.visible) continue;
      const prev = rt.m.slice();
      if (!this.attach(rt, rt.piece.bone, rt.m)) continue;
      if (rt.active) {
        count++;
        if (rt.frozenAt) {
          // reprise : l'état figé suit l'attache jusqu'ici, sans élan
          tmpM.fromArray(rt.m as unknown as number[]).multiply(tmpI.fromArray(rt.frozenAt as unknown as number[]).invert());
          rt.ps.sim.transformAll(tmpM.elements);
          rt.frozenAt = null;
          rt.pos0 = rt.nrm0 = null;
        }
        this.updateSpheres(rt);
        if (this.stepSim(rt, dt)) {
          this.write(rt);
          moved = true;
        }
        continue;
      }
      // figée : suit l'attache (acteur qui marche, objet glissé) sans calcul de tissu
      const g = rt.mesh.geometry;
      const pa = g.getAttribute("position") as THREE.BufferAttribute, na = g.getAttribute("normal") as THREE.BufferAttribute;
      if (!rt.frozenAt) {
        rt.frozenAt = Float64Array.from(rt.m);
        rt.pos0 = (pa.array as Float32Array).slice();
        rt.nrm0 = (na.array as Float32Array).slice();
        continue;
      }
      let same = true;
      for (let i = 0; i < 16 && same; i++) if (Math.abs(prev[i] - rt.m[i]) > 1e-7) same = false;
      if (same) continue;
      tmpM.fromArray(rt.m as unknown as number[]).multiply(tmpI.fromArray(rt.frozenAt as unknown as number[]).invert());
      tmpN.getNormalMatrix(tmpM);
      const e = tmpM.elements, ne = tmpN.elements;
      const P = pa.array as Float32Array, N = na.array as Float32Array, P0 = rt.pos0!, N0 = rt.nrm0!;
      for (let i = 0; i < P.length; i += 3) {
        const x = P0[i], y = P0[i + 1], z = P0[i + 2];
        P[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
        P[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        P[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        const a = N0[i], b = N0[i + 1], c = N0[i + 2];
        N[i] = ne[0] * a + ne[3] * b + ne[6] * c;
        N[i + 1] = ne[1] * a + ne[4] * b + ne[7] * c;
        N[i + 2] = ne[2] * a + ne[5] * b + ne[8] * c;
      }
      pa.needsUpdate = na.needsUpdate = true;
      moved = true;
    }
    this.activeCount = count;
    return moved;
  }

  /** Pièces d'un propriétaire (acteur ou objet). */
  of(owner: { actor?: string; obj?: number }): SoftRT[] {
    return this.items.filter((r) => (owner.actor !== undefined ? r.actor === owner.actor : r.obj === owner.obj));
  }

  /** Points simulés à l'image précédente (statistiques). */
  stats() {
    let pts = 0;
    for (const r of this.items) if (r.active) pts += r.cost;
    return { pieces: this.items.length, active: this.activeCount, points: pts, ms: Math.round(this.ms * 100) / 100 };
  }
  /** Temps de calcul moyen par image (ms, moyenne glissante). */
  private ms = 0;

  dispose() {
    for (const rt of this.items) {
      rt.mesh.removeFromParent();
      rt.mesh.geometry.dispose();
    }
    this.items.length = 0;
  }
}

/** Matrice (colonnes) : translation + cap autour de y. */
export function yawMatrix(x: number, y: number, z: number, yaw: number, out: Float64Array | M4) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out.fill(0);
  out[0] = c;
  out[2] = -s;
  out[5] = 1;
  out[8] = s;
  out[10] = c;
  out[12] = x;
  out[13] = y;
  out[14] = z;
  out[15] = 1;
}
