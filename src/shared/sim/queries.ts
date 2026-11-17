/**
 * Collisions en jeu, sans moteur physique : requêtes (rayon, sphère, boîte) contre les formes de collision du monde,
 * et capteurs (zones qui détectent sans bloquer). Les formes sont les boîtes orientées des modèles (une par pièce, ou
 * la forme écrite `collider`), placées par la pose courante des instances.
 */
import type { Monde } from "../monde/format";
import type { MondeDriver } from "../monde/driver";
import { hull, penetration, placeBoxes, type Obb } from "../monde/collide";

type V3 = [number, number, number];

export type Shape = {
  /** Instance nommée, ou vide pour le décor. */
  name: string;
  model: string;
  tags: string[];
  sensor: boolean;
  boxes: Obb[];
  lo: V3;
  hi: V3;
};

export type QuerySpec = {
  ray?: { from: V3; dir: V3; max: number };
  sphere?: { at: V3; r: number };
  box?: { lo: V3; hi: V3 };
  mask: string[];
  /** Instances ignorées (le tireur lui-même). */
  ignore: string[];
  live: boolean;
};

export type QueryResult = {
  n: number;
  hit: boolean;
  instance?: string;
  model?: string;
  tags?: string[];
  x?: number;
  y?: number;
  z?: number;
  normal?: V3;
  dist?: number;
  /** Sphère et boîte : tout ce qui chevauche (16 au plus). */
  all?: { instance: string; model: string; tags: string[] }[];
};

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const vec = (v: unknown, k: number): V3 | null => (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(fin) ? [v[0] * k, v[1] * k, v[2] * k] : null);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0).slice(0, 16) : typeof v === "string" && v ? [v] : []);
const r3 = (v: number) => Math.round(v * 1000) / 1000 + 0;

/** Lecture d'une requête du DataProvider (`queries.<id>`), longueurs dans l'unité du document. */
export function readQuery(v: unknown, u: number): QuerySpec | null {
  if (!isObj(v)) return null;
  const q: QuerySpec = { mask: strs(v.mask), ignore: strs(v.ignore), live: v.live === true };
  if (isObj(v.ray)) {
    const from = vec(v.ray.from, u), dir = vec(v.ray.dir, 1);
    if (from && dir) {
      const l = Math.hypot(dir[0], dir[1], dir[2]);
      if (l > 1e-9) q.ray = { from, dir: [dir[0] / l, dir[1] / l, dir[2] / l], max: fin(v.ray.max) ? Math.max(0, v.ray.max * u) : 100 };
    }
  }
  if (isObj(v.sphere)) {
    const at = vec(v.sphere.at, u);
    if (at && fin(v.sphere.r)) q.sphere = { at, r: Math.max(0, v.sphere.r * u) };
  }
  if (isObj(v.box)) {
    const lo = vec(v.box.lo, u), hi = vec(v.box.hi, u);
    if (lo && hi) q.box = { lo: [Math.min(lo[0], hi[0]), Math.min(lo[1], hi[1]), Math.min(lo[2], hi[2])], hi: [Math.max(lo[0], hi[0]), Math.max(lo[1], hi[1]), Math.max(lo[2], hi[2])] };
  }
  return q.ray || q.sphere || q.box ? q : null;
}

function tagsOf(m: Monde | null, name: string, model: string, own: readonly string[] | undefined): string[] {
  const base = model.split("~")[0];
  const p = m && Object.prototype.hasOwnProperty.call(m.prefabs, base) ? m.prefabs[base] : null;
  const out = [base, ...(p?.tags ?? []), ...(own ?? [])];
  if (name) out.unshift(name);
  else out.push("decor");
  if (p?.famille) out.push(p.famille);
  return out;
}

/** Formes du monde à l'instant : instances nommées visibles (pose courante) puis décor. */
export function shapesOf(driver: MondeDriver, decor: Shape[] | null): Shape[] {
  const m = driver.monde;
  const out: Shape[] = [];
  for (const inst of driver.instances.values()) {
    if (!inst.visible) continue;
    const t = inst.t;
    const boxes = placeBoxes(inst.model, [t.x, t.y, t.z], [t.rx, t.ry, t.rz], [t.sx, t.sy, t.sz]);
    if (!boxes.length) continue;
    const h = hull(boxes);
    out.push({ name: inst.name, model: inst.placement.model, tags: tagsOf(m, inst.name, inst.placement.model, inst.placement.tags), sensor: inst.placement.sensor === true, boxes, lo: h.lo, hi: h.hi });
  }
  if (decor) out.push(...decor);
  return out;
}

/** Formes du décor sans nom (fixes : calculées une fois par monde), 4 000 au plus. */
export function decorShapes(m: Monde): Shape[] {
  const out: Shape[] = [];
  for (const pl of m.place) {
    if (pl.name || pl.hidden) continue;
    const model = m.models.get(pl.model);
    if (!model) continue;
    const boxes = placeBoxes(model, pl.at, pl.rot, pl.scale);
    if (!boxes.length) continue;
    const h = hull(boxes);
    out.push({ name: "", model: pl.model, tags: tagsOf(m, "", pl.model, pl.tags), sensor: pl.sensor === true, boxes, lo: h.lo, hi: h.hi });
    if (out.length >= 4000) break;
  }
  return out;
}

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Rayon contre une boîte orientée : distance d'entrée et normale de la face touchée, ou `null`. */
export function rayObb(o: V3, d: V3, b: Obb, max: number): { t: number; n: V3 } | null {
  let t0 = 0, t1 = max, axis = -1, sign = 1;
  const p: V3 = [b.c[0] - o[0], b.c[1] - o[1], b.c[2] - o[2]];
  for (let a = 0; a < 3; a++) {
    const ax = b.ax[a];
    const e = dot(ax, p), f = dot(ax, d), h = Math.max(b.h[a], 1e-4);
    if (Math.abs(f) > 1e-9) {
      let ta = (e + h) / f, tb = (e - h) / f;
      if (ta > tb) {
        const x = ta;
        ta = tb;
        tb = x;
      }
      if (ta > t0) {
        t0 = ta;
        axis = a;
        sign = f > 0 ? -1 : 1;
      }
      if (tb < t1) t1 = tb;
      if (t0 > t1) return null;
    } else if (-e - h > 0 || -e + h < 0) return null;
  }
  // départ à l'intérieur : la boîte est touchée tout de suite, normale opposée au rayon
  if (axis < 0) return { t: 0, n: [-d[0], -d[1], -d[2]] };
  const ax = b.ax[axis];
  return { t: t0, n: [ax[0] * sign, ax[1] * sign, ax[2] * sign] };
}

function masked(s: Shape, q: QuerySpec): boolean {
  if (s.name && q.ignore.includes(s.name)) return false;
  // un capteur n'est vu que s'il est demandé par le masque
  if (!q.mask.length) return !s.sensor;
  return s.tags.some((t) => q.mask.includes(t)) || (s.sensor && q.mask.includes("sensor"));
}

function boxOf(lo: V3, hi: V3): Obb {
  return { c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], ax: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], h: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2] };
}

/** Exécute une requête ; `n` (compteur de la demande) est recopié dans la réponse. */
export function runQuery(q: QuerySpec, shapes: Shape[], n: number): QueryResult {
  if (q.ray) {
    const { from, dir, max } = q.ray;
    let best: { t: number; n: V3; s: Shape } | null = null;
    for (const s of shapes) {
      if (!masked(s, q)) continue;
      for (const b of s.boxes) {
        const h = rayObb(from, dir, b, best ? best.t : max);
        if (h && (!best || h.t < best.t)) best = { ...h, s };
      }
    }
    // le sol (y = 0) arrête aussi un rayon descendant, si le masque le demande ou s'il n'y a pas de masque
    if (dir[1] < -1e-6 && (!q.mask.length || q.mask.includes("sol"))) {
      const t = -from[1] / dir[1];
      if (t >= 0 && t <= max && (!best || t < best.t)) return { n, hit: true, instance: "", model: "sol", tags: ["sol"], x: r3(from[0] + dir[0] * t), y: 0, z: r3(from[2] + dir[2] * t), normal: [0, 1, 0], dist: r3(t) };
    }
    if (!best) return { n, hit: false };
    const t = best.t;
    return { n, hit: true, instance: best.s.name, model: best.s.model.split("~")[0], tags: best.s.tags, x: r3(from[0] + dir[0] * t), y: r3(from[1] + dir[1] * t), z: r3(from[2] + dir[2] * t), normal: best.n.map(r3) as V3, dist: r3(t) };
  }
  const probe = q.sphere ? boxOf([q.sphere.at[0] - q.sphere.r, q.sphere.at[1] - q.sphere.r, q.sphere.at[2] - q.sphere.r], [q.sphere.at[0] + q.sphere.r, q.sphere.at[1] + q.sphere.r, q.sphere.at[2] + q.sphere.r]) : boxOf(q.box!.lo, q.box!.hi);
  const all: NonNullable<QueryResult["all"]> = [];
  for (const s of shapes) {
    if (!masked(s, q)) continue;
    const lo = probe.c.map((c, a) => c - probe.h[a]), hi = probe.c.map((c, a) => c + probe.h[a]);
    if (s.hi[0] < lo[0] || s.lo[0] > hi[0] || s.hi[1] < lo[1] || s.lo[1] > hi[1] || s.hi[2] < lo[2] || s.lo[2] > hi[2]) continue;
    if (!s.boxes.some((b) => penetration(probe, b) > 0)) continue;
    // sphère : le point le plus proche de chaque boîte doit être dans le rayon
    if (q.sphere && !s.boxes.some((b) => distObb(q.sphere!.at, b) <= q.sphere!.r)) continue;
    all.push({ instance: s.name, model: s.model.split("~")[0], tags: s.tags });
    if (all.length >= 16) break;
  }
  const first = all[0];
  return first ? { n, hit: true, instance: first.instance, model: first.model, tags: first.tags, all } : { n, hit: false, all: [] };
}

/** Distance d'un point à une boîte orientée (0 dedans). */
function distObb(p: V3, b: Obb): number {
  const d: V3 = [p[0] - b.c[0], p[1] - b.c[1], p[2] - b.c[2]];
  let s = 0;
  for (let a = 0; a < 3; a++) {
    const e = Math.abs(dot(d, b.ax[a])) - b.h[a];
    if (e > 0) s += e * e;
  }
  return Math.sqrt(s);
}

/**
 * Requêtes du DataProvider : une réponse à chaque hausse de `n`, ou à chaque image avec `live: true` (16 au plus).
 * Capteurs : les instances nommées qui entrent ou sortent de chaque capteur.
 */
export class GameProbe {
  private seen = new Map<string, number>();
  private specs = new Map<string, QuerySpec>();
  private decor: Shape[] | null = null;
  private own: Shape[] = [];
  private extraSig = "";
  private inside = new Map<string, Set<string>>();
  private unit = 1;
  private hasSensors = false;

  set(m: Monde) {
    this.unit = m.unit;
    this.own = decorShapes(m);
    this.decor = this.own;
    this.extraSig = "";
    this.hasSensors = m.place.some((p) => p.sensor);
    for (const k of [...this.inside.keys()]) if (!m.place.some((p) => p.sensor && p.name === k)) this.inside.delete(k);
  }

  /** Formes ajoutées au décor (peuplement du monde infini proche) ; `sig` évite de refaire la liste. */
  setExtra(sig: string, shapes: Shape[]) {
    if (sig === this.extraSig) return;
    this.extraSig = sig;
    this.decor = shapes.length ? [...this.own, ...shapes] : this.own;
  }

  get busy(): boolean {
    return this.hasSensors || [...this.specs.values()].some((s) => s.live);
  }

  /** Nouvelles demandes ; rend les réponses à publier tout de suite (`{id: résultat}`). */
  apply(spec: unknown, driver: MondeDriver): Record<string, QueryResult> | null {
    if (!isObj(spec)) return null;
    let out: Record<string, QueryResult> | null = null;
    let shapes: Shape[] | null = null;
    for (const [id, raw] of Object.entries(spec).slice(0, 16)) {
      const q = readQuery(raw, this.unit);
      if (!q) {
        this.specs.delete(id);
        continue;
      }
      this.specs.set(id, q);
      const n = isObj(raw) && fin(raw.n) ? raw.n : 0;
      const prev = this.seen.get(id);
      this.seen.set(id, n);
      if (prev !== undefined && n <= prev && !q.live) continue;
      shapes ??= shapesOf(driver, this.decor);
      (out ??= {})[id] = runQuery(q, shapes, n);
    }
    return out;
  }

  /** À chaque image : requêtes vivantes et capteurs. */
  step(driver: MondeDriver): { results: Record<string, QueryResult> | null; events: { type: "enter" | "leave"; sensor: string; instance: string; tags: string[] }[] } {
    const events: { type: "enter" | "leave"; sensor: string; instance: string; tags: string[] }[] = [];
    let results: Record<string, QueryResult> | null = null;
    if (!this.busy) return { results, events };
    const shapes = shapesOf(driver, this.decor);
    for (const [id, q] of this.specs) if (q.live) (results ??= {})[id] = runQuery(q, shapes, this.seen.get(id) ?? 0);
    if (this.hasSensors) {
      const movers = shapes.filter((s) => s.name && !s.sensor);
      for (const sen of shapes) {
        if (!sen.sensor || !sen.name) continue;
        const now = new Set<string>();
        for (const mv of movers) {
          if (mv.hi[0] < sen.lo[0] || mv.lo[0] > sen.hi[0] || mv.hi[1] < sen.lo[1] || mv.lo[1] > sen.hi[1] || mv.hi[2] < sen.lo[2] || mv.lo[2] > sen.hi[2]) continue;
          if (sen.boxes.some((a) => mv.boxes.some((b) => penetration(a, b) > 0))) now.add(mv.name);
        }
        const before = this.inside.get(sen.name) ?? new Set<string>();
        for (const n of now) if (!before.has(n)) events.push({ type: "enter", sensor: sen.name, instance: n, tags: movers.find((s) => s.name === n)!.tags });
        for (const n of before) if (!now.has(n)) events.push({ type: "leave", sensor: sen.name, instance: n, tags: movers.find((s) => s.name === n)?.tags ?? [n] });
        this.inside.set(sen.name, now);
      }
    }
    return { results, events };
  }
}
