import { BRUSH_DEFAULTS, sanitizeBrush } from "../paint/brush";
import { multiBBox, type Multi, type Pt } from "../vector";
import { flatBBox, type Region } from "./flat";
import { quantize, toCss, type Rgba } from "./flat-color";
import {
  DEFAULT_VIEW, MAX_STROKES, MAX_TOTAL_POINTS, makeBrush, sanitizeBlend, sanitizeView, strokeBBox, strokeMargin,
  type Stroke, type View,
} from "./model";

/**
 * Carnet de dessins de `sonic-sketch` : chaque dessin (traits, aplats, masques, vue) est gardé dans le
 * navigateur (IndexedDB), rangé sous un espace de noms (`persist`). Le dessin ouvert est réenregistré peu après
 * chaque changement ; on peut en créer, ouvrir, dupliquer, renommer et supprimer. Les données relues passent par
 * `readStrokes` : la même origine peut héberger d'autres pages, on ne fait confiance à rien de ce qu'on relit.
 */

export type DrawingMeta = { id: string; name: string; created: number; updated: number; strokes: number; thumb: Blob | null };
export type DrawingRecord = DrawingMeta & { ns: string; view: View; nextId: number; data: unknown; settings?: unknown };

export interface DrawingBackend {
  all(ns: string): Promise<DrawingRecord[]>;
  get(ns: string, id: string): Promise<DrawingRecord | null>;
  put(rec: DrawingRecord): Promise<void>;
  remove(ns: string, id: string): Promise<void>;
}

export const MAX_DRAWINGS = 200;
export const MAX_NAME_CHARS = 80;
const MAX_THUMB_BYTES = 400_000;
const MAX_RINGS = 200_000;

export const cleanName = (v: unknown, fallback: string): string => {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_NAME_CHARS) : "";
  return s || fallback;
};

export const newDrawingId = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const ID_RE = /^[a-z0-9_-]{1,40}$/i;
export const isDrawingId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

/* ------------------------------------------------------------ relecture sûre */

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function readRing(v: unknown, budget: { n: number }): Pt[] | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const out: Pt[] = [];
  for (const p of v) {
    if (!Array.isArray(p) || !fin(p[0]) || !fin(p[1])) return null;
    out.push([p[0], p[1]]);
  }
  budget.n -= out.length;
  return budget.n >= 0 ? out : null;
}

function readMulti(v: unknown, budget: { n: number }): Multi | null {
  if (!Array.isArray(v) || !v.length || v.length > MAX_RINGS) return null;
  const out: Multi = [];
  for (const poly of v) {
    if (!Array.isArray(poly) || !poly.length) return null;
    const rings: Pt[][] = [];
    for (const r of poly) {
      const ring = readRing(r, budget);
      if (!ring) return null;
      rings.push(ring);
    }
    out.push(rings);
  }
  return out;
}

function readRegion(v: unknown, budget: { n: number }): Region | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const c = o.rgba;
  if (!Array.isArray(c) || c.length !== 4 || !c.every((x) => fin(x) && x >= 0 && x <= 1)) return null;
  const shape = readMulti(o.shape, budget);
  if (!shape) return null;
  const rgba = quantize(c as Rgba);
  const r: Region = { rgba, color: toCss(rgba), shape, bbox: multiBBox(shape) };
  const blend = sanitizeBlend(o.blend);
  if (blend !== "normal") r.blend = blend;
  return r;
}

/**
 * Traits relus (JSON d'un enregistrement) : structure vérifiée, nombres finis, pinceau assaini, boîtes
 * recalculées, bornes du document respectées. Un élément invalide est écarté ; `null` si la liste ne l'est pas.
 */
export function readStrokes(v: unknown): Stroke[] | null {
  if (!Array.isArray(v)) return null;
  const budget = { n: MAX_TOTAL_POINTS };
  const out: Stroke[] = [];
  let id = 1;
  for (const raw of v.slice(0, MAX_STROKES)) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const b = (o.brush && typeof o.brush === "object" ? o.brush : {}) as Record<string, unknown>;
    if (!fin(b.size) || !(b.size > 0)) continue;
    const settings = sanitizeBrush({ ...BRUSH_DEFAULTS }, { ...b, size: undefined });
    const brush = makeBrush(settings, b.size, sanitizeBlend(b.blend));
    const seed = fin(o.seed) ? o.seed : 0;
    const base = { id: id++, brush, seed };
    if (Array.isArray(o.flat)) {
      const regions = o.flat.map((r) => readRegion(r, budget)).filter((r): r is Region => !!r);
      if (regions.length) out.push({ ...base, pts: [], flat: regions, bbox: flatBBox(regions) });
      continue;
    }
    if (o.mask !== undefined) {
      const mask = readMulti(o.mask, budget);
      if (mask) out.push({ ...base, pts: [], mask, bbox: multiBBox(mask) });
      continue;
    }
    const pts = o.pts;
    if (!Array.isArray(pts) || pts.length < 3 || pts.length % 3 !== 0 || !pts.every(fin)) continue;
    budget.n -= pts.length / 3;
    if (budget.n < 0) break;
    const s: Stroke = { ...base, pts: pts.slice(), bbox: { x: 0, y: 0, w: 0, h: 0 } };
    if (o.erase === true) s.erase = true;
    s.bbox = strokeBBox(s.pts, strokeMargin(brush));
    out.push(s);
  }
  return out;
}

/** Fiche d'un enregistrement relu (pour la liste), ou `null`. */
export function readMeta(v: unknown): DrawingMeta | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isDrawingId(o.id)) return null;
  const thumb = typeof Blob !== "undefined" && o.thumb instanceof Blob && o.thumb.type === "image/png" && o.thumb.size <= MAX_THUMB_BYTES ? o.thumb : null;
  return {
    id: o.id,
    name: cleanName(o.name, "Sans titre"),
    created: fin(o.created) ? o.created : 0,
    updated: fin(o.updated) ? o.updated : 0,
    strokes: fin(o.strokes) ? Math.max(0, Math.floor(o.strokes)) : 0,
    thumb,
  };
}

export const readView = (v: unknown): View => sanitizeView(v, DEFAULT_VIEW);

/** Copie sérialisable d'une liste de traits (les régions perdent leur couleur CSS et leur boîte, recalculées). */
const written = new WeakMap<Stroke, unknown>();

/** (Les traits sont immuables une fois posés : leur copie est mise en cache.) */
export function writeStrokes(strokes: Stroke[]): unknown {
  return strokes.map((s) => {
    const hit = written.get(s);
    if (hit) return hit;
    const o = writeStroke(s);
    written.set(s, o);
    return o;
  });
}

function writeStroke(s: Stroke): unknown {
  {
    const o: Record<string, unknown> = { brush: s.brush, seed: s.seed };
    if (s.flat) o.flat = s.flat.map((r) => (r.blend ? { rgba: r.rgba, shape: r.shape, blend: r.blend } : { rgba: r.rgba, shape: r.shape }));
    else if (s.mask) o.mask = s.mask;
    else {
      o.pts = s.pts;
      if (s.erase) o.erase = true;
    }
    return o;
  }
}

/* ------------------------------------------------------------ stockage */

const DB = "creative-stack-sketch";
const STORE = "drawings";

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB"));
  });
}

/** Stockage IndexedDB (une base pour toutes les toiles ; clé [espace de noms, identifiant]). */
export class IdbBackend implements DrawingBackend {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") return reject(new Error("stockage local indisponible"));
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => {
          const s = req.result.createObjectStore(STORE, { keyPath: ["ns", "id"] });
          s.createIndex("ns", "ns");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("stockage local indisponible"));
      });
      this.db.catch(() => { this.db = null; });
    }
    return this.db;
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.open()).transaction(STORE, mode).objectStore(STORE);
  }

  async all(ns: string): Promise<DrawingRecord[]> {
    return request((await this.store("readonly")).index("ns").getAll(ns)) as Promise<DrawingRecord[]>;
  }

  async get(ns: string, id: string): Promise<DrawingRecord | null> {
    return ((await request((await this.store("readonly")).get([ns, id]))) as DrawingRecord | undefined) ?? null;
  }

  async put(rec: DrawingRecord): Promise<void> {
    await request((await this.store("readwrite")).put(rec));
  }

  async remove(ns: string, id: string): Promise<void> {
    await request((await this.store("readwrite")).delete([ns, id]));
  }
}

/** Stockage en mémoire (tests, navigateurs sans IndexedDB). */
export class MemoryBackend implements DrawingBackend {
  private m = new Map<string, DrawingRecord>();
  async all(ns: string) { return [...this.m.values()].filter((r) => r.ns === ns).map((r) => structuredClone(r)); }
  async get(ns: string, id: string) { const r = this.m.get(ns + "\u0000" + id); return r ? structuredClone(r) : null; }
  async put(rec: DrawingRecord) { this.m.set(rec.ns + "\u0000" + rec.id, structuredClone(rec)); }
  async remove(ns: string, id: string) { this.m.delete(ns + "\u0000" + id); }
}

/** Fiches d'un espace de noms, la plus récemment modifiée d'abord (sans le pointeur de dessin ouvert). */
export async function listDrawings(b: DrawingBackend, ns: string): Promise<DrawingMeta[]> {
  const all = await b.all(ns);
  return all
    .filter((r) => !isReserved(r.id))
    .map(readMeta)
    .filter((m): m is DrawingMeta => !!m)
    .sort((a, b2) => b2.updated - a.updated)
    .slice(0, MAX_DRAWINGS);
}

/** Identifiant réservé : l'enregistrement qui retient le dessin ouvert en dernier. */
export const CURRENT = "_current";
/** Identifiant réservé : les préférences de l'utilisateur (`prefs-from`), gardées d'une session à l'autre. */
export const PREFS = "_prefs";
/** Enregistrements du carnet qui ne sont pas des dessins (`_current`, `_prefs`…). */
export const isReserved = (id: unknown): boolean => typeof id !== "string" || id.startsWith("_");

export async function readPrefs(b: DrawingBackend, ns: string): Promise<unknown> {
  const r = await b.get(ns, PREFS);
  return (r as { prefs?: unknown } | null)?.prefs ?? null;
}

export async function writePrefs(b: DrawingBackend, ns: string, prefs: unknown): Promise<void> {
  await b.put({ ns, id: PREFS, prefs } as unknown as DrawingRecord);
}

export async function readCurrent(b: DrawingBackend, ns: string): Promise<string | null> {
  const r = await b.get(ns, CURRENT);
  const id = (r as { open?: unknown } | null)?.open;
  return isDrawingId(id) ? id : null;
}

export async function writeCurrent(b: DrawingBackend, ns: string, id: string | null): Promise<void> {
  await b.put({ ns, id: CURRENT, open: id } as unknown as DrawingRecord);
}
