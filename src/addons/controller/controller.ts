import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";

const tagName = "sonic-controller";

/** Boutons de la disposition standard (W3C Gamepad « standard »). */
export const BUTTONS = ["a", "b", "x", "y", "lb", "rb", "lt", "rt", "select", "start", "ls", "rs", "up", "down", "left", "right", "home"] as const;
export type ButtonName = (typeof BUTTONS)[number];

export type PadState = {
  index: number;
  id: string;
  /** "standard" si la disposition est connue (sinon les noms de boutons sont approximatifs). */
  mapping: string;
  /** Sticks -1..1 après zone morte ; gâchettes 0..1. */
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  lt: number;
  rt: number;
  /** Boutons enfoncés (noms). */
  pressed: string[];
};

export type ControllerState = {
  status: "idle" | "ready" | "unsupported";
  /** Le navigateur ne montre une manette qu'après un appui sur un de ses boutons. */
  count: number;
  pads: PadState[];
};

type Mapped = string | { type: string; payload?: unknown };
type StoreLike = { dispatchAction(action: { type: string; payload?: unknown }): void };

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Zone morte radiale, puis remise à l'échelle (le stick « démarre » au bord de la zone). */
export function deadzone(x: number, y: number, dz: number): [number, number] {
  const m = Math.hypot(x, y);
  if (m < dz || m === 0) return [0, 0];
  const k = Math.min(1, (m - dz) / (1 - dz)) / m;
  return [r2(x * k), r2(y * k)];
}

/**
 * Manettes (API Gamepad) : jusqu'à 4, sticks et gâchettes analogiques, boutons.
 *
 * - `keymap` : `{ "a": "jump", "start": "pause", "b": { "type": "fire", "payload": 2 } }` → action
 *   envoyée au `store` à l'appui (et `<type>:up` au relâchement avec `release`).
 * - `analog-action="stick"` : envoie `{ type: "stick", payload: { pad, lx, ly, rx, ry, lt, rt } }`
 *   quand un axe bouge (au plus `rate` fois par seconde) : le reducer en fait une vitesse, un paramètre…
 * - État `<id>State` : `{ status, count, pads: [{ index, id, lx, ly, rx, ry, lt, rt, pressed }] }`.
 * - `control` (DP) : `{ rumble: { n: compteur, ms, strong, weak } }` fait vibrer la manette.
 */
@customElement(tagName)
export class SonicController extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  @property({ type: String }) store = "";
  @property({ type: Object }) keymap: Record<string, Mapped> = {};
  /** Envoie aussi `<type>:up` au relâchement. */
  @property({ type: Boolean }) release = false;
  @property({ type: String, attribute: "analog-action" }) analogAction = "";
  /** Zone morte des sticks (0..0.9). */
  @property({ type: Number }) deadzone = 0.15;
  /** Manette suivie : `all` (défaut) ou 0..3. */
  @property({ type: String }) player = "all";
  @property({ type: Number }) rate = 30;
  @property({ type: String }) control = "";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  private raf = 0;
  private prev = new Map<number, Set<string>>();
  private lastAnalog = new Map<number, string>();
  private lastAnalogAt = 0;
  private lastPublish = 0;
  private lastJson = "";
  private rumbleN: number | undefined;
  private unsub: (() => void) | null = null;
  private state: ControllerState = { status: "idle", count: 0, pads: [] };

  connectedCallback(): void {
    super.connectedCallback();
    if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
      this.state = { status: "unsupported", count: 0, pads: [] };
      this.publish(true);
      return;
    }
    window.addEventListener("gamepadconnected", this.scan);
    window.addEventListener("gamepaddisconnected", this.scan);
    this.scan();
  }

  disconnectedCallback(): void {
    window.removeEventListener("gamepadconnected", this.scan);
    window.removeEventListener("gamepaddisconnected", this.scan);
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.unsub?.();
    this.unsub = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("control")) {
      this.unsub?.();
      this.rumbleN = undefined;
      this.unsub = this.control
        ? listenDp(this.control, (v) => {
            const r = (v as { rumble?: { n?: unknown; ms?: unknown; strong?: unknown; weak?: unknown } } | null)?.rumble;
            if (!r || typeof r.n !== "number") return;
            const prev = this.rumbleN;
            this.rumbleN = r.n;
            if (prev !== undefined && r.n > prev) this.rumble(Number(r.ms) || 200, Number(r.strong ?? 0.8), Number(r.weak ?? 0.5));
          })
        : null;
    }
  }

  getState(): ControllerState {
    return JSON.parse(JSON.stringify(this.state)) as ControllerState;
  }

  /** Vibration (si la manette et le navigateur le permettent). */
  rumble(ms = 200, strong = 0.8, weak = 0.5): void {
    for (const pad of this.pads()) {
      const act = (pad as Gamepad & { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } }).vibrationActuator;
      act?.playEffect?.("dual-rumble", { duration: Math.min(5000, ms), strongMagnitude: clamp01(strong), weakMagnitude: clamp01(weak) })?.catch(() => undefined);
    }
  }

  private pads(): Gamepad[] {
    const all = [...(navigator.getGamepads?.() ?? [])].filter((p): p is Gamepad => !!p && p.connected !== false);
    if (this.player === "all" || this.player === "") return all.slice(0, 4);
    const i = Number(this.player);
    return all.filter((p) => p.index === i);
  }

  private scan = (): void => {
    const any = this.pads().length > 0;
    if (any && !this.raf) this.raf = requestAnimationFrame(this.loop);
    if (!any) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.state = { status: "idle", count: 0, pads: [] };
      this.publish(true);
    }
  };

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    this.poll();
  };

  /** Lecture des manettes (public pour les tests). */
  poll(): void {
    const pads = this.pads();
    if (!pads.length) {
      this.scan();
      return;
    }
    const now = performance.now();
    const states: PadState[] = [];
    for (const pad of pads) {
      const b = (i: number) => pad.buttons[i];
      const val = (i: number) => (b(i) ? Math.max(b(i).value ?? 0, b(i).pressed ? 1 : 0) : 0);
      const [lx, ly] = deadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0, this.deadzone);
      const [rx, ry] = deadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0, this.deadzone);
      const pressed = new Set<string>();
      BUTTONS.forEach((name, i) => {
        if (b(i)?.pressed) pressed.add(name);
      });
      // Stick gauche au-delà de la moitié : aussi des directions (menus, jeux au pas).
      if (lx < -0.5) pressed.add("ls-left");
      if (lx > 0.5) pressed.add("ls-right");
      if (ly < -0.5) pressed.add("ls-up");
      if (ly > 0.5) pressed.add("ls-down");
      const st: PadState = { index: pad.index, id: pad.id, mapping: pad.mapping || "", lx, ly, rx, ry, lt: r2(val(6)), rt: r2(val(7)), pressed: [...pressed] };
      states.push(st);

      // Appuis / relâchements → store.
      const before = this.prev.get(pad.index) ?? new Set<string>();
      for (const name of pressed) if (!before.has(name)) this.fire(name, pad.index, false);
      for (const name of before) if (!pressed.has(name)) this.fire(name, pad.index, true);
      this.prev.set(pad.index, pressed);

      // Axes → action analogique.
      if (this.analogAction && this.store) {
        const payload = { pad: pad.index, lx, ly, rx, ry, lt: st.lt, rt: st.rt };
        const key = JSON.stringify(payload);
        if (key !== this.lastAnalog.get(pad.index) && now - this.lastAnalogAt >= 1000 / Math.max(1, Math.min(120, this.rate))) {
          this.lastAnalog.set(pad.index, key);
          this.lastAnalogAt = now;
          this.storeEl()?.dispatchAction({ type: this.analogAction, payload });
        }
      }
    }
    this.state = { status: "ready", count: states.length, pads: states };
    this.publish(false);
  }

  private fire(name: string, pad: number, up: boolean): void {
    const mapped = this.keymap?.[name];
    if (!mapped || !this.store) return;
    if (up && !this.release) return;
    const action = typeof mapped === "string" ? { type: mapped, payload: undefined as unknown } : { type: mapped.type, payload: mapped.payload };
    const payload = action.payload !== undefined ? action.payload : { pad };
    this.storeEl()?.dispatchAction({ type: up ? `${action.type}:up` : action.type, payload });
  }

  private storeEl(): (Element & StoreLike) | null {
    const id = this.store.replace(/^#/, "");
    if (!id) return null;
    const root = this.getRootNode() as Document | ShadowRoot;
    const el = (root.getElementById?.(id) ?? document.getElementById(id)) as (Element & StoreLike) | null;
    return el && typeof el.dispatchAction === "function" ? el : null;
  }

  private publish(force: boolean): void {
    const now = performance.now();
    if (!force && now - this.lastPublish < 1000 / Math.max(1, Math.min(60, this.rate))) return;
    const json = JSON.stringify(this.state);
    if (!force && json === this.lastJson) return;
    this.lastPublish = now;
    this.lastJson = json;
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (out) set(out, this.getState());
  }

  render() {
    return html``;
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
}

export default SonicController;
