import { customElement, property } from "lit/decorators.js";
import { dispatch } from "../interactive";
import { resolveAudioElement } from "../../shared/audio/engine";
import { DeviceElement, type CommandMap, type DeviceBaseState } from "../../shared/device/base";
import { num } from "../../shared/media/control";
import { isFrameConsumerHost, isFrameSource, revokeMediaUrls } from "../../shared/mediaRef";
import { WebmMuxer, type WebmCodec } from "./webm-mux";

const tagName = "sonic-video-export";

/** Codecs essayés dans l'ordre : VP9 (profil 0, 8 bits), puis VP8. */
const CODECS: { webcodecs: string; webm: WebmCodec }[] = [
  { webcodecs: "vp09.00.10.08", webm: "V_VP9" },
  { webcodecs: "vp8", webm: "V_VP8" },
];
/** Images en attente dans l'encodeur au-delà desquelles on attend (frames) ou on saute une image (live). */
const MAX_QUEUE = 6;
/** Une source qui ne redessine pas (image fixe) est quand même capturée à ce rythme. */
const STILL_MS = 250;

export type VideoExportFile = { url: string; name: string; type: "video/webm"; mime: "video/webm"; size: number };

export type VideoExportState = DeviceBaseState & {
  mode: "live" | "frames";
  /** Encodage en cours (capture puis finalisation). */
  encoding: boolean;
  frames: number;
  /** Durée de la vidéo produite jusqu'ici, en s. */
  seconds: number;
  /** 0..1 quand la durée est connue (`duration` ou `frames`), sinon null. */
  progress: number | null;
  /** Codec WebCodecs retenu (`vp09.00.10.08` ou `vp8`). */
  codec: string | null;
  width: number;
  height: number;
  bytes: number;
  file: VideoExportFile | null;
};

type ImageSource = Element & {
  getFrameCanvas(): HTMLCanvasElement | null;
  frameSeq: number;
  getFrameSource?: () => CanvasImageSource | null;
};

type Encoder = {
  configure(c: Record<string, unknown>): void;
  encode(frame: unknown, opts?: { keyFrame?: boolean }): void;
  flush(): Promise<void>;
  close(): void;
  readonly encodeQueueSize: number;
  readonly state?: string;
};
type EncoderCtor = {
  new (init: { output: (chunk: Chunk) => void; error: (e: unknown) => void }): Encoder;
  isConfigSupported(c: Record<string, unknown>): Promise<{ supported?: boolean }>;
};
type Chunk = { type: "key" | "delta"; timestamp: number; byteLength: number; copyTo(dest: Uint8Array): void };
type FrameCtor = new (src: CanvasImageSource, init: { timestamp: number; duration?: number }) => { close(): void };

function webcodecs(): { Encoder: EncoderCtor; Frame: FrameCtor } | null {
  const g = globalThis as unknown as { VideoEncoder?: EncoderCtor; VideoFrame?: FrameCtor };
  return typeof g.VideoEncoder === "function" && typeof g.VideoFrame === "function" ? { Encoder: g.VideoEncoder, Frame: g.VideoFrame } : null;
}

const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function sourceSize(src: CanvasImageSource): { w: number; h: number } {
  const s = src as HTMLVideoElement & HTMLCanvasElement;
  return { w: s.videoWidth || s.width || 0, h: s.videoHeight || s.height || 0 };
}

type Job = {
  encoder: Encoder;
  muxer: WebmMuxer;
  codec: string;
  width: number;
  height: number;
  frameMs: number;
  /** Nombre d'images visé (mode frames), 0 si inconnu. */
  total: number;
  /** Durée visée en ms (mode live), 0 si inconnue. */
  limitMs: number;
  t0: number;
  index: number;
  lastSeq: number;
  lastWall: number;
  lastKeyMs: number;
  lastMs: number;
  failed: string | null;
  token: object;
  source: ImageSource;
};

/**
 * Export vidéo image par image (WebCodecs + muxer WebM intégré, sans dépendance) d'une source
 * d'images (`source="#id"` : sonic-shader, sonic-3d, sonic-2d, sonic-camera, sonic-video…).
 *
 * - `mode="live"` : une image par rafraîchissement, horodatée à l'instant réel.
 * - `mode="frames"` (défaut) : temps fixe, image n à n / fps. Aucune source du dépôt ne permet
 *   d'avancer son temps à la demande : la capture suit la cadence réelle du rendu (jamais plus vite
 *   que `fps`), mais l'horodatage est fixe, donc une vidéo fluide même si le rendu est lent (elle
 *   paraît alors accélérée).
 *
 * Commandes `control` : `{start, stop, cancel, toggle}` (compteurs) ; `for="idBouton"` = toggle.
 * Fichier publié dans `file` {url blob:, name, type, mime, size} pour `sonic-media-download`,
 * action `video:done` vers `target`.
 */
@customElement(tagName)
export class SonicVideoExport extends DeviceElement<VideoExportState> {
  /** `#id` d'une source d'images. */
  @property({ type: String }) source = "";
  /** `frames` (défaut, temps fixe) ou `live` (temps réel). */
  @property({ type: String }) mode: "live" | "frames" = "frames";
  /** Images par seconde de la vidéo (défaut 30). */
  @property({ type: Number }) fps = 30;
  /** Durée en s (arrêt automatique ; 0 = jusqu'à `stop`). */
  @property({ type: Number }) duration = 0;
  /** Nombre d'images (mode frames ; prioritaire sur `duration`). */
  @property({ type: Number }) frames = 0;
  /** Taille de la vidéo (défaut : taille de la source, arrondie au pair). */
  @property({ type: Number }) width = 0;
  @property({ type: Number }) height = 0;
  /** Débit en bits/s (défaut 6 Mb/s). */
  @property({ type: Number }) bitrate = 6_000_000;
  /** Intervalle entre images clés, en s (défaut 2). */
  @property({ type: Number, attribute: "keyframe-every" }) keyframeEvery = 2;
  /** Taille maximale du fichier en Mo (défaut 200) : l'export s'arrête et garde ce qui est fait. */
  @property({ type: Number, attribute: "max-mb" }) maxMb = 200;
  /** Nom du fichier, sans extension. */
  @property({ type: String }) filename = "video";
  /** Store qui reçoit l'action de fin. */
  @property({ type: String }) target = "";
  /** Type de l'action de fin (défaut `video:done`). */
  @property({ type: String }) type = "video:done";

  protected readonly feature = null;
  protected readonly defaultCommand = "toggle";
  protected state: VideoExportState = {
    status: "idle", error: null, supported: false, allowed: "unknown", active: false,
    mode: "frames", encoding: false, frames: 0, seconds: 0, progress: null, codec: null,
    width: 0, height: 0, bytes: 0, file: null,
  };

  private job: Job | null = null;
  private raf = 0;
  private canvas: HTMLCanvasElement | null = null;
  private url: string | null = null;

  protected commands(): CommandMap {
    return {
      start: () => this.start(),
      stop: () => this.stop(),
      cancel: () => this.cancel(),
      toggle: () => (this.job ? this.stop() : this.start()),
    };
  }

  connectedCallback(): void {
    super.connectedCallback();
    const ok = !!webcodecs();
    this.patch({
      supported: ok,
      // WebCodecs ne dépend d'aucune Permissions Policy.
      allowed: ok ? true : "unknown",
      status: ok ? "idle" : "unsupported",
      error: ok ? null : "export vidéo non disponible : WebCodecs (VideoEncoder) absent de ce navigateur",
      mode: this.currentMode(),
    });
  }

  disconnectedCallback(): void {
    this.cancel();
    if (this.url) revokeMediaUrls([this.url]);
    this.url = null;
    super.disconnectedCallback();
  }

  /** Lance l'export. Résout à vrai si la capture a démarré. */
  async start(): Promise<boolean> {
    if (this.job) return true;
    const api = webcodecs();
    if (!api) {
      this.patch({ status: "unsupported", error: "export vidéo non disponible : WebCodecs (VideoEncoder) absent de ce navigateur" });
      return false;
    }
    const el = resolveAudioElement(this, this.source);
    if (!el || !isFrameSource(el)) {
      this.patch({ status: "error", error: `source "${this.source}" introuvable (attendu : #id d'une source d'images)` });
      return false;
    }
    const src = el as ImageSource;
    const img = this.image(src);
    const size = img ? sourceSize(img) : { w: 0, h: 0 };
    const width = even(num(this.width, 0, 7680) || size.w);
    const height = even(num(this.height, 0, 4320) || size.h);
    if (!img || !size.w || !size.h) {
      if (!num(this.width, 2, 7680) || !num(this.height, 2, 4320)) {
        this.patch({ status: "error", error: `source "${this.source}" pas encore prête (aucune image)` });
        return false;
      }
    }
    const fps = num(this.fps, 1, 120) ?? 30;
    const bitrate = Math.round(num(this.bitrate, 100_000, 100_000_000) ?? 6_000_000);
    const config = { width, height, bitrate, framerate: fps };
    let chosen: (typeof CODECS)[number] | null = null;
    for (const c of CODECS) {
      try {
        const r = await api.Encoder.isConfigSupported({ codec: c.webcodecs, ...config });
        if (r?.supported) {
          chosen = c;
          break;
        }
      } catch {
        /* codec inconnu : suivant */
      }
    }
    if (this.job) return true; // démarré entre-temps
    if (!chosen) {
      this.patch({ status: "unsupported", error: `aucun encodeur VP9 ou VP8 disponible pour ${width}×${height}` });
      return false;
    }
    const mode = this.currentMode();
    const frameMs = 1000 / fps;
    const duration = num(this.duration, 0, 3600) ?? 0;
    const total = mode === "frames" ? Math.round(num(this.frames, 0, 1_000_000) || duration * fps) : 0;
    const maxBytes = (num(this.maxMb, 1, 2000) ?? 200) * 1_000_000;
    const muxer = new WebmMuxer({ codec: chosen.webm, width, height, maxBytes, frameMs: mode === "frames" ? frameMs : undefined });
    const job: Job = {
      encoder: null as unknown as Encoder,
      muxer, codec: chosen.webcodecs, width, height, frameMs, total,
      limitMs: mode === "live" ? duration * 1000 : 0,
      t0: performance.now(), index: 0, lastSeq: -1, lastWall: -Infinity, lastKeyMs: -Infinity, lastMs: 0,
      failed: null, token: {}, source: src,
    };
    try {
      job.encoder = new api.Encoder({
        output: (chunk) => {
          if (this.job !== job || job.failed) return;
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          try {
            muxer.add(data, chunk.timestamp / 1000, chunk.type === "key");
          } catch (e) {
            job.failed = e instanceof Error ? e.message : String(e);
            void this.stop();
            return;
          }
          this.patch({ bytes: muxer.size }, false);
        },
        error: (e) => {
          if (this.job !== job) return;
          job.failed = `encodeur : ${e instanceof Error ? e.message : String(e)}`;
          void this.stop();
        },
      });
      job.encoder.configure({ codec: chosen.webcodecs, ...config, latencyMode: "quality" });
    } catch (e) {
      this.patch({ status: "error", error: `encodeur impossible à configurer : ${e instanceof Error ? e.message : String(e)}` });
      return false;
    }
    if (isFrameConsumerHost(src)) src.registerFrameConsumer(job.token);
    this.job = job;
    this.patch({
      status: "ready", error: null, active: true, encoding: true, mode,
      frames: 0, seconds: 0, progress: total || job.limitMs ? 0 : null,
      codec: chosen.webcodecs, width, height, bytes: 0,
    });
    this.emit("video-start", { codec: chosen.webcodecs, width, height, mode });
    this.loop();
    return true;
  }

  /** Arrête la capture et finalise le fichier. */
  async stop(): Promise<boolean> {
    const job = this.job;
    if (!job || !this.state.active) return false;
    this.endCapture(job);
    this.patch({ active: false });
    try {
      await job.encoder.flush();
    } catch (e) {
      job.failed ??= `encodeur : ${e instanceof Error ? e.message : String(e)}`;
    }
    try {
      job.encoder.close();
    } catch {
      /* déjà fermé */
    }
    if (this.job !== job) return false; // annulé pendant la finalisation
    this.job = null;
    if (!job.muxer.frames) {
      this.patch({ status: job.failed ? "error" : "ready", encoding: false, error: job.failed ?? "aucune image capturée" });
      return false;
    }
    const durationMs = this.state.mode === "frames" ? job.index * job.frameMs : job.lastMs + job.frameMs;
    const blob = new Blob(job.muxer.finishParts(durationMs) as BlobPart[], { type: "video/webm" });
    if (this.url) revokeMediaUrls([this.url]);
    this.url = URL.createObjectURL(blob);
    const file: VideoExportFile = {
      url: this.url,
      name: `${(this.filename || "video").replace(/[^\w.-]+/g, "-")}.webm`,
      type: "video/webm",
      mime: "video/webm",
      size: blob.size,
    };
    const seconds = r3(durationMs / 1000);
    this.patch({
      status: "ready", encoding: false, error: job.failed, file, bytes: blob.size, seconds,
      progress: this.state.progress === null ? null : 1,
    });
    const payload = { file, frames: job.index, seconds, codec: job.codec, width: job.width, height: job.height, error: job.failed };
    const target = this.target.trim();
    if (target) dispatch(target, { type: this.type.trim() || "video:done", payload });
    this.emit("video-done", payload);
    return true;
  }

  /** Abandonne l'export en cours (le fichier précédent est gardé). */
  cancel(): boolean {
    const job = this.job;
    if (!job) return false;
    this.job = null;
    this.endCapture(job);
    try {
      job.encoder.close();
    } catch {
      /* déjà fermé */
    }
    if (this.isConnected) this.patch({ active: false, encoding: false, frames: 0, seconds: 0, bytes: this.state.file?.size ?? 0, progress: null });
    return true;
  }

  /**
   * Un pas de capture (appelé à chaque rafraîchissement ; public pour les tests).
   * Retourne vrai si une image a été envoyée à l'encodeur.
   */
  step(now: number = performance.now()): boolean {
    const job = this.job;
    if (!job || !this.state.active) return false;
    const api = webcodecs();
    if (!api) return false;
    const live = this.state.mode === "live";
    const seq = job.source.frameSeq;
    const fresh = seq !== job.lastSeq || now - job.lastWall >= STILL_MS;
    if (!fresh) return false;
    const elapsed = now - job.t0;
    // Mode frames : jamais plus vite que la cadence réelle visée.
    if (!live && elapsed + 1 < job.index * job.frameMs) return false;
    if (job.encoder.encodeQueueSize > MAX_QUEUE) return false;
    const img = this.image(job.source);
    if (!img) return false;
    const tMs = live ? elapsed : job.index * job.frameMs;
    if (live && job.limitMs && tMs >= job.limitMs) {
      void this.stop();
      return false;
    }
    const canvas = this.draw(img, job.width, job.height);
    const key = job.index === 0 || tMs - job.lastKeyMs >= (num(this.keyframeEvery, 0.1, 60) ?? 2) * 1000;
    let frame: { close(): void } | null = null;
    try {
      frame = new api.Frame(canvas, { timestamp: Math.round(tMs * 1000), duration: Math.round(job.frameMs * 1000) });
      job.encoder.encode(frame, { keyFrame: key });
    } catch (e) {
      job.failed = `image refusée : ${e instanceof Error ? e.message : String(e)}`;
      void this.stop();
      return false;
    } finally {
      frame?.close();
    }
    if (key) job.lastKeyMs = tMs;
    job.lastSeq = seq;
    job.lastWall = now;
    job.lastMs = tMs;
    job.index++;
    const seconds = r3(live ? tMs / 1000 : (job.index * job.frameMs) / 1000);
    const progress = job.total ? Math.min(1, job.index / job.total) : job.limitMs ? Math.min(1, tMs / job.limitMs) : null;
    this.patch({ frames: job.index, seconds, progress: progress === null ? null : r3(progress) }, false);
    if (job.total && job.index >= job.total) void this.stop();
    return true;
  }

  /* ---------------------------------------------------------------- */

  private currentMode(): "live" | "frames" {
    return this.mode === "live" ? "live" : "frames";
  }

  private image(src: ImageSource): CanvasImageSource | null {
    return (typeof src.getFrameSource === "function" ? src.getFrameSource() : null) ?? src.getFrameCanvas();
  }

  /** Image de la source mise à la taille de la vidéo (proportions gardées, bandes noires). */
  private draw(img: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
    const c = (this.canvas ??= document.createElement("canvas"));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext("2d");
    if (!ctx) return c;
    const s = sourceSize(img);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    if (!s.w || !s.h) return c;
    const k = Math.min(w / s.w, h / s.h);
    const dw = s.w * k;
    const dh = s.h * k;
    try {
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    } catch {
      /* image illisible : image noire */
    }
    return c;
  }

  private loop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    const tick = () => {
      this.raf = 0;
      if (!this.job || !this.state.active) return;
      this.step(performance.now());
      if (this.job && this.state.active) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private endCapture(job: Job): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (isFrameConsumerHost(job.source)) job.source.unregisterFrameConsumer(job.token);
  }
}

export default SonicVideoExport;
