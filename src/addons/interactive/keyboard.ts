import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { dispatch, type SonicActionMessage } from "./registry";

const tagName = "sonic-keyboard";

type KeymapValue = string | { type: string; payload?: unknown };
type Keymap = Record<string, KeymapValue>;
type RepeatCfg = Record<string, [number, number]>;
type HeldKey = { type: string; payload?: unknown; timer?: number; interval?: number };

/**
 * Source d’actions clavier → store (`target`).
 * Opt-in `@supersoniks/concorde/interactive`.
 */
@customElement(tagName)
export class SonicKeyboard extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }
    :host([scope="focus"]) {
      display: block;
      outline: none;
    }
    :host([scope="focus"]:focus) {
      outline: 2px solid var(--sc-primary, #3b82f6);
      outline-offset: 2px;
    }
  `;

  @property({ type: String })
  target = "";

  @property({ type: Object })
  keymap: Keymap = {};

  /** `document` | `focus` */
  @property({ type: String })
  scope: "document" | "focus" = "document";

  /** `{ "left": [delayMs, intervalMs] }` */
  @property({ type: Object })
  repeat: RepeatCfg = {};

  @property({ type: Boolean })
  keyup = false;

  @property({ type: Boolean, attribute: "dispatch-event" })
  dispatchEventFlag = false;

  private held = new Map<string, HeldKey>();

  connectedCallback(): void {
    super.connectedCallback();
    if (this.scope === "focus") {
      if (!this.hasAttribute("tabindex")) this.tabIndex = 0;
    }
    this.bindTarget().addEventListener("keydown", this.onKeyDown);
    this.bindTarget().addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.releaseAll);
    document.addEventListener("visibilitychange", this.onVis);
  }

  disconnectedCallback(): void {
    this.bindTarget().removeEventListener("keydown", this.onKeyDown);
    this.bindTarget().removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.releaseAll);
    document.removeEventListener("visibilitychange", this.onVis);
    this.releaseAll();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("scope")) {
      // rebind would need disconnect/connect; keep simple: focus ring attrs
      if (this.scope === "focus" && !this.hasAttribute("tabindex")) this.tabIndex = 0;
    }
  }

  private bindTarget(): EventTarget {
    return this.scope === "focus" ? this : window;
  }

  private onVis = () => {
    if (document.hidden) this.releaseAll();
  };

  private onKeyDown = (ev: Event) => {
    const e = ev as KeyboardEvent;
    if (e.repeat) return; // handled via our DAS/ARR
    if (this.isEditableTarget(e.target)) return;
    const code = e.code || e.key;
    const mapped = this.keymap?.[code] ?? this.keymap?.[e.key];
    if (!mapped) return;
    e.preventDefault();
    const action = this.toAction(mapped);
    this.emit(action);
    const rep = this.repeat?.[action.type];
    if (rep) {
      const [delay, interval] = rep;
      const entry: HeldKey = {
        type: action.type,
        payload: action.payload,
        timer: window.setTimeout(() => {
          this.emit({ type: action.type, payload: action.payload });
          entry.interval = window.setInterval(() => {
            this.emit({ type: action.type, payload: action.payload });
          }, Math.max(16, interval));
        }, Math.max(0, delay)),
      };
      this.held.set(code, entry);
    } else {
      this.held.set(code, { type: action.type, payload: action.payload });
    }
  };

  private onKeyUp = (ev: Event) => {
    const e = ev as KeyboardEvent;
    const code = e.code || e.key;
    const held = this.held.get(code);
    if (held) {
      if (held.timer) clearTimeout(held.timer);
      if (held.interval) clearInterval(held.interval);
      this.held.delete(code);
      if (this.keyup) {
        this.emit({ type: `${held.type}:up`, payload: held.payload });
      }
    }
  };

  private releaseAll = () => {
    for (const [, held] of this.held) {
      if (held.timer) clearTimeout(held.timer);
      if (held.interval) clearInterval(held.interval);
    }
    this.held.clear();
  };

  private isEditableTarget(t: EventTarget | null): boolean {
    if (!(t instanceof HTMLElement)) return false;
    const tag = t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (t.isContentEditable) return true;
    return Boolean(t.closest("input,textarea,select,[contenteditable=true]"));
  }

  private toAction(mapped: KeymapValue): SonicActionMessage {
    if (typeof mapped === "string") return { type: mapped };
    return { type: mapped.type, payload: mapped.payload };
  }

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

  render() {
    return this.scope === "focus" ? html`<slot></slot>` : html``;
  }
}

export default SonicKeyboard;
