import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { playSound } from "./registry";

const tagName = "sonic-sfx";

/**
 * Sons d'interface déclaratifs : enveloppe des éléments et joue un son
 * sur leurs événements (clic, survol…), sans JS.
 *
 * ```json
 * { "tagName": "sonic-sfx", "attributes": { "sound": "click", "hover": "hover" },
 *   "nodes": [{ "tagName": "sonic-button", "nodes": [{ "innerText": "Jouer" }] }] }
 * ```
 */
@customElement(tagName)
export class SonicSfx extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }
  `;

  /** Son joué sur l'événement `on`. */
  @property({ type: String })
  sound = "";

  /** Événement déclencheur (défaut `click`) : click, pointerdown, pointerup, focusin, change, input… */
  @property({ type: String })
  on = "click";

  /** Son joué au survol (pointerenter). */
  @property({ type: String })
  hover = "";

  /** Moteur visé (id d'un `sonic-sound`) ; défaut : le premier. */
  @property({ type: String })
  engine = "";

  /** Transposition en demi-tons. */
  @property({ type: Number })
  pitch = 0;

  /** Multiplicateur de volume. */
  @property({ type: Number })
  vol = 1;

  private bound = "";

  connectedCallback(): void {
    super.connectedCallback();
    this.bind();
    this.addEventListener("pointerover", this.onOver);
  }

  disconnectedCallback(): void {
    this.unbind();
    this.removeEventListener("pointerover", this.onOver);
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("on")) this.bind();
  }

  private bind(): void {
    this.unbind();
    this.bound = (this.on || "click").trim();
    this.addEventListener(this.bound, this.onTrigger);
  }

  private unbind(): void {
    if (this.bound) this.removeEventListener(this.bound, this.onTrigger);
    this.bound = "";
  }

  private onTrigger = (e: Event): void => {
    if (!this.sound || this.isDisabled(e)) return;
    playSound(this.sound, { pitch: this.pitch, vol: this.vol, engine: this.engine || undefined });
  };

  /** pointerover bulle : on ne joue qu'à l'entrée dans un nouvel enfant direct. */
  private lastOver: Element | null = null;
  private onOver = (e: PointerEvent): void => {
    if (!this.hover || e.pointerType === "touch") return;
    const child = this.directChild(e.target);
    if (!child || child === this.lastOver) return;
    this.lastOver = child;
    const leave = (ev: PointerEvent) => {
      if (ev.relatedTarget instanceof Node && child.contains(ev.relatedTarget)) return;
      child.removeEventListener("pointerout", leave as EventListener);
      if (this.lastOver === child) this.lastOver = null;
    };
    child.addEventListener("pointerout", leave as EventListener);
    if (this.isDisabled(e)) return;
    playSound(this.hover, { vol: this.vol, engine: this.engine || undefined });
  };

  private directChild(target: EventTarget | null): Element | null {
    let el = target instanceof Element ? target : null;
    while (el && el.parentElement !== this) el = el.parentElement;
    return el;
  }

  private isDisabled(e: Event): boolean {
    for (const el of e.composedPath()) {
      if (el === this) break;
      if (el instanceof Element && (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true")) {
        return true;
      }
    }
    return false;
  }

  render() {
    return html`<slot></slot>`;
  }
}

export default SonicSfx;
