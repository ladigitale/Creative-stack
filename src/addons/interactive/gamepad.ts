import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { dispatch, type SonicActionMessage } from "./registry";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";

const tagName = "sonic-gamepad";

type RepeatCfg = Record<string, [number, number]>;

const STANDARD: Record<string, number | { axis: number; dir: 1 | -1 }> = {
  "dpad-up": 12,
  "dpad-down": 13,
  "dpad-left": 14,
  "dpad-right": 15,
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  start: 9,
  select: 8,
  "ls-x-": { axis: 0, dir: -1 },
  "ls-x+": { axis: 0, dir: 1 },
  "ls-y-": { axis: 1, dir: -1 },
  "ls-y+": { axis: 1, dir: 1 },
};

/**
 * Manette → actions store. Raf uniquement si une pad est connectée.
 */
@customElement(tagName)
export class SonicGamepad extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }
  `;

  @property({ type: String })
  target = "";

  @property({ type: Object })
  keymap: Record<string, string | { type: string; payload?: unknown }> = {
    "dpad-left": "left",
    "dpad-right": "right",
    "dpad-up": "rotate",
    "dpad-down": "soft-drop",
    a: "rotate",
    b: "drop",
    start: "pause",
  };

  @property({ type: Number })
  deadzone = 0.25;

  @property({ type: Object })
  repeat: RepeatCfg = {};

  @property({ type: String })
  dataProvider = "";

  @property({ type: Boolean, attribute: "dispatch-event" })
  dispatchEventFlag = false;

  @state() private connected = false;

  private raf = 0;
  private prev = new Map<string, boolean>();
  private heldTimers = new Map<string, { timer?: number; interval?: number }>();

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("gamepadconnected", this.onConnect);
    window.addEventListener("gamepaddisconnected", this.onDisconnect);
    this.scan();
  }

  disconnectedCallback(): void {
    window.removeEventListener("gamepadconnected", this.onConnect);
    window.removeEventListener("gamepaddisconnected", this.onDisconnect);
    this.stopLoop();
    this.clearHolds();
    super.disconnectedCallback();
  }

  private onConnect = () => this.scan();
  private onDisconnect = () => this.scan();

  private scan(): void {
    const pads = navigator.getGamepads?.() ?? [];
    const any = [...pads].some(Boolean);
    this.connected = any;
    this.publishStatus();
    if (any) this.startLoop();
    else this.stopLoop();
  }

  private publishStatus(): void {
    if (!this.dataProvider) return;
    const pads = navigator.getGamepads?.() ?? [];
    const first = [...pads].find(Boolean);
    set(this.dataProvider, {
      connected: this.connected,
      id: first?.id ?? null,
    } as never);
  }

  private startLoop(): void {
    if (this.raf) return;
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.poll();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private poll(): void {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = [...pads].find(Boolean);
    if (!pad) {
      this.scan();
      return;
    }
    for (const [name, mapped] of Object.entries(this.keymap || {})) {
      const spec = STANDARD[name];
      if (spec == null) continue;
      let pressed = false;
      if (typeof spec === "number") {
        pressed = Boolean(pad.buttons[spec]?.pressed);
      } else {
        const axis = pad.axes[spec.axis] ?? 0;
        pressed = spec.dir < 0 ? axis < -this.deadzone : axis > this.deadzone;
      }
      const was = this.prev.get(name) ?? false;
      if (pressed && !was) {
        this.fire(mapped);
        this.startRepeat(name, mapped);
      } else if (!pressed && was) {
        this.stopRepeat(name);
      }
      this.prev.set(name, pressed);
    }
  }

  private startRepeat(
    name: string,
    mapped: string | { type: string; payload?: unknown },
  ): void {
    const action = typeof mapped === "string" ? { type: mapped } : mapped;
    const rep = this.repeat?.[action.type];
    if (!rep) return;
    const [delay, interval] = rep;
    const entry: { timer?: number; interval?: number } = {};
    entry.timer = window.setTimeout(() => {
      this.fire(mapped);
      entry.interval = window.setInterval(() => this.fire(mapped), Math.max(16, interval));
    }, Math.max(0, delay));
    this.heldTimers.set(name, entry);
  }

  private stopRepeat(name: string): void {
    const h = this.heldTimers.get(name);
    if (!h) return;
    if (h.timer) clearTimeout(h.timer);
    if (h.interval) clearInterval(h.interval);
    this.heldTimers.delete(name);
  }

  private clearHolds(): void {
    for (const name of [...this.heldTimers.keys()]) this.stopRepeat(name);
  }

  private fire(mapped: string | { type: string; payload?: unknown }): void {
    const action: SonicActionMessage =
      typeof mapped === "string" ? { type: mapped } : { type: mapped.type, payload: mapped.payload };
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
    return html``;
  }
}

export default SonicGamepad;
