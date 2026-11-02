/**
 * Téléchargement d'un modèle (.task, .onnx…) avec plafond de taille, progression et empreinte sha256
 * optionnelle. Le modèle est ensuite passé au moteur sous forme de buffer : c'est ce qui permet de le
 * vérifier avant qu'un runtime ne le lise, et de le transférer à un worker sans copie.
 */

export type ModelProgress = { loaded: number; total: number | null };

export class ModelFetchError extends Error {
  constructor(
    public readonly code: "download-failed" | "too-large" | "hash-mismatch" | "invalid-hash",
    message: string,
  ) {
    super(message);
    this.name = "ModelFetchError";
  }
}

export type FetchModelOptions = {
  maxBytes: number;
  /** Hexadécimal (64 caractères), éventuellement préfixé `sha256-` ou `sha256:`. */
  sha256?: string;
  onProgress?: (p: ModelProgress) => void;
  fetchImpl?: typeof fetch;
};

export function normalizeSha256(value: string): string | null {
  const hex = value.trim().toLowerCase().replace(/^sha256[-:]/, "");
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new ModelFetchError("download-failed", "WebCrypto indisponible : impossible de vérifier l'empreinte.");
  const digest = await subtle.digest("SHA-256", data as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fetchModel(url: string, opts: FetchModelOptions): Promise<Uint8Array> {
  const expected = opts.sha256 ? normalizeSha256(opts.sha256) : null;
  if (opts.sha256 && !expected) throw new ModelFetchError("invalid-hash", "model-sha256 : 64 caractères hexadécimaux attendus.");
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
  } catch (e) {
    throw new ModelFetchError("download-failed", `Téléchargement impossible : ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new ModelFetchError("download-failed", `Téléchargement impossible : HTTP ${res.status}.`);
  const header = Number(res.headers.get("content-length"));
  const total = Number.isFinite(header) && header > 0 ? header : null;
  if (total !== null && total > opts.maxBytes) {
    throw new ModelFetchError("too-large", `Modèle trop gros (${Math.round(total / 1048576)} Mo, plafond ${Math.round(opts.maxBytes / 1048576)} Mo).`);
  }

  let bytes: Uint8Array;
  if (res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      if (loaded > opts.maxBytes) {
        void reader.cancel();
        throw new ModelFetchError("too-large", `Modèle trop gros (plafond ${Math.round(opts.maxBytes / 1048576)} Mo).`);
      }
      chunks.push(value);
      opts.onProgress?.({ loaded, total });
    }
    bytes = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.byteLength;
    }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > opts.maxBytes) throw new ModelFetchError("too-large", "Modèle trop gros.");
    opts.onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength });
  }

  if (expected) {
    const actual = await sha256Hex(bytes);
    if (actual !== expected) throw new ModelFetchError("hash-mismatch", "L'empreinte du modèle ne correspond pas à model-sha256.");
  }
  return bytes;
}
