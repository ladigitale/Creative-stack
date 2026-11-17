/**
 * Émetteurs d'un monde, indépendants du rendu : simulations gardées d'une lecture du monde à l'autre (tant que la
 * définition ne change pas), ordres du DataProvider, boîtes du monde pour les contacts, état publié.
 * `sonic-3d` (instances three.js) et `sonic-2d` (silhouettes Pixi) n'ajoutent que le dessin.
 */
import type { Monde } from "../monde/format";
import { placeBoxes, hull } from "../monde/collide";
import type { MondeDriver } from "../monde/driver";
import { BoxGrid, GridPair, type Aabb } from "./grid";
import { groundOf } from "./infini-shapes";
import { Emitter, readOrder, type EmitterSpec, type Hit, type SimWorld } from "./emitter";

export type EmitStats = Record<string, { alive: number; emitted: number; dropped: number; expired: number; ms: number; near?: { id: number; x: number; y: number; z: number; d: number }[] }>;

type Pose = { x: number; y: number; z: number; ry: number };
type Slot = { sig: string; sim: Emitter; seeded: boolean };

/** Signature d'une définition : ce qui oblige à repartir de zéro si cela change. */
function sigOf(s: EmitterSpec): string {
  return JSON.stringify([s.model, s.variants, s.behavior, s.max, s.spawn, s.seed]);
}

export class EmitterSet {
  private slots = new Map<string, Slot>();
  /** Simulations du monde courant, dans l'ordre de `monde.emitters`. */
  sims: Emitter[] = [];
  private grid = new BoxGrid(2);
  /** Peuplement du monde infini proche : refait seulement quand les tuiles proches changent. */
  private fixed = new BoxGrid(2);
  private fixedSig = "";
  private pair = new GridPair(this.grid, this.fixed);
  /** Hauteur du sol (relief du monde infini). */
  ground: (x: number, z: number) => number = () => 0;
  private staticBoxes: Aabb[] = [];
  private needsBoxes = false;
  private orders = new Map<string, { n: number; clear: number; kill: number }>();
  private unit = 1;
  private hits: Hit[] = [];
  /** Position affichée d'une instance nommée (le rendu resynchronise le pilote avec la scène). */
  poseOf: ((name: string) => Pose | null) | null = null;
  onHits: ((hits: Hit[]) => void) | null = null;
  onExpire: ((e: { emitter: string; count: number }) => void) | null = null;

  get active(): boolean {
    for (const s of this.sims) if (s.n > 0 || s.spec.rate > 0) return true;
    return false;
  }

  /** Monte les émetteurs d'un monde ; ceux dont la définition n'a pas changé gardent leurs copies. */
  set(m: Monde, driver: MondeDriver) {
    this.unit = m.unit;
    this.ground = groundOf(m);
    this.fixedSig = "";
    this.fixed.clear();
    const next = new Map<string, Slot>();
    for (const spec of m.emitters) {
      const sig = sigOf(spec);
      const old = this.slots.get(spec.id);
      let slot: Slot;
      if (old && old.sig === sig) {
        // les réglages vivants (vitesse, cible, débit…) suivent la nouvelle lecture
        Object.assign(old.sim.spec, spec);
        slot = old;
      } else slot = { sig, sim: new Emitter(spec), seeded: false };
      next.set(spec.id, slot);
    }
    this.slots = next;
    this.sims = [...next.values()].map((s) => s.sim);
    for (const id of [...this.orders.keys()]) if (!next.has(id)) this.orders.delete(id);
    this.needsBoxes = m.emitters.some((e) => e.mask.length > 0 || (e.flock?.avoid.length ?? 0) > 0);
    this.staticBoxes = this.needsBoxes ? decorBoxes(m) : [];
    for (const s of this.slots.values())
      if (!s.seeded) {
        s.seeded = true;
        s.sim.seed(this.world(driver));
      }
  }

  /**
   * Ordres `emit.<id>` : salve à chaque hausse de `n` (`count` copies), `clear` (compteur) vide le pool,
   * `kill: {n, ids}` retire des copies. La première lecture ne fait que mémoriser les compteurs.
   */
  applyOrders(spec: unknown, driver: MondeDriver): boolean {
    if (!spec || typeof spec !== "object") return false;
    let any = false;
    for (const [id, raw] of Object.entries(spec as Record<string, unknown>)) {
      const slot = this.slots.get(id);
      if (!slot || !raw || typeof raw !== "object") continue;
      const o = raw as { n?: unknown; clear?: unknown; kill?: { n?: unknown; ids?: unknown } };
      const n = typeof o.n === "number" ? o.n : 0;
      const clear = typeof o.clear === "number" ? o.clear : 0;
      const kill = o.kill && typeof o.kill === "object" && typeof o.kill.n === "number" ? o.kill.n : 0;
      const prev = this.orders.get(id);
      this.orders.set(id, { n, clear, kill });
      if (!prev) continue;
      if (clear > prev.clear) {
        slot.sim.clear();
        any = true;
      }
      if (kill > prev.kill && Array.isArray(o.kill!.ids)) {
        slot.sim.kill(o.kill!.ids.filter((v): v is number => typeof v === "number"));
        any = true;
      }
      if (n > prev.n) {
        const order = readOrder(raw, this.unit);
        // plusieurs hausses d'un coup : autant de salves (16 au plus)
        const salvos = Math.min(16, n - prev.n);
        for (let k = 0; k < salvos; k++) slot.sim.emit(order.count ?? 1, this.world(driver), order);
        any = true;
      }
    }
    return any;
  }

  world(driver: MondeDriver): SimWorld {
    return {
      boxes: this.pair,
      emitter: (id) => this.slots.get(id)?.sim ?? null,
      ground: (x, z) => this.ground(x, z),
      pose: (name) => {
        if (this.poseOf) return this.poseOf(name);
        const inst = driver.instances.get(name);
        if (!inst || !inst.visible) return null;
        return { x: inst.t.x, y: inst.t.y, z: inst.t.z, ry: inst.t.ry };
      },
    };
  }

  private rebuildGrid(driver: MondeDriver) {
    this.grid.clear();
    for (const b of this.staticBoxes) this.grid.add(b);
    const m = driver.monde;
    for (const inst of driver.instances.values()) {
      if (!inst.visible || inst.placement.sensor) continue;
      const t = inst.t;
      const boxes = placeBoxes(inst.model, [t.x, t.y, t.z], [t.rx, t.ry, t.rz], [t.sx, t.sy, t.sz]);
      if (!boxes.length) continue;
      const h = hull(boxes);
      this.grid.add({ name: inst.name, tags: tagsOf(m, inst.name, inst.model.name), lo: h.lo, hi: h.hi });
    }
  }

  /** Boîtes du peuplement infini proche (`sig` : clés des tuiles ; rien n'est refait si elle ne change pas). */
  setFixed(sig: string, boxes: Aabb[]) {
    if (sig === this.fixedSig) return;
    this.fixedSig = sig;
    this.fixed.clear();
    for (const b of boxes) this.fixed.add(b);
  }

  /** Avance toutes les simulations de `dt` secondes ; vrai si une copie a bougé. */
  step(dt: number, driver: MondeDriver): boolean {
    if (!this.sims.length) return false;
    if (this.needsBoxes) this.rebuildGrid(driver);
    const w = this.world(driver);
    this.hits.length = 0;
    let changed = false;
    for (const sim of this.sims) {
      const before = sim.expired;
      if (sim.advance(dt, w, this.hits)) changed = true;
      if (sim.expired > before && sim.spec.events.includes("expire")) this.onExpire?.({ emitter: sim.spec.id, count: sim.expired - before });
    }
    if (this.hits.length) this.onHits?.(this.hits.slice());
    return changed;
  }

  stats(driver: MondeDriver): EmitStats {
    const out: EmitStats = {};
    for (const s of this.sims) {
      const e: EmitStats[string] = { alive: s.n, emitted: s.emitted, dropped: s.dropped, expired: s.expired, ms: Math.round(s.ms * 100) / 100 };
      if (s.spec.publish > 0) {
        const target = s.spec.flock?.seek || s.spec.flock?.flee || s.spec.from;
        const p = target ? (this.poseOf?.(target) ?? driver.instances.get(target)?.t ?? null) : null;
        if (p) e.near = s.near(p.x, p.z, s.spec.publish);
      }
      out[s.spec.id] = e;
    }
    return out;
  }

  dispose() {
    this.slots.clear();
    this.sims = [];
    this.orders.clear();
  }
}

function tagsOf(m: Monde | null, name: string, model: string): string[] {
  const base = model.split("~")[0];
  const p = m && Object.prototype.hasOwnProperty.call(m.prefabs, base) ? m.prefabs[base] : null;
  const out = [base, ...(p?.tags ?? [])];
  if (name) out.unshift(name);
  else out.push("decor");
  if (p?.famille) out.push(p.famille);
  return out;
}

/** Boîtes englobantes du décor sans nom (murs et sols de l'espace compris), 4 000 au plus. */
function decorBoxes(m: Monde): Aabb[] {
  const out: Aabb[] = [];
  for (const pl of m.place) {
    if (pl.name || pl.hidden) continue;
    const model = m.models.get(pl.model);
    if (!model) continue;
    const boxes = placeBoxes(model, pl.at, pl.rot, pl.scale);
    if (!boxes.length) continue;
    const h = hull(boxes);
    out.push({ name: "", tags: tagsOf(m, "", pl.model), lo: h.lo, hi: h.hi });
    if (out.length >= 4000) break;
  }
  return out;
}

/** Cap autour de y puis tangage dans le repère tourné (le nez suit la trajectoire), échelle uniforme. */
export function composeYP(o: Float32Array, x: number, y: number, z: number, yaw: number, pitch: number, s: number) {
  const ch = Math.cos(yaw), sh = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  o[0] = ch * s;
  o[1] = 0;
  o[2] = -sh * s;
  o[3] = 0;
  o[4] = sh * sp * s;
  o[5] = cp * s;
  o[6] = ch * sp * s;
  o[7] = 0;
  o[8] = sh * cp * s;
  o[9] = -sp * s;
  o[10] = ch * cp * s;
  o[11] = 0;
  o[12] = x;
  o[13] = y;
  o[14] = z;
  o[15] = 1;
}
