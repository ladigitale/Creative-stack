import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { listenDp } from "../../shared/audio/dp";
import { boolConverter, prefersReducedMotion } from "./attrs";
import { ClockCore } from "./clock-core";
import { buildRecipe, isRecipe, RECIPE_NAMES } from "./recipes";
import { TimelineRunner } from "./runner";
import type { Ease } from "./types";

const tagName = "sonic-animate";

type Trigger = "viewport" | "load" | "data" | "manual";

/**
 * Enveloppe ses enfants et leur applique une recette (reveal, fade, slide-up, count-up, typewriter).
 * Horloge locale par défaut ; avec `time-source`, le temps vient d'un DataProvider (slider, p2p, audio…).
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

  private runner: TimelineRunner | null = null;
  private core = new ClockCore();
  private raf = 0;
  private last = 0;
  private played = false;
  private unsubs: Array<() => void> = [];
  private io: IntersectionObserver | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.build();
  }

  disconnectedCallback(): void {
    this.teardown();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (!this.isConnected || !this.runner) return;
    if (changed.size && [...changed.keys()].some((k) => k !== "once")) this.build();
  }

  /** Lance l'animation (trigger `manual`, ou relance). */
  start(): void {
    if (!this.runner) return;
    this.played = true;
    if (this.timeSource.trim()) return; // le temps vient d'ailleurs
    if (prefersReducedMotion()) {
      this.runner.setProgress(1);
      return;
    }
    this.core.duration = this.runner.duration > 0 ? this.runner.duration : 0.5;
    this.core.mode = "once";
    this.core.rate = 1;
    this.core.t = 0;
    this.core.play();
    this.runner.setProgress(0);
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
  }

  private tick = (now: number) => {
    this.raf = 0;
    if (!this.runner) return;
    this.core.advance(Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.runner?.setProgress(this.core.t);
    if (this.core.playing) this.raf = requestAnimationFrame(this.tick);
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
      return;
    }
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
      this.unsubs.push(listenDp(source, (v) => this.runner?.setProgress(v)));
      return;
    }
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
