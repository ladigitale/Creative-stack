/**
 * Composition des tuiles du monde infini **hors du fil principal**.
 *
 * - Côté worker : `serveTileWorker(self)` compose les tuiles demandées (`composeTile`) et renvoie des tableaux typés
 *   transférés ; le maillage d'un asset instancié n'est envoyé qu'une fois (le fil principal le garde par clé).
 * - Côté page : `WorkerTileRunner` (un `TileRunner`) envoie les tâches et reconstruit les `SceneModel` ; le fil
 *   principal ne fait plus que l'envoi à la carte graphique. Si le worker échoue (CSP, erreur), les tâches en cours
 *   et suivantes repassent sur le fil principal par tranches.
 *
 * Le worker est construit par l'application (son bundler) : aucune URL de script libre, aucun code évalué.
 *
 * ```ts
 * // procgen-tiles.worker.ts (dans l'application)
 * import { serveTileWorker } from "@supersoniks/creative-stack/procgen/tile-worker";
 * serveTileWorker(self);
 * // au chargement de l'addon procgen
 * setProcgenTileRunner(() => new WorkerTileRunner(new Worker(new URL("./procgen-tiles.worker.ts", import.meta.url), { type: "module" })));
 * ```
 */
import type { Asset } from "../gen/types";
import { buildCharacterFromKey } from "../gen/character";
import type { Look } from "../gen/character/look";
import { type PackedBuilt, packBuilt } from "../gen/character/pack";
import { loadTextAssets, loadTextAssetsFor } from "../fonts/index";
import { Mesh } from "../geom/mesh";
import type { SceneModel } from "./compose";
import { type TileJob, type TileRunner, MainThreadRunner, composeTile } from "./infinite";
import { NavGrid } from "./nav";
import { type GroundSpec, type PathSpec, Terrain } from "./terrain";

type MeshData = { pos: Float32Array; nrm: Float32Array; role: Float32Array; ao: Float32Array; flex: Float32Array; obj: Float32Array; blend: Float32Array | null; idx: Uint32Array };
export type TileData = {
  model: Omit<SceneModel, "terrain" | "ground" | "roads" | "water" | "tiles" | "instances" | "nav"> & {
    terrain: { spec: GroundSpec; paths: PathSpec[]; heights: Float32Array } | null;
    ground: MeshData | null; roads: MeshData | null; water: MeshData | null; tiles: MeshData[];
    instances: { key: string; mesh: MeshData | null; matrices: Float64Array; objs: number[]; flex: boolean }[];
    nav: { w: number; d: number; cell: number; ox: number; oz: number; blocked: Uint8Array } | null;
  };
};
type Req = { id: number; job: TileJob } | { id: number; reset: true } | { id: number; char: { look: Look; vkey: string } };
type Rep = { id: number; data?: TileData; ms: number; error?: string };

function packMesh(m: Mesh | null, out: Transferable[]): MeshData | null {
  if (!m || !m.vertexCount) return null;
  const d: MeshData = { pos: new Float32Array(m.pos), nrm: new Float32Array(m.nrm), role: new Float32Array(m.role), ao: new Float32Array(m.ao), flex: new Float32Array(m.flex), obj: new Float32Array(m.obj), blend: m.blend ? new Float32Array(m.blend) : null, idx: new Uint32Array(m.idx) };
  out.push(d.pos.buffer, d.nrm.buffer, d.role.buffer, d.ao.buffer, d.flex.buffer, d.obj.buffer, d.idx.buffer);
  if (d.blend) out.push(d.blend.buffer);
  return d;
}

/** Maillage reconstruit (attributs en tableaux typés : `toGeometry` les prend tels quels). */
function unpackMesh(d: MeshData | null): Mesh | null {
  if (!d) return null;
  const m = new Mesh();
  const a = m as unknown as Record<string, unknown>;
  a.pos = d.pos;
  a.nrm = d.nrm;
  a.role = d.role;
  a.ao = d.ao;
  a.flex = d.flex;
  a.obj = d.obj;
  a.blend = d.blend;
  a.idx = d.idx;
  return m;
}

/** Tuile composée → données transférables ; `sent` : clés d'assets déjà envoyées. */
export function packTile(m: SceneModel, sent: Set<string>): { data: TileData; transfer: Transferable[] } {
  const tr: Transferable[] = [];
  const nav = m.nav;
  const data: TileData = {
    model: {
      ...m,
      terrain: m.terrain ? { spec: m.terrain.spec, paths: m.terrain.paths, heights: m.terrain.heightData.slice() } : null,
      ground: packMesh(m.ground, tr),
      roads: packMesh(m.roads, tr),
      water: packMesh(m.water, tr),
      tiles: m.tiles.map((t) => packMesh(t, tr)!).filter(Boolean),
      instances: m.instances.map((g) => {
        const mats = new Float64Array(g.matrices.length * 16);
        g.matrices.forEach((x, i) => mats.set(x as unknown as Float64Array, i * 16));
        tr.push(mats.buffer);
        const mesh = sent.has(g.key) ? null : packMesh(g.mesh, tr);
        sent.add(g.key);
        return { key: g.key, mesh, matrices: mats, objs: g.objs, flex: g.flex };
      }),
      nav: nav ? { w: nav.nx * nav.cell, d: nav.nz * nav.cell, cell: nav.cell, ox: nav.ox, oz: nav.oz, blocked: nav.dyn ? nav.blocked.map((b, k) => (b || nav.dyn![k] > 0 ? 1 : 0)) : nav.blocked } : null,
    },
  };
  if (data.model.terrain) tr.push(data.model.terrain.heights.buffer);
  return { data, transfer: tr };
}

/** Données d'une tuile → `SceneModel` ; `meshes` : maillages d'assets reçus (par clé). */
export function unpackTile(d: TileData, meshes: Map<string, Mesh>): SceneModel {
  const t = d.model;
  const instances = t.instances.map((g) => {
    let mesh = meshes.get(g.key);
    if (g.mesh) meshes.set(g.key, (mesh = unpackMesh(g.mesh)!));
    const matrices = Array.from({ length: g.matrices.length / 16 }, (_, i) => g.matrices.subarray(i * 16, i * 16 + 16));
    return { key: g.key, mesh: mesh ?? new Mesh(), matrices: matrices as unknown as import("../core/math").M4[], objs: g.objs, flex: g.flex };
  });
  let nav: NavGrid | null = null;
  if (t.nav) {
    nav = new NavGrid(t.nav.w, t.nav.d, t.nav.cell);
    nav.ox = t.nav.ox;
    nav.oz = t.nav.oz;
    nav.blocked.set(t.nav.blocked.subarray(0, nav.blocked.length));
  }
  return {
    ...t,
    terrain: t.terrain ? new Terrain(t.terrain.spec, t.terrain.paths, t.terrain.heights) : null,
    ground: unpackMesh(t.ground),
    roads: unpackMesh(t.roads),
    water: unpackMesh(t.water),
    tiles: t.tiles.map((x) => unpackMesh(x)!),
    instances,
    nav,
  };
}

/** Portée minimale d'un worker. */
type Scope = { onmessage: ((e: { data: Req }) => void) | null; postMessage(m: Rep | { id: number; char?: PackedBuilt; error?: string }, transfer?: Transferable[]): void };

/** Boucle du worker : compose les tuiles demandées, une à la fois. */
export function serveTileWorker(scope: unknown) {
  const self = scope as Scope;
  const cache = new Map<string, Asset>();
  let sent = new Set<string>();
  self.onmessage = async (e) => {
    const r = e.data;
    if ("reset" in r) {
      sent = new Set();
      return;
    }
    if ("char" in r) {
      // personnage construit pour le pool de `prefetchCharacters` (même script, autre instance)
      try {
        // police des textes imprimés (et icônes) chargée dans ce worker avant la construction
        const lk = r.char.look;
        await loadTextAssets(lk.printFont ? [lk.printFont] : [], /\{[a-z0-9-]+\}/.test(`${lk.printFront ?? ""}${lk.printName ?? ""}`));
        const transfer: Transferable[] = [];
        const char = packBuilt(buildCharacterFromKey(r.char.look, r.char.vkey), transfer);
        self.postMessage({ id: r.id, char }, transfer);
      } catch (err) {
        self.postMessage({ id: r.id, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    const t0 = Date.now();
    try {
      await loadTextAssetsFor(r.job.recipe);
      if (cache.size > 600) {
        cache.clear();
        sent = new Set();
      }
      const m = composeTile(r.job, cache);
      const { data, transfer } = packTile(m, sent);
      self.postMessage({ id: r.id, data, ms: Date.now() - t0 }, transfer);
    } catch (err) {
      self.postMessage({ id: r.id, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) });
    }
  };
}

type WorkerLike = { postMessage(m: Req): void; terminate(): void; onmessage: ((e: { data: Rep }) => void) | null; onerror: ((e: { preventDefault?(): void }) => void) | null };

/** Compositions dans un worker ; repli sur le fil principal si le worker échoue. */
export class WorkerTileRunner implements TileRunner {
  private worker: WorkerLike | null;
  private seq = 0;
  private wait = new Map<number, { job: TileJob; done: (m: SceneModel | null, ms: number) => void; h: { cancelled: boolean } }>();
  private meshes = new Map<string, Mesh>();
  private fallback: MainThreadRunner | null = null;
  /** Nombre de tuiles composées par le worker. */
  composed = 0;

  constructor(worker: unknown) {
    this.worker = worker as WorkerLike;
    this.worker.onmessage = (e) => this.reply(e.data);
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      this.fail();
    };
  }

  get usingWorker() {
    return !!this.worker;
  }
  get busy() {
    return this.wait.size > 0 || !!this.fallback?.busy;
  }

  start(job: TileJob, done: (m: SceneModel | null, ms: number) => void) {
    if (!this.worker) return this.main().start(job, done);
    const id = ++this.seq;
    const h = { cancelled: false };
    this.wait.set(id, { job, done, h });
    try {
      this.worker.postMessage({ id, job });
    } catch {
      this.fail();
    }
    return { cancel: () => ((h.cancelled = true), void 0) };
  }

  private reply(r: Rep) {
    const w = this.wait.get(r.id);
    if (!w) return;
    this.wait.delete(r.id);
    if (r.error || !r.data) {
      if (!w.h.cancelled) w.done(null, r.ms);
      return;
    }
    // les maillages d'assets arrivent même pour une tuile annulée (le worker les croit envoyés)
    const m = unpackTile(r.data, this.meshes);
    this.composed++;
    w.done(w.h.cancelled ? null : m, r.ms);
  }

  private main(): MainThreadRunner {
    return (this.fallback ??= new MainThreadRunner());
  }

  private fail() {
    this.worker?.terminate();
    this.worker = null;
    // tâches en vol : reprises sur le fil principal
    const pending = [...this.wait.values()];
    this.wait.clear();
    for (const p of pending) if (!p.h.cancelled) this.main().start(p.job, p.done);
  }

  pump(budgetMs: number): number {
    return this.fallback ? this.fallback.pump(budgetMs) : 0;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.wait.clear();
    this.fallback?.dispose();
  }
}
