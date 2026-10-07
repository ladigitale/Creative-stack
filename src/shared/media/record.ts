/**
 * Enregistrement MediaRecorder : choix du format, durée maximale, résultat en SonicMediaRef.
 * Pur côté navigateur, sans DOM ni WebAudio (le flux est fourni par l'appelant).
 */
import type { SonicMediaRef } from "../mediaRef";
import { withWebmDuration } from "./webm";

export type RecordedRef = SonicMediaRef & { url: string; mime: string; durS: number; size: number };

const AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
const VIDEO_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4;codecs=avc1,mp4a",
  "video/mp4",
];

export function recorderSupported(): boolean {
  return typeof MediaRecorder !== "undefined";
}

/** Premier format accepté par ce navigateur (Safari : mp4). */
export function pickMime(kind: "audio" | "video", hasAudio = true): string | null {
  if (!recorderSupported()) return null;
  const list = kind === "audio" ? AUDIO_TYPES : hasAudio ? VIDEO_TYPES : VIDEO_TYPES.map((t) => t.replace(/,opus|,mp4a/, ""));
  for (const t of list) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* navigateur sans isTypeSupported */
    }
  }
  return "";
}

export function extensionFor(mime: string): string {
  const image = /^image\/(jpeg|png|webp|gif)/.exec(mime);
  if (image) return image[1] === "jpeg" ? "jpg" : image[1];
  if (/^audio\/(wav|wave|x-wav)/.test(mime)) return "wav";
  if (/mp4/.test(mime)) return mime.startsWith("audio") ? "m4a" : "mp4";
  if (/ogg/.test(mime)) return "ogg";
  return "webm";
}

/**
 * Une prise : démarre à la construction, s'arrête sur `stop()` ou au bout de `maxS`.
 * `done` se résout avec le média enregistré (null si vide).
 */
export class Take {
  readonly done: Promise<RecordedRef | null>;
  readonly startedAt = performance.now();
  private recorder: MediaRecorder;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(stream: MediaStream, kind: "audio" | "video", opts: { maxS: number; bitsPerSecond?: number }) {
    const mime = pickMime(kind, stream.getAudioTracks().length > 0) ?? "";
    this.recorder = new MediaRecorder(stream, {
      ...(mime ? { mimeType: mime } : {}),
      ...(opts.bitsPerSecond ? (kind === "audio" ? { audioBitsPerSecond: opts.bitsPerSecond } : { videoBitsPerSecond: opts.bitsPerSecond }) : {}),
    });
    const chunks: Blob[] = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    this.done = new Promise((resolve) => {
      this.recorder.onstop = async () => {
        if (this.timer) clearTimeout(this.timer);
        const ms = performance.now() - this.startedAt;
        const durS = +(ms / 1000).toFixed(2);
        const type = this.recorder.mimeType || mime || (kind === "audio" ? "audio/webm" : "video/webm");
        let blob = new Blob(chunks, { type });
        if (!blob.size) return resolve(null);
        if (/webm/.test(type)) {
          // Durée écrite dans le fichier : lisible et navigable une fois téléchargé.
          try {
            const fixed = withWebmDuration(await blob.arrayBuffer(), ms);
            if (fixed) blob = new Blob([fixed as BlobPart], { type });
          } catch {
            /* fichier gardé tel quel */
          }
        }
        resolve({ blob, url: URL.createObjectURL(blob), mime: type, durS, size: blob.size });
      };
      this.recorder.onerror = () => this.stop();
    });
    this.recorder.start(250);
    this.timer = setTimeout(() => this.stop(), Math.max(0.2, opts.maxS) * 1000);
  }

  get elapsedS(): number {
    return +((performance.now() - this.startedAt) / 1000).toFixed(2);
  }

  get active(): boolean {
    return this.recorder.state !== "inactive";
  }

  stop(): void {
    if (this.recorder.state !== "inactive") this.recorder.stop();
  }
}
