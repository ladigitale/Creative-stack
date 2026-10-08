import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

const tagName = "sonic-media-start";

type Startable = Element & { start?: () => void; getState?: () => { status?: string; error?: string | null } };

const READY = ["ready", "playing", "paused"];

/**
 * Bouton d'invite pour démarrer caméra, micro ou vidéo (`for="cam mic"`) :
 * la demande d'accès part d'un clic, jamais du chargement de la page.
 * Caché quand toutes les cibles sont prêtes ; affiche le refus éventuel.
 */
@customElement(tagName)
export class SonicMediaStart extends LitElement {
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
    .error {
      display: block;
      margin-top: 0.4em;
      font-size: 0.85em;
      opacity: 0.8;
    }
  `;

  /** Ids des éléments à démarrer (sonic-camera, sonic-mic, sonic-video). */
  @property({ type: String, attribute: "for" })
  targets = "";

  @property({ type: String })
  label = "Activer la caméra";

  /** Reste affiché une fois les cibles prêtes. */
  @property({ type: Boolean })
  persist = false;

  @state()
  private ready = false;

  @state()
  private error: string | null = null;

  private poll: ReturnType<typeof setInterval> | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.poll = setInterval(() => this.check(), 300);
    this.check();
  }

  disconnectedCallback(): void {
    if (this.poll) clearInterval(this.poll);
    super.disconnectedCallback();
  }

  private elements(): Startable[] {
    const root = this.getRootNode() as Document | ShadowRoot;
    return this.targets
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => id.replace(/^#/, ""))
      .map((id) => (root.getElementById?.(id) ?? document.getElementById(id)) as Startable | null)
      .filter((e): e is Startable => !!e);
  }

  private check(): void {
    const els = this.elements();
    const states = els.map((e) => e.getState?.() ?? {});
    this.ready = els.length > 0 && states.every((s) => READY.includes(String(s.status)));
    this.error = states.map((s) => s.error).find((e): e is string => !!e) ?? null;
  }

  private onClick = () => {
    for (const el of this.elements()) el.start?.();
    setTimeout(() => this.check(), 50);
  };

  render() {
    if (this.ready && !this.persist) return nothing;
    return html`<slot @click=${this.onClick}><button type="button" part="button">${this.label}</button></slot>${this.error
        ? html`<span class="error" part="error" role="status">${this.error}</span>`
        : nothing}`;
  }
}

export default SonicMediaStart;
