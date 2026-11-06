import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { isAudioSink, type SonicAudioSource } from "../../shared/audio/contracts";
import { listenDp } from "../../shared/audio/dp";
import { AudioEngine, AudioRoute, resolveAudioElement } from "../../shared/audio/engine";
import { SampleBank } from "../../shared/audio/samples";
import { bool, num } from "../../shared/media/control";
import { RateMapper, scrubRate, type RateMode } from "./mapping";
import { TapeVoice } from "./voice";

const tagName = "sonic-tape";

export type TapeStatus = "idle" | "loading" | "ready" | "error";

export type TapeState = {
  status: TapeStatus;
  error: string | null;
  duration: number;
  /** Position de la tête de lecture, 0..1. */
  position: number;
  /** Vitesse signée courante (1 = normal, −1 = à l'envers). */
  rate: number;
  playing: boolean;
  reversed: boolean;
};

/**
 * Lecture « bande magnétique / platine » d'un son : vitesse **signée** et continue, pilotée
 * en temps réel par DataProvider — `control.rate`, un capteur (`rate-from="orientation.rg"`
 * avec `rate-mode="omega"` pour la rotation, `"accel"` pour une secousse), ou la position
 * visée (`control.position` 0..1 : la bande rattrape la cible en avant ou en arrière).
 *
 * Le son vient de `src` : URL ou chemin DP d'un SonicMediaRef (prise d'un enregistreur,
 * fichier ouvert par `sonic-file-open`, …). Sortie : `output` = `master` (défaut), `none` ou `#id`.
 */
@customElement(tagName)
export class SonicTape extends LitElement implements SonicAudioSource {
  /** URL (https, blob:, data:audio, relative) ou chemin DP portant `{ url }`. */
  @property({ type: String })
  src = "";

  @property({ type: Boolean })
  loop = false;

  @property({ type: Number, attribute: "loop-start" })
  loopStart = 0;

  /** Fin de boucle (s) ; 0 = fin du son. */
  @property({ type: Number, attribute: "loop-end" })
  loopEnd = 0;

  @property({ type: Number })
  gain = 1;

  /** Multiplicateur appliqué à toute vitesse (hauteur / tempo global). */
  @property({ type: Number })
  pitch = 1;

  @property({ type: String })
  output = "master";

  /** Chemin DP (pointé) d'une valeur numérique qui pilote la vitesse (capteur, curseur…). */
  @property({ type: String, attribute: "rate-from" })
  rateFrom = "";

  /** `rate` : valeur × échelle ; `omega` : °/s (platine, 33⅓ tr/min = 1×) ; `accel` : accélération → secousse. */
  @property({ type: String, attribute: "rate-mode" })
  rateMode: RateMode = "rate";

  @property({ type: Number, attribute: "rate-scale" })
  rateScale = 1;

  @property({ type: Number, attribute: "rate-deadzone" })
  rateDeadzone = 0;

  @property({ type: Number, attribute: "rate-smooth" })
  rateSmooth = 40;

  /** DP de pilotage : `{ rate, position, play, hold }`. */
  @property({ type: String })
  control = "";

  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private voice: TapeVoice | null = null;
  private outGain: GainNode | null = null;
  private route: AudioRoute | null = null;
  private mapper = new RateMapper();
  private buffer: AudioBuffer | null = null;
  private target: number | null = null;
  private scrubTimer: ReturnType<typeof setInterval> | null = null;
  private pubTimer: ReturnType<typeof setInterval> | null = null;
  private lastPub = "";
  private unsubs: (() => void)[] = [];
  private unsubEngine: (() => void) | null = null;
  private unsubBank: (() => void) | null = null;
  private baseRate = 0;
  private state: TapeState = { status: "idle", error: null, duration: 0, position: 0, rate: 0, playing: false, reversed: false };

  getAudioOutput(): AudioNode | null {
    return this.outGain;
  }

  getState(): TapeState {
    const v = this.voice;
    const d = v?.duration ?? this.state.duration;
    return {
      ...this.state,
      position: v && d > 0 ? v.position() / d : 0,
      rate: v?.currentRate ?? 0,
      playing: !!v && Math.abs(v.currentRate) > 0,
      reversed: (v?.currentRate ?? 0) < 0,
    };
  }

  /** Vitesse signée imposée (1 = normal, −1 = à l'envers, 0 = arrêt). */
  setRate(rate: number): void {
    this.baseRate = Number.isFinite(rate) ? rate : 0;
    this.target = null;
    this.stopScrub();
    this.apply();
  }

  /** Vise une position (0..1) : la bande la rejoint en avant ou en arrière ; `null` relâche. */
  scrubTo(position: number | null): void {
    if (position === null) {
      this.target = null;
      this.stopScrub();
      this.apply();
      return;
    }
    this.target = Math.min(1, Math.max(0, position));
    this.startScrub();
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubEngine = AudioEngine.get().onChange(() => this.ensureOutput());
    this.pubTimer = setInterval(() => this.publish(), 66);
    this.ensureOutput();
  }

  disconnectedCallback(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.unsubEngine?.();
    this.unsubBank?.();
    this.unsubEngine = this.unsubBank = null;
    this.stopScrub();
    if (this.pubTimer) clearInterval(this.pubTimer);
    this.pubTimer = null;
    this.voice?.stop();
    this.voice = null;
    this.route?.to(null);
    this.route = null;
    this.outGain = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("src")) this.loadSource();
    if (changed.has("control") || changed.has("rateFrom") || changed.has("rateMode") || changed.has("rateScale") || changed.has("rateDeadzone") || changed.has("rateSmooth")) {
      this.listen();
    }
    if (this.voice) {
      this.voice.loop = this.loop;
      this.voice.loopStart = this.loopStart;
      this.voice.loopEnd = this.loopEnd;
    }
    if (changed.has("gain") && this.outGain) this.outGain.gain.value = Math.max(0, this.gain);
    if (changed.has("pitch") || changed.has("loop")) this.apply();
    if (changed.has("output")) this.reconnect();
  }

  render() {
    return null;
  }

  /* ---------------------------------------------------------------- */

  private loadSource(): void {
    this.unsubBank?.();
    this.unsubBank = null;
    this.voice?.stop();
    this.voice = null;
    this.buffer = null;
    const spec = this.src.trim();
    if (!spec) {
      this.patch({ status: "idle", error: null, duration: 0 });
      return;
    }
    const bank = SampleBank.get();
    this.patch({ status: "loading", error: null, duration: 0 });
    const check = () => {
      const err = bank.error(spec);
      if (err) return this.patch({ status: "error", error: err });
      const buf = bank.buffer(spec);
      if (buf && buf !== this.buffer) {
        this.buffer = buf;
        this.buildVoice();
      }
    };
    this.unsubBank = bank.onChange(check);
    bank.request(spec);
    check();
  }

  private ensureOutput(): void {
    const engine = AudioEngine.get();
    if (!engine.context || !engine.master) return;
    if (!this.outGain) {
      this.outGain = engine.context.createGain();
      this.outGain.gain.value = Math.max(0, this.gain);
    }
    this.reconnect();
    this.buildVoice();
  }

  private reconnect(): void {
    const engine = AudioEngine.get();
    if (!this.outGain || !engine.master) return;
    this.route ??= new AudioRoute(this.outGain);
    const out = (this.output || "master").trim();
    if (out === "none") this.route.to(null);
    else if (out === "master") this.route.to(engine.master);
    else {
      const el = resolveAudioElement(this, out);
      const input = isAudioSink(el) ? el.getAudioInput() : null;
      this.route.to(input ?? engine.master);
    }
  }

  private buildVoice(): void {
    const ac = AudioEngine.get().context;
    if (this.voice || !this.buffer || !ac || !this.outGain) return;
    this.voice = new TapeVoice(ac, this.buffer, this.outGain);
    this.voice.loop = this.loop;
    this.voice.loopStart = this.loopStart;
    this.voice.loopEnd = this.loopEnd;
    this.patch({ status: "ready", error: null, duration: this.buffer.duration });
    this.apply();
  }

  private apply(): void {
    if (this.target !== null) return;
    this.voice?.setRate(this.baseRate * (Number.isFinite(this.pitch) ? this.pitch : 1));
  }

  private listen(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.mapper = new RateMapper({
      mode: ["rate", "omega", "accel"].includes(this.rateMode) ? this.rateMode : "rate",
      scale: Number.isFinite(this.rateScale) ? this.rateScale : 1,
      deadzone: Math.max(0, this.rateDeadzone),
      smoothMs: Math.max(0, this.rateSmooth),
    });
    if (this.rateFrom) {
      this.unsubs.push(
        listenDp(this.rateFrom, (v) => {
          const n = typeof v === "number" ? v : Number((v as { value?: unknown } | null)?.value);
          if (!Number.isFinite(n)) return;
          this.setRate(this.mapper.feed(n, typeof performance !== "undefined" ? performance.now() : Date.now()));
        }),
      );
    }
    if (this.control) {
      this.unsubs.push(
        listenDp(this.control, (v) => {
          if (!v || typeof v !== "object") return;
          const c = v as Record<string, unknown>;
          if ("position" in c) {
            const p = c.position === null ? null : num(c.position, 0, 1);
            if (p !== undefined) this.scrubTo(p);
          } else if (this.target !== null && ("rate" in c || "play" in c)) {
            this.target = null;
            this.stopScrub();
          }
          const r = num(c.rate, -64, 64);
          if (r !== undefined) this.setRate(r);
          const p = bool(c.play);
          if (p !== undefined && r === undefined) this.setRate(p ? 1 : 0);
          if (bool(c.hold) === true) this.setRate(0);
        }),
      );
    }
  }

  private startScrub(): void {
    if (this.scrubTimer) return;
    this.scrubTimer = setInterval(() => this.tickScrub(), 16);
    this.tickScrub();
  }

  private stopScrub(): void {
    if (this.scrubTimer) clearInterval(this.scrubTimer);
    this.scrubTimer = null;
  }

  private tickScrub(): void {
    const v = this.voice;
    const buf = this.buffer;
    if (!v || !buf || this.target === null) return;
    const err = (this.target * v.duration - v.position()) * buf.sampleRate;
    v.setRate(scrubRate(err, buf.sampleRate) * (Number.isFinite(this.pitch) ? this.pitch : 1));
  }

  private patch(p: Partial<TapeState>): void {
    this.state = { ...this.state, ...p };
    this.lastPub = "";
    this.publish();
  }

  private publish(): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (!out) return;
    const s = this.getState();
    const sig = `${s.status}|${s.error}|${s.duration}|${s.position.toFixed(3)}|${s.rate.toFixed(3)}`;
    if (sig === this.lastPub) return;
    this.lastPub = sig;
    set(out, s);
  }
}

export default SonicTape;
