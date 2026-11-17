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
import type { SimWorld } from "./emitter";
import { EmitterPool, type EmitStats } from "./pool";

export type { EmitStats };

type Pose = { x: number; y: number; z: number; ry: number };

export class EmitterSet extends EmitterPool {
  private grid = new BoxGrid(2);
  /** Peuplement du monde infini proche : refait seulement quand les tuiles proches changent. */
  private fixed = new BoxGrid(2);
  private fixedSig = "";
  private pair = new GridPair(this.grid, this.fixed);
  /** Hauteur du sol (relief du monde infini). */
  ground: (x: number, z: number) => number = () => 0;
  private staticBoxes: Aabb[] = [];
  private needsBoxes = false;
  /** Position affichée d'une instance nommée (le rendu resynchronise le pilote avec la scène). */
  poseOf: ((name: string) => Pose | null) | null = null;

  /** Monte les émetteurs d'un monde ; ceux dont la définition n'a pas changé gardent leurs copies. */
  set(m: Monde, driver: MondeDriver) {
    this.unit = m.unit;
    this.ground = groundOf(m);
    this.fixedSig = "";
    this.fixed.clear();
    this.needsBoxes = m.emitters.some((e) => e.mask.length > 0 || (e.flock?.avoid.length ?? 0) > 0);
    this.staticBoxes = this.needsBoxes ? decorBoxes(m) : [];
    this.mountSpecs(m.emitters, () => this.world(driver));
  }

  /** Ordres `emit.<id>` (voir `EmitterPool`). */
  applyOrders(spec: unknown, driver: MondeDriver): boolean {
    return this.ordersWith(spec, () => this.world(driver));
  }

  world(driver: MondeDriver): SimWorld {
    return {
      boxes: this.pair,
      emitter: (id) => this.sim(id),
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
    return this.stepWith(dt, this.world(driver));
  }

  stats(driver: MondeDriver): EmitStats {
    return this.statsWith((target) => this.poseOf?.(target) ?? driver.instances.get(target)?.t ?? null);
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
