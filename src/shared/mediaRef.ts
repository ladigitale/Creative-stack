/**
 * Jeton média neutre pour chaîner HF → jsonata → shader / 3d via DataProvider.
 *
 * - `url` : http(s) | blob: | data: (préféré pour les canaux shader)
 * - `blob` : binaire (HF, upload) — le producteur publie aussi `url` quand possible
 * - `blobUrl` : alias historique (extract shader)
 * - `element` : sélecteur `#id` ou Element (pont live → canaux shader, ignoré par toMediaUrl)
 */

export type SonicMediaRef = {
  url?: string;
  blobUrl?: string;
  blob?: Blob;
  width?: number;
  height?: number;
  mime?: string;
  /** Sélecteur `#id` ou référence Element (upload live, pas d’URL). */
  element?: string | Element;
};

/**
 * Contrat minimal pour qu’un composant Concorde alimente un canal shader
 * sans JPEG / blob (`channel0="#plateau"` ou `{ element }`).
 */
export type SonicFrameSource = {
  /** Canvas lisible (preserveDrawingBuffer ou 2D). `null` tant que pas prêt. */
  getFrameCanvas(): HTMLCanvasElement | null;
  /** Incrémenté après chaque rendu effectif. */
  readonly frameSeq: number;
};

/**
 * Producteur de frames live qui peut rester actif hors viewport
 * tant qu’un consommateur est enregistré (`sonic-3d` Lot 9).
 */
export type SonicFrameConsumerHost = {
  registerFrameConsumer(token?: object): void;
  unregisterFrameConsumer(token?: object): void;
};

export function isFrameSource(el: unknown): el is SonicFrameSource {
  if (!el || typeof el !== "object") return false;
  const o = el as SonicFrameSource;
  return (
    typeof o.getFrameCanvas === "function" && typeof o.frameSeq === "number"
  );
}

export function isFrameConsumerHost(el: unknown): el is SonicFrameConsumerHost {
  if (!el || typeof el !== "object") return false;
  const o = el as SonicFrameConsumerHost;
  return (
    typeof o.registerFrameConsumer === "function" &&
    typeof o.unregisterFrameConsumer === "function"
  );
}

/** Suit les `#id` résolus → register/unregister auprès du producteur. */
export class FrameConsumerRegistry {
  private tokens = new Map<Element, object>();

  sync(elements: Iterable<Element | null | undefined>) {
    const next = new Set<Element>();
    for (const el of elements) {
      if (el && isFrameConsumerHost(el)) next.add(el);
    }
    for (const [el, token] of [...this.tokens]) {
      if (next.has(el)) continue;
      if (isFrameConsumerHost(el)) el.unregisterFrameConsumer(token);
      this.tokens.delete(el);
    }
    for (const el of next) {
      if (this.tokens.has(el)) continue;
      const token = {};
      (el as unknown as SonicFrameConsumerHost).registerFrameConsumer(token);
      this.tokens.set(el, token);
    }
  }

  clear() {
    this.sync([]);
  }
}

/** Clés synthétiques pour Elements DP sans `id` (`#__sonic_frame_N`). */
const LIVE_PREFIX = "#__sonic_frame_";
let liveSeq = 0;
const liveByKey = new Map<string, Element>();
const keyByLive = new WeakMap<Element, string>();

/** Enregistre un Element sans id → clé `#__sonic_frame_N` (réutilisée). */
export function registerLiveElement(el: Element): string {
  const existing = keyByLive.get(el);
  if (existing) return existing;
  const key = `${LIVE_PREFIX}${++liveSeq}`;
  liveByKey.set(key, el);
  keyByLive.set(el, key);
  return key;
}

export function lookupLiveElement(key: string): Element | null {
  if (!key.startsWith(LIVE_PREFIX)) return null;
  const el = liveByKey.get(key) ?? null;
  if (el && !el.isConnected) {
    liveByKey.delete(key);
    return null;
  }
  return el;
}

/** Normalise `element` DP → clé canal (`#id` ou live). */
export function mediaElementKey(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    return s.startsWith("#") ? s : `#${s}`;
  }
  if (typeof Element !== "undefined" && value instanceof Element) {
    if (value.id) return `#${value.id}`;
    return registerLiveElement(value);
  }
  return null;
}

/** Objet image sérialisé (sortie HF / extract) : Blob + dimensions. */
export function isMediaBlobObject(
  value: unknown,
): value is SonicMediaRef & { blob: Blob } {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    o.blob instanceof Blob &&
    (typeof o.width === "number" ||
      typeof o.height === "number" ||
      typeof o.channels === "number" ||
      typeof o.url === "string" ||
      typeof o.blobUrl === "string")
  );
}

/**
 * Résout une URL affichable / chargeable sans créer d’ObjectURL.
 * Accepte : string | objet avec `url` / `blobUrl` | null.
 * Ne matérialise pas un `blob` seul — utiliser `attachMediaUrls` / `cloneMediaRef`.
 */
function nonEmptyTrimmed(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function toMediaUrl(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "string") return nonEmptyTrimmed(value);
  if (typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  return nonEmptyTrimmed(o.url) ?? nonEmptyTrimmed(o.blobUrl);
}

/**
 * Attache un `url` (ObjectURL) à chaque nœud image `{ blob, width?, height? }`
 * dans une arborescence. Mutates in place. Les URLs créées sont poussées dans
 * `created` pour revoke ultérieur.
 */
export function attachMediaUrls(
  value: unknown,
  created: string[],
): unknown {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = attachMediaUrls(value[i], created);
    }
    return value;
  }
  if (!value || typeof value !== "object") return value;
  const o = value as Record<string, unknown>;
  if (isMediaBlobObject(o)) {
    // Ne pas écraser une url http(s)/blob déjà fournie par le producteur.
    if (toMediaUrl(o)) return value;
    const url = URL.createObjectURL(o.blob);
    created.push(url);
    o.url = url;
    return value;
  }
  for (const key of Object.keys(o)) {
    o[key] = attachMediaUrls(o[key], created);
  }
  return value;
}

/** Révoque une liste d’ObjectURL (ignore les erreurs). */
export function revokeMediaUrls(urls: Iterable<string>): void {
  for (const url of urls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Copie durable d’un média : nouvel ObjectURL depuis `blob` (ou fetch de `url`).
 * À utiliser quand on fige un `frameUrl` 3d — le producteur révoque sinon au frame suivant.
 */
export async function cloneMediaRef(
  value: unknown,
): Promise<SonicMediaRef | null> {
  if (value == null) return null;
  if (typeof value === "string") {
    const url = value.trim();
    if (!url) return null;
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const cloned = URL.createObjectURL(blob);
      return { url: cloned, blob, mime: blob.type || undefined };
    } catch {
      return null;
    }
  }
  if (typeof value !== "object") return null;
  const o = value as SonicMediaRef;
  if (o.blob instanceof Blob) {
    const url = URL.createObjectURL(o.blob);
    return {
      url,
      blob: o.blob,
      width: o.width,
      height: o.height,
      mime: o.mime || o.blob.type || undefined,
    };
  }
  const existing = toMediaUrl(o);
  if (!existing) return null;
  return cloneMediaRef(existing);
}
