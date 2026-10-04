import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine, resolveAudioElement } from "../../shared/audio/engine";
import { isInstrument, type SonicNoteEvent } from "../../shared/audio/contracts";
import { listenDp } from "../../shared/audio/dp";
import { compilePattern, SequencerCore, type StepTick } from "./seq/core";

const tagName = "sonic-sequencer";
const TICK_MS = 25;

export type SequencerState = {
  status: "idle" | "ready" | "playing" | "unsupported";
  playing: boolean;
  bpm: number;
  swing: number;
  /** Pas dans la mesure, temps, mesure, position 0..1 : publiés à l'heure audio. */
  step: number;
  beat: number;
  bar: number;
  phase: number;
  errors: string[];
  warnings: string[];
};

type StoreLike = { dispatchAction?: (a: { type: string; payload?: unknown; t?: number }) => void };

/**
 * Horloge musicale calée sur l'AudioContext (ordonnancement anticipé).
 * Joue `pattern` sur des instruments désignés par leur id, et/ou envoie
 * l'action `step` à un `sonic-store` pour la musique calculée par un reducer.
 */
@customElement(tagName)
export class SonicSequencer extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** Motifs : { "<id instrument>": "c4 e4" | { notes, scale, octave, vel, gate, transpose, "<pad>": "x..x" } }. */
  @property({ type: Object })
  pattern: unknown = null;

  @property({ type: Number })
  bpm = 120;

  /** 0..0.5 : retarde les pas impairs. */
  @property({ type: Number })
  swing = 0;

  /** Graine des probabilités (même graine = même musique). */
  @property({ type: Number })
  seed = 0;

  @property({ type: Number })
  beats = 4;

  @property({ type: Number, attribute: "steps-per-beat" })
  stepsPerBeat = 4;

  /** Démarre dès que le son est actif. */
  @property({ type: Boolean })
  playing = false;

  /** DataProvider de pilotage : { playing, bpm, swing, seed, pattern }. */
  @property({ type: String })
  control = "";

  /** Id d'un `sonic-store` qui reçoit `step` à chaque pas (en avance de `lookahead-ms`). */
  @property({ type: String })
  store = "";

  @property({ type: Number, attribute: "lookahead-ms" })
  lookaheadMs = 100;

  /** DataProvider de l'état (défaut : `<id>State`). */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private core = new SequencerCore([], { bpm: 120, swing: 0, seed: 0, beats: 4, stepsPerBeat: 4 });
  private patternErrors: string[] = [];
  private warnings = new Set<string>();
  private running = false;
  private scheduledUntil = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubs: (() => void)[] = [];
  private unsubscribeEngine: (() => void) | null = null;
  private wantPlaying = false;
  private position: Pick<SequencerState, "step" | "beat" | "bar" | "phase"> = { step: 0, beat: 0, bar: 0, phase: 0 };
  private controlPattern: unknown = undefined;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribeEngine = AudioEngine.get().onChange(() => this.sync());
  }

  disconnectedCallback(): void {
    this.stop();
    this.unsubscribeEngine?.();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("pattern")) this.setPattern(this.controlPattern ?? this.pattern);
    if (changed.has("bpm")) this.setBpm(this.bpm);
    if (changed.has("swing")) this.core.opts.swing = clamp(this.swing, 0, 0.5);
    if (changed.has("seed")) this.core.setSeed(Math.round(this.seed) >>> 0);
    if (changed.has("beats") || changed.has("stepsPerBeat")) {
      this.core.opts.beats = Math.max(1, Math.min(16, Math.round(this.beats)));
      this.core.opts.stepsPerBeat = Math.max(1, Math.min(12, Math.round(this.stepsPerBeat)));
    }
    if (changed.has("playing")) {
      this.wantPlaying = this.playing;
      this.sync();
    }
    if (changed.has("control")) this.listenControl();
    this.publish();
  }

  /* ---------------------------------------------------------------- */
  /* Pilotage                                                          */
  /* ---------------------------------------------------------------- */

  private listenControl(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (!this.control) return;
    this.unsubs.push(
      listenDp(this.control, (v) => {
        if (!v || typeof v !== "object") return;
        const c = v as { playing?: unknown; bpm?: unknown; swing?: unknown; seed?: unknown; pattern?: unknown };
        if (typeof c.bpm === "number") this.setBpm(c.bpm);
        if (typeof c.swing === "number") this.core.opts.swing = clamp(c.swing, 0, 0.5);
        if (typeof c.seed === "number") this.core.setSeed(Math.round(c.seed) >>> 0);
        if (c.pattern !== undefined && JSON.stringify(c.pattern) !== JSON.stringify(this.controlPattern)) {
          this.controlPattern = c.pattern;
          this.setPattern(c.pattern);
        }
        if (typeof c.playing === "boolean") {
          this.wantPlaying = c.playing;
          this.sync();
        }
        this.publish();
      }),
    );
  }

  private setPattern(p: unknown): void {
    const { tracks, errors } = compilePattern(p);
    this.patternErrors = errors;
    // Pris en compte pour tout ce qui n'est pas encore programmé (≤ lookahead).
    this.core.setTracks(tracks);
    this.publish();
  }

  private setBpm(bpm: number): void {
    const b = clamp(bpm, 20, 400);
    if (b === this.core.opts.bpm) return;
    const ac = AudioEngine.get().context;
    if (this.running && ac) {
      // re-ancrage à la limite déjà programmée : pas de trou ni de doublon
      this.core.setBpm(b, this.scheduledUntil);
    } else this.core.opts.bpm = b;
  }

  /** Démarre / arrête selon le souhait et l'état du moteur. */
  private sync(): void {
    const engine = AudioEngine.get();
    if (this.wantPlaying && engine.ready && engine.context && !this.running) this.start(engine.context);
    else if (!this.wantPlaying && this.running) this.stop();
    this.publish();
  }

  private start(ac: BaseAudioContext): void {
    this.running = true;
    const t0 = ac.currentTime + 0.06;
    this.core.start(t0);
    this.scheduledUntil = t0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.publish();
  }

  /* ---------------------------------------------------------------- */
  /* Horloge                                                           */
  /* ---------------------------------------------------------------- */

  private tick(): void {
    const ac = AudioEngine.get().context;
    if (!this.running || !ac) return;
    const horizon = ac.currentTime + clamp(this.lookaheadMs, 20, 1000) / 1000;
    if (horizon <= this.scheduledUntil) return;
    const from = Math.max(this.scheduledUntil, ac.currentTime - 0.01);
    const steps = this.core.steps(from, horizon);
    const events = this.core.window(from, horizon);
    this.scheduledUntil = horizon;

    // Mode store : le reducer reçoit chaque pas en avance, avec son instant audio.
    if (this.store) {
      const store = resolveAudioElement(this, `#${this.store}`) as (Element & StoreLike) | null;
      if (store && typeof store.dispatchAction === "function") {
        for (const s of steps) {
          store.dispatchAction({
            type: "step",
            payload: { step: s.step, beat: s.beat, bar: s.bar, phase: s.phase, when: s.when, bpm: this.core.opts.bpm },
          });
        }
      } else this.warn(`store "${this.store}" introuvable`);
    }

    // Mode direct : un appel schedule() groupé par instrument.
    const byTarget = new Map<string, SonicNoteEvent[]>();
    for (const { target, event } of events) {
      const list = byTarget.get(target) ?? [];
      list.push(event);
      byTarget.set(target, list);
    }
    for (const [target, list] of byTarget) {
      const el = resolveAudioElement(this, `#${target}`);
      if (isInstrument(el)) el.schedule(list);
      else this.warn(`instrument "${target}" introuvable (sonic-patch, sonic-sampler… avec cet id)`);
    }
    for (const msg of this.core.invalid) this.warn(msg);
    this.core.invalid.clear();

    // Position publiée quand le pas est réellement entendu.
    const latency = AudioEngine.get().getState().latencyS;
    for (const s of steps) this.publishAt(s, ac, latency);
  }

  private publishAt(s: StepTick, ac: BaseAudioContext, latency: number): void {
    const delay = Math.max(0, (s.when + latency - ac.currentTime) * 1000);
    setTimeout(() => {
      if (!this.running) return;
      this.position = { step: s.step, beat: s.beat, bar: s.bar, phase: s.phase };
      this.publish();
    }, delay);
  }

  private warn(msg: string): void {
    if (this.warnings.has(msg)) return;
    this.warnings.add(msg);
    console.warn(`[sonic-sequencer${this.id ? "#" + this.id : ""}] ${msg}`);
    this.publish();
  }

  /* ---------------------------------------------------------------- */
  /* État                                                              */
  /* ---------------------------------------------------------------- */

  getState(): SequencerState {
    const engine = AudioEngine.get();
    return {
      status: !engine.supported ? "unsupported" : this.running ? "playing" : engine.ready ? "ready" : "idle",
      playing: this.running,
      bpm: this.core.opts.bpm,
      swing: this.core.opts.swing,
      ...this.position,
      errors: [...this.patternErrors],
      warnings: [...this.warnings],
    };
  }

  private publishQueued = false;
  private publish(): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (!out || this.publishQueued) return;
    this.publishQueued = true;
    queueMicrotask(() => {
      this.publishQueued = false;
      set(out, this.getState());
    });
  }

  render() {
    return html``;
  }
}

function clamp(v: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

export default SonicSequencer;
