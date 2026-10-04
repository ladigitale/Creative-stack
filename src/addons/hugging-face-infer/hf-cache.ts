/**
 * Mémoïsation des résultats.
 *
 * - en mémoire pour la session (petit LRU) ;
 * - optionnellement en IndexedDB (`persistResults`), plafonnée (LRU en octets).
 *
 * Clé = hachage de (entrée normalisée, alias, révision, version du moteur,
 * options d'appel) : changer l'un d'eux invalide automatiquement le résultat.
 * Les résultats contenant des Blob (images) ne sont pas persistés.
 */

const DB_NAME = "concorde-hf-results";
const STORE = "results";
const MEMORY_ENTRIES = 64;

type Row = { key: string; value: unknown; bytes: number; at: number };

/* ---------------- hachage ---------------- */

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const hash = await subtle.digest("SHA-256", bytes as BufferSource);
    return [...new Uint8Array(hash)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Repli (contextes non sécurisés) : FNV-1a 64 bits sur deux moitiés.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bytes[bytes.length - 1 - i], 0x811c9dc5) >>> 0;
  }
  return `fnv-${h1.toString(16)}${h2.toString(16)}-${bytes.length}`;
}

/** Représentation stable (clés triées ; Blob et tableaux typés hachés par contenu). */
async function stable(value: unknown): Promise<unknown> {
  if (value instanceof Blob) {
    return {
      $blob: await digestBytes(new Uint8Array(await value.arrayBuffer())),
      type: value.type,
    };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      $typed: value.constructor.name,
      hash: await digestBytes(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      ),
    };
  }
  if (Array.isArray(value)) return Promise.all(value.map(stable));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      out[key] = await stable((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export async function resultKey(parts: Record<string, unknown>): Promise<string> {
  const json = JSON.stringify(await stable(parts));
  return digestBytes(new TextEncoder().encode(json));
}

function containsBlob(value: unknown): boolean {
  if (value instanceof Blob) return true;
  if (Array.isArray(value)) return value.some(containsBlob);
  if (value && typeof value === "object")
    return Object.values(value).some(containsBlob);
  return false;
}

/* ---------------- mémoire ---------------- */

const memory = new Map<string, unknown>();

function remember(key: string, value: unknown): void {
  memory.delete(key);
  memory.set(key, value);
  while (memory.size > MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

/* ---------------- IndexedDB ---------------- */

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("at", "at");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      transaction.oncomplete = () =>
        resolve(request ? (request.result as T) : undefined);
      transaction.onerror = () => resolve(undefined);
      transaction.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function readResult(
  key: string,
  persisted: boolean,
  ttlMs?: number,
): Promise<{ hit: true; value: unknown } | { hit: false }> {
  if (memory.has(key)) {
    const value = memory.get(key);
    remember(key, value);
    return { hit: true, value };
  }
  if (!persisted) return { hit: false };
  const db = await openDb();
  if (!db) return { hit: false };
  const row = await tx<Row | undefined>(db, "readonly", (s) => s.get(key));
  if (!row) return { hit: false };
  if (ttlMs && Date.now() - row.at > ttlMs) return { hit: false };
  remember(key, row.value);
  void tx(db, "readwrite", (s) => s.put({ ...row, at: Date.now() }));
  return { hit: true, value: row.value };
}

export async function writeResult(
  key: string,
  value: unknown,
  persisted: boolean,
  capBytes: number,
): Promise<void> {
  remember(key, value);
  if (!persisted || containsBlob(value)) return;
  const db = await openDb();
  if (!db) return;
  let bytes = 0;
  try {
    bytes = JSON.stringify(value).length;
  } catch {
    return;
  }
  if (bytes > capBytes) return;
  await tx(db, "readwrite", (s) => s.put({ key, value, bytes, at: Date.now() } satisfies Row));
  await prune(db, capBytes);
}

async function prune(db: IDBDatabase, capBytes: number): Promise<void> {
  const rows =
    (await tx<Row[]>(db, "readonly", (s) => s.getAll() as IDBRequest<Row[]>)) ?? [];
  let total = rows.reduce((sum, r) => sum + r.bytes, 0);
  if (total <= capBytes) return;
  rows.sort((a, b) => a.at - b.at);
  const doomed: string[] = [];
  for (const row of rows) {
    if (total <= capBytes) break;
    doomed.push(row.key);
    total -= row.bytes;
  }
  await tx(db, "readwrite", (s) => {
    for (const key of doomed) s.delete(key);
  });
}

/** Vide les résultats mémorisés (mémoire + IndexedDB). */
export async function clearResults(): Promise<void> {
  memory.clear();
  const db = await openDb();
  if (db) await tx(db, "readwrite", (s) => s.clear());
}
