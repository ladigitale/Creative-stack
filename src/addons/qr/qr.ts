import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { MAX_QR_TEXT, qrMatrix, qrPath, safeHref, sanitizeEcc, type QrMatrix } from "./core";

export type QrState = {
  status: "ready" | "empty" | "error";
  text: string;
  version: number | null;
  modules: number | null;
  error: string | null;
};

/**
 * QR code dessiné en SVG (aucune requête, aucun service tiers) depuis `text` ou un DataProvider
 * (`text-from` = "dp" ou "dp.chemin", lu en direct : un lien de run, un code de salon…).
 * Noir sur blanc par défaut (lisible par tous les téléphones, quel que soit le thème) ; `link`
 * rend le code cliquable quand le texte est une URL http(s). État dans `out-data-provider`.
 */
@customElement("sonic-qr")
export class SonicQr extends LitElement {
  static styles = css`
    :host { display: inline-block; line-height: 0; }
    svg { display: block; width: var(--qr-size, 12rem); height: var(--qr-size, 12rem); max-width: 100%; border-radius: var(--qr-radius, .5rem); }
    a { display: inline-block; }
    .empty { display: grid; place-items: center; width: var(--qr-size, 12rem); aspect-ratio: 1; border: 1px dashed var(--sc-base-300, #aaa); border-radius: var(--qr-radius, .5rem); color: var(--sc-base-content, inherit); opacity: .6; font: .8rem/1.3 var(--sc-font-family, system-ui); text-align: center; padding: .5rem; box-sizing: border-box; }
  `;

  /** Texte à encoder (URL, code…). Remplacé par `text-from` s'il est donné. */
  @property({ type: String }) text = "";
  /** DataProvider (chemin pointé accepté) dont la valeur est le texte. */
  @property({ type: String, attribute: "text-from" }) textFrom = "";
  /** Correction d'erreur L | M | Q | H (défaut M). */
  @property({ type: String }) ecc = "M";
  /** Taille affichée (px) ; la variable CSS --qr-size l'emporte. */
  @property({ type: Number }) size = 192;
  /** Zone de silence autour du code, en modules (défaut 2, 4 selon la norme pour l'impression). */
  @property({ type: Number }) margin = 2;
  @property({ type: String }) color = "#000000";
  @property({ type: String }) background = "#ffffff";
  /** Le code est aussi un lien (texte http/https seulement). */
  @property({ type: Boolean }) link = false;
  /** Texte annoncé aux lecteurs d'écran (défaut : « QR code » + le texte). */
  @property({ type: String }) label = "";
  /** Message affiché tant que le texte est vide. */
  @property({ type: String }) placeholder = "";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  @state() private fromValue: string | null = null;
  private off: (() => void) | null = null;
  private lastOut = "";

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.off?.();
    this.off = null;
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("textFrom")) this.listen();
  }

  private listen(): void {
    this.off?.();
    this.off = null;
    this.fromValue = null;
    if (!this.textFrom || !this.isConnected) return;
    this.off = listenDp(this.textFrom, (v) => {
      this.fromValue = v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
    });
  }

  private publish(out: QrState): void {
    if (!this.outDataProvider) return;
    const k = JSON.stringify(out);
    if (k === this.lastOut) return;
    this.lastOut = k;
    set(this.outDataProvider, out as never);
  }

  render() {
    const text = (this.textFrom ? this.fromValue ?? "" : this.text ?? "").trim();
    const px = Math.max(48, Math.min(2048, Number(this.size) || 192));
    let m: QrMatrix | null = null;
    let error: string | null = null;
    try {
      m = qrMatrix(text, sanitizeEcc(this.ecc));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    this.publish({ status: error ? "error" : m ? "ready" : "empty", text, version: m?.version ?? null, modules: m?.size ?? null, error });
    if (!m) {
      const msg = error ?? this.placeholder;
      return msg || error ? html`<div class="empty" role="img" aria-label=${msg} style="width:${px}px">${msg}</div>` : html`<div class="empty" aria-hidden="true" style="width:${px}px"></div>`;
    }
    const margin = Math.max(0, Math.min(8, Math.round(Number(this.margin) || 0)));
    const total = m.size + margin * 2;
    const label = this.label || `QR code : ${text.length > 80 ? text.slice(0, 80) + "…" : text}`;
    const code = html`<svg viewBox="0 0 ${total} ${total}" role="img" aria-label=${label} style="width:var(--qr-size, ${px}px);height:var(--qr-size, ${px}px)" shape-rendering="crispEdges">
      ${svg`<rect width=${total} height=${total} fill=${this.background || "#ffffff"}></rect><path d=${qrPath(m, margin)} fill=${this.color || "#000000"}></path>`}
    </svg>`;
    const href = this.link ? safeHref(text) : null;
    return href ? html`<a href=${href} target="_blank" rel="noopener noreferrer">${code}</a>` : code;
  }
}

export { MAX_QR_TEXT };
