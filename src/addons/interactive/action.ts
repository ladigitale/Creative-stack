import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { dispatch, type SonicActionMessage } from "./registry";

const tagName = "sonic-action";

/**
 * Wrapper : envoie une action à un store.
 * Par défaut au `pointerdown` (réactivité des croix directionnelles et des jeux ; `hold-repeat="170,50"` pour d-pad tactile).
 * `trigger="click"` : au clic, comme un bouton Concorde (interfaces : onglets, « Détails », filtres), donc annulable
 * en sortant du bouton avant de relâcher et sans déclenchement à l'appui d'un doigt qui défile.
 * Tout autre nom (ex. `trigger="hide"`) : l'action part quand un ENFANT DIRECT émet cet évènement, même s'il ne
 * remonte pas (écouté en capture) — garder un store au courant de la fermeture d'un `sonic-modal` (croix, fond,
 * Échap) : `<sonic-action trigger="hide" target="ui" type="close"><sonic-modal …>`.
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

  /** "pointerdown" (défaut, jeux et manettes tactiles), "click" (interfaces) ou un nom d'évènement d'un enfant direct. */
  @property({ type: String })
  trigger: string = "pointerdown";

  private customTrigger = "";

  private onCustom = (e: Event) => {
    // Seul un enfant direct compte : les pops, boutons… plus profonds émettent parfois le même nom.
    if (e.target instanceof Element && e.target.parentElement === this) this.emit();
  };

  private syncCustomTrigger(): void {
    const t = this.trigger === "click" || this.trigger === "pointerdown" ? "" : (this.trigger || "").trim();
    if (t === this.customTrigger) return;
    if (this.customTrigger) this.removeEventListener(this.customTrigger, this.onCustom, true);
    this.customTrigger = t;
    if (t && this.isConnected) this.addEventListener(t, this.onCustom, true);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.customTrigger = "";
    this.syncCustomTrigger();
  }

  disconnectedCallback(): void {
    if (this.customTrigger) this.removeEventListener(this.customTrigger, this.onCustom, true);
    this.customTrigger = "";
    this.clearHold();
    super.disconnectedCallback();
  }

  protected updated(): void {
    this.syncCustomTrigger();
  }

  @property({ type: Boolean, attribute: "dispatch-event" })
  dispatchEventFlag = false;

  private holdTimer: number | null = null;
  private holdInterval: number | null = null;

  private onClick = () => {
    if (this.trigger === "click") this.emit();
  };

  private onPointerDown = (e: PointerEvent) => {
    if (this.trigger !== "pointerdown" && this.trigger) return;
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
