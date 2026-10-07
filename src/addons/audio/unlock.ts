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

  /** Ids d'éléments à démarrer avec le son (`start="mic cam"` : sonic-mic, sonic-camera…). */
  @property({ type: String })
  start = "";

  /** Libellé par défaut (sans contenu en slot). */
  @property({ type: String })
  label = "Activer le son";

  @state()
  private ready = false;

  @state()
  private targetsReady = true;

  private unsubscribe: (() => void) | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    const engine = AudioEngine.get();
    this.ready = engine.ready;
    this.unsubscribe = engine.onChange((e) => (this.ready = e.ready));
    // Avec `start`, le bouton reste visible tant qu'une cible n'est pas prête.
    this.poll = setInterval(() => (this.targetsReady = this.checkTargets()), 400);
    this.targetsReady = this.checkTargets();
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
    if (this.poll) clearInterval(this.poll);
    super.disconnectedCallback();
  }

  private targets(): (Element & { start?: () => void; getState?: () => { status?: string } })[] {
    const root = this.getRootNode() as Document | ShadowRoot;
    return this.start
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => id.replace(/^#/, ""))
      .map((id) => (root.getElementById?.(id) ?? document.getElementById(id)) as Element & { start?: () => void })
      .filter(Boolean);
  }

  private checkTargets(): boolean {
    return this.targets().every((t) => ["ready", "playing", "paused"].includes(String(t.getState?.().status)));
  }

  private onClick = () => {
    void AudioEngine.get().unlock();
    for (const t of this.targets()) t.start?.();
  };

  render() {
    if (this.ready && this.targetsReady && !this.persist) return nothing;
    return html`<slot @click=${this.onClick}><button type="button" part="button" @click=${this.onClick}>${this.label}</button></slot>`;
  }
}

export default SonicAudioUnlock;
