import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { bool } from "../../shared/media/control";
import { dispatch, type SonicActionMessage } from "./registry";

const tagName = "sonic-keyboard";

export type KeymapValue = string | { type: string; payload?: unknown };
export type Keymap = Record<string, KeymapValue>;
export type RepeatCfg = Record<string, [number, number]>;
type HeldKey = { type: string; payload?: unknown; timer?: number; interval?: number };

const MAX_KEYS = 256;
const MAX_REPEAT_MS = 60_000;

/** Keymap lue dans un DP (objet, ou chaîne JSON) : `{ code: "type" | { type, payload } }` ; entrées invalides écartées. */
export function readKeymap(v: unknown): Keymap | null {
  let x = v;
  if (typeof x === "string") {
    try {
      x = JSON.parse(x);
    } catch {
      return null;
    }
  }
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const out: Keymap = {};
  for (const [k, m] of Object.entries(x as Record<string, unknown>).slice(0, MAX_KEYS)) {
    if (typeof m === "string" && m) out[k] = m;
    else if (m && typeof m === "object" && typeof (m as { type?: unknown }).type === "string" && (m as { type: string }).type) {
      const { type, payload } = m as { type: string; payload?: unknown };
      out[k] = payload === undefined ? { type } : { type, payload };
    }
  }
  return out;
}

/** Répétition lue dans un DP : `{ type: [delayMs, intervalMs] }`, durées bornées à 0..60 s. */
export function readRepeat(v: unknown): RepeatCfg | null {
  let x = v;
  if (typeof x === "string") {
    try {
      x = JSON.parse(x);
    } catch {
      return null;
    }
  }
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const out: RepeatCfg = {};
  for (const [k, r] of Object.entries(x as Record<string, unknown>).slice(0, MAX_KEYS)) {
    if (!Array.isArray(r) || r.length < 2) continue;
    const [d, i] = [Number(r[0]), Number(r[1])];
    if (Number.isFinite(d) && Number.isFinite(i)) out[k] = [Math.min(MAX_REPEAT_MS, Math.max(0, d)), Math.min(MAX_REPEAT_MS, Math.max(0, i))];
  }
  return out;
}

export type KeyboardSettings = { keymap: Keymap; repeat: RepeatCfg; keyup: boolean; disabled: boolean };

/**
 * Lit le DP `params` (ou `control`) : `{ keymap, repeat, keyup, disabled }`. Clé absente ou `null` : l'attribut
 * s'applique. `invalid` liste les clés présentes mais illisibles.
 */
export function readKeyboardParams(v: unknown): { settings: Partial<KeyboardSettings>; invalid: string[] } {
  const p = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const o: Partial<KeyboardSettings> = {};
  const invalid: string[] = [];
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
  for (const key of ["keyup", "disabled"] as const) {
    if (p[key] === undefined || p[key] === null) continue;
    const b = bool(p[key]);
    if (b === undefined) invalid.push(key);
    else o[key] = b;
  }
  return { settings: o, invalid };
}

export type KeyboardState = {
  /** `idle` : keymap vide ou suspendu ; `ready` : à l'écoute ; `error` : réglage refusé. */
  status: "idle" | "ready" | "error";
  error: string | null;
  /** Touches tenues (codes `KeyboardEvent.code`), dans l'ordre d'appui. */
  held: string[];
  /** Dernière action émise par une touche, ou null. */
  last: { code: string; type: string; payload: unknown; phase: "down" | "repeat" | "up" } | null;
  /** Nombre d'actions émises depuis le chargement. */
  count: number;
  /** Codes de la keymap effective. */
  keys: string[];
};

/**
 * Source d’actions clavier → store (`target`).
 * Opt-in `@supersoniks/concorde/interactive`.
 * Réglages en direct par DP (`params`, ou `control`) : `{ keymap, repeat, keyup, disabled }` ; état complet
 * (`status`, touches tenues, dernière action) dans `out-data-provider`.
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

  /** Suspend l'écoute (les touches tenues sont relâchées). */
  @property({ type: Boolean })
  disabled = false;

  /** DP de pilotage : `{ keymap, repeat, keyup, disabled }` (mêmes clés que `params`, qui l'emporte). */
  @property({ type: String })
  control = "";

  /** DP de réglages en direct : `{ keymap, repeat, keyup, disabled }`. */
  @property({ type: String })
  params = "";

  /** DataProvider où publier l'état `{ status, error, held, last, count, keys }`. */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private held = new Map<string, HeldKey>();
  private fromControl: Partial<KeyboardSettings> = {};
  private fromParams: Partial<KeyboardSettings> = {};
  private invalid: { control: string[]; params: string[] } = { control: [], params: [] };
  private unsubs: Array<() => void> = [];
  private last: KeyboardState["last"] = null;
  private count = 0;
  private published = "";

  connectedCallback(): void {
    super.connectedCallback();
    if (this.scope === "focus") {
      if (!this.hasAttribute("tabindex")) this.tabIndex = 0;
    }
    this.bindTarget().addEventListener("keydown", this.onKeyDown);
    this.bindTarget().addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.releaseAll);
    document.addEventListener("visibilitychange", this.onVis);
    this.listen();
    this.publish();
  }

  disconnectedCallback(): void {
    this.bindTarget().removeEventListener("keydown", this.onKeyDown);
    this.bindTarget().removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.releaseAll);
    document.removeEventListener("visibilitychange", this.onVis);
    this.releaseAll();
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("scope")) {
      // rebind would need disconnect/connect; keep simple: focus ring attrs
      if (this.scope === "focus" && !this.hasAttribute("tabindex")) this.tabIndex = 0;
    }
    if (((changed.has("control") && changed.get("control") !== undefined) || (changed.has("params") && changed.get("params") !== undefined)) && this.isConnected) this.listen();
    if (changed.has("disabled") && this.settings().disabled) this.releaseAll();
    if (changed.has("outDataProvider")) this.published = "";
    this.publish();
  }

  /** Réglages effectifs (attributs, puis `control`, puis `params`). */
  settings(): KeyboardSettings {
    const attr = { keymap: readKeymap(this.keymap) ?? {}, repeat: readRepeat(this.repeat) ?? {}, keyup: this.keyup, disabled: this.disabled };
    return { ...attr, ...this.fromControl, ...this.fromParams };
  }

  /** État courant (aussi publié dans `out-data-provider`). */
  getState(): KeyboardState {
    const s = this.settings();
    const bad = [...this.invalid.control.map((k) => `control.${k}`), ...this.invalid.params.map((k) => `params.${k}`)];
    const error = bad.length ? `valeur refusée pour ${bad.join(", ")}` : null;
    const keys = Object.keys(s.keymap);
    const status: KeyboardState["status"] = error ? "error" : s.disabled || !keys.length ? "idle" : "ready";
    return { status, error, held: [...this.held.keys()], last: this.last, count: this.count, keys };
  }

  private listen(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.fromControl = {};
    this.fromParams = {};
    this.invalid = { control: [], params: [] };
    for (const which of ["control", "params"] as const) {
      const path = this[which].trim();
      if (!path) continue;
      this.unsubs.push(listenDp(path, (v) => {
        const { settings, invalid } = readKeyboardParams(v);
        if (which === "control") this.fromControl = settings;
        else this.fromParams = settings;
        this.invalid[which] = invalid;
        if (this.settings().disabled) this.releaseAll();
        this.publish();
      }));
    }
  }

  private publish(): void {
    const dp = this.outDataProvider.trim();
    if (!dp) return;
    const state = this.getState();
    const key = JSON.stringify(state);
    if (key === this.published) return;
    this.published = key;
    set(dp, state);
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
    const s = this.settings();
    if (s.disabled) return;
    const code = e.code || e.key;
    const mapped = s.keymap[code] ?? s.keymap[e.key];
    if (!mapped) return;
    e.preventDefault();
    const action = this.toAction(mapped);
    this.emit(action, code, "down");
    const rep = s.repeat[action.type];
    if (rep) {
      const [delay, interval] = rep;
      const entry: HeldKey = {
        type: action.type,
        payload: action.payload,
        timer: window.setTimeout(() => {
          this.emit({ type: action.type, payload: action.payload }, code, "repeat");
          entry.interval = window.setInterval(() => {
            this.emit({ type: action.type, payload: action.payload }, code, "repeat");
          }, Math.max(16, interval));
        }, Math.max(0, delay)),
      };
      this.held.set(code, entry);
    } else {
      this.held.set(code, { type: action.type, payload: action.payload });
    }
    this.publish();
  };

  private onKeyUp = (ev: Event) => {
    const e = ev as KeyboardEvent;
    const code = e.code || e.key;
    const held = this.held.get(code);
    if (held) {
      if (held.timer) clearTimeout(held.timer);
      if (held.interval) clearInterval(held.interval);
      this.held.delete(code);
      if (this.settings().keyup) {
        this.emit({ type: `${held.type}:up`, payload: held.payload }, code, "up");
      }
      this.publish();
    }
  };

  private releaseAll = () => {
    for (const [, held] of this.held) {
      if (held.timer) clearTimeout(held.timer);
      if (held.interval) clearInterval(held.interval);
    }
    const had = this.held.size > 0;
    this.held.clear();
    if (had) this.publish();
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

  private emit(action: SonicActionMessage, code: string, phase: "down" | "repeat" | "up"): void {
    this.count++;
    this.last = { code, type: action.type, payload: action.payload ?? null, phase };
    if (phase === "repeat") this.publish();
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
