/**
 * Monde infini de `sonic-procgen` : une recette déclare `infinite: {tile, radius, follow, seed, roads, persist}` et
 * son sol, ses routes et ses couches sont composés **par tuiles** autour d'un point suivi (acteur ou caméra).
 *
 * - Chaque tuile est une petite scène composée par `composeSteps` (même code que les scènes finies) en repère local,
 *   relief en coordonnées du monde (raccord exact), semis par cellule du monde (`place.scatter`), routes d'un réseau
 *   du monde (`roads`) déterministe : même graine → même monde, quel que soit le chemin parcouru.
 * - Les tuiles se composent par tranches dans un budget par image (ou dans un worker fourni par l'application) ; les
 *   plus proches d'abord ; relâchées derrière le point suivi (mécanique commune : `shared/monde/tiles.ts`).
 * - Retouches persistées par tuile (`tiles."cx,cz"` : `remove`, `move`, `add`) et bornées par un total.
 * - `TileWorld` présente les tuiles chargées comme un seul sol (`height`, `pathInfo`), une seule grille de navigation
 *   (`free`, `path`) et une seule liste d'objets : la vue, le rangement au doigt et les ballons s'en servent sans savoir
 *   qu'il y a des tuiles.
 *
 * Sans DOM ni three.js (testable, transportable dans un worker).
 */
import { clamp, type V3 } from "../core/math";
import { Rng, hash32 } from "../core/rng";
import { type Issue, Issues } from "../core/schema";
import type { Asset } from "../gen/types";
import { type ObjectInfo, type Recipe, type SceneModel, type TileEdit, composeSteps, deckHeight } from "./compose";
import { NavGrid } from "./nav";
import { type PathKind, type PathSpec, worldRelief } from "./terrain";
import { boundEdits, editCount, parseTileKey, ringTiles, tileKey, tileOf, tileTooFar } from "../../../shared/monde/tiles";

export type RoadNet = { id: string; kind: PathKind; width: number; sidewalk: number; spacing: number; density: number; wiggle: number };

export type InfiniteSpec = {
  tile: number;
  radius: number;
  /** Id d'acteur suivi, ou `camera` (centre de la vue). */
  follow: string;
  seed: string;
  roads: RoadNet[];
  /** Retouches persistées au plus (tout le monde confondu). */
  persist: number;
  /** Composition par image (ms). */
  budget: number;
  quality: "auto" | "low" | "high";
  /** Pas du maillage de sol (m). */
  step: number;
};

export const INFINITE_LIMITS = { radius: 4, tile: [8, 128] as const, persist: 5000, roads: 4 };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const KINDS: PathKind[] = ["street", "road", "path", "river", "plaza"];

/** Lecture de `recipe.infinite` ; `null` : scène finie. */
export function readInfinite(v: unknown, issues: Issues, defaultSeed: string): InfiniteSpec | null {
  if (v === undefined || v === null || v === false) return null;
  if (!isObj(v)) {
    issues.add({ path: "infinite", code: "type", message: "objet attendu ({tile, radius, follow, seed, roads, persist})" });
    return null;
  }
  const num = (k: string, d: number, lo: number, hi: number) => {
    const x = v[k];
    if (x === undefined) return d;
    if (!fin(x)) {
      issues.add({ path: `infinite.${k}`, code: "type", message: "nombre attendu", got: x, used: d });
      return d;
    }
    const c = clamp(x, lo, hi);
    if (c !== x) issues.add({ path: `infinite.${k}`, code: "clamped", message: "hors bornes", got: x, used: c });
    return c;
  };
  const tile = num("tile", 32, INFINITE_LIMITS.tile[0], INFINITE_LIMITS.tile[1]);
  const rawRoads = v.roads === undefined ? [] : v.roads === false ? [] : Array.isArray(v.roads) ? v.roads : [v.roads];
  const roads: RoadNet[] = [];
  for (const [i, r] of rawRoads.entries()) {
    if (roads.length >= INFINITE_LIMITS.roads) {
      issues.add({ path: "infinite.roads", code: "limit", message: `${INFINITE_LIMITS.roads} réseaux au plus` });
      break;
    }
    if (!isObj(r)) continue;
    const kind = KINDS.includes(r.kind as PathKind) ? (r.kind as PathKind) : "road";
    roads.push({
      id: typeof r.id === "string" && r.id ? r.id.slice(0, 32) : i ? `routes${i}` : "routes",
      kind,
      width: fin(r.width) ? clamp(r.width, 0.5, 30) : kind === "path" ? 1.6 : kind === "river" ? 6 : 4,
      sidewalk: fin(r.sidewalk) ? clamp(r.sidewalk, 0, 6) : kind === "street" ? 1.8 : 0,
      spacing: fin(r.spacing) ? clamp(r.spacing, tile, 2000) : Math.max(tile, 96),
      density: fin(r.density) ? clamp(r.density, 0, 1) : 0.7,
      wiggle: fin(r.wiggle) ? clamp(r.wiggle, 0, 0.45) : 0.2,
    });
  }
  const p = v.persist;
  const persist = p === undefined ? 400 : fin(p) ? clamp(Math.round(p), 0, INFINITE_LIMITS.persist) : isObj(p) && fin(p.total) ? clamp(Math.round(p.total), 0, INFINITE_LIMITS.persist) : 400;
  return {
    tile,
    radius: Math.round(num("radius", 2, 1, INFINITE_LIMITS.radius)),
    follow: typeof v.follow === "string" && v.follow ? v.follow : "camera",
    seed: typeof v.seed === "string" || fin(v.seed) ? String(v.seed) : defaultSeed,
    roads,
    persist,
    budget: num("budget", 4, 1, 16),
    quality: v.quality === "low" || v.quality === "high" ? v.quality : "auto",
    step: num("step", 1, 0.4, 4),
  };
}

/**
 * Réseau de routes du monde : un nœud par cellule de `spacing` m (position à désordre), une route entre deux nœuds
 * voisins avec la probabilité `density`, tracé légèrement sinueux. Renvoie les tronçons dont l'emprise touche le
 * rectangle (repère du monde) ; chaque tronçon a un id stable `<réseau>.<i>_<j>_<h|v>` et les mêmes points dans
 * toutes les tuiles (même relief de chaussée partout).
 */
export function worldRoads(spec: Pick<InfiniteSpec, "roads" | "seed">, x0: number, z0: number, x1: number, z1: number): PathSpec[] {
  const out: PathSpec[] = [];
  for (const net of spec.roads) {
    const S = net.spacing;
    const node = (i: number, j: number): [number, number] => {
      const r = new Rng(hash32(`${spec.seed}/${net.id}/n/${i}/${j}`));
      return [(i + 0.5 + (r.next() - 0.5) * 0.6) * S, (j + 0.5 + (r.next() - 0.5) * 0.6) * S];
    };
    const m = net.width + net.sidewalk * 2 + S * net.wiggle + 4;
    const i0 = Math.floor((x0 - m) / S) - 1, i1 = Math.floor((x1 + m) / S) + 1;
    const j0 = Math.floor((z0 - m) / S) - 1, j1 = Math.floor((z1 + m) / S) + 1;
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++)
        for (const dir of ["h", "v"] as const) {
          const r = new Rng(hash32(`${spec.seed}/${net.id}/e/${i}/${j}/${dir}`));
          if (r.next() >= net.density) continue;
          const a = node(i, j), b = dir === "h" ? node(i + 1, j) : node(i, j + 1);
          if (Math.max(a[0], b[0]) < x0 - m || Math.min(a[0], b[0]) > x1 + m || Math.max(a[1], b[1]) < z0 - m || Math.min(a[1], b[1]) > z1 + m) continue;
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L;
          const amp = (r.next() - 0.5) * 2 * net.wiggle * S * 0.35, amp2 = (r.next() - 0.5) * net.wiggle * S * 0.2;
          const pts: [number, number][] = [];
          const N = Math.max(4, Math.ceil(L / 12));
          for (let k = 0; k <= N; k++) {
            const t = k / N;
            const w = Math.sin(Math.PI * t) * amp + Math.sin(2 * Math.PI * t) * amp2;
            pts.push([a[0] + (b[0] - a[0]) * t + nx * w, a[1] + (b[1] - a[1]) * t + nz * w]);
          }
          out.push({ id: `${net.id}.${i}_${j}_${dir}`, points: pts, width: net.width, kind: net.kind, sidewalk: net.sidewalk });
        }
  }
  return out;
}

export type TileRec = { cx: number; cz: number; key: string; origin: [number, number]; model: SceneModel; sig: string; ms: number; serial: number };

/** Entrée d'une composition de tuile (sérialisable : passe telle quelle à un worker). */
export type TileJob = { recipe: Recipe; seed: string; params: Record<string, unknown>; spec: InfiniteSpec; cx: number; cz: number; edits?: TileEdit; objBase: number; step: number };

/** Étapes de composition d'une tuile (une étape par objet lourd). */
export function composeTileSteps(job: TileJob, assetCache?: Map<string, Asset>) {
  const T = job.spec.tile;
  const origin: [number, number] = [(job.cx + 0.5) * T, (job.cz + 0.5) * T];
  const paths = worldRoads(job.spec, origin[0] - T / 2, origin[1] - T / 2, origin[0] + T / 2, origin[1] + T / 2);
  return composeSteps({
    recipe: job.recipe,
    seed: job.seed,
    params: job.params,
    tile: { cx: job.cx, cz: job.cz, size: T, origin, seed: job.spec.seed, step: job.step, paths, assetCache, objBase: job.objBase, edits: job.edits },
  });
}

/** Composition synchrone d'une tuile (tests, worker). */
export function composeTile(job: TileJob, assetCache?: Map<string, Asset>): SceneModel {
  const it = composeTileSteps(job, assetCache);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/** Retouches persistées : `tiles` du DataProvider. */
export type TileEdits = Record<string, TileEdit>;

/** Lecture tolérante de `tiles` (clés `"cx,cz"`). */
export function readTileEdits(v: unknown): TileEdits {
  const out: TileEdits = {};
  if (!isObj(v)) return out;
  for (const [k, e] of Object.entries(v)) if (parseTileKey(k) && isObj(e)) out[k] = e as TileEdit;
  return out;
}

/** Ajoute une retouche (déplacement d'un objet) et borne le total : renvoie la nouvelle valeur de `tiles`. */
export function recordMove(edits: TileEdits, spec: InfiniteSpec, o: Pick<ObjectInfo, "id" | "layer" | "generator" | "params" | "scale">, from: [number, number], to: { x: number; z: number; yaw: number }, center: [number, number], now = Date.now()): { tiles: TileEdits; dropped: string[]; count: number } {
  const T = spec.tile;
  const [fcx, fcz] = tileOf(T, from[0], from[1]);
  const [tcx, tcz] = tileOf(T, to.x, to.z);
  const fk = tileKey(fcx, fcz), tk = tileKey(tcx, tcz);
  const next: TileEdits = { ...edits };
  const R2 = (v: number) => Math.round(v * 100) / 100;
  const yaw = Math.round(to.yaw);
  // objet ajouté par le joueur : on réécrit son ajout (il change de tuile avec lui)
  const addedIn = Object.keys(next).find((k) => next[k].add?.some((a) => a.id === o.id));
  if (addedIn) {
    const a = next[addedIn].add!.find((x) => x.id === o.id)!;
    next[addedIn] = { ...next[addedIn], add: next[addedIn].add!.filter((x) => x.id !== o.id), t: now };
    next[tk] = { ...(next[tk] ?? {}), add: [...(next[tk]?.add ?? []), { ...a, x: R2(to.x), z: R2(to.z), yaw }], t: now };
  } else if (fk === tk) {
    next[fk] = { ...(next[fk] ?? {}), move: { ...(next[fk]?.move ?? {}), [o.id]: { x: R2(to.x), z: R2(to.z), yaw } }, t: now };
  } else {
    // change de tuile : retiré de la sienne, ajouté (avec son générateur et ses paramètres) dans l'autre
    const fm = { ...(next[fk]?.move ?? {}) };
    delete fm[o.id];
    next[fk] = { ...(next[fk] ?? {}), move: fm, remove: [...new Set([...(next[fk]?.remove ?? []), o.id])], t: now };
    next[tk] = { ...(next[tk] ?? {}), add: [...(next[tk]?.add ?? []), { id: o.id, layer: o.layer, gen: o.generator, params: o.params, x: R2(to.x), z: R2(to.z), yaw, ...(o.scale !== 1 ? { scale: R2(o.scale) } : {}) }], t: now };
  }
  for (const k of Object.keys(next)) if (!editCount(next[k])) delete next[k];
  const [ccx, ccz] = tileOf(T, center[0], center[1]);
  const b = boundEdits(next, spec.persist, ccx, ccz, tk);
  return { tiles: b.edits, dropped: b.dropped, count: b.count };
}

/** Exécute une composition de tuile (fil principal par tranches, ou worker). */
export interface TileRunner {
  /** Démarre une composition ; `done` reçoit le modèle (ou `null` si annulée). */
  start(job: TileJob, done: (m: SceneModel | null, ms: number) => void): { cancel(): void };
  /** Avance les compositions en cours dans le budget donné (fil principal) ; renvoie le temps passé. */
  pump(budgetMs: number): number;
  readonly busy: boolean;
  dispose(): void;
}

/** Compositions sur le fil principal, une à la fois, par tranches (une étape par objet lourd). */
export class MainThreadRunner implements TileRunner {
  readonly cache = new Map<string, Asset>();
  private job: { it: Generator<unknown, SceneModel>; done: (m: SceneModel | null, ms: number) => void; ms: number; cancelled: boolean } | null = null;
  private queue: { job: TileJob; done: (m: SceneModel | null, ms: number) => void; h: { cancelled: boolean } }[] = [];
  get busy() {
    return !!this.job || this.queue.length > 0;
  }
  start(job: TileJob, done: (m: SceneModel | null, ms: number) => void) {
    const h = { cancelled: false };
    this.queue.push({ job, done, h });
    return {
      cancel: () => {
        h.cancelled = true;
        if (this.job && (this.job as unknown as { h?: object }).h === h) this.job.cancelled = true;
      },
    };
  }
  pump(budgetMs: number): number {
    const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const t0 = now();
    while (now() - t0 < budgetMs) {
      if (!this.job) {
        const q = this.queue.shift();
        if (!q) break;
        if (q.h.cancelled) {
          q.done(null, 0);
          continue;
        }
        // assets partagés entre tuiles ; bornés (les maillages déjà envoyés à la carte graphique restent en vie)
        if (this.cache.size > 600) this.cache.clear();
        this.job = Object.assign({ it: composeTileSteps(q.job, this.cache), done: q.done, ms: 0, cancelled: false }, { h: q.h });
      }
      const j = this.job!;
      if (j.cancelled) {
        this.job = null;
        j.done(null, j.ms);
        continue;
      }
      const s = now();
      const r = j.it.next();
      j.ms += now() - s;
      if (r.done) {
        this.job = null;
        j.done(r.value, j.ms);
      }
    }
    return now() - t0;
  }
  dispose() {
    for (const q of this.queue) q.h.cancelled = true;
    this.queue = [];
    if (this.job) this.job.cancelled = true;
    this.job = null;
  }
}

export type TileWorldState = { center: [number, number]; tile: [number, number]; radius: number; loaded: number; pending: number; ms: number; lastTileMs: number; avgTileMs: number; edits: number; persist: number; worker: boolean };

/**
 * Tuiles chargées autour d'un point, et leur façade « monde » (sol, navigation, objets). `update` décide quoi
 * composer et relâcher ; `added` / `removed` disent à la vue quelles tuiles monter ou démonter.
 */
export class TileWorld {
  readonly spec: InfiniteSpec;
  private recipe: Recipe;
  private seed: string;
  private params: Record<string, unknown>;
  tiles = new Map<string, TileRec>();
  private jobs = new Map<string, { cancel(): void; sig: string }>();
  private edits: TileEdits = {};
  added: TileRec[] = [];
  removed: TileRec[] = [];
  /** Rayon effectif (réduit en qualité basse). */
  radius: number;
  step: number;
  center: [number, number] = [0, 0];
  private serial = 0;
  private lastMs = 0;
  private sumMs = 0;
  private nTiles = 0;
  private frameMs = 0;
  issues: Issue[] = [];
  version = 0;
  private objCache: { v: number; list: ObjectInfo[] } = { v: -1, list: [] };
  private groundSeed: number;
  private groundSpec: { relief: number; scale: number; mountains: number; water: number | null };
  /** La tuile du point suivi a changé. */
  onEnter: ((e: { cx: number; cz: number }) => void) | null = null;
  private lastTile = "";

  constructor(spec: InfiniteSpec, recipe: Recipe, seed: string, params: Record<string, unknown>, readonly runner: TileRunner, quality: { low: boolean } = { low: false }) {
    this.spec = spec;
    this.recipe = recipe;
    this.seed = seed;
    this.params = params;
    const low = spec.quality === "low" || (spec.quality === "auto" && quality.low);
    this.radius = low ? Math.max(1, spec.radius - 1) : spec.radius;
    this.step = low ? Math.min(4, spec.step * 1.5) : spec.step;
    // même graine de sol que la composition (relief hors tuiles chargées)
    this.groundSeed = (new Rng(seed).fork("ground").next() * 1000) | 0;
    const g = (isObj(recipe.ground) ? recipe.ground : {}) as Record<string, unknown>;
    this.groundSpec = { relief: fin(g.relief) ? g.relief : 0.6, scale: fin(g.scale) ? g.scale : 18, mountains: fin(g.mountains) ? g.mountains : 0, water: fin(g.water) ? g.water : null };
  }

  /** Qualité basse (auto) : rayon réduit d'une tuile ; prend effet au prochain `update`. */
  setLow(low: boolean) {
    if (this.spec.quality !== "auto") return;
    const r = low ? Math.max(1, this.spec.radius - 1) : this.spec.radius;
    if (r !== this.radius) this.radius = r;
  }

  /** Retouches du joueur (`tiles`) : les tuiles dont la retouche change sont recomposées (l'ancienne reste affichée). */
  setEdits(v: unknown) {
    this.edits = readTileEdits(v);
  }
  get tileEdits(): TileEdits {
    return this.edits;
  }

  private sigOf(key: string) {
    return JSON.stringify(this.edits[key] ?? null);
  }

  /**
   * Avance autour de (x, z) : relâche les tuiles lointaines, lance les compositions manquantes (les plus proches
   * d'abord), fait avancer le fil principal dans `budgetMs`. Les tuiles montées / démontées vont dans `added` / `removed`.
   */
  update(x: number, z: number, budgetMs = this.spec.budget): boolean {
    const T = this.spec.tile;
    this.center = [x, z];
    const [ccx, ccz] = tileOf(T, x, z);
    const here = tileKey(ccx, ccz);
    if (here !== this.lastTile) {
      this.lastTile = here;
      this.onEnter?.({ cx: ccx, cz: ccz });
    }
    let changed = false;
    for (const [k, t] of this.tiles)
      if (tileTooFar(t.cx, t.cz, ccx, ccz, this.radius)) {
        this.tiles.delete(k);
        this.removed.push(t);
        changed = true;
      }
    for (const [k, j] of this.jobs) {
      const p = parseTileKey(k)!;
      if (tileTooFar(p[0], p[1], ccx, ccz, this.radius)) {
        j.cancel();
        this.jobs.delete(k);
      }
    }
    // une composition à la fois en file : la plus proche manquante (ou dont la retouche a changé)
    const want = ringTiles(ccx, ccz, this.radius);
    let queued = 0;
    for (const w of want) {
      const sig = this.sigOf(w.key);
      const have = this.tiles.get(w.key);
      const job = this.jobs.get(w.key);
      if (have && have.sig === sig && !job) continue;
      if (job) {
        if (job.sig === sig) {
          queued++;
          continue;
        }
        job.cancel();
        this.jobs.delete(w.key);
      }
      if (queued >= 2) break;
      queued++;
      const serial = this.serial++;
      const objBase = 100000 + (serial % 4000) * 2048;
      const h = this.runner.start({ recipe: this.recipe, seed: this.seed, params: this.params, spec: this.spec, cx: w.cx, cz: w.cz, edits: this.edits[w.key], objBase, step: this.step }, (m, ms) => {
        const cur = this.jobs.get(w.key);
        if (!cur || cur.sig !== sig) return;
        this.jobs.delete(w.key);
        if (!m) return;
        const old = this.tiles.get(w.key);
        const rec: TileRec = { cx: w.cx, cz: w.cz, key: w.key, origin: [(w.cx + 0.5) * T, (w.cz + 0.5) * T], model: m, sig, ms, serial };
        this.tiles.set(w.key, rec);
        if (old) this.removed.push(old);
        this.added.push(rec);
        this.lastMs = ms;
        this.sumMs += ms;
        this.nTiles++;
        if (m.issues.length && this.issues.length < 20) for (const i of m.issues) if (!this.issues.some((x) => x.path === i.path && x.message === i.message)) this.issues.push(i);
        this.version++;
      });
      this.jobs.set(w.key, { cancel: h.cancel, sig });
    }
    const before = this.version;
    this.frameMs = this.runner.pump(budgetMs);
    if (changed) this.version++;
    return changed || this.version !== before;
  }

  get busy(): boolean {
    return this.jobs.size > 0 || this.runner.busy;
  }

  state(): TileWorldState {
    const T = this.spec.tile;
    const R = (v: number) => Math.round(v * 100) / 100;
    let edits = 0;
    for (const e of Object.values(this.edits)) edits += editCount(e);
    return { center: [R(this.center[0]), R(this.center[1])], tile: tileOf(T, this.center[0], this.center[1]), radius: this.radius, loaded: this.tiles.size, pending: this.jobs.size, ms: R(this.frameMs), lastTileMs: R(this.lastMs), avgTileMs: this.nTiles ? R(this.sumMs / this.nTiles) : 0, edits, persist: this.spec.persist, worker: !!(this.runner as { usingWorker?: boolean }).usingWorker };
  }

  /* ---------- façade « monde » ---------- */

  tileAt(x: number, z: number): TileRec | undefined {
    const [cx, cz] = tileOf(this.spec.tile, x, z);
    return this.tiles.get(tileKey(cx, cz));
  }

  /** Hauteur où l'on marche : sol de la tuile (routes aplanies), tabliers ; relief brut hors des tuiles chargées. */
  height(x: number, z: number): number {
    const t = this.tileAt(x, z);
    if (!t) return this.rawHeight(x, z);
    const g = t.model.terrain ? t.model.terrain.height(x - t.origin[0], z - t.origin[1]) : 0;
    return t.model.decks.length ? deckHeight(t.model.decks, x, z, g) : g;
  }
  /** Sol seul (sans tablier). */
  groundOnly(x: number, z: number): number {
    const t = this.tileAt(x, z);
    if (!t) return this.rawHeight(x, z);
    return t.model.terrain ? t.model.terrain.height(x - t.origin[0], z - t.origin[1]) : 0;
  }
  rawHeight(x: number, z: number): number {
    return worldRelief({ ...this.groundSpec, seed: this.groundSeed }, x, z);
  }
  normal(x: number, z: number): V3 {
    const e = 0.5;
    const a = this.groundOnly(x - e, z) - this.groundOnly(x + e, z), b = this.groundOnly(x, z - e) - this.groundOnly(x, z + e);
    const l = Math.hypot(a, 2 * e, b) || 1;
    return [a / l, (2 * e) / l, b / l];
  }
  pathInfo(x: number, z: number): { d: number; path: PathSpec | null } {
    const t = this.tileAt(x, z);
    if (!t?.model.terrain) return { d: Infinity, path: null };
    return t.model.terrain.pathInfo(x - t.origin[0], z - t.origin[1]);
  }
  get waterLevel(): number | null {
    return this.groundSpec.water;
  }
  /** Routes (repère du monde) de la tuile du point suivi (ronde des acteurs `patrol`). */
  pathsNear(x: number, z: number): PathSpec[] {
    const T = this.spec.tile;
    return worldRoads(this.spec, x - T, z - T, x + T, z + T).filter((p) => p.kind !== "river");
  }

  /** Cellule praticable (tuile non chargée : libre). */
  free(x: number, z: number): boolean {
    const t = this.tileAt(x, z);
    return !t?.model.nav || t.model.nav.free(x, z);
  }

  /**
   * Chemin de `from` à `to` à travers les tuiles chargées : grille de navigation recousue sur le rectangle des deux
   * points (élargi de 8 m, 160 m de côté au plus). Au-delà, ligne droite (l'acteur s'arrête contre un obstacle).
   */
  path(from: [number, number], to: [number, number]): [number, number][] | null {
    const pad = 8;
    const x0 = Math.min(from[0], to[0]) - pad, x1 = Math.max(from[0], to[0]) + pad;
    const z0 = Math.min(from[1], to[1]) - pad, z1 = Math.max(from[1], to[1]) + pad;
    if (x1 - x0 > 160 || z1 - z0 > 160) return [from, to];
    const g = new NavGrid(x1 - x0, z1 - z0, 0.5).shift((x0 + x1) / 2, (z0 + z1) / 2);
    for (let j = 0; j < g.nz; j++)
      for (let i = 0; i < g.nx; i++) {
        const [x, z] = g.center(i, j);
        if (!this.free(x, z)) g.blocked[j * g.nx + i] = 1;
      }
    return g.path(from, to);
  }

  /** Objets de toutes les tuiles chargées (repère du monde), recalculés quand l'ensemble change. */
  objects(): ObjectInfo[] {
    if (this.objCache.v === this.version) return this.objCache.list;
    const list: ObjectInfo[] = [];
    for (const t of this.tiles.values()) for (const o of t.model.objects) list.push(o);
    this.objCache = { v: this.version, list };
    return list;
  }

  dispose() {
    for (const j of this.jobs.values()) j.cancel();
    this.jobs.clear();
    this.runner.dispose();
    this.tiles.clear();
  }
}
