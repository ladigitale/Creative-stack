/**
 * Maillage indexé de procgen : position, normale et attributs par sommet.
 *
 * - `role` : rôle de couleur (voir style/roles.ts), résolu au rendu ;
 * - `ao` : occlusion ambiante (1 = dégagé, 0 = fermé) ;
 * - `flex` : souplesse au vent (0 = rigide, 1 = bout de branche, feuillage) ;
 * - `obj` : identifiant d'objet (sélection, variation de teinte par objet) ;
 * - `skin` / `weight` : 4 os et 4 poids par sommet (personnages).
 */
import { type M4, type V3, m4Dir, m4NormalDir, m4Point, norm, cross, sub } from "../core/math";

export class Mesh {
  pos: number[] = [];
  nrm: number[] = [];
  role: number[] = [];
  ao: number[] = [];
  flex: number[] = [];
  obj: number[] = [];
  skin: number[] | null = null;
  weight: number[] | null = null;
  /** Décalage de morph (clignement) par sommet, en repère de repos ; nul sauf sur les paupières/yeux. */
  morph: number[] | null = null;
  /** Second rôle et part de mélange, encodés `rôle2 + part` (part ∈ [0, 1[) : usure du sol vers la terre battue. */
  blend: number[] | null = null;
  idx: number[] = [];

  get vertexCount() {
    return this.pos.length / 3;
  }
  get triangleCount() {
    return this.idx.length / 3;
  }

  vertex(p: V3, n: V3, role: number, ao = 1, flex = 0): number {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.role.push(role);
    this.ao.push(ao);
    this.flex.push(flex);
    this.obj.push(0);
    return this.pos.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }

  getPos(i: number): V3 {
    return [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]];
  }
  getNrm(i: number): V3 {
    return [this.nrm[i * 3], this.nrm[i * 3 + 1], this.nrm[i * 3 + 2]];
  }
  setPos(i: number, p: V3) {
    this.pos[i * 3] = p[0];
    this.pos[i * 3 + 1] = p[1];
    this.pos[i * 3 + 2] = p[2];
  }
  setNrm(i: number, n: V3) {
    this.nrm[i * 3] = n[0];
    this.nrm[i * 3 + 1] = n[1];
    this.nrm[i * 3 + 2] = n[2];
  }

  /** Ajoute `m` transformé par `t` ; `over` remplace des attributs (rôle, objet, souplesse) s'ils sont donnés. */
  append(m: Mesh, t?: M4, over: { role?: number; obj?: number; flex?: number; aoMul?: number } = {}): this {
    const base = this.vertexCount;
    const n = m.vertexCount;
    for (let i = 0; i < n; i++) {
      const p = m.getPos(i);
      const q = t ? m4Point(t, p) : p;
      const nn = t ? m4NormalDir(t, m.getNrm(i)) : m.getNrm(i);
      this.pos.push(q[0], q[1], q[2]);
      this.nrm.push(nn[0], nn[1], nn[2]);
      this.role.push(over.role ?? m.role[i]);
      this.ao.push(m.ao[i] * (over.aoMul ?? 1));
      this.flex.push(over.flex ?? m.flex[i]);
      this.obj.push(over.obj ?? m.obj[i]);
    }
    if (m.skin && m.weight) {
      if (!this.skin || !this.weight) {
        this.skin = new Array(base * 4).fill(0);
        this.weight = new Array(base * 4).fill(0).map((_, k) => (k % 4 === 0 ? 1 : 0));
      }
      this.skin.push(...m.skin);
      this.weight.push(...m.weight);
    } else if (this.skin && this.weight) {
      for (let i = 0; i < n; i++) {
        this.skin.push(0, 0, 0, 0);
        this.weight.push(1, 0, 0, 0);
      }
    }
    if (m.blend || this.blend) {
      if (!this.blend) this.blend = new Array(base).fill(0);
      if (m.blend) this.blend.push(...m.blend);
      else for (let i = 0; i < n; i++) this.blend.push(0);
    }
    if (m.morph || this.morph) {
      if (!this.morph) this.morph = new Array(base * 3).fill(0);
      if (m.morph) this.morph.push(...m.morph);
      else for (let i = 0; i < n * 3; i++) this.morph.push(0);
    }
    for (const k of m.idx) this.idx.push(k + base);
    return this;
  }

  /** Applique une transformation en place. */
  transform(t: M4): this {
    for (let i = 0; i < this.vertexCount; i++) {
      this.setPos(i, m4Point(t, this.getPos(i)));
      this.setNrm(i, m4NormalDir(t, this.getNrm(i)));
    }
    return this;
  }

  setRole(role: number): this {
    this.role.fill(role);
    return this;
  }
  setFlex(f: number | ((p: V3) => number)): this {
    for (let i = 0; i < this.vertexCount; i++) this.flex[i] = typeof f === "number" ? f : f(this.getPos(i));
    return this;
  }
  setObj(id: number): this {
    this.obj.fill(id);
    return this;
  }
  mapPos(fn: (p: V3, i: number) => V3): this {
    for (let i = 0; i < this.vertexCount; i++) this.setPos(i, fn(this.getPos(i), i));
    return this;
  }

  /** Normales lissées recalculées depuis les triangles (pondération par aire). */
  computeNormals(): this {
    const acc = new Float64Array(this.pos.length);
    for (let t = 0; t < this.idx.length; t += 3) {
      const a = this.idx[t], b = this.idx[t + 1], c = this.idx[t + 2];
      const n = cross(sub(this.getPos(b), this.getPos(a)), sub(this.getPos(c), this.getPos(a)));
      for (const v of [a, b, c]) {
        acc[v * 3] += n[0];
        acc[v * 3 + 1] += n[1];
        acc[v * 3 + 2] += n[2];
      }
    }
    for (let i = 0; i < this.vertexCount; i++) this.setNrm(i, norm([acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]]));
    return this;
  }

  /** Facettage : chaque triangle reçoit ses propres sommets et sa normale (style low-poly). */
  facet(): Mesh {
    const o = new Mesh();
    if (this.skin) {
      o.skin = [];
      o.weight = [];
    }
    for (let t = 0; t < this.idx.length; t += 3) {
      const ids = [this.idx[t], this.idx[t + 1], this.idx[t + 2]];
      const ps = ids.map((i) => this.getPos(i));
      const n = norm(cross(sub(ps[1], ps[0]), sub(ps[2], ps[0])));
      const base = o.vertexCount;
      ids.forEach((i, k) => {
        o.vertex(ps[k], n, this.role[i], this.ao[i], this.flex[i]);
        o.obj[o.obj.length - 1] = this.obj[i];
        if (this.skin && this.weight) {
          o.skin!.push(...this.skin.slice(i * 4, i * 4 + 4));
          o.weight!.push(...this.weight.slice(i * 4, i * 4 + 4));
        }
      });
      o.tri(base, base + 1, base + 2);
    }
    return o;
  }

  /** Boîte englobante. */
  bounds(): { min: V3; max: V3 } {
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.pos.length; i += 3)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], this.pos[i + k]);
        max[k] = Math.max(max[k], this.pos[i + k]);
      }
    if (!this.pos.length) return { min: [0, 0, 0], max: [0, 0, 0] };
    return { min, max };
  }

  /** Voisinage (liste d'adjacence) des sommets. */
  adjacency(): number[][] {
    const adj: Set<number>[] = Array.from({ length: this.vertexCount }, () => new Set<number>());
    for (let t = 0; t < this.idx.length; t += 3) {
      const a = this.idx[t], b = this.idx[t + 1], c = this.idx[t + 2];
      adj[a].add(b).add(c);
      adj[b].add(a).add(c);
      adj[c].add(a).add(b);
    }
    return adj.map((s) => [...s]);
  }

  clone(): Mesh {
    const o = new Mesh();
    o.pos = this.pos.slice();
    o.nrm = this.nrm.slice();
    o.role = this.role.slice();
    o.ao = this.ao.slice();
    o.flex = this.flex.slice();
    o.obj = this.obj.slice();
    o.idx = this.idx.slice();
    o.skin = this.skin ? this.skin.slice() : null;
    o.weight = this.weight ? this.weight.slice() : null;
    o.morph = this.morph ? this.morph.slice() : null;
    o.blend = this.blend ? this.blend.slice() : null;
    return o;
  }
}

export const dirOf = m4Dir;
