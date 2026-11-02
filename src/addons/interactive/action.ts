import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { dispatch, type SonicActionMessage } from "./registry";

const tagName = "sonic-action";

/**
 * Wrapper : envoie une action à un store.
 * Par défaut au `pointerdown` (réactivité des croix directionnelles et des jeux ; `hold-repeat="170,50"` pour d-pad tactile).
 * `trigger="click"` : au clic, comme un bouton Concorde (interfaces : onglets, « Détails », filtres), donc annulable
 * en sortant du bouton avant de relâcher et sans déclenchement à l'appui d'un doigt qui défile.
 */
@customElement(tagName)
export class SonicAction extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }
  `;

  @property({ type: String })
  target = "";

  @property({ type: String })
  type = "";

  @property({ type: Object })
  payload: unknown = null;

  @property({ type: String, attribute: "hold-repeat" })
  holdRepeat = "";

  /** "pointerdown" (défaut, jeux et manettes tactiles) ou "click" (interfaces). */
  @property({ type: String })
  trigger: "pointerdown" | "click" = "pointerdown";

  @property({ type: Boolean, attribute: "dispatch-event" })
  dispatchEventFlag = false;

  private holdTimer: number | null = null;
  private holdInterval: number | null = null;

  private onClick = () => {
    if (this.trigger === "click") this.emit();
  };

  private onPointerDown = (e: PointerEvent) => {
    if (this.trigger === "click") return;
    if (e.button != null && e.button !== 0) return;
    this.emit();
    const parts = this.holdRepeat.split(",").map((s) => Number(s.trim()));
    if (parts.length === 2 && parts.every((n) => Number.isFinite(n))) {
      const [delay, interval] = parts;
      this.holdTimer = window.setTimeout(() => {
        this.emit();
        this.holdInterval = window.setInterval(() => this.emit(), Math.max(16, interval));
      }, Math.max(0, delay));
    }
  };

  private onPointerUp = () => this.clearHold();

  private clearHold(): void {
    if (this.holdTimer != null) clearTimeout(this.holdTimer);
    if (this.holdInterval != null) clearInterval(this.holdInterval);
    this.holdTimer = null;
    this.holdInterval = null;
  }

  private emit(): void {
    if (!this.type) return;
    const action: SonicActionMessage = { type: this.type, payload: this.payload };
    if (this.target) dispatch(this.target, action);
    if (this.dispatchEventFlag) {
      this.dispatchEvent(
        new CustomEvent("sonic-action", {
          detail: action,
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  render() {
    return html`<slot
      @click=${this.onClick}
      @pointerdown=${this.onPointerDown}
      @pointerup=${this.onPointerUp}
      @pointercancel=${this.onPointerUp}
      @pointerleave=${this.onPointerUp}
    ></slot>`;
  }
}

export default SonicAction;
