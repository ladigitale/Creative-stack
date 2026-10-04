import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { AudioEngine } from "../../shared/audio/engine";
import { listenDp } from "../../shared/audio/dp";

const tagName = "sonic-audio-master";

/**
 * Réglages du master partagé (volume, muet), par attributs ou DataProvider.
 * L'état du moteur est publié dans le DataProvider `audio`.
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

  private unlisten: (() => void) | null = null;

  disconnectedCallback(): void {
    this.unlisten?.();
    this.unlisten = null;
    super.disconnectedCallback();
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
            AudioEngine.get().setMaster({
              volume: typeof c.volume === "number" ? c.volume : undefined,
              muted: typeof c.muted === "boolean" ? c.muted : undefined,
            });
          })
        : null;
    }
  }

  render() {
    return html``;
  }
}

export default SonicAudioMaster;
