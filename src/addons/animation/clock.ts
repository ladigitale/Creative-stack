import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { boolConverter } from "./attrs";
import { ClockCore } from "./clock-core";
import type { ClockMode, ClockSnapshot } from "./types";

const tagName = "sonic-clock";
let instanceCount = 0;

/** Nombre ou chaîne numérique (valeur d'un `<input type="range">`) ; sinon null. */
function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Produit du temps, n'anime rien. Écrit dans son DataProvider : `t` (0..1), `time` (s), `duration`,
 * `playing`, `rate`, `direction`, `origin`. Se pilote en écrivant `playing`, `rate` ou `t` (un `t` écrit
 * de l'extérieur positionne l'horloge et la met en pause).
 */
@customElement(tagName)
export class SonicClock extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** DataProvider où l'horloge publie son état (obligatoire). */
  @property({ type: String })
  dataProvider = "";

  /** Durée d'un tour en secondes. */
  @property({ type: Number })
  duration = 1;

  /** `once` | `loop` | `pingpong`. */
  @property({ type: String })
  mode: ClockMode = "once";

  /** Vitesse (1 = temps réel, négatif = à rebours). */
  @property({ type: Number })
  rate = 1;

  /** Démarre à la connexion. */
  @property({ converter: boolConverter })
  autoplay = false;

  /** Onglet masqué puis revu : `freeze` (défaut, reprend sans saut) ou `catch-up` (rattrape le temps écoulé). */
  @property({ type: String, attribute: "on-hidden" })
  onHidden: "freeze" | "catch-up" = "freeze";

  private core = new ClockCore();
  private origin = `clock-${++instanceCount}`;
  private raf = 0;
  private last = 0;
  private writing = false;
  private written: Partial<ClockSnapshot> = {};
  private unsubs: Array<() => void> = [];
  private started = false;

  /** État courant. */
  getState(): ClockSnapshot {
    return this.core.snapshot(this.origin);
  }

  play(): void {
    this.core.play();
    this.publish();
    this.loop();
  }

  pause(): void {
    this.core.pause();
    this.publish();
  }

  seek(t: number): void {
    this.core.seek(t);
    this.publish();
  }

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.onVisibility);
    this.setup();
  }

  disconnectedCallback(): void {
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.teardown();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (!this.isConnected) return;
    if (changed.has("dataProvider")) {
      this.teardown();
      this.setup();
      return;
    }
    if (changed.has("duration") || changed.has("mode") || changed.has("rate")) {
      this.configureCore();
      this.publish();
    }
  }

  private configureCore(): void {
    this.core.duration = Number.isFinite(this.duration) && this.duration > 0 ? this.duration : 1;
    this.core.mode = this.mode === "loop" || this.mode === "pingpong" ? this.mode : "once";
    this.core.rate = Number.isFinite(this.rate) ? this.rate : 1;
  }

  private setup(): void {
    this.configureCore();
    const dp = this.dataProvider.trim();
    if (dp) {
      this.unsubs.push(
        listenDp(`${dp}.t`, (raw) => {
          const v = toNumber(raw); // un slider de formulaire écrit une chaîne
          if (this.writing || v === null) return;
          if (Math.abs(v - this.core.t) < 1e-9) return;
          // Écriture externe (slider, pair p2p…) : l'horloge se positionne et s'arrête.
          this.core.seek(v);
          this.core.pause();
          this.publish();
        }),
        listenDp(`${dp}.playing`, (v) => {
          if (this.writing || typeof v !== "boolean" || v === this.core.playing) return;
          if (v) this.core.play();
          else this.core.pause();
          this.publish();
          this.loop();
        }),
        listenDp(`${dp}.rate`, (raw) => {
          const v = toNumber(raw);
          if (this.writing || v === null || v === this.core.rate) return;
          this.core.rate = v;
          this.publish();
        }),
      );
    }
    this.written = {};
    if (this.autoplay && !this.started) {
      this.started = true;
      this.core.play();
    }
    this.publish();
    this.loop();
  }

  private teardown(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private onVisibility = () => {
    if (!document.hidden && this.onHidden !== "catch-up") this.last = performance.now();
  };

  private loop(): void {
    if (this.raf || !this.core.playing) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.raf = 0;
    if (!this.isConnected) return;
    // Temps réel issu de performance.now ; au retour d'un onglet masqué, `onVisibility` a déjà
    // remis `last` à jour en mode `freeze`, donc aucun saut.
    const dt = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    this.core.advance(dt);
    this.publish();
    if (this.core.playing) this.raf = requestAnimationFrame(this.tick);
  };

  /** Écrit dans le DataProvider uniquement les clés qui ont changé. */
  private publish(): void {
    const dp = this.dataProvider.trim();
    if (!dp) return;
    const snap = this.core.snapshot(this.origin);
    this.writing = true;
    try {
      for (const [k, v] of Object.entries(snap) as Array<[keyof ClockSnapshot, unknown]>) {
        if (this.written[k] !== v) set(`${dp}.${k}`, v);
      }
    } finally {
      this.writing = false;
    }
    this.written = snap;
  }

  render() {
    return html``;
  }
}

export default SonicClock;
