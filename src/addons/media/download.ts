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

  /**
   * Téléchargement automatique : chaque NOUVEAU média publié dans `source` (url différente de la précédente)
   * est téléchargé tout de suite ; la valeur présente au branchement ne l'est pas. Sans lien affiché :
   * un bouton à côté déclenche la production (ex. `save` d'un sonic-shader), le fichier part dès qu'il est prêt.
   */
  @property({ type: Boolean })
  auto = false;

  /**
   * Comme `auto`, mais seulement pour le média demandé par un clic sur le contenu (slot) : le clic arme le
   * téléchargement, une action autour produit le média, le PROCHAIN publié dans `source` part. Plusieurs boutons
   * peuvent ainsi partager une même production (télécharger, partager) sans que chacun ne parte à chaque fois.
   */
  @property({ type: Boolean })
  wait = false;

  private pendingUntil = 0;
  private onClick = (): void => { if (this.wait) this.pendingUntil = Date.now() + 20000; };

  private seen: string | null | undefined = undefined;

  @state()
  private ref: { url: string; mime: string } | null = null;

  private unsub: (() => void) | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("click", this.onClick);
    if (this.hasUpdated) this.listen();
  }

  disconnectedCallback(): void {
    this.removeEventListener("click", this.onClick);
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
          const url = this.ref?.url ?? null;
          const first = this.seen === undefined;
          const fresh = url !== this.seen;
          this.seen = url;
          if (this.auto && !first && fresh && this.ref) this.download(this.ref);
          else if (this.wait && !first && fresh && this.ref && Date.now() < this.pendingUntil) {
            this.pendingUntil = 0;
            this.download(this.ref);
          }
        })
      : null;
  }

  private fileName(mime: string): string {
    return `${(this.filename || "creation").replace(/[^\w.-]+/g, "-")}.${extensionFor(mime)}`;
  }

  /** Lance le téléchargement d'un média (lien temporaire, hors du DOM visible). */
  download(ref: { url: string; mime: string } | null = this.ref): void {
    if (!ref) return;
    const a = document.createElement("a");
    a.href = ref.url;
    a.download = this.fileName(ref.mime);
    a.style.display = "none";
    (this.shadowRoot ?? this).appendChild(a);
    a.click();
    a.remove();
  }

  render() {
    if (this.wait) return html`<slot></slot>`;
    if (!this.ref || this.auto) return nothing;
    const name = this.fileName(this.ref.mime);
    return html`<a part="link" href=${this.ref.url} download=${name}><slot>${this.label}</slot></a>`;
  }
}

export default SonicMediaDownload;
