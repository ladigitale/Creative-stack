import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { bool, num } from "../../shared/media/control";
import { dispatch, type SonicActionMessage } from "./registry";
import { CONTINUOUS, GestureTracker, coalesce, type GestureAction, type GestureOptions } from "./gesture-core";

const tagName = "sonic-gesture";

export type GestureSettings = {
  swipeThreshold: number;
  longPressMs: number;
  doubleTapMs: number;
  drag: boolean;
  pan: boolean;
  pinch: boolean;
  wheel: boolean;
  press: boolean;
};

const NUM_KEYS: Array<[keyof GestureSettings, number, number]> = [
  ["swipeThreshold", 1, 2000],
  ["longPressMs", 50, 10_000],
  ["doubleTapMs", 0, 2000],
];
const BOOL_KEYS = ["drag", "pan", "pinch", "wheel", "press"] as const;
/** Actions transmises par une zone traversante pendant un geste à plusieurs doigts. */
export const PASSTHROUGH_TYPES = new Set(["pan", "pan-end", "pinch-start", "pinch", "pinch-end"]);

/**
 * Lit le DP `params` : `{ swipeThreshold (px, 1..2000), longPressMs (50..10000), doubleTapMs (0..2000), drag, pan,
 * pinch, wheel, press }`. Clé absente, `null` ou `""` : l'attribut s'applique. `invalid` : clés présentes mais illisibles
 * (ignorées).
 */
export function readGestureParams(v: unknown): { settings: Partial<GestureSettings>; invalid: string[] } {
  const p = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const o: Record<string, number | boolean> = {};
  const invalid: string[] = [];
  for (const [k, min, max] of NUM_KEYS) {
    const x = p[k];
    if (x === undefined || x === null || x === "") continue;
    const n = typeof x === "boolean" ? undefined : num(x, min, max);
    if (n === undefined) invalid.push(k);
    else o[k] = n;
  }
  for (const k of BOOL_KEYS) {
    if (p[k] === undefined || p[k] === null) continue;
    const b = bool(p[k]);
    if (b === undefined) invalid.push(k);
    else o[k] = b;
  }
  return { settings: o as Partial<GestureSettings>, invalid };
}

/**
 * Zone tactile multipoint → actions vers un sonic-store (`target`).
 *
 * Toujours : tap / double-tap / long-press ({x, y, u, v} : px dans la zone et fraction), swipe-up|down|left|right.
 * `drag` : drag {dx, dy} cumulés en fraction de la zone (1 doigt) + drag-end.
 * `pan` : pan {dx, dy, x, y} en px depuis l'action précédente (centre des doigts) + pan-end {dx, dy, vx, vy} ; pas de swipe.
 * `pinch` : pinch-start, pinch {scale, dScale, rotation, dRotation, cx, cy}, pinch-end (deux doigts).
 * `wheel` : la molette envoie pinch {source: "wheel", dScale…}.
 * Les actions continues (drag, pan, pinch) sont regroupées : au plus une de chaque par image.
 * `press` : press {id, x, y, u, v} dès qu'un doigt touche, release {id, x, y, u, v} quand il se lève
 *   (ou que le geste est annulé), pour chaque doigt : jeu instrumental (note tenue tant que le doigt reste).
 * `passthrough` : ne capture rien et n'émet que les gestes à deux doigts (pan, pinch) et la molette : un doigt seul
 *   va aux éléments dessous (dessiner d'un doigt, déplacer / zoomer / tourner à deux).
 * `state-provider` : DataProvider qui reçoit {active, pointers, scale, rotation, panX, panY, x, y}.
 * `params` : DP de réglages en direct {swipeThreshold, longPressMs, doubleTapMs, drag, pan, pinch, wheel, press},
 *   prioritaires sur les attributs (clé retirée : retour à l'attribut).
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

  @property({ type: Boolean })
  pan = false;

  @property({ type: Boolean })
  pinch = false;

  @property({ type: Boolean })
  wheel = false;

  /** Émet press / release par doigt (pointerdown / pointerup), en plus des gestes. */
  @property({ type: Boolean })
  press = false;

  /**
   * Zone traversante : ne capture pas les pointeurs et n'émet que les gestes à deux doigts ou plus
   * (pan, pinch avec rotation) et la molette. Un doigt seul reste aux éléments dessous (toile de
   * dessin, boutons) : poser une zone traversante autour d'une toile pour déplacer / zoomer / tourner.
   */
  @property({ type: Boolean })
  passthrough = false;

  @property({ type: String, attribute: "state-provider" })
  stateProvider = "";

  @property({ type: Boolean, attribute: "dispatch-event" })
  dispatchEventFlag = false;

  /** DP de réglages en direct : `{ swipeThreshold, longPressMs, doubleTapMs, drag, pan, pinch, wheel, press }`. */
  @property({ type: String })
  params = "";

  private live: Partial<GestureSettings> = {};
  private unlistenParams: (() => void) | null = null;
  private tracker = new GestureTracker();
  private longTimer: number | null = null;
  private queue: GestureAction[] = [];
  private frame: number | null = null;

  /** Réglages effectifs (attributs, puis `params`). */
  settings(): GestureSettings {
    return {
      swipeThreshold: this.swipeThreshold,
      longPressMs: this.longPressMs,
      doubleTapMs: this.doubleTapMs,
      drag: this.drag,
      pan: this.pan,
      pinch: this.pinch,
      wheel: this.wheel,
      press: this.press,
      ...this.live,
    };
  }

  private listenParams(): void {
    this.unlistenParams?.();
    this.unlistenParams = null;
    this.live = {};
    const path = this.params.trim();
    if (!path) return;
    this.unlistenParams = listenDp(path, (v) => {
      this.live = readGestureParams(v).settings;
    });
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("params") && changed.get("params") !== undefined && this.isConnected) this.listenParams();
  }

  private options(): GestureOptions {
    const r = this.getBoundingClientRect();
    const s = this.settings();
    return {
      swipeThreshold: s.swipeThreshold,
      longPressMs: s.longPressMs,
      doubleTapMs: s.doubleTapMs,
      drag: s.drag,
      pan: s.pan,
      pinch: s.pinch,
      width: r.width,
      height: r.height,
    };
  }

  private point(e: PointerEvent) {
    const r = this.getBoundingClientRect();
    return { id: e.pointerId, x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp || performance.now() };
  }

  private clearLong(): void {
    if (this.longTimer != null) {
      clearTimeout(this.longTimer);
      this.longTimer = null;
    }
  }

  /** Doigts posés (press émis, release pas encore). */
  private pressed = new Set<number>();

  private pressAction(type: "press" | "release", e: PointerEvent): SonicActionMessage {
    const r = this.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return {
      type,
      payload: {
        id: e.pointerId,
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        u: r.width ? Math.round(clamp(x / r.width) * 10000) / 10000 : 0,
        v: r.height ? Math.round(clamp(y / r.height) * 10000) / 10000 : 0,
      },
    };
  }

  private releasePointer(e: PointerEvent): void {
    if (!this.pressed.delete(e.pointerId)) return;
    this.flush();
    this.emit(this.pressAction("release", e));
  }

  private onDown = (e: PointerEvent) => {
    if (!this.passthrough) {
      try {
        this.setPointerCapture(e.pointerId);
      } catch {
        /* pointeur déjà relâché */
      }
    }
    if (this.settings().press) {
      // tout de suite, avant toute analyse de geste : la note part au contact
      this.pressed.add(e.pointerId);
      this.flush();
      this.emit(this.pressAction("press", e));
    }
    this.handle(this.tracker.down(this.point(e), this.options()));
    this.clearLong();
    if (this.tracker.canLongPress()) {
      this.longTimer = window.setTimeout(() => {
        this.longTimer = null;
        this.handle(this.tracker.longPress(this.options()));
      }, this.settings().longPressMs);
    }
  };

  private onMove = (e: PointerEvent) => {
    const actions = this.tracker.move(this.point(e), this.options());
    if (!this.tracker.canLongPress()) this.clearLong();
    this.handle(actions);
  };

  private onUp = (e: PointerEvent) => {
    this.clearLong();
    this.releasePointer(e);
    this.handle(this.tracker.up(this.point(e), this.options()));
  };

  private onCancel = (e: PointerEvent) => {
    this.clearLong();
    this.releasePointer(e);
    // Un pointeur annulé (geste système) termine le geste sans tap ni swipe.
    if (this.tracker.size <= 1) this.handle(this.tracker.cancel());
    else this.handle(this.tracker.up(this.point(e), { ...this.options(), swipeThreshold: Infinity, longPressMs: 0 }));
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.settings().wheel) return;
    e.preventDefault();
    const r = this.getBoundingClientRect();
    this.handle([this.tracker.wheel(e.deltaY, e.clientX - r.left, e.clientY - r.top)]);
  };

  /** Mode traversant : un geste à plusieurs doigts est en cours (jusqu'à ce que le dernier doigt se lève). */
  private multi = false;

  /** Actions ponctuelles : envoyées tout de suite (après les continues en attente) ; continues : par image. */
  private handle(actions: GestureAction[]): void {
    if (this.passthrough) actions = this.passthroughFilter(actions);
    if (!actions.length) return;
    for (const a of actions) {
      if (CONTINUOUS.has(a.type)) {
        this.queue.push(a);
        if (this.frame == null) this.frame = requestAnimationFrame(() => this.flush());
      } else {
        this.flush();
        this.emit(a);
        this.publishState();
      }
    }
  }

  /** Ne garde que les gestes à deux doigts (et ceux qui les prolongent jusqu'au dernier doigt levé) et la molette. */
  private passthroughFilter(actions: GestureAction[]): GestureAction[] {
    if (this.tracker.size >= 2) this.multi = true;
    const out = actions.filter((a) => {
      const p = a.payload as Record<string, unknown> | undefined;
      if (a.type === "pinch" && p?.source === "wheel") return true;
      return this.multi && PASSTHROUGH_TYPES.has(a.type);
    });
    if (this.tracker.size === 0) this.multi = false;
    return out;
  }

  private flush(): void {
    if (this.frame != null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    if (!this.queue.length) return;
    const batch = coalesce(this.queue);
    this.queue = [];
    for (const a of batch) this.emit(a);
    this.publishState();
  }

  private publishState(): void {
    if (this.stateProvider) set(this.stateProvider, this.tracker.state());
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

  connectedCallback(): void {
    super.connectedCallback();
    this.listenParams();
    // Écouteurs sur l'hôte : setPointerCapture() vise l'hôte, les événements
    // capturés (move/up) n'atteignent jamais un <slot> du shadow DOM.
    this.addEventListener("pointerdown", this.onDown);
    this.addEventListener("pointermove", this.onMove);
    this.addEventListener("pointerup", this.onUp);
    this.addEventListener("pointercancel", this.onCancel);
    this.addEventListener("wheel", this.onWheel, { passive: false });
  }

  disconnectedCallback(): void {
    this.removeEventListener("pointerdown", this.onDown);
    this.removeEventListener("pointermove", this.onMove);
    this.removeEventListener("pointerup", this.onUp);
    this.removeEventListener("pointercancel", this.onCancel);
    this.removeEventListener("wheel", this.onWheel);
    this.clearLong();
    if (this.frame != null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.queue = [];
    this.tracker.cancel();
    this.unlistenParams?.();
    this.unlistenParams = null;
    super.disconnectedCallback();
  }

  render() {
    return html`<slot></slot>`;
  }
}

export default SonicGesture;
