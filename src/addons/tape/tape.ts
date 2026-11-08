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

/** Réglages effectifs (attributs, puis `control` : le dernier l'emporte). */
export type TapeSettings = {
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  gain: number;
  pitch: number;
  rateMode: RateMode;
  rateScale: number;
  rateDeadzone: number;
  rateSmooth: number;
};

const RATE_MODES: RateMode[] = ["rate", "omega", "accel"];

/** Lit les réglages du DP `control` (clés absentes ou invalides ignorées), valeurs bornées. */
export function readTapeSettings(v: unknown): Partial<TapeSettings> {
  const c = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const o: Partial<TapeSettings> = {};
  const loop = bool(c.loop); if (loop !== undefined) o.loop = loop;
  const ls = num(c.loopStart, 0, 86400); if (ls !== undefined) o.loopStart = ls;
  const le = num(c.loopEnd, 0, 86400); if (le !== undefined) o.loopEnd = le;
  const gain = num(c.gain, 0, 4); if (gain !== undefined) o.gain = gain;
  const pitch = num(c.pitch, -16, 16); if (pitch !== undefined) o.pitch = pitch;
  if (typeof c.rateMode === "string" && RATE_MODES.includes(c.rateMode as RateMode)) o.rateMode = c.rateMode as RateMode;
  const scale = num(c.rateScale, -10000, 10000); if (scale !== undefined) o.rateScale = scale;
  const dz = num(c.rateDeadzone, 0, 10000); if (dz !== undefined) o.rateDeadzone = dz;
  const sm = num(c.rateSmooth, 0, 10000); if (sm !== undefined) o.rateSmooth = sm;
  return o;
}

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
  settings: TapeSettings;
};

/**
 * Lecture « bande magnétique / platine » d'un son : vitesse **signée** et continue, pilotée
 * en temps réel par DataProvider — `control.rate`, un capteur (`rate-from="orientation.rg"`
 * avec `rate-mode="omega"` pour la rotation, `"accel"` pour une secousse), ou la position
 * visée (`control.position` 0..1 : la bande rattrape la cible en avant ou en arrière).
 *
 * Le son vient de `source` : URL ou chemin DP d'un SonicMediaRef (prise d'un enregistreur,
 * fichier ouvert par `sonic-file-open`, …). Sortie : `output` = `master` (défaut), `none` ou `#id`.
 */
@customElement(tagName)
export class SonicTape extends LitElement implements SonicAudioSource {
  /** URL (https, blob:, data:audio, relative) ou chemin DP portant `{ url }`. */
  @property({ type: String })
  source = "";

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

  /**
   * DP de pilotage : `{ rate, position, play, hold }` et réglages
   * `{ loop, loopStart, loopEnd, gain, pitch, rateMode, rateScale, rateDeadzone, rateSmooth }` (prioritaires sur les attributs).
   */
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
  private fromControl: Partial<TapeSettings> = {};
  private state: Omit<TapeState, "settings"> = { status: "idle", error: null, duration: 0, position: 0, rate: 0, playing: false, reversed: false };

  /** Réglages effectifs (attributs, puis `control`). */
  settings(): TapeSettings {
    const s = {
      loop: this.loop, loopStart: this.loopStart, loopEnd: this.loopEnd, gain: this.gain, pitch: this.pitch,
      rateMode: this.rateMode, rateScale: this.rateScale, rateDeadzone: this.rateDeadzone, rateSmooth: this.rateSmooth,
      ...this.fromControl,
    };
    return {
      loop: !!s.loop,
      loopStart: finite(s.loopStart, 0, 0),
      loopEnd: finite(s.loopEnd, 0, 0),
      gain: finite(s.gain, 0, 1),
      pitch: Number.isFinite(s.pitch) ? s.pitch : 1,
      rateMode: RATE_MODES.includes(s.rateMode) ? s.rateMode : "rate",
      rateScale: Number.isFinite(s.rateScale) ? s.rateScale : 1,
      rateDeadzone: finite(s.rateDeadzone, 0, 0),
      rateSmooth: finite(s.rateSmooth, 0, 40),
    };
  }

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
      settings: this.settings(),
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
    if (changed.has("source")) this.loadSource();
    if (changed.has("control") || changed.has("rateFrom")) this.listen();
    else if (changed.has("rateMode") || changed.has("rateScale") || changed.has("rateDeadzone") || changed.has("rateSmooth")) this.buildMapper();
    this.applyLoop();
    if (changed.has("gain")) this.applyGain();
    if (changed.has("pitch") || changed.has("loop")) this.apply();
    if (changed.has("output")) this.reconnect();
    if (["loop", "loopStart", "loopEnd", "gain", "pitch", "rateMode", "rateScale", "rateDeadzone", "rateSmooth"].some((k) => changed.has(k))) {
      this.lastPub = "";
      this.publish();
    }
  }

  private applyLoop(): void {
    if (!this.voice) return;
    const s = this.settings();
    this.voice.loop = s.loop;
    this.voice.loopStart = s.loopStart;
    this.voice.loopEnd = s.loopEnd;
  }

  private applyGain(): void {
    if (this.outGain) this.outGain.gain.value = this.settings().gain;
  }

  /** Applique les réglages lus dans `control` (seulement ce qui a changé). */
  private applySettings(next: Partial<TapeSettings>): void {
    const before = this.settings();
    this.fromControl = next;
    const after = this.settings();
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    if (before.rateMode !== after.rateMode || before.rateScale !== after.rateScale || before.rateDeadzone !== after.rateDeadzone || before.rateSmooth !== after.rateSmooth) {
      this.buildMapper();
    }
    this.applyLoop();
    if (before.gain !== after.gain) this.applyGain();
    if (before.pitch !== after.pitch || before.loop !== after.loop) {
      if (this.target !== null) this.tickScrub();
      else this.apply();
    }
    this.lastPub = "";
    this.publish();
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
    const spec = this.source.trim();
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
      this.outGain.gain.value = this.settings().gain;
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
    this.applyLoop();
    this.patch({ status: "ready", error: null, duration: this.buffer.duration });
    this.apply();
  }

  private apply(): void {
    if (this.target !== null) return;
    this.voice?.setRate(this.baseRate * this.settings().pitch);
  }

  private buildMapper(): void {
    const s = this.settings();
    this.mapper = new RateMapper({ mode: s.rateMode, scale: s.rateScale, deadzone: s.rateDeadzone, smoothMs: s.rateSmooth });
  }

  private listen(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (Object.keys(this.fromControl).length) this.applySettings({});
    this.buildMapper();
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
          this.applySettings(readTapeSettings(c));
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
    v.setRate(scrubRate(err, buf.sampleRate) * this.settings().pitch);
  }

  private patch(p: Partial<Omit<TapeState, "settings">>): void {
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

const finite = (v: number, min: number, d: number) => (Number.isFinite(v) ? Math.max(min, v) : d);

export default SonicTape;
