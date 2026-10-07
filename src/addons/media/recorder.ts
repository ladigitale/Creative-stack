import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine, resolveAudioElement } from "../../shared/audio/engine";
import { isAudioSource } from "../../shared/audio/contracts";
import { listenDp } from "../../shared/audio/dp";
import { bool } from "../../shared/media/control";
import { recorderSupported, Take, type RecordedRef } from "../../shared/media/record";
import { revokeMediaUrls } from "../../shared/mediaRef";

const tagName = "sonic-media-recorder";

type Info = { url: string; mime: string; durS: number; size: number; width: number; height: number };

export type MediaRecorderState = {
  status: "idle" | "waiting-source" | "ready" | "recording" | "error" | "unsupported";
  error: string | null;
  recording: boolean;
  elapsedS: number;
  last: Info | null;
  takes: number;
};

type VisualSource = Element & {
  getMediaStream?: () => MediaStream | null;
  getFrameCanvas?: () => HTMLCanvasElement | null;
};

/**
 * Export d'une performance : images d'un `sonic-shader` / `sonic-3d` / `sonic-webgpu` / `sonic-camera` /
 * `sonic-video` (`video-source="#id"`) + son (`audio-source="master"` par défaut) → vidéo webm / mp4
 * publiée en SonicMediaRef. Pilotage : DP `control` { recording: true|false }.
 */
@customElement(tagName)
export class SonicMediaRecorder extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  @property({ type: String, attribute: "video-source" })
  videoSource = "";

  /** `master` (défaut : tout ce qu'on entend), `#id` d'une source audio, ou `none`. */
  @property({ type: String, attribute: "audio-source" })
  audioSource = "master";

  @property({ type: Number })
  fps = 30;

  /** Débit vidéo en bits/s (défaut 4 Mb/s). */
  @property({ type: Number, attribute: "bits-per-second" })
  bits = 4_000_000;

  @property({ type: Number, attribute: "max-s" })
  maxS = 20;

  @property({ type: Number, attribute: "max-takes" })
  maxTakes = 4;

  @property({ type: String, attribute: "take-provider" })
  takeProvider = "";

  @property({ type: String })
  control = "";

  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private take: Take | null = null;
  private tracks: MediaStreamTrack[] = [];
  private audioDest: MediaStreamAudioDestinationNode | null = null;
  private audioNode: AudioNode | null = null;
  private size = { width: 0, height: 0 };
  private urls: string[] = [];
  private unsubs: (() => void)[] = [];
  private clock: ReturnType<typeof setInterval> | null = null;
  private state: MediaRecorderState = { status: "idle", error: null, recording: false, elapsedS: 0, last: null, takes: 0 };

  connectedCallback(): void {
    super.connectedCallback();
    this.clock = setInterval(() => this.tick(), 200);
    this.tick();
  }

  disconnectedCallback(): void {
    if (this.clock) clearInterval(this.clock);
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.take?.stop();
    this.release();
    revokeMediaUrls(this.urls);
    this.urls = [];
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("control")) this.listenControl();
  }

  start(): void {
    if (this.take) return;
    if (!recorderSupported()) {
      this.patch({ status: "unsupported", error: "enregistrement vidéo non disponible dans ce navigateur" });
      return;
    }
    const video = this.videoTracks();
    if (!video.length) {
      this.patch({ status: "error", error: `source vidéo "${this.videoSource}" pas prête` });
      return;
    }
    const audio = this.audioTracks();
    this.tracks = [...video, ...audio.created];
    const take = new Take(new MediaStream([...video, ...audio.tracks]), "video", { maxS: this.maxS, bitsPerSecond: this.bits });
    this.take = take;
    this.patch({ status: "recording", recording: true, elapsedS: 0, error: null });
    void take.done.then((ref) => this.finish(take, ref));
  }

  stop(): void {
    this.take?.stop();
  }

  getState(): MediaRecorderState {
    return { ...this.state };
  }

  /* ---------------------------------------------------------------- */

  private visual(): VisualSource | null {
    if (!this.videoSource) return null;
    return resolveAudioElement(this, this.videoSource) as VisualSource | null;
  }

  private videoTracks(): MediaStreamTrack[] {
    const el = this.visual();
    if (!el) return [];
    const stream = el.getMediaStream?.();
    const fromStream = stream?.getVideoTracks() ?? [];
    if (fromStream.length) {
      const s = fromStream[0].getSettings();
      this.size = { width: s.width ?? 0, height: s.height ?? 0 };
      // copie : arrêter la prise ne doit pas couper la caméra
      return fromStream.map((t) => t.clone());
    }
    const canvas = el.getFrameCanvas?.() as (HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }) | null;
    if (!canvas || typeof canvas.captureStream !== "function") return [];
    this.size = { width: canvas.width, height: canvas.height };
    return canvas.captureStream(Math.min(60, Math.max(1, this.fps))).getVideoTracks();
  }

  private audioTracks(): { tracks: MediaStreamTrack[]; created: MediaStreamTrack[] } {
    const ref = (this.audioSource || "master").trim();
    if (ref === "none") return { tracks: [], created: [] };
    const engine = AudioEngine.get();
    const ac = engine.context as AudioContext | null;
    if (!ac || typeof ac.createMediaStreamDestination !== "function") return { tracks: [], created: [] };
    let node: AudioNode | null = null;
    if (ref === "master") node = engine.output;
    else {
      const el = resolveAudioElement(this, ref);
      node = isAudioSource(el) ? el.getAudioOutput() : null;
    }
    if (!node) return { tracks: [], created: [] };
    this.audioDest ??= ac.createMediaStreamDestination();
    if (this.audioNode !== node) {
      this.unplugAudio();
      node.connect(this.audioDest);
      this.audioNode = node;
    }
    return { tracks: this.audioDest.stream.getAudioTracks(), created: [] };
  }

  private unplugAudio(): void {
    if (this.audioNode && this.audioDest) {
      try {
        this.audioNode.disconnect(this.audioDest);
      } catch {
        /* ok */
      }
    }
    this.audioNode = null;
  }

  private release(): void {
    for (const t of this.tracks) t.stop();
    this.tracks = [];
    this.unplugAudio();
  }

  private finish(take: Take, ref: RecordedRef | null): void {
    if (this.take === take) this.take = null;
    this.release();
    if (!ref) {
      this.patch({ status: "ready", recording: false, error: "enregistrement vide" });
      return;
    }
    this.urls.push(ref.url);
    while (this.urls.length > Math.max(1, Math.round(this.maxTakes))) revokeMediaUrls([this.urls.shift()!]);
    const info: Info = { url: ref.url, mime: ref.mime, durS: ref.durS, size: ref.size, ...this.size };
    this.patch({ status: "ready", recording: false, elapsedS: ref.durS, last: info, takes: this.state.takes + 1 });
    if (this.takeProvider) set(this.takeProvider, { ...info });
  }

  private listenControl(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (!this.control) return;
    this.unsubs.push(
      listenDp(this.control, (v) => {
        const rec = bool((v as { recording?: unknown } | null)?.recording);
        if (rec === true) this.start();
        if (rec === false) this.stop();
      }),
    );
  }

  private tick(): void {
    if (this.take) {
      this.patch({ elapsedS: this.take.elapsedS });
      return;
    }
    if (this.state.status === "recording") return;
    const el = this.visual();
    const ready = !!el && (!!el.getMediaStream?.() || !!el.getFrameCanvas?.());
    const status = !recorderSupported() ? "unsupported" : ready ? "ready" : "waiting-source";
    if (status !== this.state.status) this.patch({ status });
  }

  private patch(p: Partial<MediaRecorderState>): void {
    this.state = { ...this.state, ...p };
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (out) set(out, this.getState());
  }

  render() {
    return html``;
  }
}

export default SonicMediaRecorder;
