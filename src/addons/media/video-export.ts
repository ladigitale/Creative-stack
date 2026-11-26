import { customElement, property } from "lit/decorators.js";
import { dispatch } from "../interactive";
import { AudioEngine, resolveAudioElement } from "../../shared/audio/engine";
import { isAudioSource } from "../../shared/audio/contracts";
import { DeviceElement, type CommandMap, type DeviceBaseState } from "../../shared/device/base";
import { num } from "../../shared/media/control";
import { isFrameConsumerHost, isFrameSource, revokeMediaUrls } from "../../shared/mediaRef";
import { installVirtualTime, nextRealFrame, nextTask, type VirtualClock } from "../../shared/virtual-time";
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
/** Débit Opus (bits/s). */
const OPUS_BITRATE = 128_000;
/** Paquets audio en attente au-delà desquels on jette les échantillons (encodeur débordé). */
const MAX_AUDIO_QUEUE = 64;

export type VideoExportMode = "live" | "frames" | "offline";

export type VideoExportFile = { url: string; name: string; type: "video/webm"; mime: "video/webm"; size: number };

export type VideoExportState = DeviceBaseState & {
  mode: VideoExportMode;
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
  /** Piste son en cours d'enregistrement ou présente dans le fichier (mode live). */
  audio: boolean;
  /** Avertissement non bloquant (son non capturé…), `null` sinon. */
  warning: string | null;
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

type AudioChunkMeta = { decoderConfig?: { description?: ArrayBuffer | ArrayBufferView } };
type AudioEnc = {
  configure(c: Record<string, unknown>): void;
  encode(data: AudioDataLike): void;
  flush(): Promise<void>;
  close(): void;
  readonly encodeQueueSize: number;
  readonly state?: string;
};
type AudioEncCtor = {
  new (init: { output: (chunk: Chunk, meta?: AudioChunkMeta) => void; error: (e: unknown) => void }): AudioEnc;
  isConfigSupported(c: Record<string, unknown>): Promise<{ supported?: boolean }>;
};
type AudioDataLike = {
  readonly timestamp: number;
  readonly duration: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  close(): void;
};
type AudioDataCtor = new (init: {
  format: "f32-planar";
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  timestamp: number;
  data: Float32Array;
}) => AudioDataLike;
type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<AudioDataLike> };

function webcodecs(): { Encoder: EncoderCtor; Frame: FrameCtor } | null {
  const g = globalThis as unknown as { VideoEncoder?: EncoderCtor; VideoFrame?: FrameCtor };
  return typeof g.VideoEncoder === "function" && typeof g.VideoFrame === "function" ? { Encoder: g.VideoEncoder, Frame: g.VideoFrame } : null;
}

function audioCodecs(): { Encoder: AudioEncCtor; Data: AudioDataCtor | null } | null {
  const g = globalThis as unknown as { AudioEncoder?: AudioEncCtor; AudioData?: AudioDataCtor };
  return typeof g.AudioEncoder === "function" ? { Encoder: g.AudioEncoder, Data: typeof g.AudioData === "function" ? g.AudioData : null } : null;
}

const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function sourceSize(src: CanvasImageSource): { w: number; h: number } {
  const s = src as HTMLVideoElement & HTMLCanvasElement;
  return { w: s.videoWidth || s.width || 0, h: s.videoHeight || s.height || 0 };
}

/** Prise de son : rend des AudioData tant qu'elle n'est pas arrêtée. */
type AudioTap = { stop(): void };

/**
 * Branche `node` sur une prise de son : MediaStreamTrackProcessor (AudioData horodatées par le
 * navigateur) si présent, sinon ScriptProcessorNode (échantillons recopiés en AudioData).
 */
function openAudioTap(ac: AudioContext, node: AudioNode, Data: AudioDataCtor | null, onData: (d: AudioDataLike) => void): AudioTap | null {
  const g = globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor };
  if (typeof g.MediaStreamTrackProcessor === "function" && typeof ac.createMediaStreamDestination === "function") {
    const dest = ac.createMediaStreamDestination();
    dest.channelCount = 2;
    const track = dest.stream.getAudioTracks()[0];
    if (track) {
      node.connect(dest);
      const reader = new g.MediaStreamTrackProcessor({ track }).readable.getReader();
      let open = true;
      void (async () => {
        try {
          while (open) {
            const r = await reader.read();
            if (r.done) break;
            if (open) onData(r.value);
            else r.value.close();
          }
        } catch {
          /* flux fermé */
        }
      })();
      return {
        stop() {
          open = false;
          void reader.cancel().catch(() => undefined);
          track.stop();
          try {
            node.disconnect(dest);
          } catch {
            /* déjà débranché */
          }
        },
      };
    }
  }
  if (Data && typeof ac.createScriptProcessor === "function") {
    const sp = ac.createScriptProcessor(4096, 2, 2);
    let samples = 0;
    sp.onaudioprocess = (e: AudioProcessingEvent) => {
      const input = e.inputBuffer;
      const n = input.length;
      const ch = Math.min(2, input.numberOfChannels) || 1;
      const planar = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) planar.set(input.getChannelData(c), c * n);
      const timestamp = Math.round((samples / input.sampleRate) * 1e6);
      samples += n;
      onData(new Data({ format: "f32-planar", sampleRate: input.sampleRate, numberOfFrames: n, numberOfChannels: ch, timestamp, data: planar }));
    };
    node.connect(sp);
    // Un ScriptProcessor ne tourne que branché sur la sortie (il y écrit du silence).
    sp.connect(ac.destination);
    return {
      stop() {
        sp.onaudioprocess = null;
        try {
          node.disconnect(sp);
          sp.disconnect();
        } catch {
          /* déjà débranché */
        }
      },
    };
  }
  return null;
}

type AudioJob = {
  encoder: AudioEnc;
  tap: AudioTap | null;
  configured: boolean;
  /** Décalage µs entre l'horloge des AudioData et le temps de la vidéo (fixé au premier paquet). */
  offsetUs: number | null;
  failed: boolean;
};

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
  mode: VideoExportMode;
  audio: AudioJob | null;
  clock: VirtualClock | null;
};

/**
 * Export vidéo image par image (WebCodecs + muxer WebM intégré, sans dépendance) d'une source
 * d'images (`source="#id"` : sonic-shader, sonic-3d, sonic-2d, sonic-camera, sonic-video…).
 *
 * - `mode="live"` : une image par rafraîchissement, horodatée à l'instant réel ; son possible
 *   (`audio-source`, Opus).
 * - `mode="frames"` (défaut) : temps fixe, image n à n / fps, la capture suit la cadence réelle du
 *   rendu (jamais plus vite que `fps`) : vidéo fluide même si le rendu est lent (elle paraît alors
 *   accélérée).
 * - `mode="offline"` : rendu hors temps réel. Le temps de la page est virtualisé
 *   (`shared/virtual-time` : rAF, performance.now, Date.now) et avance de exactement 1 / fps par
 *   image : la vidéo est exacte quelle que soit la lenteur du rendu. Pas de son.
 *
 * Commandes `control` : `{start, stop, cancel, toggle}` (compteurs) ; `for="idBouton"` = toggle.
 * Fichier publié dans `file` {url blob:, name, type, mime, size} pour `sonic-media-download`,
 * action `video:done` vers `target`.
 */
@customElement(tagName)
export class SonicVideoExport extends DeviceElement<VideoExportState> {
  /** `#id` d'une source d'images. */
  @property({ type: String }) source = "";
  /** `frames` (défaut, temps fixe), `live` (temps réel) ou `offline` (temps virtuel, image exacte). */
  @property({ type: String }) mode: VideoExportMode = "frames";
  /** Son (mode live seulement) : `none` (défaut), `master` (tout ce qu'on entend) ou `#id` d'une source audio. */
  @property({ type: String, attribute: "audio-source" }) audioSource = "none";
  /** Images par seconde de la vidéo (défaut 30). */
  @property({ type: Number }) fps = 30;
  /** Durée en s (arrêt automatique ; 0 = jusqu'à `stop`). */
  @property({ type: Number }) duration = 0;
  /** Nombre d'images (modes frames et offline ; prioritaire sur `duration`). */
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
    width: 0, height: 0, bytes: 0, audio: false, warning: null, file: null,
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
    // Son : préparé avant l'encodeur vidéo (une vérification asynchrone).
    const sound = await this.prepareAudio(mode);
    if (this.job) return true;
    const frameMs = 1000 / fps;
    const duration = num(this.duration, 0, 3600) ?? 0;
    const total = mode === "live" ? 0 : Math.round(num(this.frames, 0, 1_000_000) || duration * fps);
    const maxBytes = (num(this.maxMb, 1, 2000) ?? 200) * 1_000_000;
    const muxer = new WebmMuxer({
      codec: chosen.webm, width, height, maxBytes,
      frameMs: mode === "live" ? undefined : frameMs,
      audio: sound.node ? { channels: 2, inputRate: sound.node.context.sampleRate } : undefined,
    });
    const job: Job = {
      encoder: null as unknown as Encoder,
      muxer, codec: chosen.webcodecs, width, height, frameMs, total,
      limitMs: mode === "live" ? duration * 1000 : 0,
      t0: performance.now(), index: 0, lastSeq: -1, lastWall: -Infinity, lastKeyMs: -Infinity, lastMs: 0,
      failed: null, token: {}, source: src, mode, audio: null, clock: null,
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
            this.abortJob(job, e instanceof Error ? e.message : String(e));
            return;
          }
          this.patch({ bytes: muxer.size }, false);
        },
        error: (e) => {
          if (this.job !== job) return;
          this.abortJob(job, `encodeur : ${e instanceof Error ? e.message : String(e)}`);
        },
      });
      job.encoder.configure({ codec: chosen.webcodecs, ...config, latencyMode: "quality" });
    } catch (e) {
      this.patch({ status: "error", error: `encodeur impossible à configurer : ${e instanceof Error ? e.message : String(e)}` });
      return false;
    }
    if (mode === "offline") {
      try {
        job.clock = installVirtualTime();
      } catch (e) {
        try {
          job.encoder.close();
        } catch {
          /* déjà fermé */
        }
        this.patch({ status: "error", error: e instanceof Error ? e.message : String(e) });
        return false;
      }
    }
    if (isFrameConsumerHost(src)) src.registerFrameConsumer(job.token);
    this.job = job;
    let warning = sound.warning;
    if (sound.node) {
      job.audio = this.startAudio(job, sound.node);
      if (!job.audio) warning = "son non capturé : prise de son impossible dans ce navigateur";
    }
    this.patch({
      status: "ready", error: null, active: true, encoding: true, mode,
      frames: 0, seconds: 0, progress: total || job.limitMs ? 0 : null,
      codec: chosen.webcodecs, width, height, bytes: 0, audio: !!job.audio, warning,
    });
    this.emit("video-start", { codec: chosen.webcodecs, width, height, mode, audio: !!job.audio });
    if (mode === "offline") void this.runOffline(job);
    else this.loop();
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
    const a = job.audio;
    if (a) {
      try {
        if (a.configured && !a.failed) await a.encoder.flush();
      } catch {
        a.failed = true;
      }
      try {
        a.encoder.close();
      } catch {
        /* déjà fermé */
      }
    }
    if (this.job !== job) return false; // annulé pendant la finalisation
    this.job = null;
    if (!job.muxer.frames) {
      this.patch({ status: job.failed ? "error" : "ready", encoding: false, error: job.failed ?? "aucune image capturée" });
      return false;
    }
    const durationMs = job.mode === "live" ? job.lastMs + job.frameMs : job.index * job.frameMs;
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
    const audio = job.muxer.audioPackets > 0;
    const warning = a && !audio ? (this.state.warning ?? "son non capturé : aucun échantillon reçu") : this.state.warning;
    this.patch({
      status: "ready", encoding: false, error: job.failed, file, bytes: blob.size, seconds, audio, warning,
      progress: this.state.progress === null ? null : 1,
    });
    const payload = { file, frames: job.index, seconds, codec: job.codec, width: job.width, height: job.height, audio, error: job.failed };
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
    try {
      job.audio?.encoder.close();
    } catch {
      /* déjà fermé */
    }
    if (this.isConnected) this.patch({ active: false, encoding: false, frames: 0, seconds: 0, bytes: this.state.file?.size ?? 0, progress: null, audio: false });
    return true;
  }

  /**
   * Un pas de capture des modes live et frames (appelé à chaque rafraîchissement ; public pour les
   * tests). Retourne vrai si une image a été envoyée à l'encodeur.
   */
  step(now: number = performance.now()): boolean {
    const job = this.job;
    if (!job || !this.state.active || job.mode === "offline") return false;
    const live = job.mode === "live";
    const seq = job.source.frameSeq;
    const fresh = seq !== job.lastSeq || now - job.lastWall >= STILL_MS;
    if (!fresh) return false;
    const elapsed = now - job.t0;
    // Mode frames : jamais plus vite que la cadence réelle visée.
    if (!live && elapsed + 1 < job.index * job.frameMs) return false;
    if (job.encoder.encodeQueueSize > MAX_QUEUE) return false;
    const tMs = live ? elapsed : job.index * job.frameMs;
    if (live && job.limitMs && tMs >= job.limitMs) {
      void this.stop();
      return false;
    }
    if (!this.encodeAt(job, tMs)) return false;
    job.lastSeq = seq;
    job.lastWall = now;
    return true;
  }

  /* ---------------------------------------------------------------- */

  private currentMode(): VideoExportMode {
    return this.mode === "live" || this.mode === "offline" ? this.mode : "frames";
  }

  /** Encode l'image courante de la source à l'instant `tMs` de la vidéo ; publie l'avancement. */
  private encodeAt(job: Job, tMs: number): boolean {
    const api = webcodecs();
    const img = this.image(job.source);
    if (!api || !img) return false;
    const canvas = this.draw(img, job.width, job.height);
    const key = job.index === 0 || tMs - job.lastKeyMs >= (num(this.keyframeEvery, 0.1, 60) ?? 2) * 1000;
    let frame: { close(): void } | null = null;
    try {
      frame = new api.Frame(canvas, { timestamp: Math.round(tMs * 1000), duration: Math.round(job.frameMs * 1000) });
      job.encoder.encode(frame, { keyFrame: key });
    } catch (e) {
      this.abortJob(job, `image refusée : ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      frame?.close();
    }
    if (key) job.lastKeyMs = tMs;
    job.lastMs = tMs;
    job.index++;
    const live = job.mode === "live";
    const seconds = r3(live ? tMs / 1000 : (job.index * job.frameMs) / 1000);
    const progress = job.total ? Math.min(1, job.index / job.total) : job.limitMs ? Math.min(1, tMs / job.limitMs) : null;
    this.patch({ frames: job.index, seconds, progress: progress === null ? null : r3(progress) }, false);
    if (job.total && job.index >= job.total) void this.stop();
    return true;
  }

  /** Erreur pendant l'export : arrêt, fichier gardé avec ce qui est fait. */
  private abortJob(job: Job, message: string): void {
    job.failed ??= message;
    if (this.job === job) void this.stop();
  }

  /**
   * Boucle du mode offline. À chaque image : le temps virtuel avance de 1 / fps, les rappels rAF
   * en attente s'exécutent (les sources dessinent), une tâche passe (mises à jour Lit et promesses
   * déclenchées par ce rendu), l'image est capturée, puis un vrai rafraîchissement laisse la page
   * s'afficher (progression, boutons) — sauf onglet masqué, où rAF est suspendu.
   */
  private async runOffline(job: Job): Promise<void> {
    const clock = job.clock!;
    const alive = () => this.job === job && this.state.active && !job.failed;
    try {
      // Les boucles lancées avant l'installation tournent encore une fois au vrai rythme (rappels
      // déjà confiés au vrai rAF) puis passent dans la file virtuelle : le temps est figé à
      // l'horodatage de ce rafraîchissement, que ces rappels ont reçu.
      const origin = await nextRealFrame(clock.real);
      clock.freeze(origin);
      await nextTask();
      while (alive()) {
        if (job.index > 0) {
          // Image n à exactement origine + n / fps (sans cumul d'arrondis).
          clock.advanceTo(origin + job.index * job.frameMs);
          await nextTask();
          if (!alive()) break;
        }
        while (job.encoder.encodeQueueSize > MAX_QUEUE && alive()) await nextTask();
        if (!alive()) break;
        if (!this.encodeAt(job, job.index * job.frameMs)) {
          // Source sans image : ses rappels tournent sans que le temps virtuel avance.
          if (!alive()) break;
          await nextRealFrame(clock.real);
          clock.advanceTo(clock.now());
          await nextTask();
          continue;
        }
        if (!alive()) break;
        if (!document.hidden) await nextRealFrame(clock.real);
      }
    } catch (e) {
      job.failed ??= `capture hors temps réel : ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      clock.restore();
    }
    if (this.job === job && this.state.active) await this.stop();
  }

  /** Nœud audio à enregistrer (mode live), ou la raison de son absence. */
  private async prepareAudio(mode: VideoExportMode): Promise<{ node: AudioNode | null; warning: string | null }> {
    const ref = (this.audioSource || "none").trim();
    if (!ref || ref === "none") return { node: null, warning: null };
    if (mode !== "live") return { node: null, warning: `son ignoré : seulement en mode live (mode ${mode})` };
    const codecs = audioCodecs();
    if (!codecs) return { node: null, warning: "son non capturé : AudioEncoder absent de ce navigateur" };
    let node: AudioNode | null = null;
    if (ref === "master") {
      node = AudioEngine.get().output;
      if (!node) return { node: null, warning: "son non capturé : moteur audio pas encore démarré (il faut un geste)" };
    } else {
      const el = resolveAudioElement(this, ref);
      node = isAudioSource(el) ? el.getAudioOutput() : null;
      if (!node) return { node: null, warning: `son non capturé : source audio "${ref}" introuvable` };
    }
    const ac = node.context;
    try {
      const r = await codecs.Encoder.isConfigSupported({ codec: "opus", sampleRate: ac.sampleRate, numberOfChannels: 2, bitrate: OPUS_BITRATE });
      if (!r?.supported) return { node: null, warning: "son non capturé : encodeur Opus non disponible" };
    } catch {
      return { node: null, warning: "son non capturé : encodeur Opus non disponible" };
    }
    return { node, warning: null };
  }

  /** Encodeur Opus + prise de son ; null si la prise est impossible. */
  private startAudio(job: Job, node: AudioNode): AudioJob | null {
    const codecs = audioCodecs();
    if (!codecs) return null;
    const ac = node.context as AudioContext;
    let a: AudioJob;
    const fail = (why: string) => {
      if (a.failed) return;
      a.failed = true;
      a.tap?.stop();
      if (this.job === job) this.patch({ warning: `son interrompu : ${why}` });
    };
    try {
      a = {
        encoder: new codecs.Encoder({
          output: (chunk, meta) => {
            if (this.job !== job || job.failed || a.failed || a.offsetUs === null) return;
            const desc = meta?.decoderConfig?.description;
            if (desc) {
              job.muxer.setAudioCodecPrivate(
                desc instanceof ArrayBuffer ? new Uint8Array(desc.slice(0)) : new Uint8Array(desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength)),
              );
            }
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            try {
              job.muxer.addAudio(data, (chunk.timestamp - a.offsetUs) / 1000);
            } catch (e) {
              this.abortJob(job, e instanceof Error ? e.message : String(e));
            }
          },
          error: (e) => fail(e instanceof Error ? e.message : String(e)),
        }),
        tap: null, configured: false, offsetUs: null, failed: false,
      };
    } catch {
      return null;
    }
    a.tap = openAudioTap(ac, node, codecs.Data, (d) => {
      try {
        if (this.job !== job || a.failed || !this.state.active) return;
        if (!a.configured) {
          if (d.numberOfChannels > 2) throw new Error(`${d.numberOfChannels} canaux (2 au plus)`);
          a.encoder.configure({ codec: "opus", sampleRate: d.sampleRate, numberOfChannels: d.numberOfChannels, bitrate: OPUS_BITRATE });
          a.configured = true;
          job.muxer.opts.audio = { channels: d.numberOfChannels, inputRate: d.sampleRate };
        }
        // Premier paquet : sa fin correspond à l'instant présent de la vidéo.
        if (a.offsetUs === null) {
          const endUs = (performance.now() - job.t0) * 1000;
          a.offsetUs = d.timestamp - Math.max(0, endUs - d.duration);
        }
        if (a.encoder.encodeQueueSize <= MAX_AUDIO_QUEUE) a.encoder.encode(d);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      } finally {
        d.close();
      }
    });
    if (!a.tap) {
      try {
        a.encoder.close();
      } catch {
        /* rien */
      }
      return null;
    }
    return a;
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
    // Toujours rendre le temps réel à la page (fin, annulation, erreur, retrait du composant).
    job.clock?.restore();
    job.audio?.tap?.stop();
    if (isFrameConsumerHost(job.source)) job.source.unregisterFrameConsumer(job.token);
  }
}

export default SonicVideoExport;
