import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { num } from "../../shared/media/control";
import { MotionTracker, type MotionOptions, type MotionOutput } from "./motion-core";
import { readPath } from "./trigger-core";

const tagName = "sonic-motion";

/** Pas de la boucle qui fait retomber la vitesse quand plus rien n'arrive. */
const IDLE_POLL_MS = 50;
const MAX_MS = 60_000;
const PARAM_KEYS = ["smoothMs", "speedMax", "idleMs", "peakMs"] as const;

/**
 * Lit le DP `params` : `{ smoothMs, speedMax, idleMs, peakMs }`. Durées bornées à 0..60 s, `speedMax` à 0.001..1e6.
 * Clé absente, `null` ou `""` : l'attribut s'applique. `invalid` liste les clés présentes mais illisibles.
 */
export function readMotionParams(v: unknown): { settings: Partial<MotionOptions>; invalid: string[] } {
  const p = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const o: Partial<MotionOptions> = {};
  const invalid: string[] = [];
  for (const k of PARAM_KEYS) {
    const x = p[k];
    if (x === undefined || x === null || x === "") continue;
    const n = k === "speedMax" ? num(x, 0.001, 1e6) : num(x, 0, MAX_MS);
    if (n === undefined || typeof x === "boolean" || typeof x === "object") invalid.push(k);
    else o[k] = n;
  }
  return { settings: o, invalid };
}

/** Sortie publiée : mesures + état standard. */
export type MotionState = MotionOutput & {
  /** `idle` : pas de `source` ou de `keys` ; `ready` : suivi actif ; `error` : réglage `params` refusé. */
  status: "idle" | "ready" | "error";
  error: string | null;
  /** Réglages effectifs (attributs, puis `params`). */
  settings: MotionOptions;
};

const ZERO: MotionOutput = { value: 0, values: [], speed: 0, accel: 0, vel: 0, peak: 0, peakVel: 0, moving: false };

/**
 * Vitesse d'un capteur : suit une ou plusieurs valeurs d'un DataProvider (`keys="x"` ou `keys="x,y"`) et publie
 * leur vitesse, accélération et pic de vitesse lissés. `vel` / `peakVel` (0..1) servent directement de vélocité
 * MIDI ; `speed` signée distingue montée et descente ; sans nouvelle valeur la vitesse retombe vers 0.
 * Réglages en direct par le DP `params` `{ smoothMs, speedMax, idleMs, peakMs }` (prioritaire sur les attributs).
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

  /** DataProvider de sortie : {status, error, value, values, speed, accel, vel, peak, peakVel, moving, settings}. */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  /** DP de réglages en direct : `{ smoothMs, speedMax, idleMs, peakMs }`. */
  @property({ type: String })
  params = "";

  private tracker = new MotionTracker({ smoothMs: 60, speedMax: 2, idleMs: 120, peakMs: 150 });
  private unlisten: (() => void) | null = null;
  private timer: number | null = null;
  private data: unknown = undefined;
  private published = "";
  private last: MotionOutput = ZERO;
  private live: Partial<MotionOptions> = {};
  private liveInvalid: string[] = [];
  private unlistenParams: (() => void) | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    this.listenParams();
    this.publish(this.last);
    this.timer = window.setInterval(() => this.idle(), IDLE_POLL_MS);
  }

  disconnectedCallback(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.unlistenParams?.();
    this.unlistenParams = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("source") || changed.has("keys")) {
      this.tracker.reset();
      this.last = ZERO;
      this.listen();
      this.publish(this.last);
    }
    if (changed.has("params") && changed.get("params") !== undefined && this.isConnected) this.listenParams();
    if (changed.has("outDataProvider")) {
      this.published = "";
      this.publish(this.last);
    }
  }

  private listenParams(): void {
    this.unlistenParams?.();
    this.unlistenParams = null;
    this.live = {};
    this.liveInvalid = [];
    const path = this.params.trim();
    if (!path) return;
    this.unlistenParams = listenDp(path, (v) => {
      const { settings, invalid } = readMotionParams(v);
      this.live = settings;
      this.liveInvalid = invalid;
      this.sync();
      this.publish(this.last);
    });
  }

  /** Réglages effectifs (attributs, puis `params`), bornés. */
  settings(): MotionOptions {
    const s = { smoothMs: this.smoothMs, speedMax: this.speedMax, idleMs: this.idleMs, peakMs: this.peakMs, ...this.live };
    return {
      smoothMs: Math.max(0, Number(s.smoothMs) || 0),
      speedMax: Number(s.speedMax) > 0 ? Number(s.speedMax) : 1,
      idleMs: Math.max(0, Number(s.idleMs) || 0),
      peakMs: Math.max(0, Number(s.peakMs) || 0),
    };
  }

  /** État courant (aussi publié dans `out-data-provider`). */
  getState(): MotionState {
    const error = this.liveInvalid.length ? `params : valeur refusée pour ${this.liveInvalid.join(", ")}` : null;
    const keys = this.keys.split(",").some((k) => k.trim());
    const status: MotionState["status"] = error ? "error" : this.source.trim() && keys ? "ready" : "idle";
    return { ...this.last, status, error, settings: this.settings() };
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
    this.tracker.opts = this.settings();
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
    this.last = out;
    const dp = this.outDataProvider.trim();
    if (!dp) return;
    const r = (n: number) => Math.round(n * 10000) / 10000;
    const rounded = { ...this.getState(), value: r(out.value), values: out.values.map(r), speed: r(out.speed), accel: r(out.accel), vel: r(out.vel), peak: r(out.peak), peakVel: r(out.peakVel) };
    const key = JSON.stringify(rounded);
    if (key === this.published) return;
    this.published = key;
    set(dp, rounded);
  }
}
