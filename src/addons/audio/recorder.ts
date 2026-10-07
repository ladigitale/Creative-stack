import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine, resolveAudioElement } from "../../shared/audio/engine";
import { isAudioSource } from "../../shared/audio/contracts";
import { listenDp } from "../../shared/audio/dp";
import { bool } from "../../shared/media/control";
import { recorderSupported, Take, type RecordedRef } from "../../shared/media/record";
import { revokeMediaUrls } from "../../shared/mediaRef";

const tagName = "sonic-audio-recorder";

type TakeInfo = { url: string; mime: string; durS: number; size: number };

export type AudioRecorderState = {
  status: "idle" | "waiting-source" | "ready" | "recording" | "error" | "unsupported";
  error: string | null;
  recording: boolean;
  elapsedS: number;
  /** Dernière prise (SonicMediaRef) : `{ url, mime, durS, size }`. */
  last: TakeInfo | null;
  takes: number;
};

/**
 * Enregistreur audio : capte une source (`#mic`, `#id` d'un patch / sampler / vidéo, ou `master`)
 * et publie chaque prise en SonicMediaRef, rejouable par `sonic-sampler` (`{"ref": "…"}`).
 * Pilotage : DP `control` { recording: true|false, target: "chemin.dp" } — `target` reçoit la prise.
 */
@customElement(tagName)
export class SonicAudioRecorder extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** `#mic` (défaut), `#id` d'une source, ou `master` (tout ce qu'on entend). */
  @property({ type: String })
  source = "#mic";

  /** Durée max d'une prise en s (défaut 30). */
  @property({ type: Number, attribute: "max-s" })
  maxS = 30;

  /** Prises gardées en mémoire (les plus anciennes sont libérées). */
  @property({ type: Number, attribute: "max-takes" })
  maxTakes = 8;

  /** Chemin DP où écrire chaque prise (remplacé par `control.target` s'il est fourni). */
  @property({ type: String, attribute: "take-provider" })
  takeProvider = "";

  @property({ type: String })
  control = "";

  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private take: Take | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private connected: AudioNode | null = null;
  private target = "";
  private urls: string[] = [];
  private unsubs: (() => void)[] = [];
  private clock: ReturnType<typeof setInterval> | null = null;
  private state: AudioRecorderState = {
    status: "idle", error: null, recording: false, elapsedS: 0, last: null, takes: 0,
  };

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
    this.take = null;
    this.unplug();
    revokeMediaUrls(this.urls);
    this.urls = [];
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("control")) this.listenControl();
    if (changed.has("source")) this.unplug();
  }

  /* ---------------------------------------------------------------- */
  /* API                                                               */
  /* ---------------------------------------------------------------- */

  start(target?: string): void {
    if (this.take) return;
    if (!recorderSupported()) {
      this.patch({ status: "unsupported", error: "enregistrement non disponible dans ce navigateur" });
      return;
    }
    const node = this.resolveSource();
    const ac = AudioEngine.get().context as AudioContext | null;
    if (!node || !ac || typeof ac.createMediaStreamDestination !== "function") {
      this.patch({ status: "error", error: `source "${this.source}" pas prête (micro activé ? son activé ?)` });
      return;
    }
    this.plug(node, ac);
    this.target = target ?? this.takeProvider;
    this.take = new Take(this.dest!.stream, "audio", { maxS: this.maxS });
    const take = this.take;
    this.patch({ status: "recording", recording: true, elapsedS: 0, error: null });
    void take.done.then((ref) => this.finish(take, ref));
  }

  stop(): void {
    this.take?.stop();
  }

  getState(): AudioRecorderState {
    return { ...this.state };
  }

  /* ---------------------------------------------------------------- */

  private listenControl(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (!this.control) return;
    this.unsubs.push(
      listenDp(this.control, (v) => {
        if (!v || typeof v !== "object") return;
        const c = v as { recording?: unknown; target?: unknown };
        const rec = bool(c.recording);
        if (rec === true && !this.take) this.start(typeof c.target === "string" ? c.target : undefined);
        if (rec === false) this.stop();
      }),
    );
  }

  private resolveSource(): AudioNode | null {
    const ref = (this.source || "#mic").trim();
    if (ref === "master") return AudioEngine.get().output;
    const el = resolveAudioElement(this, ref);
    return isAudioSource(el) ? el.getAudioOutput() : null;
  }

  private plug(node: AudioNode, ac: AudioContext): void {
    this.dest ??= ac.createMediaStreamDestination();
    if (this.connected === node) return;
    this.unplug();
    node.connect(this.dest);
    this.connected = node;
  }

  private unplug(): void {
    if (this.connected && this.dest) {
      try {
        this.connected.disconnect(this.dest);
      } catch {
        /* déjà débranché */
      }
    }
    this.connected = null;
  }

  private finish(take: Take, ref: RecordedRef | null): void {
    if (this.take === take) this.take = null;
    if (!ref) {
      this.patch({ status: "ready", recording: false, error: "prise vide" });
      return;
    }
    this.urls.push(ref.url);
    while (this.urls.length > Math.max(1, Math.round(this.maxTakes))) revokeMediaUrls([this.urls.shift()!]);
    const info: TakeInfo = { url: ref.url, mime: ref.mime, durS: ref.durS, size: ref.size };
    this.patch({ status: "ready", recording: false, elapsedS: ref.durS, last: info, takes: this.state.takes + 1 });
    if (this.target) set(this.target, { ...info });
  }

  private tick(): void {
    if (this.take) {
      this.patch({ elapsedS: this.take.elapsedS });
      return;
    }
    if (this.state.status === "recording") return;
    const ready = !!this.resolveSource() && !!AudioEngine.get().context;
    const status = !recorderSupported() ? "unsupported" : ready ? "ready" : "waiting-source";
    if (status !== this.state.status) this.patch({ status });
  }

  private patch(p: Partial<AudioRecorderState>): void {
    this.state = { ...this.state, ...p };
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (out) set(out, this.getState());
  }

  render() {
    return html``;
  }
}

export default SonicAudioRecorder;
