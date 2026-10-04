import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { get } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { dispatch, type SonicActionMessage } from "./registry";

const tagName = "sonic-ticker";

/**
 * Horloge déclarative : émet `tick` avec `dt` vers un store.
 */
@customElement(tagName)
export class SonicTicker extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }
  `;

  @property({ type: String })
  target = "";

  @property({ type: Number })
  interval = 500;

  /** Chemin dans le DP du store pour l’intervalle (ex. `speed`). */
  @property({ type: String, attribute: "interval-key" })
  intervalKey = "";

  /** Chemin booléen pause (ex. `running`). */
  @property({ type: String, attribute: "running-key" })
  runningKey = "";

  /** `interval` | `raf` */
  @property({ type: String })
  mode: "interval" | "raf" = "interval";

  @property({ type: Boolean, attribute: "dispatch-event" })
  dispatchEventFlag = false;

  private timer: number | null = null;
  private raf = 0;
  private last = 0;
  private acc = 0;

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.onVis);
    this.restart();
  }

  disconnectedCallback(): void {
    document.removeEventListener("visibilitychange", this.onVis);
    this.stop();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (
      changed.has("interval") ||
      changed.has("mode") ||
      changed.has("target") ||
      changed.has("intervalKey") ||
      changed.has("runningKey")
    ) {
      this.restart();
    }
  }

  private onVis = () => {
    if (document.hidden) this.stop();
    else this.restart();
  };

  private stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.acc = 0;
  }

  private restart(): void {
    this.stop();
    if (!this.target || document.hidden) return;
    this.last = performance.now();
    if (this.mode === "raf") {
      const loop = (now: number) => {
        this.raf = requestAnimationFrame(loop);
        if (!this.isRunning()) {
          this.last = now;
          return;
        }
        const raw = Math.min(100, now - this.last);
        this.last = now;
        this.acc += raw;
        const ms = this.currentInterval();
        while (this.acc >= ms) {
          this.acc -= ms;
          this.emit(ms);
        }
      };
      this.raf = requestAnimationFrame(loop);
      return;
    }
    this.timer = window.setInterval(() => {
      if (!this.isRunning()) return;
      const now = performance.now();
      const dt = Math.min(1000, now - this.last);
      this.last = now;
      this.emit(dt);
    }, this.currentInterval());
  }

  private currentInterval(): number {
    let ms = this.interval;
    if (this.intervalKey && this.target) {
      try {
        const state = get(this.target) as Record<string, unknown> | undefined;
        const v = this.path(state, this.intervalKey);
        if (typeof v === "number" && Number.isFinite(v)) ms = v;
      } catch {
        /* keep */
      }
    }
    return Math.max(16, ms);
  }

  private isRunning(): boolean {
    if (!this.runningKey || !this.target) return true;
    try {
      const state = get(this.target) as Record<string, unknown> | undefined;
      return Boolean(this.path(state, this.runningKey));
    } catch {
      return true;
    }
  }

  private path(obj: unknown, path: string): unknown {
    if (!obj || typeof obj !== "object") return undefined;
    let cur: any = obj;
    for (const p of path.split(".").filter(Boolean)) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  }

  private emit(dt: number): void {
    const action: SonicActionMessage = { type: "tick", payload: { dt }, dt };
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

export default SonicTicker;
