import { RATE_EPS } from "./mapping";

/** Sous-ensemble du contexte audio utilisé (facilite les tests). */
type Ctx = Pick<BaseAudioContext, "createGain" | "createBufferSource" | "createBuffer" | "currentTime">;

const FADE_S = 0.008;

/** Copie inversée d'un buffer (lecture à l'envers). */
export function reverseBuffer(ctx: Pick<BaseAudioContext, "createBuffer">, buf: AudioBuffer): AudioBuffer {
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
  }
  return out;
}

/**
 * Lecture à vitesse signée d'un buffer : avant et arrière, vitesse continue, arrêt.
 *
 * Sans AudioWorklet : deux copies du son (normale et inversée), une `AudioBufferSourceNode`
 * à la fois dont `playbackRate` vaut |vitesse| ; au changement de sens, fondu croisé court
 * et reprise à la position équivalente dans l'autre copie. La position est suivie par un
 * modèle (ancre + vitesse), recalé à chaque changement.
 */
export class TapeVoice {
  private reversed: AudioBuffer | null = null;
  private src: AudioBufferSourceNode | null = null;
  private srcGain: GainNode | null = null;
  private dir = 1;
  private rate = 0;
  private anchorPos = 0;
  private anchorTime = 0;
  loop = false;
  loopStart = 0;
  loopEnd = 0;

  constructor(
    private readonly ctx: Ctx,
    private readonly buffer: AudioBuffer,
    private readonly out: AudioNode,
  ) {}

  get duration(): number {
    return this.buffer.duration;
  }

  get currentRate(): number {
    return this.rate;
  }

  get playing(): boolean {
    return this.src !== null;
  }

  /** Position en secondes dans le son d'origine. */
  position(): number {
    const raw = this.anchorPos + this.rate * (this.ctx.currentTime - this.anchorTime);
    return this.wrap(raw);
  }

  /** Place la tête de lecture sans changer la vitesse. */
  seek(seconds: number): void {
    const was = this.rate;
    this.stopSource(true);
    this.anchorPos = Math.min(this.buffer.duration, Math.max(0, seconds));
    this.anchorTime = this.ctx.currentTime;
    if (Math.abs(was) >= RATE_EPS) this.startSource(was);
  }

  /** Vitesse signée : > 0 avant, < 0 arrière, 0 arrêt. */
  setRate(rate: number): void {
    const r = Number.isFinite(rate) ? rate : 0;
    const now = this.ctx.currentTime;
    this.anchorPos = this.position();
    this.anchorTime = now;
    if (Math.abs(r) < RATE_EPS) {
      this.rate = 0;
      this.stopSource(true);
      return;
    }
    const dir = r > 0 ? 1 : -1;
    // Fin de lecture sans boucle : rien à rejouer dans ce sens.
    if (!this.loop && ((dir > 0 && this.anchorPos >= this.buffer.duration) || (dir < 0 && this.anchorPos <= 0))) {
      this.rate = 0;
      this.stopSource(true);
      return;
    }
    this.rate = r;
    if (this.src && dir === this.dir) {
      this.src.playbackRate.setTargetAtTime(Math.abs(r), now, 0.01);
      return;
    }
    this.stopSource(true);
    this.startSource(r);
  }

  stop(): void {
    this.rate = 0;
    this.stopSource(false);
  }

  private wrap(raw: number): number {
    const d = this.buffer.duration;
    if (this.loop) {
      const a = Math.max(0, Math.min(this.loopStart, d));
      const b = this.loopEnd > a ? Math.min(this.loopEnd, d) : d;
      const span = b - a;
      if (span > 0 && (raw >= b || raw < a)) return a + ((((raw - a) % span) + span) % span);
      return Math.min(b, Math.max(a, raw));
    }
    return Math.min(d, Math.max(0, raw));
  }

  private startSource(rate: number): void {
    const dir = rate > 0 ? 1 : -1;
    const d = this.buffer.duration;
    const pos = this.wrap(this.anchorPos);
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    let buf = this.buffer;
    let offset = pos;
    const a = this.loop ? Math.max(0, Math.min(this.loopStart, d)) : 0;
    const b = this.loop ? (this.loopEnd > a ? Math.min(this.loopEnd, d) : d) : d;
    if (dir < 0) {
      this.reversed ??= reverseBuffer(this.ctx, this.buffer);
      buf = this.reversed;
      offset = d - pos;
    }
    src.buffer = buf;
    src.loop = this.loop;
    if (this.loop) {
      src.loopStart = dir > 0 ? a : d - b;
      src.loopEnd = dir > 0 ? b : d - a;
    }
    src.playbackRate.value = Math.abs(rate);
    gain.gain.setValueAtTime(0, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(1, this.ctx.currentTime + FADE_S);
    src.connect(gain);
    gain.connect(this.out);
    src.onended = () => {
      if (this.src !== src) return;
      this.anchorPos = this.wrap(this.anchorPos + this.rate * (this.ctx.currentTime - this.anchorTime));
      this.anchorTime = this.ctx.currentTime;
      this.src = null;
      this.srcGain = null;
      this.rate = 0;
    };
    src.start(0, Math.min(Math.max(0, offset), buf.duration));
    this.src = src;
    this.srcGain = gain;
    this.dir = dir;
    this.rate = rate;
  }

  private stopSource(fade: boolean): void {
    const src = this.src;
    const gain = this.srcGain;
    this.src = null;
    this.srcGain = null;
    if (!src) return;
    const t = this.ctx.currentTime;
    const end = t + (fade ? FADE_S : 0);
    try {
      if (gain && fade) {
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(0, end);
      }
      src.onended = null;
      src.stop(end);
      src.addEventListener?.("ended", () => {
        try {
          src.disconnect();
          gain?.disconnect();
        } catch {
          /* déjà débranché */
        }
      });
    } catch {
      /* déjà arrêtée */
    }
  }
}
