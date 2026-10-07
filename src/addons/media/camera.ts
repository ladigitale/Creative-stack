import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import {
  listDevices,
  onFirstGesture,
  openStream,
  stopStream,
  type CaptureStatus,
  type MediaDeviceInfoLite,
} from "../../shared/media/capture";
import { bool, CounterTrigger } from "../../shared/media/control";
import { VideoFrames } from "../../shared/media/frames";
import { revokeMediaUrls, type SonicFrameConsumerHost, type SonicFrameSource, type SonicMediaRef } from "../../shared/mediaRef";

const tagName = "sonic-camera";

export type CameraState = {
  status: CaptureStatus;
  error: string | null;
  active: boolean;
  facing: "user" | "environment";
  width: number;
  height: number;
  deviceId: string | null;
  devices: MediaDeviceInfoLite[];
  /** Dernière photo (SonicMediaRef : url blob:, dimensions). */
  snapshot: { url: string; width: number; height: number; mime: string } | null;
  snapshots: number;
};

/**
 * Caméra : aperçu, source d'images pour `sonic-shader channel0="#id"`,
 * photos (`snapshot`) en SonicMediaRef.
 *
 * Démarrage : `active`, `autostart` (au premier geste), DP `control`
 * ({ active, facing, deviceId, snapshot: compteur }) ou `sonic-media-start for="cam"`.
 * Jamais de demande de permission au chargement de la page.
 */
@customElement(tagName)
export class SonicCamera extends LitElement implements SonicFrameSource, SonicFrameConsumerHost {
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
      object-fit: var(--sonic-camera-fit, cover);
    }
    video.mirror {
      transform: scaleX(-1);
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

  /** Demande la caméra au premier geste sur la page. */
  @property({ type: Boolean })
  autostart = false;

  /** `user` (avant, défaut) ou `environment` (arrière). */
  @property({ type: String })
  facing: "user" | "environment" = "user";

  @property({ type: Number })
  width = 1280;

  @property({ type: Number })
  height = 720;

  @property({ type: Number })
  fps = 30;

  @property({ type: String, attribute: "device-id" })
  deviceId = "";

  /** Effet miroir (aperçu, images envoyées aux shaders et photos). Défaut : vrai pour la caméra avant. */
  @property({ type: String })
  mirror: "auto" | "true" | "false" | "" = "auto";

  /** `cover` (défaut) ou `contain`. */
  @property({ type: String })
  fit = "cover";

  /** Caméra utilisée seulement comme source (shader) : pas d'aperçu visible. */
  @property({ type: Boolean, attribute: "hidden-preview" })
  hiddenPreview = false;

  /** Continue quand l'onglet est caché (par défaut la caméra s'arrête et reprend au retour). */
  @property({ type: Boolean, attribute: "keep-running" })
  keepRunning = false;

  /** Largeur max des images envoyées aux shaders et des photos (0 = native). */
  @property({ type: Number, attribute: "max-width" })
  maxWidth = 1280;

  @property({ type: String, attribute: "snapshot-type" })
  snapshotType: "jpeg" | "png" | "webp" = "jpeg";

  /** Photos gardées (les plus anciennes sont libérées). */
  @property({ type: Number, attribute: "max-snapshots" })
  maxSnapshots = 8;

  /** DataProvider où écrire chaque photo (SonicMediaRef) : ex. `gallery.channel0` pour un shader. */
  @property({ type: String, attribute: "snapshot-provider" })
  snapshotProvider = "";

  @property({ type: String })
  control = "";

  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  @query("video")
  private videoEl!: HTMLVideoElement;

  private frames: VideoFrames | null = null;
  private stream: MediaStream | null = null;
  private wantActive = false;
  private opening = false;
  private pausedByVisibility = false;
  private token = 0;
  private refs: SonicMediaRef[] = [];
  private snapshotTrigger = new CounterTrigger();
  private unsubs: (() => void)[] = [];
  private cancelGesture: (() => void) | null = null;
  private state: CameraState = {
    status: "idle", error: null, active: false, facing: "user", width: 0, height: 0,
    deviceId: null, devices: [], snapshot: null, snapshots: 0,
  };

  /* ---------------------------------------------------------------- */
  /* SonicFrameSource / SonicFrameConsumerHost                         */
  /* ---------------------------------------------------------------- */

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

  /* ---------------------------------------------------------------- */
  /* Cycle de vie                                                      */
  /* ---------------------------------------------------------------- */

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.onVisibility);
    this.publish();
  }

  disconnectedCallback(): void {
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.cancelGesture?.();
    this.cancelGesture = null;
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
    this.frames.mirror = this.isMirrored();
    this.frames.start();
    if (this.wantActive && !this.stream && !this.opening) void this.open();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("active")) this.setActive(this.active);
    if (changed.has("autostart")) {
      this.cancelGesture?.();
      this.cancelGesture = this.autostart ? onFirstGesture(() => this.start()) : null;
    }
    if (this.frames) {
      this.frames.maxWidth = this.maxWidth;
      this.frames.mirror = this.isMirrored();
    }
    const restartKeys = ["facing", "deviceId", "width", "height", "fps"];
    if (restartKeys.some((k) => changed.has(k) && changed.get(k) !== undefined) && (this.stream || this.opening)) this.restart();
    if (changed.has("control")) this.listenControl();
    if (changed.has("fit")) this.style.setProperty("--sonic-camera-fit", this.fit === "contain" ? "contain" : "cover");
  }

  /* ---------------------------------------------------------------- */
  /* API                                                               */
  /* ---------------------------------------------------------------- */

  start(): void {
    this.setActive(true);
  }

  stop(): void {
    this.setActive(false);
  }

  /** Flux de la caméra (pour un enregistreur). */
  getMediaStream(): MediaStream | null {
    return this.stream;
  }

  /** Bascule caméra avant / arrière. */
  flip(): void {
    this.facing = this.facing === "user" ? "environment" : "user";
  }

  /** Prend une photo : SonicMediaRef publié dans l'état (et `snapshot-provider`). */
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

  getState(): CameraState {
    return { ...this.state, devices: [...this.state.devices] };
  }

  /* ---------------------------------------------------------------- */

  private isMirrored(): boolean {
    if (this.mirror === "true") return true;
    if (this.mirror === "false") return false;
    return this.facing !== "environment";
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
        if (c.facing === "user" || c.facing === "environment") this.facing = c.facing;
        if (typeof c.deviceId === "string" && c.deviceId !== this.deviceId) this.deviceId = c.deviceId;
        const a = bool(c.active);
        if (a !== undefined) this.setActive(a);
        if (this.snapshotTrigger.feed(c.snapshot)) void this.takeSnapshot();
      }),
    );
  }

  private setActive(on: boolean): void {
    this.wantActive = on;
    if (!this.frames) return; // ouverture après le premier rendu
    if (on && !this.stream && !this.opening) void this.open();
    if (!on && (this.stream || this.opening)) this.close("idle");
  }

  private restart(): void {
    this.close("idle");
    if (this.wantActive) void this.open();
  }

  private async open(): Promise<void> {
    const token = ++this.token;
    this.opening = true;
    this.patch({ status: "requesting", error: null });
    const res = await openStream(
      {
        audio: false,
        video: {
          deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
          facingMode: this.deviceId ? undefined : { ideal: this.facing },
          width: { ideal: this.width },
          height: { ideal: this.height },
          frameRate: { ideal: this.fps },
        },
      },
      "caméra",
    );
    if (token !== this.token) {
      if ("stream" in res) stopStream(res.stream);
      return;
    }
    this.opening = false;
    if (!("stream" in res)) {
      this.patch({ status: res.status, error: res.error, active: false });
      return;
    }
    if (!this.wantActive) {
      stopStream(res.stream);
      return;
    }
    this.stream = res.stream;
    const track = res.stream.getVideoTracks()[0];
    track?.addEventListener("ended", () => {
      if (this.stream === res.stream) this.close("error", "la caméra a été déconnectée");
    });
    const video = this.videoEl;
    video.srcObject = res.stream;
    try {
      await video.play();
    } catch {
      /* muet + playsinline : la lecture d'un flux caméra n'est pas bloquée */
    }
    const s = track?.getSettings() ?? {};
    this.patch({
      status: "ready",
      error: null,
      active: true,
      facing: (s.facingMode as "user" | "environment") ?? this.facing,
      width: video.videoWidth || s.width || 0,
      height: video.videoHeight || s.height || 0,
      deviceId: s.deviceId ?? null,
      devices: await listDevices("videoinput"),
    });
    this.requestUpdate();
  }

  private close(status: CaptureStatus, error: string | null = null): void {
    this.token++;
    this.opening = false;
    stopStream(this.stream);
    this.stream = null;
    if (this.videoEl) this.videoEl.srcObject = null;
    this.patch({ status, error, active: false });
    this.requestUpdate();
  }

  private onVisibility = (): void => {
    if (this.keepRunning) return;
    if (document.hidden && this.stream) {
      this.pausedByVisibility = true;
      this.close("paused");
    } else if (!document.hidden && this.pausedByVisibility) {
      this.pausedByVisibility = false;
      if (this.wantActive) void this.open();
    }
  };

  private patch(p: Partial<CameraState>): void {
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
    const cls = `${this.isMirrored() ? "mirror" : ""} ${this.stream ? "" : "off"}`;
    return html`<video class=${cls} playsinline muted autoplay part="video"></video><slot></slot>`;
  }
}

export default SonicCamera;
