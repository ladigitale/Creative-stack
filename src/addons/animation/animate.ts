import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import { boolConverter, prefersReducedMotion } from "./attrs";
import { ClockCore } from "./clock-core";
import { buildRecipe, isRecipe, RECIPE_NAMES } from "./recipes";
import { TimelineRunner } from "./runner";
import type { Ease } from "./types";

const tagName = "sonic-animate";

type Trigger = "viewport" | "load" | "data" | "manual";

/** Publications au plus toutes les 33 ms pendant la lecture (≈ 30 Hz). */
const PUBLISH_MS = 33;

export type AnimateState = {
  /** `idle` : pas encore joué ; `running` : horloge locale en cours ; `ready` : terminé, ou temps lu dans `time-source` ; `error` : recette inconnue. */
  status: "idle" | "running" | "ready" | "error";
  error: string | null;
  /** Avancement affiché, 0..1. */
  progress: number;
  done: boolean;
  /** Nombre de lancements (trigger, `control`, `start()`) depuis le chargement. */
  runs: number;
  /** Durée totale de la recette (s). */
  duration: number;
};

/**
 * Enveloppe ses enfants et leur applique une recette (reveal, fade, slide-up, count-up, typewriter).
 * Horloge locale par défaut ; avec `time-source`, le temps vient d'un DataProvider (slider, p2p, audio…).
 * `control` (`{ n }`, une hausse de `n` lance) remplace l'appel de `start()` ; état complet dans `out-data-provider`.
 */
@customElement(tagName)
export class SonicAnimate extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }
  `;

  @property({ type: String })
  recipe = "";

  /** `viewport` (défaut) | `load` | `data` (changement de `watch`) | `manual` (appel de `start()`). */
  @property({ type: String })
  trigger: Trigger = "viewport";

  /** Durée d'un effet en secondes (défaut propre à la recette). */
  @property({ type: Number })
  duration?: number;

  /** Décalage en secondes entre enfants. */
  @property({ type: Number })
  stagger?: number;

  /** Ne joue qu'une fois (défaut). `false` : rejoue à chaque entrée dans l'écran. */
  @property({ converter: boolConverter })
  once = true;

  /** Chemin DataProvider d'un temps 0..1 qui remplace l'horloge locale. */
  @property({ type: String, attribute: "time-source" })
  timeSource = "";

  /** Chemin DataProvider surveillé par `trigger="data"`. */
  @property({ type: String })
  watch = "";

  @property({ type: Number })
  from?: number;

  @property({ type: Number })
  to?: number;

  @property({ type: Number })
  decimals?: number;

  /** count-up : texte avant / après le nombre (nommés `text-*` : `prefix` est déjà une propriété du DOM). */
  @property({ type: String, attribute: "text-prefix" })
  textPrefix?: string;

  @property({ type: String, attribute: "text-suffix" })
  textSuffix?: string;

  @property({ type: String })
  ease?: string;

  /** DP de pilotage `{ n }` : chaque hausse de `n` lance (ou relance) l'animation, quel que soit `trigger`. */
  @property({ type: String })
  control = "";

  /** DataProvider où publier l'état `{ status, error, progress, done, runs, duration }`. */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private runner: TimelineRunner | null = null;
  private core = new ClockCore();
  private raf = 0;
  private last = 0;
  private played = false;
  private unsubs: Array<() => void> = [];
  private io: IntersectionObserver | null = null;
  private counter = new CounterTrigger();
  private unlistenControl: (() => void) | null = null;
  private runs = 0;
  private error: string | null = null;
  private published = "";
  private lastPublish = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.listenControl();
    this.build();
  }

  disconnectedCallback(): void {
    this.teardown();
    this.unlistenControl?.();
    this.unlistenControl = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (!this.isConnected) return;
    if (changed.has("control") && changed.get("control") !== undefined) this.listenControl();
    if (changed.has("outDataProvider")) {
      this.published = "";
      this.publish(true);
    }
    // Recette d'abord inconnue puis corrigée : on reconstruit aussi sans runner.
    if (!this.runner && !changed.has("recipe")) return;
    const own = new Set(["once", "control", "outDataProvider"]);
    if (changed.size && [...changed.keys()].some((k) => !own.has(String(k)))) this.build();
  }

  private listenControl(): void {
    this.unlistenControl?.();
    this.unlistenControl = null;
    this.counter.reset();
    const path = this.control.trim();
    if (!path) return;
    this.unlistenControl = listenDp(path, (v) => {
      if (this.counter.feed(v)) this.start();
    });
  }

  /** État courant (aussi publié dans `out-data-provider`). */
  getState(): AnimateState {
    const r = this.runner?.state;
    const progress = r ? Math.round(r.progress * 10000) / 10000 : 0;
    const status: AnimateState["status"] = this.error
      ? "error"
      : !this.runner
        ? "idle"
        : this.timeSource.trim()
          ? "ready"
          : this.core.playing
            ? "running"
            : this.played
              ? "ready"
              : "idle";
    return { status, error: this.error, progress, done: progress >= 1, runs: this.runs, duration: this.runner?.duration ?? 0 };
  }

  /** Publie l'état (plafonné à ≈ 30 Hz pendant la lecture, sauf `force`). */
  private publish(force = false): void {
    const dp = this.outDataProvider.trim();
    if (!dp) return;
    const now = performance.now();
    if (!force && now - this.lastPublish < PUBLISH_MS) return;
    const state = this.getState();
    const key = JSON.stringify(state);
    if (key === this.published) return;
    this.published = key;
    this.lastPublish = now;
    set(dp, state);
  }

  /** Lance l'animation (trigger `manual`, ou relance). */
  start(): void {
    if (!this.runner) return;
    this.played = true;
    this.runs++;
    if (this.timeSource.trim()) {
      this.publish(true);
      return; // le temps vient d'ailleurs
    }
    if (prefersReducedMotion()) {
      this.core.pause();
      this.runner.setProgress(1);
      this.publish(true);
      return;
    }
    this.core.duration = this.runner.duration > 0 ? this.runner.duration : 0.5;
    this.core.mode = "once";
    this.core.rate = 1;
    this.core.t = 0;
    this.core.play();
    this.runner.setProgress(0);
    this.publish(true);
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  /** Remet les enfants à l'état de départ. */
  reset(): void {
    this.core.pause();
    this.core.t = 0;
    this.played = false;
    this.runner?.setProgress(0);
    this.publish(true);
  }

  private tick = (now: number) => {
    this.raf = 0;
    if (!this.runner) return;
    this.core.advance(Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.runner?.setProgress(this.core.t);
    if (this.core.playing) this.raf = requestAnimationFrame(this.tick);
    this.publish(!this.core.playing);
  };

  private teardown(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.io?.disconnect();
    this.io = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.runner?.dispose();
    this.runner = null;
  }

  private build(): void {
    this.teardown();
    if (!isRecipe(this.recipe)) {
      console.warn(`[sonic-animate] recipe « ${this.recipe} » inconnue. Utilise ${RECIPE_NAMES.join(", ")}.`);
      this.error = `recipe « ${this.recipe} » inconnue (${RECIPE_NAMES.join(", ")})`;
      this.publish(true);
      return;
    }
    this.error = null;
    const ease: Ease | undefined = this.ease === "linear" || this.ease === "easeIn" || this.ease === "easeOut" || this.ease === "easeInOut" ? this.ease : undefined;
    const descriptor = buildRecipe(this.recipe, {
      duration: this.duration,
      stagger: this.stagger,
      ease,
      from: this.from,
      to: this.to,
      decimals: this.decimals,
      prefix: this.textPrefix,
      suffix: this.textSuffix,
    });
    this.runner = new TimelineRunner(this);
    this.runner.configure(descriptor);

    const source = this.timeSource.trim();
    if (source) {
      this.unsubs.push(listenDp(source, (v) => {
        this.runner?.setProgress(v);
        this.publish();
      }));
      this.publish(true);
      return;
    }
    this.publish(true);
    this.armTrigger();
  }

  private armTrigger(): void {
    const trigger: Trigger = ["viewport", "load", "data", "manual"].includes(this.trigger) ? this.trigger : "viewport";
    if (trigger === "load") {
      requestAnimationFrame(() => this.start());
    } else if (trigger === "data") {
      const path = this.watch.trim();
      if (path) this.unsubs.push(listenDp(path, () => this.start()));
    } else if (trigger === "viewport") {
      this.watchViewport();
    }
  }

  private watchViewport(): void {
    if (typeof IntersectionObserver === "undefined") {
      requestAnimationFrame(() => this.start());
      return;
    }
    this.io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (visible) {
          if (!this.played || !this.once) this.start();
        } else if (!this.once && this.played) {
          this.reset();
        }
      },
      { threshold: 0.1 },
    );
    this.observeChildren();
  }

  /** `display: contents` n'a pas de boîte : on observe les enfants. */
  private observeChildren(): void {
    if (!this.io) return;
    this.io.disconnect();
    for (const child of Array.from(this.children)) this.io.observe(child);
  }

  private onSlotChange = () => this.observeChildren();

  render() {
    return html`<slot @slotchange=${this.onSlotChange}></slot>`;
  }
}

export default SonicAnimate;
