/**
 * Parties mobiles au rendu 3D : chaque partie est une instance à part (voir `scene/compose.ts`), sa matrice vaut
 * matrice de l'objet × mouvement de la partie (`gen/joints.ts`). Changer un état ne réécrit que ces matrices : ni
 * recomposition, ni nouveau maillage, l'objet reste instancié. Passage doux : `speed` secondes par course complète.
 */
import * as THREE from "three";
import { type M4, m4Dir, m4Invert, m4Mul, m4Point } from "../core/math";
import { type JointInfo, jointChain } from "../gen/joints";
import type { ObjectInfo, PointLight } from "../scene/compose";

/** Partie instanciée (instance `i` de `im`) ou fusionnée dans une tuile (sommets `a…b` de `mesh`, repère de la partie fermée). */
type Slot = { im: THREE.InstancedMesh; i: number; def: JointInfo; tile?: undefined } | { im?: undefined; def: JointInfo; tile: { mesh: THREE.Mesh; a: number; b: number; pos: Float32Array; nrm: Float32Array } };
type RT = { o: ObjectInfo; slots: Slot[]; cur: Record<string, number>; target: Record<string, number> };
/** Valeur imposée par le rendu (roues d'un véhicule qui roule, portière ouverte pour monter) : `snap` = sans passage doux. */
type Hold = { v: number; snap: boolean };

export type StateEvent = { objectId: string; part: string; value: number };

export class StateLayer {
  private rts = new Map<string, RT>();
  /** Maillage instancié d'une partie → nom de la partie (événement `pick.part`). */
  readonly partOf = new Map<THREE.InstancedMesh, string>();
  private values: Record<string, Record<string, number>> = {};
  /** Tuiles touchées depuis le dernier rendu (sommets réécrits). */
  readonly tilesTouched = new Set<THREE.Mesh>();
  /** Durée d'une course complète (s) ; 0 : immédiat. */
  speed = 0.6;
  /** Lumières des états libres (`burning`, `lit`). */
  lights: PointLight[] = [];
  onState: (e: StateEvent) => void = () => {};
  /** Matrice monde courante de l'objet (pose glissée, corps physique). */
  objMatrix: (o: ObjectInfo) => M4 = () => new Float64Array(16);
  private tmp = new THREE.Matrix4();
  /** Valeurs imposées par objet (conduite : roues, direction, portières), prioritaires sur les états demandés. */
  private holds = new Map<string, Record<string, Hold>>();

  clear() {
    this.rts.clear();
    this.partOf.clear();
    this.holds.clear();
  }

  /** Toutes les parties de l'objet (slots ou non : une direction sans maillage reste parente des roues). */
  private init(rt: RT) {
    for (const j of rt.o.joints ?? []) if (!(j.name in rt.cur)) rt.cur[j.name] = rt.target[j.name] = j.initial;
  }

  get count() {
    return this.rts.size;
  }

  /** Instances d'une partie (un groupe de la composition). */
  add(im: THREE.InstancedMesh, joint: string, objs: number[], byObj: Map<number, ObjectInfo>) {
    this.partOf.set(im, joint);
    objs.forEach((ob, i) => {
      const o = byObj.get(ob);
      const def = o?.joints?.find((j) => j.name === joint);
      if (!o || !def) return;
      let rt = this.rts.get(o.id);
      if (!rt) this.rts.set(o.id, (rt = { o, slots: [], cur: {}, target: {} }));
      rt.slots.push({ im, i, def });
      this.init(rt);
    });
  }

  /** Parties d'un objet fusionné dans une tuile : sommets ramenés dans le repère de la partie fermée. */
  addTile(o: ObjectInfo, mesh: THREE.Mesh, ranges: Record<string, [number, number]>) {
    const pa = mesh.geometry.getAttribute("position").array as Float32Array, na = mesh.geometry.getAttribute("normal").array as Float32Array;
    const M = this.objMatrix(o);
    for (const def of o.joints ?? []) {
      const r = ranges[def.name];
      if (!r) continue;
      const inv = m4Invert(m4Mul(M, jointChain(o.joints!, def, (n) => o.joints!.find((x) => x.name === n)?.initial ?? 0)));
      const n = r[1] - r[0];
      const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) {
        const v = r[0] + k;
        const p = m4Point(inv, [pa[v * 3], pa[v * 3 + 1], pa[v * 3 + 2]]);
        const d = m4Dir(inv, [na[v * 3], na[v * 3 + 1], na[v * 3 + 2]]);
        const l = Math.hypot(d[0], d[1], d[2]) || 1;
        pos.set(p, k * 3);
        nrm.set([d[0] / l, d[1] / l, d[2] / l], k * 3);
      }
      let rt = this.rts.get(o.id);
      if (!rt) this.rts.set(o.id, (rt = { o, slots: [], cur: {}, target: {} }));
      rt.slots.push({ def, tile: { mesh, a: r[0], b: r[1], pos, nrm } });
      this.init(rt);
    }
  }

  /** Partie d'une tuile sous un sommet (pick), sinon `null`. */
  partAt(o: ObjectInfo, mesh: THREE.Object3D, vertex: number): string | null {
    const rt = this.rts.get(o.id);
    for (const s of rt?.slots ?? []) if (s.tile && s.tile.mesh === mesh && vertex >= s.tile.a && vertex < s.tile.b) return s.def.name;
    return null;
  }

  /** Nouveau modèle monté : les états demandés s'appliquent d'un coup (pas d'animation après une recomposition). */
  mounted(): Set<THREE.InstancedMesh> {
    const touched = new Set<THREE.InstancedMesh>();
    for (const rt of this.rts.values()) {
      this.retarget(rt);
      Object.assign(rt.cur, rt.target);
      this.write(rt, touched);
    }
    this.publish();
    return touched;
  }

  /** États voulus (déjà validés par `scene/states.ts`) ; vrai si une partie doit bouger. */
  set(values: Record<string, Record<string, number>>, speed: number, lights: PointLight[]): boolean {
    this.values = values;
    this.speed = speed;
    this.lights = lights;
    let any = false;
    for (const rt of this.rts.values()) {
      this.retarget(rt);
      for (const k of Object.keys(rt.target)) if (Math.abs(rt.target[k] - rt.cur[k]) > 1e-6) any = true;
    }
    this.publish();
    return any;
  }

  private retarget(rt: RT) {
    const v = this.values[rt.o.id];
    const h = this.holds.get(rt.o.id);
    for (const j of rt.o.joints ?? []) rt.target[j.name] = h?.[j.name] ? h[j.name].v : typeof v?.[j.name] === "number" ? v[j.name] : j.initial;
  }

  /**
   * Impose des valeurs à des parties (conduite) : `snap` les pose tout de suite (roues, direction : rien n'est
   * publié), sinon elles y vont en douceur (portière : événement `state` à l'arrivée). `null` rend la partie aux états
   * demandés. Rend les maillages touchés.
   */
  hold(id: string, values: Record<string, number | null>, snap: boolean, touched = new Set<THREE.InstancedMesh>()): Set<THREE.InstancedMesh> {
    const rt = this.rts.get(id);
    if (!rt) return touched;
    let h = this.holds.get(id);
    if (!h) this.holds.set(id, (h = {}));
    let any = false;
    for (const [k, v] of Object.entries(values)) {
      if (!(k in rt.cur)) continue;
      if (v === null) delete h[k];
      else h[k] = { v, snap };
      any = true;
    }
    if (!Object.keys(h).length) this.holds.delete(id);
    if (!any) return touched;
    this.retarget(rt);
    if (snap) {
      let moved = false;
      for (const k of Object.keys(values)) if (k in rt.cur && rt.cur[k] !== rt.target[k]) ((rt.cur[k] = rt.target[k]), (moved = true));
      if (moved) {
        this.write(rt, touched);
        rt.o.states = { ...(this.values[rt.o.id] ?? {}), ...rt.cur };
      }
    }
    return touched;
  }

  /** Valeur courante d'une partie (ou `null`). */
  value(id: string, part: string): number | null {
    const v = this.rts.get(id)?.cur[part];
    return typeof v === "number" ? v : null;
  }

  /** L'objet a-t-il cette partie (instanciée ou fusionnée) ? */
  has(id: string, part: string): boolean {
    return !!this.rts.get(id) && part in this.rts.get(id)!.cur;
  }

  /** États courants recopiés dans les objets (sélection, `ids`, vectoriel) : parties et états libres. */
  private publish() {
    for (const rt of this.rts.values()) rt.o.states = { ...(this.values[rt.o.id] ?? {}), ...rt.cur };
  }

  get moving(): boolean {
    for (const rt of this.rts.values()) for (const k in rt.target) if (rt.target[k] !== rt.cur[k]) return true;
    return false;
  }

  /** Avance les parties vers leur cible ; rend les maillages touchés. */
  step(dt: number): Set<THREE.InstancedMesh> {
    const touched = new Set<THREE.InstancedMesh>();
    const k = this.speed > 0 ? dt / this.speed : 1;
    for (const rt of this.rts.values()) {
      let moved = false;
      for (const name in rt.target) {
        const a = rt.cur[name], b = rt.target[name];
        if (a === b) continue;
        const n = Math.abs(b - a) <= k ? b : a + Math.sign(b - a) * k;
        rt.cur[name] = n;
        moved = true;
        if (n === b) this.onState({ objectId: rt.o.id, part: name, value: Math.round(b * 1000) / 1000 });
      }
      if (moved) {
        this.write(rt, touched);
        rt.o.states = { ...(this.values[rt.o.id] ?? {}), ...rt.cur };
      }
    }
    return touched;
  }

  /** L'objet a bougé (glisser, corps physique) : ses parties suivent. */
  sync(id: string, touched = new Set<THREE.InstancedMesh>()): Set<THREE.InstancedMesh> {
    const rt = this.rts.get(id);
    if (rt) this.write(rt, touched);
    return touched;
  }

  private write(rt: RT, touched: Set<THREE.InstancedMesh>) {
    const M = this.objMatrix(rt.o);
    for (const s of rt.slots) {
      const W = m4Mul(M, jointChain(rt.o.joints ?? [s.def], s.def, (n) => rt.cur[n] ?? 0));
      if (s.tile) this.writeTile(s.tile, W);
      else {
        s.im.setMatrixAt(s.i, this.tmp.fromArray(W as unknown as number[]));
        touched.add(s.im);
      }
      // ancres de la partie (`lid.top`) : suivent la partie
      for (const [k, p] of Object.entries(s.def.anchors ?? {})) rt.o.anchors[`${s.def.name}.${k}`] = m4Point(W, p);
    }
  }

  private writeTile(t: { mesh: THREE.Mesh; a: number; b: number; pos: Float32Array; nrm: Float32Array }, W: M4) {
    const g = t.mesh.geometry;
    const pa = g.getAttribute("position") as THREE.BufferAttribute, na = g.getAttribute("normal") as THREE.BufferAttribute;
    const P = pa.array as Float32Array, N = na.array as Float32Array;
    const n = t.b - t.a;
    for (let k = 0; k < n; k++) {
      const p = m4Point(W, [t.pos[k * 3], t.pos[k * 3 + 1], t.pos[k * 3 + 2]]);
      const d = m4Dir(W, [t.nrm[k * 3], t.nrm[k * 3 + 1], t.nrm[k * 3 + 2]]);
      const l = Math.hypot(d[0], d[1], d[2]) || 1;
      const v = (t.a + k) * 3;
      P[v] = p[0];
      P[v + 1] = p[1];
      P[v + 2] = p[2];
      N[v] = d[0] / l;
      N[v + 1] = d[1] / l;
      N[v + 2] = d[2] / l;
    }
    pa.clearUpdateRanges?.();
    pa.addUpdateRange?.(t.a * 3, n * 3);
    pa.needsUpdate = true;
    na.clearUpdateRanges?.();
    na.addUpdateRange?.(t.a * 3, n * 3);
    na.needsUpdate = true;
    this.tilesTouched.add(t.mesh);
  }

  /** Valeurs courantes d'un objet (parties), pour `selection.parts`. */
  current(id: string): Record<string, number> | null {
    return this.rts.get(id)?.cur ?? null;
  }
}
