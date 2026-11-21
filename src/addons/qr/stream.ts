/**
 * Flux de QR codes : un fichier découpé en trames, chacune affichée tour à tour en QR code, et
 * rassemblé par un lecteur qui les voit dans n'importe quel ordre. Logique pure.
 *
 * Trame : `QS1|<id>|<i>|<n>|<base64>`. La trame 0 porte la fiche du fichier (type, nom, taille,
 * empreinte), les trames 1…n-1 ses octets. `id` change à chaque envoi : le lecteur repart de zéro.
 */

export const QR_STREAM_PREFIX = "QS1";
/** Octets par trame : compromis entre débit et densité du code (lisible à l'écran par un téléphone). */
export const QR_STREAM_CHUNK = 300;
export const QR_STREAM_MAX_BYTES = 400_000;

export type QrStreamMeta = { mime: string; name: string; size: number; hash: string };

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Empreinte FNV-1a 32 bits, en hexadécimal : vérifie le fichier rassemblé. */
export function qrStreamHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Identifiant court d'un envoi (lettres et chiffres). */
export function qrStreamId(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}

/** Découpe `bytes` en trames prêtes à afficher. */
export function qrStreamFrames(bytes: Uint8Array, meta: { mime: string; name?: string }, opts: { chunk?: number; id?: string } = {}): string[] {
  const chunk = Math.max(20, Math.min(800, Math.round(opts.chunk ?? QR_STREAM_CHUNK)));
  const id = (opts.id ?? qrStreamId()).replace(/[^a-z0-9]/gi, "").slice(0, 8) || "0";
  const count = Math.ceil(bytes.length / chunk) + 1;
  const fiche = JSON.stringify({ m: meta.mime, n: (meta.name ?? "").slice(0, 60), s: bytes.length, h: qrStreamHash(bytes) });
  const frames = [`${QR_STREAM_PREFIX}|${id}|0|${count}|${bytesToBase64(new TextEncoder().encode(fiche))}`];
  for (let i = 1; i < count; i++) {
    frames.push(`${QR_STREAM_PREFIX}|${id}|${i}|${count}|${bytesToBase64(bytes.subarray((i - 1) * chunk, i * chunk))}`);
  }
  return frames;
}

export type QrStreamFile = QrStreamMeta & { bytes: Uint8Array };

/**
 * Rassemble les trames lues. `feed(text)` rend `"new"` (trame utile), `"known"` (déjà vue),
 * `"done"` (fichier complet et vérifié), `"error"` (fichier complet mais empreinte fausse) ou
 * `"ignored"` (pas une trame de flux).
 */
export class QrStreamAssembler {
  id = "";
  total = 0;
  received = 0;
  done = false;
  error: string | null = null;
  meta: QrStreamMeta | null = null;
  file: QrStreamFile | null = null;
  startedAt = 0;
  finishedAt = 0;
  private parts: (Uint8Array | null)[] = [];

  reset(): void {
    this.id = "";
    this.total = 0;
    this.received = 0;
    this.done = false;
    this.error = null;
    this.meta = null;
    this.file = null;
    this.startedAt = 0;
    this.finishedAt = 0;
    this.parts = [];
  }

  get progress(): number {
    return this.total ? this.received / this.total : 0;
  }

  feed(text: unknown, now = Date.now()): "new" | "known" | "done" | "error" | "ignored" {
    if (typeof text !== "string" || !text.startsWith(`${QR_STREAM_PREFIX}|`)) return "ignored";
    const [, id, si, sn, payload] = text.split("|");
    const i = Number(si);
    const n = Number(sn);
    if (!id || !Number.isInteger(i) || !Number.isInteger(n) || n < 2 || n > 5000 || i < 0 || i >= n || !payload) return "ignored";
    if (id !== this.id || n !== this.total) {
      this.reset();
      this.id = id;
      this.total = n;
      this.parts = Array<Uint8Array | null>(n).fill(null);
      this.startedAt = now;
    }
    if (this.done || this.parts[i]) return "known";
    const bytes = base64ToBytes(payload);
    if (!bytes) return "ignored";
    if (i === 0) {
      try {
        const f = JSON.parse(new TextDecoder().decode(bytes)) as { m?: unknown; n?: unknown; s?: unknown; h?: unknown };
        this.meta = { mime: String(f.m ?? "application/octet-stream"), name: String(f.n ?? ""), size: Number(f.s) || 0, hash: String(f.h ?? "") };
      } catch {
        return "ignored";
      }
    }
    this.parts[i] = bytes;
    this.received++;
    if (this.received < this.total) return "new";

    const size = this.parts.slice(1).reduce((a, p) => a + (p?.length ?? 0), 0);
    const all = new Uint8Array(size);
    let at = 0;
    for (const p of this.parts.slice(1)) {
      all.set(p!, at);
      at += p!.length;
    }
    this.done = true;
    this.finishedAt = now;
    const meta = this.meta!;
    if (size !== meta.size || qrStreamHash(all) !== meta.hash) {
      this.error = "fichier reçu incomplet ou altéré";
      return "error";
    }
    this.file = { ...meta, bytes: all };
    return "done";
  }
}

/** Charge utile d'une URL `data:` (base64 ou texte encodé), sans passer par le réseau. */
export function parseDataUrl(url: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url);
  if (!m) return null;
  const mime = m[1] || "text/plain";
  if (/;base64$/i.test(m[2])) {
    const bytes = base64ToBytes(m[3]);
    return bytes ? { bytes, mime } : null;
  }
  try {
    return { bytes: new TextEncoder().encode(decodeURIComponent(m[3])), mime };
  } catch {
    return null;
  }
}
