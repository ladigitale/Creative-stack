import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine } from "../../shared/audio/engine";
import { listenDp } from "../../shared/audio/dp";
import { bool, num } from "../../shared/media/control";

const tagName = "sonic-audio-master";

export type AudioMasterState = {
  /** `idle` : son pas encore autorisé (premier geste attendu) ; `ready` : contexte actif ; `suspended` : onglet caché. */
  status: "idle" | "ready" | "suspended" | "unsupported";
  error: string | null;
  /** Le navigateur a autorisé le son. */
  ready: boolean;
  volume: number;
  muted: boolean;
};

/**
 * Réglages du master partagé (volume, muet), par attributs ou DataProvider `control`.
 * L'état du moteur est publié dans le DataProvider `audio` ; celui du master dans
 * `out-data-provider` (défaut `<id>State`) : `{ status, error, ready, volume, muted }`.
 */
@customElement(tagName)
export class SonicAudioMaster extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** Volume 0..1. */
  @property({ type: Number })
  volume: number | null = null;

  @property({ type: Boolean })
  muted = false;

  /** DataProvider { volume, muted } (chemin pointé accepté). */
  @property({ type: String })
  control = "";

  /** DataProvider de l'état (défaut : `<id>State`). */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private unlisten: (() => void) | null = null;
  private unsubscribeEngine: (() => void) | null = null;
  private published = "";

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribeEngine = AudioEngine.get().onChange(() => this.publish());
    this.published = "";
    this.publish();
  }

  disconnectedCallback(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.unsubscribeEngine?.();
    this.unsubscribeEngine = null;
    super.disconnectedCallback();
  }

  /** État du master (aussi publié dans le DataProvider). */
  getState(): AudioMasterState {
    const s = AudioEngine.get().getState();
    const status: AudioMasterState["status"] = !s.supported ? "unsupported" : !s.ready ? "idle" : s.state === "running" ? "ready" : "suspended";
    return {
      status,
      error: s.supported ? null : "WebAudio indisponible dans ce navigateur",
      ready: s.ready,
      volume: s.volume,
      muted: s.muted,
    };
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("volume") || changed.has("muted")) {
      AudioEngine.get().setMaster({ volume: this.volume ?? undefined, muted: this.muted });
    }
    if (changed.has("control")) {
      this.unlisten?.();
      this.unlisten = this.control
        ? listenDp(this.control, (v) => {
            if (!v || typeof v !== "object") return;
            const c = v as { volume?: unknown; muted?: unknown };
            AudioEngine.get().setMaster({ volume: num(c.volume, 0, 1), muted: bool(c.muted) });
          })
        : null;
    }
    if (changed.has("outDataProvider")) {
      this.published = "";
      this.publish();
    }
  }

  private publish(): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (!out) return;
    const s = this.getState();
    const key = `${out}|${JSON.stringify(s)}`;
    if (key === this.published) return;
    this.published = key;
    set(out, s);
  }

  render() {
    return html``;
  }
}

export default SonicAudioMaster;
