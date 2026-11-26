import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { dispatch, type SonicActionMessage } from "./registry";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger, num } from "../../shared/media/control";
import { RumbleTracker, canRumble, noPadError, readRumble, type RumbleState } from "../../shared/device/rumble";
import { readKeymap, readRepeat, type Keymap, type RepeatCfg } from "./keyboard";

const tagName = "sonic-gamepad";

export type GamepadSettings = { deadzone: number; keymap: Keymap; repeat: RepeatCfg };

/**
 * Lit le DP `params` : `{ deadzone, keymap, repeat }`. `deadzone` bornée à 0..0.95. Clé absente, `null` ou `""` :
 * l'attribut s'applique. `invalid` liste les clés présentes mais illisibles.
 */
export function readGamepadParams(v: unknown): { settings: Partial<GamepadSettings>; invalid: string[] } {
  const p = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const o: Partial<GamepadSettings> = {};
  const invalid: string[] = [];
  if (p.deadzone !== undefined && p.deadzone !== null && p.deadzone !== "") {
    const d = typeof p.deadzone === "boolean" ? undefined : num(p.deadzone, 0, 0.95);
    if (d === undefined) invalid.push("deadzone");
    else o.deadzone = d;
  }
  if (p.keymap !== undefined && p.keymap !== null) {
    const k = readKeymap(p.keymap);
    if (k) o.keymap = k;
    else invalid.push("keymap");
  }
  if (p.repeat !== undefined && p.repeat !== null) {
    const r = readRepeat(p.repeat);
    if (r) o.repeat = r;
    else invalid.push("repeat");
  }
  return { settings: o, invalid };
}

export type GamepadState = {
  /** `idle` : aucune manette visible ; `ready` : manette connectée ; `error` : réglage `params` refusé ; `unsupported` : pas d'API Gamepad. */
  status: "idle" | "ready" | "error" | "unsupported";
  error: string | null;
  connected: boolean;
  id: string | null;
  /** Zone morte effective des sticks. */
  deadzone: number;
  /** Vibration de la manette 0 (ou de la première visible) : `supported` si elle sait vibrer, `active` pendant l'effet. */
  rumble: RumbleState;
};

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
 * Manette → actions store. Raf uniquement si une pad est connectée. Boutons et stick gauche poussé à fond
 * seulement, une manette : pour les axes analogiques, les gâchettes ou plusieurs manettes, voir `sonic-controller`.
 * Réglages en direct par le DP `params` : `{ deadzone, keymap, repeat }`.
 * Vibration par le DP `control` : `{ rumble: { n: compteur, duration (ms, ≤ 5000), strong (0..1), weak (0..1), pad } }`,
 * `{ stopRumble: n }` l'arrête ; erreur lisible dans `error` de l'état (sans changer `status`). Non testé sur matériel.
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

  /** DataProvider de l'état `{ status, error, connected, id, deadzone }`. */
  @property({ type: String })
  dataProvider = "";

  /** Même rôle que `dataProvider` (convention des autres composants) ; les deux peuvent coexister. */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  /** DP de réglages en direct : `{ deadzone, keymap, repeat }`. */
  @property({ type: String })
  params = "";

  @property({ type: Boolean, attribute: "dispatch-event" })
  dispatchEventFlag = false;

  /** DP de pilotage par compteurs : `{ rumble: { n, duration, strong, weak, pad }, stopRumble: n }`. */
  @property({ type: String })
  control = "";

  @state() private connected = false;

  private raf = 0;
  private prev = new Map<string, boolean>();
  private heldTimers = new Map<string, { timer?: number; interval?: number }>();
  private live: Partial<GamepadSettings> = {};
  private liveInvalid: string[] = [];
  private unlistenParams: (() => void) | null = null;
  private published = "";
  private unlistenControl: (() => void) | null = null;
  private rumbleTrigger = new CounterTrigger();
  private stopTrigger = new CounterTrigger();
  private rumbleError: string | null = null;
  private rumbles = new RumbleTracker(() => this.publishStatus());

  connectedCallback(): void {
    super.connectedCallback();
    this.listenParams();
    if (this.hasUpdated) this.listenControl();
    window.addEventListener("gamepadconnected", this.onConnect);
    window.addEventListener("gamepaddisconnected", this.onDisconnect);
    this.scan();
  }

  disconnectedCallback(): void {
    window.removeEventListener("gamepadconnected", this.onConnect);
    window.removeEventListener("gamepaddisconnected", this.onDisconnect);
    this.stopLoop();
    this.clearHolds();
    this.unlistenParams?.();
    this.unlistenParams = null;
    this.unlistenControl?.();
    this.unlistenControl = null;
    this.rumbles.reset();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("params") && changed.get("params") !== undefined && this.isConnected) this.listenParams();
    if (changed.has("control")) this.listenControl();
    if (changed.has("dataProvider") || changed.has("outDataProvider")) this.published = "";
    this.publishStatus();
  }

  private listenParams(): void {
    this.unlistenParams?.();
    this.unlistenParams = null;
    this.live = {};
    this.liveInvalid = [];
    const path = this.params.trim();
    if (!path) return;
    this.unlistenParams = listenDp(path, (v) => {
      const { settings, invalid } = readGamepadParams(v);
      this.live = settings;
      this.liveInvalid = invalid;
      this.publishStatus();
    });
  }

  private listenControl(): void {
    this.unlistenControl?.();
    this.unlistenControl = null;
    this.rumbleTrigger.reset();
    this.stopTrigger.reset();
    const path = this.control.trim();
    if (!path) return;
    this.unlistenControl = listenDp(path, (v) => {
      if (!v || typeof v !== "object") return;
      const c = v as Record<string, unknown>;
      if (this.stopTrigger.feed(c.stopRumble)) void this.stopRumble();
      if (this.rumbleTrigger.feed(c.rumble)) void this.rumble(c.rumble);
    });
  }

  /** Manette visée : `Gamepad.index` = `index`, ou la première visible pour l'index 0. */
  private padAt(index: number): Gamepad | undefined {
    const pads = [...(navigator.getGamepads?.() ?? [])].filter((p): p is Gamepad => !!p);
    return pads.find((p) => p.index === index) ?? (index === 0 ? pads[0] : undefined);
  }

  /** Vibration (commande `rumble`) : `{ duration (ms), strong, weak, pad }`. Ne lève jamais ; vrai si elle a joué. */
  async rumble(arg: unknown = {}): Promise<boolean> {
    const args = readRumble(arg);
    const index = args.pad ?? 0;
    const pad = typeof navigator.getGamepads === "function" ? this.padAt(index) : undefined;
    if (!pad) return this.rumbleFailed(noPadError(index));
    try {
      this.rumbleError = null;
      await this.rumbles.play([pad], args);
      return true;
    } catch (e) {
      return this.rumbleFailed(e instanceof Error ? e.message : String(e));
    }
  }

  /** Arrête la vibration (commande `stopRumble`). */
  async stopRumble(): Promise<void> {
    const pads = [...(navigator.getGamepads?.() ?? [])].filter((p): p is Gamepad => !!p);
    await this.rumbles.stop(pads);
  }

  private rumbleFailed(message: string): false {
    this.rumbleError = message;
    this.publishStatus();
    return false;
  }

  /** Réglages effectifs (attributs, puis `params`). */
  settings(): GamepadSettings {
    const dz = Number(this.deadzone);
    return {
      deadzone: Number.isFinite(dz) ? Math.min(0.95, Math.max(0, dz)) : 0.25,
      keymap: readKeymap(this.keymap) ?? {},
      repeat: readRepeat(this.repeat) ?? {},
      ...this.live,
    };
  }

  /** État courant (aussi publié dans `dataProvider` / `out-data-provider`). */
  getState(): GamepadState {
    const error = this.liveInvalid.length ? `params : valeur refusée pour ${this.liveInvalid.join(", ")}` : this.rumbleError;
    const supported = typeof navigator !== "undefined" && typeof navigator.getGamepads === "function";
    const pads = supported ? navigator.getGamepads() : [];
    const first = [...pads].find(Boolean);
    const status: GamepadState["status"] = this.liveInvalid.length ? "error" : !supported ? "unsupported" : this.connected ? "ready" : "idle";
    const rumblePad = supported ? this.padAt(0) : undefined;
    return {
      status,
      error,
      connected: this.connected,
      id: first?.id ?? null,
      deadzone: this.settings().deadzone,
      rumble: { supported: canRumble(rumblePad), active: this.rumbles.active },
    };
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
    const targets = [...new Set([this.dataProvider.trim(), this.outDataProvider.trim()].filter(Boolean))];
    if (!targets.length) return;
    const state = this.getState();
    const key = JSON.stringify(state);
    if (key === this.published) return;
    this.published = key;
    for (const t of targets) set(t, state as never);
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
    const { deadzone, keymap } = this.settings();
    for (const [name, mapped] of Object.entries(keymap)) {
      const spec = STANDARD[name];
      if (spec == null) continue;
      let pressed = false;
      if (typeof spec === "number") {
        pressed = Boolean(pad.buttons[spec]?.pressed);
      } else {
        const axis = pad.axes[spec.axis] ?? 0;
        pressed = spec.dir < 0 ? axis < -deadzone : axis > deadzone;
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
    const rep = this.settings().repeat[action.type];
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
