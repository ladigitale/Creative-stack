import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import HTML from "@supersoniks/concorde/core/utils/HTML";
import { dp } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";

/**
 * Curseur de réglage : libellé, valeur affichée (unité) et glissière qui écrit un **nombre** dans un DataProvider
 * (`formDataProvider` + `name`, chemin pointé accepté : `name="photo.lum"`), et suit la valeur si elle change
 * ailleurs. Contrairement à `sonic-input type="range"` (qui écrit une chaîne), la valeur reste numérique : les
 * réducteurs et expressions JSONata peuvent calculer dessus.
 */
@customElement("sonic-slider")
export class SonicSlider extends LitElement {
  static styles = css`
    :host { display: block; min-width: 0; }
    .head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 2px; }
    .lab { flex: 1; min-width: 0; font-size: var(--sonic-slider-label-size, 12.5px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .val { font: 600 12px/1 var(--sonic-slider-value-font, ui-monospace, monospace); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .unit { opacity: 0.6; margin-left: 2px; font-size: 10px; }
    input { width: 100%; margin: 0; height: 28px; accent-color: var(--sc-primary, currentColor); cursor: pointer; touch-action: pan-y; }
    input:disabled { cursor: default; opacity: 0.5; }
  `;

  /** DataProvider écrit (défaut : celui de l'ancêtre `formDataProvider` / `dataProvider`). */
  @property({ type: String }) formDataProvider = "";
  /** Clé écrite, chemin pointé accepté. */
  @property({ type: String }) name = "";
  @property({ type: String }) label = "";
  @property({ type: String }) unit = "";
  @property({ type: Number }) min = 0;
  @property({ type: Number }) max = 100;
  @property({ type: Number }) step = 1;
  /** Décimales affichées (défaut : celles du pas). */
  @property({ type: Number }) decimals = -1;
  @property({ type: Boolean, reflect: true }) disabled = false;
  /** Valeur montrée tant que le DataProvider n'en a pas (défaut d'un paramètre jamais réglé). */
  @property({ type: Number }) value = NaN;

  @state() private current: number | null = null;
  private stop: (() => void) | null = null;
  private path = "";

  connectedCallback(): void {
    super.connectedCallback();
    this.bind();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stop?.();
    this.stop = null;
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("formDataProvider") || changed.has("name")) this.bind();
  }

  private providerId(): string {
    const own = this.formDataProvider?.trim();
    if (own) return own;
    return HTML.getAncestorAttributeValue(this, "formDataProvider") || HTML.getAncestorAttributeValue(this, "dataProvider") || "";
  }

  private bind(): void {
    const id = this.providerId();
    const key = this.name?.trim();
    const path = id && key ? `${id}.${key}` : "";
    if (path === this.path && this.stop) return;
    this.stop?.();
    this.stop = null;
    this.path = path;
    if (!path) return;
    this.stop = listenDp(path, (v) => {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      this.current = Number.isFinite(n) ? n : null;
    });
  }

  private clamp(v: number): number {
    const lo = Math.min(this.min, this.max), hi = Math.max(this.min, this.max);
    return Math.min(hi, Math.max(lo, v));
  }

  private onInput(e: Event): void {
    const n = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(n) || !this.path) return;
    const v = this.clamp(n);
    this.current = v;
    (dp(this.path) as unknown as { set: (v: unknown) => void }).set(v);
    this.dispatchEvent(new CustomEvent("sonic-slider", { detail: { value: v }, bubbles: true, composed: true }));
  }

  private digits(): number {
    if (this.decimals >= 0) return Math.min(6, this.decimals);
    const s = String(this.step);
    const i = s.indexOf(".");
    return i < 0 ? 0 : Math.min(6, s.length - i - 1);
  }

  render() {
    const known = this.current ?? (Number.isFinite(this.value) ? this.value : null);
    const v = known === null ? this.clamp(this.min) : this.clamp(known);
    const shown = known === null ? "–" : v.toLocaleString("fr-FR", { minimumFractionDigits: this.digits(), maximumFractionDigits: this.digits() });
    return html`
      <div class="head" part="head">
        ${this.label ? html`<span class="lab" part="label">${this.label}</span>` : nothing}
        <span class="val" part="value">${shown}${this.unit ? html`<span class="unit">${this.unit}</span>` : nothing}</span>
      </div>
      <input part="input" type="range" .min=${String(this.min)} .max=${String(this.max)} .step=${String(this.step)} .value=${String(v)}
        ?disabled=${this.disabled} aria-label=${this.label || this.name} @input=${(e: Event) => this.onInput(e)} />
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sonic-slider": SonicSlider;
  }
}
