import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { dispatch, type SonicActionMessage } from "./registry";

const tagName = "sonic-gesture";

/**
 * Zone tactile : tap, double-tap, swipe, long-press (+ drag optionnel).
 */
@customElement(tagName)
export class SonicGesture extends LitElement {
  static styles = css`
    :host {
      display: block;
      touch-action: none;
      user-select: none;
    }
  `;

  @property({ type: String })
  target = "";

  @property({ type: Number, attribute: "swipe-threshold" })
  swipeThreshold = 40;

  @property({ type: Number, attribute: "long-press-ms" })
  longPressMs = 450;

  @property({ type: Number, attribute: "double-tap-ms" })
  doubleTapMs = 280;

  @property({ type: Boolean })
  drag = false;

  @property({ type: Boolean, attribute: "dispatch-event" })
  dispatchEventFlag = false;

  private startX = 0;
  private startY = 0;
  private startT = 0;
  private longTimer: number | null = null;
  private lastTap = 0;
  private pointerId: number | null = null;

  private onDown = (e: PointerEvent) => {
    if (this.pointerId != null) return;
    this.pointerId = e.pointerId;
    this.setPointerCapture(e.pointerId);
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.startT = performance.now();
    this.longTimer = window.setTimeout(() => {
      this.emit({ type: "long-press" });
      this.longTimer = null;
    }, this.longPressMs);
  };

  private onMove = (e: PointerEvent) => {
    if (this.pointerId !== e.pointerId) return;
    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    if (Math.hypot(dx, dy) > 10 && this.longTimer != null) {
      clearTimeout(this.longTimer);
      this.longTimer = null;
    }
    if (this.drag) {
      const rect = this.getBoundingClientRect();
      this.emit({
        type: "drag",
        payload: {
          dx: rect.width ? dx / rect.width : 0,
          dy: rect.height ? dy / rect.height : 0,
        },
      });
    }
  };

  private onUp = (e: PointerEvent) => {
    if (this.pointerId !== e.pointerId) return;
    if (this.longTimer != null) {
      clearTimeout(this.longTimer);
      this.longTimer = null;
    }
    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    const dist = Math.hypot(dx, dy);
    const dt = performance.now() - this.startT;
    this.pointerId = null;
    if (dist >= this.swipeThreshold) {
      const type =
        Math.abs(dx) > Math.abs(dy)
          ? dx > 0
            ? "swipe-right"
            : "swipe-left"
          : dy > 0
            ? "swipe-down"
            : "swipe-up";
      this.emit({ type });
      return;
    }
    if (dt < this.longPressMs) {
      const now = performance.now();
      if (now - this.lastTap < this.doubleTapMs) {
        this.emit({ type: "double-tap" });
        this.lastTap = 0;
      } else {
        this.emit({ type: "tap" });
        this.lastTap = now;
      }
    }
  };

  private emit(action: SonicActionMessage): void {
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

  connectedCallback(): void {
    super.connectedCallback();
    // Écouteurs sur l'hôte : setPointerCapture() vise l'hôte, les événements
    // capturés (move/up) n'atteignent jamais un <slot> du shadow DOM.
    this.addEventListener("pointerdown", this.onDown);
    this.addEventListener("pointermove", this.onMove);
    this.addEventListener("pointerup", this.onUp);
    this.addEventListener("pointercancel", this.onUp);
  }

  disconnectedCallback(): void {
    this.removeEventListener("pointerdown", this.onDown);
    this.removeEventListener("pointermove", this.onMove);
    this.removeEventListener("pointerup", this.onUp);
    this.removeEventListener("pointercancel", this.onUp);
    if (this.longTimer != null) clearTimeout(this.longTimer);
    super.disconnectedCallback();
  }

  render() {
    return html`<slot></slot>`;
  }
}

export default SonicGesture;
