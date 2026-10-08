/**
 * Chargement partagé des sons (sampler, grain…) : cache par URL, décodage
 * possible avant le premier geste (contexte hors ligne), URL filtrées.
 */
import { listenDp } from "./dp";
import { AudioEngine } from "./engine";
import { safeMediaUrl } from "../media/urls";

const decodeCache = new Map<string, Promise<AudioBuffer>>();
let decoder: BaseAudioContext | null = null;

function decodingContext(): BaseAudioContext | null {
  const ctx = AudioEngine.get().context;
  if (ctx) return ctx;
  if (decoder) return decoder;
  const Offline = (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  decoder = Offline ? new Offline(1, 1, 44100) : null;
  return decoder;
}

/** URL autorisée : https, blob:, data:audio/…, ou relative (même origine). */
export function safeSampleUrl(url: string): boolean {
  return safeMediaUrl(url, "audio");
}

export function loadSample(url: string): Promise<AudioBuffer> {
  let p = decodeCache.get(url);
  if (!p) {
    p = (async () => {
      const ctx = decodingContext();
      if (!ctx) throw new Error("WebAudio indisponible");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.arrayBuffer();
      return await ctx.decodeAudioData(data);
    })();
    decodeCache.set(url, p);
    p.catch(() => decodeCache.delete(url));
  }
  return p;
}


/**
 * Banque de sons désignés par URL ou par chemin DP (SonicMediaRef `{ url }`) :
 * le son suit le DataProvider (une nouvelle prise remplace l'ancienne).
 */
export class SampleBank {
  private static instance: SampleBank | null = null;
  static get(): SampleBank {
    return (SampleBank.instance ??= new SampleBank());
  }

  private buffers = new Map<string, AudioBuffer>();
  private errors = new Map<string, string>();
  private watched = new Set<string>();
  private listeners = new Set<() => void>();

  /** Demande un son (idempotent). */
  request(spec: string): void {
    const key = spec.trim();
    if (!key || this.watched.has(key)) return;
    this.watched.add(key);
    const load = (url: string) => {
      if (!safeSampleUrl(url)) {
        this.errors.set(key, `${key} : URL refusée (https, blob:, data:audio ou relative)`);
        this.emit();
        return;
      }
      loadSample(url).then(
        (buf) => {
          this.buffers.set(key, buf);
          this.errors.delete(key);
          this.emit();
        },
        (e: unknown) => {
          this.errors.set(key, `${key} : chargement impossible (${e instanceof Error ? e.message : String(e)})`);
          this.emit();
        },
      );
    };
    if (isUrlLike(key)) load(key);
    else
      listenDp(key, (v) => {
        const ref = v as { url?: unknown } | null;
        if (ref && typeof ref.url === "string") load(ref.url);
      });
  }

  buffer(spec: string): AudioBuffer | null {
    return this.buffers.get(spec.trim()) ?? null;
  }

  error(spec: string): string | null {
    return this.errors.get(spec.trim()) ?? null;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }
}

/** URL plutôt que chemin DP : schéma, chemin relatif ou extension de fichier. */
export function isUrlLike(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || /\.(wav|mp3|ogg|oga|webm|m4a|aac|flac|opus)(\?|#|$)/i.test(s);
}
