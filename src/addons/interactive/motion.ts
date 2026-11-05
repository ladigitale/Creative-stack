import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { MotionTracker, type MotionOutput } from "./motion-core";
import { readPath } from "./trigger-core";

const tagName = "sonic-motion";

/** Pas de la boucle qui fait retomber la vitesse quand plus rien n'arrive. */
const IDLE_POLL_MS = 50;

/**
 * Vitesse d'un capteur : suit une ou plusieurs valeurs d'un DataProvider (`keys="x"` ou `keys="x,y"`) et publie
 * leur vitesse, accélération et pic de vitesse lissés. `vel` / `peakVel` (0..1) servent directement de vélocité
 * MIDI ; `speed` signée distingue montée et descente ; sans nouvelle valeur la vitesse retombe vers 0.
 */
@customElement(tagName)
export class SonicMotion extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }
  `;

  /** DataProvider surveillé (sortie d'un tracker, d'un store…). */
  @property({ type: String })
  source = "";

  /** Chemins pointés, séparés par des virgules : `right.x` ou `right.x,right.y` (norme du déplacement). */
  @property({ type: String })
  keys = "";

  /** Lissage de la vitesse (ms ; 0 = brut). */
  @property({ type: Number, attribute: "smooth-ms" })
  smoothMs = 60;

  /** Vitesse (unités/s) qui donne `vel` = 1. Les positions normalisées 0..1 vont souvent de 1 à 4. */
  @property({ type: Number, attribute: "speed-max" })
  speedMax = 2;

  /** Retombée vers 0 sans nouvelle valeur après ce délai (ms). */
  @property({ type: Number, attribute: "idle-ms" })
  idleMs = 120;

  /** Fenêtre du pic de vitesse (ms). */
  @property({ type: Number, attribute: "peak-ms" })
  peakMs = 150;

  /** DataProvider de sortie : {value, values, speed, accel, vel, peak, peakVel, moving}. */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private tracker = new MotionTracker({ smoothMs: 60, speedMax: 2, idleMs: 120, peakMs: 150 });
  private unlisten: (() => void) | null = null;
  private timer: number | null = null;
  private data: unknown = undefined;
  private published = "";

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    this.timer = window.setInterval(() => this.idle(), IDLE_POLL_MS);
  }

  disconnectedCallback(): void {
    this.unlisten?.();
    this.unlisten = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("source") || changed.has("keys")) {
      this.tracker.reset();
      this.listen();
    }
  }

  render() {
    return html``;
  }

  private listen(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.data = undefined;
    const path = this.source.trim();
    if (!path) return;
    this.unlisten = listenDp(path, (v) => {
      this.data = v;
      this.feed();
    });
  }

  private sync(): void {
    this.tracker.opts = {
      smoothMs: Number(this.smoothMs) || 0,
      speedMax: Number(this.speedMax) > 0 ? Number(this.speedMax) : 1,
      idleMs: Number(this.idleMs) || 0,
      peakMs: Number(this.peakMs) || 0,
    };
  }

  /** Lit les valeurs courantes et avance le suivi ; public pour les tests. */
  feed(now: number = performance.now()): void {
    this.sync();
    const keys = this.keys.split(",").map((k) => k.trim()).filter(Boolean);
    if (!keys.length) return;
    const values: number[] = [];
    for (const k of keys) {
      const raw = readPath(this.data, k);
      const n = typeof raw === "number" ? raw : raw === undefined || raw === null || raw === "" ? NaN : Number(raw);
      if (!Number.isFinite(n)) return; // valeur absente : pas de mesure, la vitesse retombera seule
      values.push(n);
    }
    this.publish(this.tracker.update(now, values));
  }

  /** Fait retomber la vitesse sans mesure récente ; public pour les tests. */
  idle(now: number = performance.now()): void {
    this.sync();
    const out = this.tracker.idle(now);
    if (out) this.publish(out);
  }

  private publish(out: MotionOutput): void {
    const dp = this.outDataProvider.trim();
    if (!dp) return;
    const r = (n: number) => Math.round(n * 10000) / 10000;
    const rounded = { ...out, value: r(out.value), values: out.values.map(r), speed: r(out.speed), accel: r(out.accel), vel: r(out.vel), peak: r(out.peak), peakVel: r(out.peakVel) };
    const key = JSON.stringify(rounded);
    if (key === this.published) return;
    this.published = key;
    set(dp, rounded);
  }
}
