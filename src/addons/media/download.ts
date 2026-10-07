import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { listenDp } from "../../shared/audio/dp";
import { extensionFor } from "../../shared/media/record";

const tagName = "sonic-media-download";

/**
 * Lien de téléchargement d'un média produit dans la page (photo, prise audio, export vidéo).
 * `source` = chemin DP d'un SonicMediaRef (`exportState.last`, `camState.snapshot`…).
 * Seules les URL `blob:` sont acceptées : on ne télécharge que ce que la page a créé.
 */
@customElement(tagName)
export class SonicMediaDownload extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }
    a {
      color: inherit;
      font: inherit;
      display: inline-flex;
      align-items: center;
      gap: 0.4em;
      padding: 0.6em 1.2em;
      border-radius: 999px;
      border: 1px solid currentColor;
      text-decoration: none;
    }
  `;

  @property({ type: String })
  source = "";

  /** Nom du fichier, sans extension (déduite du format). */
  @property({ type: String })
  filename = "creation";

  @property({ type: String })
  label = "Télécharger";

  @state()
  private ref: { url: string; mime: string } | null = null;

  private unsub: (() => void) | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    if (this.hasUpdated) this.listen();
  }

  disconnectedCallback(): void {
    this.unsub?.();
    this.unsub = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("source")) this.listen();
  }

  private listen(): void {
    this.unsub?.();
    this.unsub = this.source
      ? listenDp(this.source, (v) => {
          const r = v as { url?: unknown; mime?: unknown } | null;
          this.ref = r && typeof r.url === "string" && /^blob:/.test(r.url) ? { url: r.url, mime: String(r.mime ?? "") } : null;
        })
      : null;
  }

  render() {
    if (!this.ref) return nothing;
    const name = `${(this.filename || "creation").replace(/[^\w.-]+/g, "-")}.${extensionFor(this.ref.mime)}`;
    return html`<a part="link" href=${this.ref.url} download=${name}><slot>${this.label}</slot></a>`;
  }
}

export default SonicMediaDownload;
