/**
 * Personnages construits **à l'avance, en parallèle et hors du fil principal**, puis gardés dans le navigateur.
 *
 * Avant une composition 3D, `prefetchCharacters` repère les personnages de la scène par une composition « à blanc »
 * (personnages remplacés par une doublure : squelette seul), cherche leurs maillages dans le cache persistant
 * (IndexedDB, clés préfixées par l'empreinte du code des générateurs), lance les manquants dans un pool de workers,
 * puis range le tout dans le cache des personnages : la vraie composition les y trouve, sans tâche longue.
 *
 * Les workers sont fournis par l'application (`setProcgenCharacterWorkers`), comme celui des tuiles : le même script
 * (`serveTileWorker`) sert les deux. Sans workers (Node, tests, application qui n'en fournit pas), rien ne change : les personnages sont
 * construits pendant la composition. Une erreur de worker ou de stockage n'est jamais bloquante.
 */
import { Mesh } from "../geom/mesh";
import { type Look } from "../gen/character/look";
import { type PackedBuilt, unpackBuilt } from "../gen/character/pack";
import type { Built } from "../gen/character/build";
import { PROCGEN_BUILD_VERSION } from "../gen/character/version";
import { characterSkeleton } from "../gen/character/build";
import { cachedCharacter, characterAsset, prepareCharacter, storeCharacter } from "../gen/character";
import type { Asset } from "../gen/types";
import { type ComposeInput, type Recipe, composeSceneAsync } from "./compose";
import { resolveGeneratorId } from "../gen/index";

export type CharJob = { key: string; look: Look; vkey: string };

type WorkerLike = {
  postMessage(m: unknown): void;
  terminate(): void;
  onmessage: ((e: { data: { id: number; char?: PackedBuilt; error?: string } }) => void) | null;
  onerror: ((e: { preventDefault?(): void }) => void) | null;
};

let workerFactory: (() => unknown) | null = null;
let poolSize = 0;
let pool: CharacterPool | null = null;

/**
 * Workers de construction des personnages (le script de `serveTileWorker`). `size` : nombre de workers (défaut :
 * cœurs − 1, entre 1 et 6). `null` : constructions sur le fil principal.
 */
export function setProcgenCharacterWorkers(f: (() => unknown) | null, size?: number) {
  pool?.dispose();
  pool = null;
  workerFactory = f;
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
  poolSize = Math.max(1, Math.min(6, size ?? cores - 1));
}

class CharacterPool {
  private workers: { w: WorkerLike; busy: boolean }[] = [];
  private queue: { job: CharJob; done: (b: PackedBuilt | null) => void }[] = [];
  private wait = new Map<number, { done: (b: PackedBuilt | null) => void; slot: { w: WorkerLike; busy: boolean } }>();
  private seq = 0;
  dead = false;

  constructor(make: () => unknown, size: number) {
    for (let i = 0; i < size; i++) {
      let w: WorkerLike;
      try {
        w = make() as WorkerLike;
      } catch {
        continue;
      }
      const slot = { w, busy: false };
      w.onmessage = (e) => this.reply(e.data);
      w.onerror = (e) => {
        e.preventDefault?.();
        this.kill(slot);
      };
      this.workers.push(slot);
    }
    if (!this.workers.length) this.dead = true;
  }

  run(job: CharJob): Promise<PackedBuilt | null> {
    if (this.dead) return Promise.resolve(null);
    return new Promise((done) => {
      this.queue.push({ job, done });
      this.pump();
    });
  }

  private pump() {
    for (const slot of this.workers) {
      if (slot.busy || !this.queue.length) continue;
      const { job, done } = this.queue.shift()!;
      const id = ++this.seq;
      slot.busy = true;
      this.wait.set(id, { done, slot });
      try {
        slot.w.postMessage({ id, char: { look: job.look, vkey: job.vkey } });
      } catch {
        this.wait.delete(id);
        done(null);
        this.kill(slot);
      }
    }
  }

  private reply(r: { id: number; char?: PackedBuilt; error?: string }) {
    const w = this.wait.get(r.id);
    if (!w) return;
    this.wait.delete(r.id);
    w.slot.busy = false;
    w.done(r.char ?? null);
    this.pump();
  }

  private kill(slot: { w: WorkerLike; busy: boolean }) {
    try {
      slot.w.terminate();
    } catch {
      /* déjà arrêté */
    }
    this.workers = this.workers.filter((s) => s !== slot);
    for (const [id, w] of this.wait) if (w.slot === slot) (this.wait.delete(id), w.done(null));
    if (!this.workers.length) {
      this.dead = true;
      for (const q of this.queue.splice(0)) q.done(null);
    } else this.pump();
  }

  dispose() {
    for (const s of this.workers) s.w.terminate();
    this.workers = [];
    this.dead = true;
    for (const q of this.queue.splice(0)) q.done(null);
    for (const w of this.wait.values()) w.done(null);
    this.wait.clear();
  }
}

/* ---------- cache persistant ---------- */

const DB = "procgen-personnages";
const STORE = "built";
const MAX_ENTRIES = 160;
let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  dbp ??= new Promise((res) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore(STORE);
        s.createIndex("t", "t");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
      r.onblocked = () => res(null);
    } catch {
      res(null);
    }
  });
  return dbp;
}

const dbKey = (k: string) => `${PROCGEN_BUILD_VERSION}|${k}`;

async function dbGet(keys: string[]): Promise<Map<string, PackedBuilt>> {
  const out = new Map<string, PackedBuilt>();
  const d = await db();
  if (!d || !keys.length) return out;
  return new Promise((res) => {
    try {
      const tx = d.transaction(STORE, "readonly");
      const s = tx.objectStore(STORE);
      for (const k of keys) {
        const r = s.get(dbKey(k));
        r.onsuccess = () => {
          const v = r.result as { b: PackedBuilt } | undefined;
          if (v?.b) out.set(k, v.b);
        };
      }
      tx.oncomplete = () => res(out);
      tx.onerror = tx.onabort = () => res(out);
    } catch {
      res(out);
    }
  });
}

async function dbPut(entries: [string, PackedBuilt][]) {
  const d = await db();
  if (!d || !entries.length) return;
  try {
    const tx = d.transaction(STORE, "readwrite");
    const s = tx.objectStore(STORE);
    const t = Date.now();
    for (const [k, b] of entries) s.put({ b, t }, dbKey(k));
    // au-delà du plafond, les plus anciennes entrées partent (et toutes celles d'une autre version du code)
    const all = s.index("t").getAllKeys();
    all.onsuccess = () => {
      const keys = all.result as string[];
      const stale = keys.filter((k) => !String(k).startsWith(PROCGEN_BUILD_VERSION + "|"));
      const fresh = keys.filter((k) => String(k).startsWith(PROCGEN_BUILD_VERSION + "|"));
      for (const k of [...stale, ...fresh.slice(0, Math.max(0, fresh.length - MAX_ENTRIES))]) s.delete(k);
    };
  } catch {
    /* stockage plein ou refusé : rien de grave */
  }
}

/* ---------- repérage ---------- */

/** Vrai si la recette peut contenir des personnages (acteurs ou couche de personnages). */
export function recipeHasCharacters(r: Recipe | undefined): boolean {
  if (!r) return false;
  const actors = (r as { actors?: Record<string, { gen?: string }> }).actors;
  if (actors && Object.values(actors).some((a) => !a?.gen || resolveGeneratorId(a.gen).gen?.id === "character")) return true;
  return (r.layers ?? []).some((l) => typeof l?.gen === "string" && resolveGeneratorId(l.gen).gen?.id === "character");
}

/**
 * Personnages à construire pour une composition (absents du cache), dans l'ordre de la composition. La composition
 * à blanc passe par tranches : les autres assets qu'elle construit restent en cache pour la vraie.
 */
export async function collectCharacterJobs(input: ComposeInput, onProgress?: (f: number) => void, signal?: { cancelled: boolean }): Promise<CharJob[]> {
  const jobs = new Map<string, CharJob>();
  const assetBuilder = (gen: string, params: Record<string, unknown>, ctx: Parameters<NonNullable<ComposeInput["assetBuilder"]>>[2]): Asset | null => {
    if (gen !== "character") return null;
    const { look, colors, v, key } = prepareCharacter(params, ctx);
    const built = cachedCharacter(key);
    if (built) return characterAsset(look, colors, built, v.key) as Asset;
    if (!jobs.has(key)) jobs.set(key, { key, look, vkey: v.key });
    // doublure : squelette et taille, sans maillage (le placement s'en contente)
    const { skel, H } = characterSkeleton(look);
    const hx = H * 0.14;
    return characterAsset(look, colors, { mesh: new Mesh(), skeleton: skel, anchors: {}, footprint: { hx, hz: H * 0.09, r: Math.max(hx, H * 0.12) }, height: H, soft: [] }, v.key) as Asset;
  };
  await composeSceneAsync({ ...input, assetBuilder }, { signal, onProgress: (d, t) => onProgress?.(t ? d / t : 0) });
  return [...jobs.values()].slice(0, 96);
}

/**
 * Prépare les personnages d'une composition (cache persistant puis workers). `onProgress` reçoit la part faite (0 à 1) :
 * repérage jusqu'à 0,2, puis personnages. Rend le nombre de personnages préparés ; 0 sans workers ni stockage, sans
 * personnage dans la recette, ou si rien ne manquait.
 */
export async function prefetchCharacters(input: ComposeInput, onProgress?: (f: number) => void, signal?: { cancelled: boolean }): Promise<number> {
  if (input.assetBuilder || !recipeHasCharacters(input.recipe)) return 0;
  if (!workerFactory) return 0;
  let jobs: CharJob[];
  try {
    // workers lancés tout de suite : leur script se charge pendant le repérage
    if (!pool || pool.dead) pool = new CharacterPool(workerFactory, poolSize || 2);
    jobs = await collectCharacterJobs(input, (f) => onProgress?.(f * 0.2), signal);
  } catch {
    return 0;
  }
  if (!jobs.length || signal?.cancelled) return 0;
  let done = 0;
  const tick = () => {
    done++;
    onProgress?.(0.2 + (0.8 * done) / jobs.length);
  };
  const found = await dbGet(jobs.map((j) => j.key));
  for (const [k, b] of found) {
    if (!cachedCharacter(k)) storeCharacter(k, unpackBuilt(b));
    tick();
  }
  if (signal?.cancelled) return done;
  const todo = jobs.filter((j) => !found.has(j.key));
  if (!todo.length) return done;
  if (!pool || pool.dead) pool = new CharacterPool(workerFactory!, poolSize || 2);
  const fresh: [string, PackedBuilt][] = [];
  await Promise.all(
    todo.map(async (j) => {
      const b = await pool!.run(j);
      if (!b || signal?.cancelled) return;
      // un personnage déjà construit entre-temps (autre composition) garde son maillage
      if (!cachedCharacter(j.key)) storeCharacter(j.key, unpackBuilt(b));
      fresh.push([j.key, b]);
      tick();
    }),
  );
  void dbPut(fresh);
  return done;
}

/* ---------- niveau de détail ---------- */

const lodWait = new Map<string, Promise<Built | null>>();

/**
 * Version allégée d'un personnage (même apparence, maillage « foule » : même squelette, même visage, ≈ 4 fois moins de
 * triangles) pour l'afficher de loin. Cache en mémoire, puis du navigateur, puis pool de workers ; `null` sans workers
 * (jamais de construction sur le fil principal pour un LOD).
 */
export function requestCharacterLod(look: Look, vkey: string): Promise<Built | null> {
  if (look.detail === "crowd") return Promise.resolve(null);
  const lite: Look = { ...look, detail: "crowd" };
  const key = JSON.stringify({ look: lite, seed: vkey.split("/").slice(-2)[0] });
  const hit = cachedCharacter(key);
  if (hit) return Promise.resolve(hit);
  if (!workerFactory) return Promise.resolve(null);
  let p = lodWait.get(key);
  if (!p) {
    p = (async () => {
      const found = await dbGet([key]);
      let b = found.get(key) ?? null;
      if (!b) {
        if (!pool || pool.dead) pool = new CharacterPool(workerFactory!, poolSize || 2);
        b = await pool.run({ key, look: lite, vkey });
        if (b) void dbPut([[key, b]]);
      }
      if (!b) return null;
      const built = cachedCharacter(key) ?? unpackBuilt(b);
      storeCharacter(key, built);
      return built;
    })().finally(() => lodWait.delete(key));
    lodWait.set(key, p);
  }
  return p;
}
