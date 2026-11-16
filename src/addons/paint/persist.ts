/**
 * Enregistrement local des toiles `sonic-paint` (attribut `persist`) : une image PNG par clé, dans IndexedDB.
 * Rien ne quitte le navigateur. Les clés sont bornées et l'image relue est vérifiée avant d'être peinte.
 */

const DB = "sonic-paint";
const STORE = "images";

export type PaintRecord = { key: string; blob: Blob; width: number; height: number; updated: number };

/** Clé d'enregistrement sûre : lettres, chiffres, `.`, `_`, `-`, 64 caractères au plus ; vide sinon. */
export function persistKey(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  return /^[A-Za-z0-9._-]{1,64}$/.test(s) ? s : "";
}

/** Un enregistrement relu est-il une image utilisable ? */
export function validRecord(r: unknown): r is PaintRecord {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return typeof o.key === "string" && typeof Blob !== "undefined" && o.blob instanceof Blob && o.blob.size > 0
    && Number.isFinite(o.width) && Number.isFinite(o.height) && (o.width as number) > 0 && (o.height as number) > 0;
}

let db: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!db) {
    db = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("stockage local indisponible"));
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: "key" }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("stockage local indisponible"));
    });
    db.catch(() => { db = null; });
  }
  return db;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("stockage local indisponible"));
  });
}

export async function readPaint(key: string): Promise<PaintRecord | null> {
  const r = await done((await open()).transaction(STORE, "readonly").objectStore(STORE).get(key));
  return validRecord(r) ? r : null;
}

export async function writePaint(rec: PaintRecord): Promise<void> {
  await done((await open()).transaction(STORE, "readwrite").objectStore(STORE).put(rec));
}
