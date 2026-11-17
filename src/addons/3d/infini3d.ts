/**
 * Monde infini dans `sonic-3d` : tuiles de sol (relief, couleur du biome par sommet) et peuplement instancié.
 *
 * Un `InstancedMesh` par pièce de chaque modèle peuplant, partagé par toutes les tuiles chargées : quel que soit le
 * nombre de tuiles, un appel de dessin par pièce. Les matrices ne sont recomposées que quand l'ensemble des tuiles
 * change (une tuile chargée ou relâchée), pas à chaque image.
 */
import * as THREE from "three";
import { m4, m4Mul } from "../../shared/monde/math";
import type { Model, Monde } from "../../shared/monde/format";
import { biomeAt, heightAt, TileManager, type Tile } from "../../shared/monde/infini";
import { composeYP } from "../../shared/sim/set";
import type { EmitPart } from "./emitters3d";

type Pool = { model: Model; parts: { im: THREE.InstancedMesh; local: Float32Array; part: EmitPart }[]; cap: number };

const SEG = 12;

export class InfiniLayer extends TileManager {
  readonly group = new THREE.Group();
  private grounds = new Map<string, THREE.Mesh>();
  private groundMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  private pools = new Map<string, Pool>();
  private partsOf: ((model: Model) => EmitPart[]) | null = null;
  private monde: Monde | null = null;
  private tmp = m4();
  private tmp2 = m4();
  private mat = new THREE.Matrix4();
  poseOf: ((name: string) => { x: number; z: number } | null) | null = null;
  onState: ((s: ReturnType<TileManager["state"]>) => void) | null = null;
  private lastState = 0;

  constructor() {
    super();
    this.group.name = "monde~infini";
  }

  mount(m: Monde, partsOf: (model: Model) => EmitPart[]) {
    this.monde = m;
    this.partsOf = partsOf;
    this.set(m.infini);
    // pièces et matières du monde relu : les pools sont refaits, les tuiles regénérées au besoin
    for (const p of this.pools.values()) for (const q of p.parts) q.im.dispose();
    this.pools.clear();
    this.group.clear();
    for (const g of this.grounds.values()) g.geometry.dispose();
    this.grounds.clear();
    this.changed = true;
  }

  /** Avance le chargement autour de l'instance suivie ; vrai si la scène a changé. */
  advance(now: number): boolean {
    const s = this.spec;
    if (!s || !this.monde) return false;
    const p = s.follow ? this.poseOf?.(s.follow) : null;
    const changed = this.update(p ? p.x : s.center[0], p ? p.z : s.center[1]);
    if (changed) this.rebuild();
    if (this.onState && now - this.lastState > 250) {
      this.lastState = now;
      this.onState(this.state());
    }
    return changed;
  }

  private rebuild() {
    const s = this.spec!;
    const m = this.monde!;
    // sols : une maille par tuile, gardée tant que la tuile reste chargée
    for (const [k, g] of this.grounds)
      if (!this.tiles.has(k)) {
        g.removeFromParent();
        g.geometry.dispose();
        this.grounds.delete(k);
      }
    for (const t of this.tiles.values()) if (!this.grounds.has(t.key)) this.grounds.set(t.key, this.groundOf(t));
    // peuplement : tous les objets des tuiles chargées, par modèle
    const byModel = new Map<string, { x: number; y: number; z: number; ry: number; s: number }[]>();
    for (const t of this.tiles.values())
      for (const it of t.items) {
        const l = byModel.get(it.model) ?? [];
        l.push(it);
        byModel.set(it.model, l);
      }
    for (const [name, pool] of this.pools) if (!byModel.has(name)) for (const q of pool.parts) q.im.count = 0;
    for (const [name, list] of byModel) {
      const model = m.models.get(name);
      if (!model) continue;
      let pool = this.pools.get(name);
      if (!pool || pool.cap < list.length) {
        const cap = Math.max(64, Math.ceil(list.length * 1.5));
        const parts = (pool ? pool.parts.map((q) => q.part) : this.partsOf!(model)).map((part) => {
          const im = new THREE.InstancedMesh(part.geo, part.mat, cap);
          im.name = `${name}~infini`;
          im.frustumCulled = false;
          for (let k = 0; k < cap; k++) im.setColorAt(k, part.color);
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
          return { im, local: part.local, part };
        });
        if (pool) for (const q of pool.parts) {
          q.im.removeFromParent();
          q.im.dispose();
        }
        pool = { model, parts, cap };
        for (const q of parts) this.group.add(q.im);
        this.pools.set(name, pool);
      }
      list.forEach((it, k) => {
        composeYP(this.tmp, it.x, it.y, it.z, it.ry, 0, it.s);
        for (const q of pool!.parts) {
          m4Mul(this.tmp2, this.tmp, q.local);
          this.mat.fromArray(this.tmp2);
          q.im.setMatrixAt(k, this.mat);
        }
      });
      for (const q of pool.parts) {
        q.im.count = list.length;
        q.im.instanceMatrix.needsUpdate = true;
      }
    }
    void s;
  }

  /** Maille de sol d'une tuile : relief et couleur du biome à chaque sommet (raccord exact avec les voisines). */
  private groundOf(t: Tile): THREE.Mesh {
    const s = this.spec!;
    const T = s.tile;
    const x0 = t.cx * T, z0 = t.cz * T;
    const n = SEG + 1;
    const pos = new Float32Array(n * n * 3);
    const col = new Float32Array(n * n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const x = x0 + (i / SEG) * T, z = z0 + (j / SEG) * T;
        const k = (i * n + j) * 3;
        pos[k] = x;
        pos[k + 1] = heightAt(s, x, z);
        pos[k + 2] = z;
        c.set(biomeAt(s, x, z).color);
        col[k] = c.r;
        col[k + 1] = c.g;
        col[k + 2] = c.b;
      }
    const idx: number[] = [];
    for (let i = 0; i < SEG; i++)
      for (let j = 0; j < SEG; j++) {
        const a = i * n + j, b = (i + 1) * n + j;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, this.groundMat);
    mesh.name = `infini~sol~${t.key}`;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  dispose() {
    for (const p of this.pools.values()) for (const q of p.parts) q.im.dispose();
    this.pools.clear();
    for (const g of this.grounds.values()) g.geometry.dispose();
    this.grounds.clear();
    this.groundMat.dispose();
    this.group.clear();
  }
}
