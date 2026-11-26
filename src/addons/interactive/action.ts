import { publisherAt } from "../../shared/dp-path";
import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { dispatch, type SonicActionMessage } from "./registry";

const tagName = "sonic-action";

/**
 * Wrapper : envoie une action à un store.
 * Par défaut au clic, comme un bouton Concorde : annulable en sortant du bouton avant de relâcher, et sans
 * déclenchement à l'appui d'un doigt qui fait défiler la page.
 * `trigger="pointerdown"` : dès l'appui (jeux, croix directionnelles, manettes tactiles). `hold-repeat="170,50"`
 * (répétition tant que l'appui dure) part lui aussi de l'appui, sans avoir à écrire `trigger`.
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

  /**
   * Chemin DataProvider lu au moment de l'action et fusionné dans le payload : un objet est fusionné par-dessus
   * `payload`, une autre valeur arrive dans `payload.value`. Pour envoyer au store une valeur qu'il ne peut pas lire
   * (champ de formulaire, choix, résultat d'un transform comme la date du jour).
   */
  @property({ type: String, attribute: "payload-from" })
  payloadFrom = "";

  @property({ type: String, attribute: "hold-repeat" })
  holdRepeat = "";

  /**
   * "click" (défaut), "pointerdown" (jeux et manettes tactiles) ou un nom d'évènement d'un enfant direct.
   * Vide : clic, ou appui si `hold-repeat` est renseigné.
   */
  @property({ type: String })
  trigger: string = "";

  /** Déclencheur effectif : "click", "pointerdown", ou "" pour un évènement d'un enfant direct. */
  private mode(): "click" | "pointerdown" | "" {
    const t = (this.trigger || "").trim();
    if (t === "click" || t === "pointerdown") return t;
    if (t) return "";
    return this.holdRepeat.trim() ? "pointerdown" : "click";
  }

  private customTrigger = "";

  private onCustom = (e: Event) => {
    // Seul un enfant direct compte : les pops, boutons… plus profonds émettent parfois le même nom.
    if (e.target instanceof Element && e.target.parentElement === this) this.emit();
  };

  private syncCustomTrigger(): void {
    const t = this.mode() ? "" : (this.trigger || "").trim();
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
    if (this.mode() === "click") this.emit();
  };

  private onPointerDown = (e: PointerEvent) => {
    if (this.mode() !== "pointerdown") return;
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
    const action: SonicActionMessage = { type: this.type, payload: this.mergedPayload() };
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

  private mergedPayload(): unknown {
    const path = this.payloadFrom.trim();
    if (!path) return this.payload;
    let v: unknown;
    try {
      v = JSON.parse(JSON.stringify((publisherAt(path) as unknown as { get(): unknown }).get() ?? null));
    } catch {
      v = null;
    }
    const base = this.payload && typeof this.payload === "object" && !Array.isArray(this.payload) ? (this.payload as Record<string, unknown>) : this.payload == null ? {} : { payload: this.payload };
    if (v && typeof v === "object" && !Array.isArray(v)) return { ...base, ...(v as Record<string, unknown>) };
    return { ...base, value: v };
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
