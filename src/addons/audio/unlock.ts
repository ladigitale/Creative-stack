import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { AudioEngine } from "../../shared/audio/engine";

const tagName = "sonic-audio-unlock";

/**
 * Bouton « Activer le son ». Le son se déverrouille aussi au premier geste
 * n'importe où sur la page : ce bouton sert d'invite explicite.
 * Contenu libre en slot ; caché une fois le son actif (sauf `persist`).
 */
@customElement(tagName)
export class SonicAudioUnlock extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }
    button {
      font: inherit;
      color: inherit;
      cursor: pointer;
      padding: 0.6em 1.2em;
      border-radius: 999px;
      border: 1px solid currentColor;
      background: transparent;
    }
  `;

  /** Reste affiché une fois le son actif. */
  @property({ type: Boolean })
  persist = false;

  /** Libellé par défaut (sans contenu en slot). */
  @property({ type: String })
  label = "Activer le son";

  @state()
  private ready = false;

  private unsubscribe: (() => void) | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    const engine = AudioEngine.get();
    this.ready = engine.ready;
    this.unsubscribe = engine.onChange((e) => (this.ready = e.ready));
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
    super.disconnectedCallback();
  }

  private onClick = () => {
    void AudioEngine.get().unlock();
  };

  render() {
    if (this.ready && !this.persist) return nothing;
    return html`<slot @click=${this.onClick}><button type="button" part="button" @click=${this.onClick}>${this.label}</button></slot>`;
  }
}

export default SonicAudioUnlock;
