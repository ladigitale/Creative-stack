import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp, plain } from "../../shared/audio/dp";
import { jsonConverter } from "./attrs";
import { TimelineRunner, type RunnerState } from "./runner";
import type { TimelineDescriptor } from "./types";

const tagName = "sonic-timeline";

/**
 * Lit un temps normalisé (0..1) dans un DataProvider et anime des éléments du document en conséquence.
 * Ne joue jamais seule : la source de temps est une horloge, un slider, un pair p2p, un analyseur audio…
 */
@customElement(tagName)
export class SonicTimeline extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** Descripteur JSON (voir animation.md). */
  @property({ converter: jsonConverter })
  descriptor: TimelineDescriptor | null = null;

  /** DataProvider qui contient le descripteur (remplace l'attribut `descriptor`). */
  @property({ type: String, attribute: "descriptor-dp" })
  descriptorDp = "";

  /** Chemin DataProvider du temps (remplace `timeSource` du descripteur). */
  @property({ type: String, attribute: "time-source" })
  timeSource = "";

  @property({ type: String, attribute: "out-of-range" })
  outOfRange: "clamp" | "wrap" | "" = "";

  @property({ type: Number })
  smooth?: number;

  @property({ type: Number })
  duration?: number;

  /** Mode nodes : publie l'état des cibles dans `<dp>.nodes` (format partagé, lu par sonic-stage / sonic-3d) au lieu d'écrire dans le DOM. */
  @property({ type: String, attribute: "nodes-out" })
  nodesOut = "";

  /** DataProvider où publier `status`, `progress`, `time`, `duration`, `currentLabel`, `issues`. */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private runner: TimelineRunner | null = null;
  private unsubs: Array<() => void> = [];
  private remote: TimelineDescriptor | null = null;
  private published: Record<string, unknown> = {};

  /** État courant du moteur (utile aux tests et à l'atelier). */
  getState(): RunnerState | null {
    return this.runner?.state ?? null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.createRunner();
  }

  private createRunner(): void {
    this.runner?.dispose();
    this.runner = new TimelineRunner(this, { onState: (s) => this.publish(s), nodesOut: this.nodesOut.trim() || undefined });
    this.rebuild();
  }

  disconnectedCallback(): void {
    this.clearSubs();
    this.timeUnsub?.();
    this.timeUnsub = null;
    this.runner?.dispose();
    this.runner = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (!this.runner) return;
    if (changed.has("nodesOut") && changed.get("nodesOut") !== undefined) return this.createRunner();
    const keys = ["descriptor", "descriptorDp", "timeSource", "outOfRange", "smooth", "duration"];
    if (keys.some((k) => changed.has(k))) this.rebuild();
  }

  private clearSubs(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  private effective(): TimelineDescriptor | null {
    const base = this.remote ?? this.descriptor;
    if (!base || typeof base !== "object") return null;
    const d: TimelineDescriptor = { ...base };
    if (this.timeSource.trim()) d.timeSource = this.timeSource.trim();
    if (this.outOfRange === "clamp" || this.outOfRange === "wrap") d.outOfRange = this.outOfRange;
    if (typeof this.smooth === "number") d.smooth = this.smooth;
    if (typeof this.duration === "number") d.duration = this.duration;
    return d;
  }

  private rebuild(): void {
    if (!this.runner) return;
    this.clearSubs();
    this.published = {};
    const dpId = this.descriptorDp.trim();
    if (dpId) {
      this.unsubs.push(
        listenDp(dpId, (v) => {
          this.remote = v && typeof v === "object" ? (v as TimelineDescriptor) : null;
          this.configure();
        }),
      );
      try {
        const v = plain(get(dpId));
        this.remote = v && typeof v === "object" ? (v as TimelineDescriptor) : null;
      } catch {
        this.remote = null;
      }
    } else {
      this.remote = null;
    }
    this.configure();
  }

  private configure(): void {
    if (!this.runner) return;
    // Les abonnements au temps sont refaits à chaque configuration ; ceux du descripteur sont conservés.
    this.timeUnsub?.();
    this.timeUnsub = null;
    const d = this.effective();
    this.runner.configure(d);
    const source = d?.timeSource?.trim();
    if (!source || this.runner.state.status !== "ready") return;
    this.timeUnsub = listenDp(source, (v) => this.runner?.setProgress(v));
    try {
      const initial = plain(get(source));
      if (typeof initial === "number") this.runner.setProgress(initial);
    } catch {
      /* DataProvider pas encore créé : le premier assign suffira */
    }
  }

  private timeUnsub: (() => void) | null = null;

  private publish(s: RunnerState): void {
    const out = this.outDataProvider.trim();
    if (!out) return;
    const next: Record<string, unknown> = {
      status: s.status,
      progress: s.progress,
      time: s.time,
      duration: s.duration,
      currentLabel: s.currentLabel,
      issues: s.issues,
    };
    for (const [k, v] of Object.entries(next)) {
      if (k === "issues") {
        const sig = JSON.stringify(v);
        if (this.published.issuesSig === sig) continue;
        this.published.issuesSig = sig;
      } else if (this.published[k] === v) continue;
      else this.published[k] = v;
      set(`${out}.${k}`, v);
    }
  }

  render() {
    return html``;
  }
}

export default SonicTimeline;
