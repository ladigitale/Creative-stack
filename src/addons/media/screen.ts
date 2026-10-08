import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine } from "../../shared/audio/engine";
import type { SonicAudioSource } from "../../shared/audio/contracts";
import { listenDp } from "../../shared/audio/dp";
import { stopStream, type CaptureStatus } from "../../shared/media/capture";
import { bool, CounterTrigger } from "../../shared/media/control";
import { VideoFrames } from "../../shared/media/frames";
import { revokeMediaUrls, type SonicFrameConsumerHost, type SonicFrameSource, type SonicMediaRef } from "../../shared/mediaRef";

const tagName = "sonic-screen";

export type ScreenState = {
  status: CaptureStatus;
  error: string | null;
  active: boolean;
  /** Ce que l'utilisateur partage : `monitor` (écran), `window`, `browser` (onglet). */
  surface: string | null;
  width: number;
  height: number;
  /** Le partage contient du son (onglet ou écran avec « partager l'audio »). */
  audio: boolean;
  snapshot: { url: string; width: number; height: number; mime: string } | null;
  snapshots: number;
};

/**
 * Capture d'écran (`getDisplayMedia`) : source d'images pour `sonic-shader channel0="#id"`,
 * photos, son du partage pour l'analyseur ou l'enregistreur, export par `sonic-media-recorder`.
 *
 * Le navigateur exige un clic **direct** : `sonic-media-start for="screen"`, ou `control.active`
 * mis à vrai par un bouton. L'utilisateur choisit quoi partager et peut arrêter à tout moment
 * (barre du navigateur) : l'état repasse à `idle` avec un message.
 */
@customElement(tagName)
export class SonicScreen extends LitElement implements SonicFrameSource, SonicFrameConsumerHost, SonicAudioSource {
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
      object-fit: var(--sonic-screen-fit, contain);
    }
    video.off {
      visibility: hidden;
    }
    ::slotted(*) {
      line-height: normal;
    }
  `;

  @property({ type: Boolean })
  active = false;

  /** Demander aussi le son (onglet, ou écran entier sous Windows / ChromeOS). */
  @property({ type: Boolean })
  audio = false;

  /** Suggestion de choix dans la fenêtre du navigateur : `monitor`, `window`, `browser`. */
  @property({ type: String })
  surface = "";

  /** Curseur : `always` (défaut), `motion`, `never`. */
  @property({ type: String })
  cursor = "always";

  /** Autoriser le partage de l'onglet de la page elle-même (effet miroir infini). */
  @property({ type: Boolean, attribute: "allow-self" })
  allowSelf = false;

  @property({ type: Number })
  fps = 30;

  /** Largeur max des images envoyées aux shaders et des photos. */
  @property({ type: Number, attribute: "max-width" })
  maxWidth = 1920;

  @property({ type: String })
  fit = "contain";

  @property({ type: Boolean, attribute: "hidden-preview" })
  hiddenPreview = false;

  @property({ type: String, attribute: "snapshot-type" })
  snapshotType: "jpeg" | "png" | "webp" = "jpeg";

  @property({ type: Number, attribute: "max-snapshots" })
  maxSnapshots = 8;

  @property({ type: String, attribute: "snapshot-provider" })
  snapshotProvider = "";

  /** DP : `{ active, snapshot: compteur }`. */
  @property({ type: String })
  control = "";

  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  @query("video")
  private videoEl!: HTMLVideoElement;

  private frames: VideoFrames | null = null;
  private stream: MediaStream | null = null;
  private audioSrc: MediaStreamAudioSourceNode | null = null;
  private audioOut: GainNode | null = null;
  private opening = false;
  private token = 0;
  private refs: SonicMediaRef[] = [];
  private snapshotTrigger = new CounterTrigger();
  private unsubs: (() => void)[] = [];
  private state: ScreenState = {
    status: "idle", error: null, active: false, surface: null, width: 0, height: 0, audio: false, snapshot: null, snapshots: 0,
  };

  get frameSeq(): number {
    return this.frames?.seq ?? 0;
  }

  getFrameCanvas(): HTMLCanvasElement | null {
    return this.stream ? (this.frames?.getFrameCanvas() ?? null) : null;
  }

  getFrameSource(): HTMLVideoElement | null {
    return this.stream ? (this.frames?.getFrameSource() ?? null) : null;
  }

  registerFrameConsumer(token: object = {}): void {
    this.frames?.consumers.add(token);
  }

  unregisterFrameConsumer(token: object = {}): void {
    this.frames?.consumers.delete(token);
  }

  /** Son du partage (null sans son ou sans moteur audio actif). Jamais envoyé vers le master. */
  getAudioOutput(): AudioNode | null {
    if (this.audioOut) return this.audioOut;
    const ac = AudioEngine.get().context as AudioContext | null;
    const track = this.stream?.getAudioTracks()[0];
    if (!ac || !track || typeof ac.createMediaStreamSource !== "function") return null;
    this.audioSrc = ac.createMediaStreamSource(new MediaStream([track]));
    this.audioOut = ac.createGain();
    this.audioSrc.connect(this.audioOut);
    return this.audioOut;
  }

  getMediaStream(): MediaStream | null {
    return this.stream;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.publish();
  }

  disconnectedCallback(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.close("idle");
    this.frames?.stop();
    revokeMediaUrls(this.refs.map((r) => r.url ?? ""));
    this.refs = [];
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    this.frames = new VideoFrames(this.videoEl);
    this.frames.maxWidth = this.maxWidth;
    this.frames.mirror = false;
    this.frames.start();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("active") && this.active) this.start();
    if (changed.has("active") && !this.active && changed.get("active") === true) this.stop();
    if (this.frames) this.frames.maxWidth = this.maxWidth;
    if (changed.has("control")) this.listenControl();
    if (changed.has("fit")) this.style.setProperty("--sonic-screen-fit", this.fit === "cover" ? "cover" : "contain");
  }

  /** À appeler dans un clic (le navigateur l'exige). */
  start(): void {
    if (this.stream || this.opening) return;
    void this.open();
  }

  stop(): void {
    this.close("idle");
  }

  async takeSnapshot(): Promise<SonicMediaRef | null> {
    if (!this.frames || !this.stream) return null;
    const ref = await this.frames.snapshot(this.snapshotType, 0.9);
    if (!ref) return null;
    this.refs.push(ref);
    const max = Math.max(1, Math.round(this.maxSnapshots));
    while (this.refs.length > max) revokeMediaUrls([this.refs.shift()!.url ?? ""]);
    this.patch({
      snapshot: { url: ref.url!, width: ref.width ?? 0, height: ref.height ?? 0, mime: ref.mime ?? "" },
      snapshots: this.state.snapshots + 1,
    });
    if (this.snapshotProvider) set(this.snapshotProvider, { ...ref });
    return ref;
  }

  getState(): ScreenState {
    return { ...this.state };
  }

  private listenControl(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.snapshotTrigger.reset();
    if (!this.control) return;
    this.unsubs.push(
      listenDp(this.control, (v) => {
        if (!v || typeof v !== "object") return;
        const c = v as Record<string, unknown>;
        const a = bool(c.active);
        if (a === true) this.start();
        if (a === false && (this.stream || this.opening)) this.stop();
        if (this.snapshotTrigger.feed(c.snapshot)) void this.takeSnapshot();
      }),
    );
  }

  private async open(): Promise<void> {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getDisplayMedia !== "function") {
      this.patch({ status: "unsupported", error: "partage d'écran non disponible (ordinateur, Chrome / Edge / Firefox / Safari récents)" });
      return;
    }
    const token = ++this.token;
    this.opening = true;
    this.patch({ status: "requesting", error: null });
    const video: MediaTrackConstraints & Record<string, unknown> = {
      frameRate: { ideal: this.fps },
      cursor: this.cursor,
    };
    if (["monitor", "window", "browser"].includes(this.surface)) video.displaySurface = this.surface;
    const options: DisplayMediaStreamOptions & Record<string, unknown> = {
      video,
      audio: this.audio,
      selfBrowserSurface: this.allowSelf ? "include" : "exclude",
      surfaceSwitching: "include",
      systemAudio: this.audio ? "include" : "exclude",
    };
    let stream: MediaStream;
    try {
      stream = await md.getDisplayMedia(options);
    } catch (e) {
      if (token !== this.token) return;
      this.opening = false;
      const name = (e as { name?: string })?.name ?? "";
      const denied = name === "NotAllowedError" || name === "SecurityError";
      this.patch({
        status: denied ? "denied" : "error",
        active: false,
        error: denied ? "partage d'écran refusé ou annulé" : name === "InvalidStateError" ? "le partage doit partir d'un clic" : e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (token !== this.token) {
      stopStream(stream);
      return;
    }
    this.opening = false;
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    track?.addEventListener("ended", () => {
      if (this.stream === stream) this.close("idle", "partage arrêté");
    });
    this.videoEl.srcObject = stream;
    try {
      await this.videoEl.play();
    } catch {
      /* flux muet : lecture autorisée */
    }
    const s = (track?.getSettings() ?? {}) as MediaTrackSettings & { displaySurface?: string };
    this.patch({
      status: "ready",
      error: null,
      active: true,
      surface: s.displaySurface ?? null,
      width: this.videoEl.videoWidth || s.width || 0,
      height: this.videoEl.videoHeight || s.height || 0,
      audio: stream.getAudioTracks().length > 0,
    });
    this.requestUpdate();
  }

  private close(status: CaptureStatus, error: string | null = null): void {
    this.token++;
    this.opening = false;
    try {
      this.audioSrc?.disconnect();
      this.audioOut?.disconnect();
    } catch {
      /* déjà débranché */
    }
    this.audioSrc = null;
    this.audioOut = null;
    stopStream(this.stream);
    this.stream = null;
    if (this.videoEl) this.videoEl.srcObject = null;
    this.patch({ status, error, active: false, audio: false });
    this.requestUpdate();
  }

  private patch(p: Partial<ScreenState>): void {
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
    return html`<video class=${this.stream ? "" : "off"} playsinline muted autoplay part="video"></video><slot></slot>`;
  }
}

export default SonicScreen;
