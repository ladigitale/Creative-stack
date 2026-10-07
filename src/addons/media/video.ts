import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine, AudioRoute, resolveAudioElement } from "../../shared/audio/engine";
import { isAudioSink, type SonicAudioSource } from "../../shared/audio/contracts";
import { listenDp } from "../../shared/audio/dp";
import { onFirstGesture } from "../../shared/media/capture";
import { bool, num } from "../../shared/media/control";
import { VideoFrames } from "../../shared/media/frames";
import { safeMediaUrl } from "../../shared/media/urls";
import { toMediaUrl, type SonicFrameConsumerHost, type SonicFrameSource } from "../../shared/mediaRef";

const tagName = "sonic-video";

export type VideoStatus = "idle" | "loading" | "ready" | "playing" | "paused" | "ended" | "needs-gesture" | "error";

export type VideoState = {
  status: VideoStatus;
  error: string | null;
  src: string | null;
  playing: boolean;
  ended: boolean;
  timeS: number;
  durationS: number;
  /** Position 0..1. */
  progress: number;
  rate: number;
  volume: number;
  muted: boolean;
  width: number;
  height: number;
};

const sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

/**
 * Lecteur vidéo déclaratif, propriétaire de sa <video> (aucun autre composant n'y touche).
 * Pilotage par attributs et DP `control` ({ playing, seek, rate, volume, muted, loop, loopStart, loopEnd }),
 * état publié (temps, durée, progression…), source d'images pour `sonic-shader channel0="#id"`,
 * son routable vers le moteur audio (`audio-out`) pour l'analyser.
 */
@customElement(tagName)
export class SonicVideo extends LitElement implements SonicFrameSource, SonicFrameConsumerHost, SonicAudioSource {
  static styles = css`
    :host {
      display: block;
      position: relative;
      overflow: hidden;
      background: #000;
      line-height: 0;
    }
    :host([hidden-preview]) {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
    }
    video {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: var(--sonic-video-fit, contain);
    }
  `;

  /** URL https, relative, blob: ou data:video/. */
  @property({ type: String })
  src = "";

  /** DataProvider contenant la source (URL ou SonicMediaRef { url }) : prioritaire sur `src`. */
  @property({ type: String, attribute: "src-provider" })
  srcProvider = "";

  @property({ type: Boolean })
  autoplay = false;

  @property({ type: Boolean })
  loop = false;

  @property({ type: Boolean })
  muted = false;

  /** Contrôles natifs du navigateur. */
  @property({ type: Boolean })
  controls = false;

  /** `auto` (défaut), `metadata`, ou `blob` : télécharge tout le fichier (pour se déplacer dans une vidéo servie sans « range requests »). */
  @property({ type: String })
  preload: "auto" | "metadata" | "blob" = "auto";

  /** `anonymous` (défaut, nécessaire pour les shaders et l'analyse), `use-credentials` ou `none`. */
  @property({ type: String })
  crossorigin = "anonymous";

  @property({ type: String })
  fit = "contain";

  @property({ type: Boolean, attribute: "hidden-preview" })
  hiddenPreview = false;

  @property({ type: Number })
  rate = 1;

  @property({ type: Number })
  volume = 1;

  /** Boucle A–B (s). */
  @property({ type: Number, attribute: "loop-start" })
  loopStart = 0;

  @property({ type: Number, attribute: "loop-end" })
  loopEnd = 0;

  /**
   * Son : vide = joué normalement par la vidéo ; `master` ou `#id` = passe par le moteur audio
   * (analysable, enregistrable) ; `none` = analysable mais muet.
   */
  @property({ type: String, attribute: "audio-out" })
  audioOut = "";

  /** Publications du temps par seconde (défaut 10). */
  @property({ type: Number, attribute: "update-rate" })
  updateRate = 10;

  @property({ type: String })
  control = "";

  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  @query("video")
  private videoEl!: HTMLVideoElement;

  private frames: VideoFrames | null = null;
  private state: VideoState = {
    status: "idle", error: null, src: null, playing: false, ended: false, timeS: 0, durationS: 0, progress: 0,
    rate: 1, volume: 1, muted: false, width: 0, height: 0,
  };
  private providedSrc: string | null = null;
  private blobUrl: string | null = null;
  private loadToken = 0;
  private wantPlaying: boolean | null = null;
  private lastSeek: string | undefined;
  private gainNode: GainNode | null = null;
  private route: AudioRoute | null = null;
  private silentSink: GainNode | null = null;
  private unsubs: (() => void)[] = [];
  private srcUnsub: (() => void) | null = null;
  private cancelGesture: (() => void) | null = null;
  private unsubscribeEngine: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private forcedMute = false;

  /* ---------------------------------------------------------------- */
  /* Contrats                                                          */
  /* ---------------------------------------------------------------- */

  get frameSeq(): number {
    return this.frames?.seq ?? 0;
  }

  getFrameCanvas(): HTMLCanvasElement | null {
    return this.frames?.getFrameCanvas() ?? null;
  }

  getFrameSource(): HTMLVideoElement | null {
    return this.frames?.getFrameSource() ?? null;
  }

  registerFrameConsumer(token: object = {}): void {
    this.frames?.consumers.add(token);
  }

  unregisterFrameConsumer(token: object = {}): void {
    this.frames?.consumers.delete(token);
  }

  getAudioOutput(): AudioNode | null {
    return this.gainNode;
  }

  /* ---------------------------------------------------------------- */
  /* Cycle de vie                                                      */
  /* ---------------------------------------------------------------- */

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribeEngine = AudioEngine.get().onChange(() => this.wireAudio());
  }

  disconnectedCallback(): void {
    this.unsubscribeEngine?.();
    this.cancelGesture?.();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.srcUnsub?.();
    this.srcUnsub = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.frames?.stop();
    const v = this.videoEl;
    if (v) {
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    this.revokeBlob();
    try {
      this.gainNode?.disconnect();
    } catch {
      /* ok */
    }
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    const v = this.videoEl;
    this.frames = new VideoFrames(v);
    this.frames.maxWidth = 1280;
    this.frames.start();
    const on = (ev: string, fn: () => void) => v.addEventListener(ev, fn);
    on("loadedmetadata", () => this.onMeta());
    on("play", () => this.sync());
    on("playing", () => this.sync());
    on("pause", () => this.sync());
    on("ended", () => this.sync());
    on("seeked", () => this.sync());
    on("ratechange", () => this.sync());
    on("volumechange", () => this.sync());
    on("timeupdate", () => this.checkLoop());
    on("error", () => {
      const code = v.error?.code;
      const msg =
        code === 4 ? "format vidéo non pris en charge ou fichier introuvable" : code === 2 ? "erreur réseau" : code === 3 ? "vidéo illisible" : "erreur de lecture";
      this.patch({ status: "error", error: msg });
    });
    this.startClock();
    this.load();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (!this.videoEl) return;
    const v = this.videoEl;
    if (changed.has("src") || changed.has("preload") || changed.has("crossorigin")) {
      if (changed.get("src") !== undefined || changed.get("preload") !== undefined || changed.get("crossorigin") !== undefined) this.load();
    }
    if (changed.has("srcProvider")) this.listenSrc();
    if (changed.has("loop")) v.loop = this.loop && !(this.loopEnd > this.loopStart);
    if (changed.has("muted")) {
      this.forcedMute = false;
      v.muted = this.muted;
    }
    if (changed.has("rate")) v.playbackRate = clamp(this.rate, 0.0625, 16);
    if (changed.has("volume")) this.applyVolume();
    if (changed.has("audioOut")) this.wireAudio();
    if (changed.has("updateRate")) this.startClock();
    if (changed.has("fit")) this.style.setProperty("--sonic-video-fit", this.fit === "cover" ? "cover" : "contain");
    if (changed.has("control")) this.listenControl();
    if (changed.has("autoplay") && this.autoplay && this.wantPlaying === null) this.wantPlaying = true;
  }

  /* ---------------------------------------------------------------- */
  /* API                                                               */
  /* ---------------------------------------------------------------- */

  play(): void {
    this.wantPlaying = true;
    void this.tryPlay();
  }

  pause(): void {
    this.wantPlaying = false;
    this.videoEl?.pause();
  }

  toggle(): void {
    if (this.videoEl?.paused) this.play();
    else this.pause();
  }

  seek(t: number): void {
    const v = this.videoEl;
    if (!v || !Number.isFinite(t)) return;
    const d = Number.isFinite(v.duration) ? v.duration : Infinity;
    v.currentTime = Math.min(Math.max(0, t), d);
  }

  /** Pour `sonic-media-start` (appelé dans un geste) : active le son et lance la lecture. */
  start(): void {
    if (this.audioOut) void AudioEngine.get().unlock();
    this.play();
  }

  getState(): VideoState {
    return { ...this.state };
  }

  /* ---------------------------------------------------------------- */
  /* Source                                                            */
  /* ---------------------------------------------------------------- */

  private listenSrc(): void {
    this.srcUnsub?.();
    this.srcUnsub = null;
    this.providedSrc = null;
    if (!this.srcProvider) return;
    this.srcUnsub = listenDp(this.srcProvider, (val) => {
      const url = toMediaUrl(val);
      if (url === this.providedSrc) return;
      this.providedSrc = url;
      this.load();
    });
  }

  private currentSrc(): string {
    return (this.providedSrc ?? this.src ?? "").trim();
  }

  private revokeBlob(): void {
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = null;
  }

  private async load(): Promise<void> {
    const v = this.videoEl;
    if (!v) return;
    const token = ++this.loadToken;
    const url = this.currentSrc();
    this.revokeBlob();
    if (!url) {
      v.removeAttribute("src");
      v.load();
      this.patch({ status: "idle", error: null, src: null, durationS: 0, timeS: 0, progress: 0 });
      return;
    }
    if (!safeMediaUrl(url, "video")) {
      this.patch({ status: "error", error: "URL vidéo refusée (https, relative, blob: ou data:video/)", src: null });
      return;
    }
    const cross = this.crossorigin === "none" ? null : this.crossorigin === "use-credentials" ? "use-credentials" : "anonymous";
    if (cross && !/^(blob|data):/i.test(url)) v.crossOrigin = cross;
    else v.removeAttribute("crossorigin");
    this.patch({ status: "loading", error: null, src: url, ended: false });
    let finalUrl = url;
    if (this.preload === "blob" && !/^(blob|data):/i.test(url)) {
      try {
        const res = await fetch(url, { credentials: cross === "use-credentials" ? "include" : "same-origin" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (token !== this.loadToken) return;
        this.blobUrl = URL.createObjectURL(blob);
        finalUrl = this.blobUrl;
        v.removeAttribute("crossorigin");
      } catch (e) {
        if (token !== this.loadToken) return;
        this.patch({ status: "error", error: `téléchargement impossible (${e instanceof Error ? e.message : String(e)})` });
        return;
      }
    }
    v.preload = this.preload === "metadata" ? "metadata" : "auto";
    v.muted = this.muted || this.forcedMute;
    v.loop = this.loop && !(this.loopEnd > this.loopStart);
    v.playbackRate = clamp(this.rate, 0.0625, 16);
    v.src = finalUrl;
    if (this.autoplay && this.wantPlaying === null) this.wantPlaying = true;
    if (this.wantPlaying) void this.tryPlay();
  }

  private onMeta(): void {
    const v = this.videoEl;
    this.patch({
      status: v.paused ? "ready" : "playing",
      width: v.videoWidth,
      height: v.videoHeight,
      durationS: Number.isFinite(v.duration) ? +v.duration.toFixed(3) : 0,
    });
    if (this.wantPlaying) void this.tryPlay();
  }

  /* ---------------------------------------------------------------- */
  /* Lecture                                                           */
  /* ---------------------------------------------------------------- */

  private async tryPlay(): Promise<void> {
    const v = this.videoEl;
    if (!v || !this.currentSrc() || v.readyState < 1) return;
    try {
      await v.play();
    } catch (e) {
      if ((e as { name?: string }).name !== "NotAllowedError") return;
      // Lecture avec son bloquée avant un geste : on démarre en muet, le son revient au premier geste.
      if (!v.muted) {
        this.forcedMute = true;
        v.muted = true;
        try {
          await v.play();
        } catch {
          /* même muette, refusée */
        }
        this.patch({ status: "needs-gesture" });
        this.cancelGesture?.();
        this.cancelGesture = onFirstGesture(() => {
          if (this.forcedMute) {
            this.forcedMute = false;
            v.muted = this.muted;
          }
          if (this.wantPlaying) void v.play().catch(() => undefined);
          this.sync();
        });
      }
    }
  }

  private checkLoop(): void {
    const v = this.videoEl;
    if (this.loopEnd > this.loopStart && v.currentTime >= this.loopEnd) {
      v.currentTime = this.loopStart;
      if (this.wantPlaying !== false) void v.play().catch(() => undefined);
    }
  }

  private listenControl(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.lastSeek = undefined;
    if (!this.control) return;
    this.unsubs.push(
      listenDp(this.control, (val) => {
        if (!val || typeof val !== "object") return;
        const c = val as Record<string, unknown>;
        const r = num(c.rate, 0.0625, 16);
        if (r !== undefined) this.rate = r;
        const vol = num(c.volume, 0, 1);
        if (vol !== undefined) this.volume = vol;
        const m = bool(c.muted);
        if (m !== undefined) this.muted = m;
        const l = bool(c.loop);
        if (l !== undefined) this.loop = l;
        const ls = num(c.loopStart, 0, 1e6);
        if (ls !== undefined) this.loopStart = ls;
        const le = num(c.loopEnd, 0, 1e6);
        if (le !== undefined) this.loopEnd = le;
        if (c.seek !== undefined && c.seek !== null) {
          const key = JSON.stringify(c.seek);
          const t = typeof c.seek === "number" ? c.seek : Number((c.seek as { t?: unknown }).t);
          if (this.lastSeek !== undefined && key !== this.lastSeek && Number.isFinite(t)) this.seek(t);
          this.lastSeek = key;
        }
        const p = bool(c.playing);
        if (p === true) this.play();
        if (p === false) this.pause();
      }),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Son                                                               */
  /* ---------------------------------------------------------------- */

  private applyVolume(): void {
    const vol = clamp(this.volume, 0, 1);
    if (this.gainNode) {
      const ac = this.gainNode.context;
      this.gainNode.gain.setTargetAtTime(this.audioOut === "none" ? 0 : vol, ac.currentTime, 0.02);
      if (this.videoEl) this.videoEl.volume = 1;
    } else if (this.videoEl) {
      this.videoEl.volume = vol;
    }
  }

  private wireAudio(): void {
    const out = this.audioOut.trim();
    const engine = AudioEngine.get();
    const v = this.videoEl;
    if (!out || !v || !engine.context || !engine.master) {
      this.applyVolume();
      return;
    }
    const ac = engine.context as AudioContext;
    if (!this.gainNode) {
      // Une source par <video> et pour toute sa vie (contrainte WebAudio).
      let src = sources.get(v);
      if (!src) {
        src = ac.createMediaElementSource(v);
        sources.set(v, src);
      }
      this.gainNode = ac.createGain();
      src.connect(this.gainNode);
      this.route = new AudioRoute(this.gainNode);
    }
    if (out === "none") {
      // Analysable (getAudioOutput) mais muet : tiré par une sortie à 0.
      if (!this.silentSink) {
        this.silentSink = ac.createGain();
        this.silentSink.gain.value = 0;
        this.silentSink.connect(ac.destination);
      }
      this.route!.to(this.silentSink);
    } else if (out === "master") {
      this.route!.to(engine.master);
    } else {
      const el = resolveAudioElement(this, out);
      const input = isAudioSink(el) ? el.getAudioInput() : null;
      this.route!.to(input ?? engine.master);
    }
    this.applyVolume();
  }

  /* ---------------------------------------------------------------- */
  /* État                                                              */
  /* ---------------------------------------------------------------- */

  private startClock(): void {
    if (this.timer) clearInterval(this.timer);
    const hz = Math.min(60, Math.max(1, this.updateRate || 10));
    this.timer = setInterval(() => {
      const v = this.videoEl;
      if (v && !v.paused && Math.abs(v.currentTime - this.state.timeS) > 0.0005) this.sync();
    }, 1000 / hz);
  }

  private sync(): void {
    const v = this.videoEl;
    if (!v) return;
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    const status: VideoStatus =
      this.state.status === "error"
        ? "error"
        : !this.currentSrc()
          ? "idle"
          : v.ended
            ? "ended"
            : !v.paused
              ? this.forcedMute
                ? "needs-gesture"
                : "playing"
              : v.readyState >= 1
                ? this.state.status === "needs-gesture" && this.forcedMute
                  ? "needs-gesture"
                  : v.currentTime > 0
                    ? "paused"
                    : "ready"
                : "loading";
    this.patch({
      status,
      playing: !v.paused && !v.ended,
      ended: v.ended,
      timeS: +v.currentTime.toFixed(3),
      durationS: +d.toFixed(3),
      progress: d > 0 ? +(v.currentTime / d).toFixed(4) : 0,
      rate: v.playbackRate,
      volume: clamp(this.volume, 0, 1),
      muted: v.muted,
    });
  }

  private patch(p: Partial<VideoState>): void {
    this.state = { ...this.state, ...p };
    this.publish();
  }

  private publishQueued = false;
  private publish(): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (!out || this.publishQueued) return;
    this.publishQueued = true;
    queueMicrotask(() => {
      this.publishQueued = false;
      set(out, this.getState());
    });
  }

  render() {
    return html`<video playsinline ?controls=${this.controls} part="video"></video>`;
  }
}

function clamp(v: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

export default SonicVideo;
