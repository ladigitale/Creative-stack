/**
 * Synthèse d'une voix WebAudio à partir d'une ResolvedSynth.
 * Fonctionne aussi sur un OfflineAudioContext (rendu de test / export).
 */
import type { ResolvedSynth } from "./types";

export type PlayOptions = {
  /** Instant de départ (temps du contexte audio). */
  time: number;
  /** Fréquence imposée par une note (sinon `def.freq`). */
  freq?: number | null;
  /** Durée tenue imposée (sinon `def.dur`). */
  hold?: number | null;
  /** Multiplicateur de volume (accent, volume du déclenchement). */
  gain?: number;
  /** Transposition supplémentaire en demi-tons. */
  pitch?: number;
  /** Aléatoire injectable (tests). */
  random?: () => number;
  /** Appelé au lancement / à la fin de chaque voix (comptage de polyphonie). */
  onStarted?: () => void;
  onEnded?: () => void;
};

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

export function noiseBuffer(ac: BaseAudioContext): AudioBuffer {
  let buf = noiseCache.get(ac);
  if (!buf) {
    buf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const data = buf.getChannelData(0);
    // PRNG déterministe : même bruit d'une session à l'autre.
    let seed = 0x9e3779b9;
    for (let i = 0; i < data.length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      data[i] = ((seed >>> 0) / 4294967296) * 2 - 1;
    }
    noiseCache.set(ac, buf);
  }
  return buf;
}

/** Niveau de l'enveloppe ADS à l'instant `t` après l'attaque (avant release). */
function adsLevel(def: ResolvedSynth, peak: number, t: number): number {
  if (t <= 0) return 0;
  if (def.attack > 0 && t < def.attack) return (peak * t) / def.attack;
  const td = t - def.attack;
  const sus = peak * def.sustain;
  if (def.decay > 0 && td < def.decay) return peak + ((sus - peak) * td) / def.decay;
  return sus;
}

/** Durée totale d'une voix (répétitions incluses, hors couches). */
export function voiceLength(def: ResolvedSynth, hold?: number | null): number {
  const h = hold ?? def.dur;
  const one = Math.max(h, 0.001) + Math.max(def.release, 0.005);
  return one + (def.repeat - 1) * (h + def.repeatGap);
}

/**
 * Joue une définition (avec répétitions et couches) vers `dest`.
 * Retourne l'instant de fin (temps du contexte).
 */
export function playSynth(
  ac: BaseAudioContext,
  dest: AudioNode,
  def: ResolvedSynth,
  opts: PlayOptions,
): number {
  const random = opts.random ?? Math.random;
  const hold = opts.hold ?? def.dur;
  let end = opts.time;
  for (let r = 0; r < def.repeat; r++) {
    const t0 = opts.time + r * (hold + def.repeatGap);
    end = Math.max(end, playVoice(ac, dest, def, { ...opts, time: t0, hold }, random));
  }
  for (const layer of def.layers) {
    end = Math.max(
      end,
      playSynth(ac, dest, layer, {
        ...opts,
        // Une couche suit la note jouée ; sans note elle garde sa propre fréquence.
        freq: opts.freq ?? null,
        hold: opts.hold ?? null,
      }),
    );
  }
  return end;
}

function playVoice(
  ac: BaseAudioContext,
  dest: AudioNode,
  def: ResolvedSynth,
  opts: PlayOptions & { hold: number },
  random: () => number,
): number {
  const t0 = Math.max(opts.time, ac.currentTime);
  const hold = Math.max(opts.hold, 0.001);
  const release = Math.max(def.release, 0.005);
  const noteOff = t0 + hold;
  const end = noteOff + release;
  const peak = Math.min(1.5, def.vol * (opts.gain ?? 1));

  const jitter = def.jitter ? (random() * 2 - 1) * def.jitter : 0;
  const semis = def.transpose + (opts.pitch ?? 0) + jitter;
  const f0 = Math.min(20000, (opts.freq ?? def.freq) * Math.pow(2, semis / 12));

  const nodes: AudioNode[] = [];
  let source: AudioScheduledSourceNode;
  let pitchParam: AudioParam | null = null;
  let detuneParam: AudioParam;

  if (def.wave === "noise") {
    const src = ac.createBufferSource();
    src.buffer = noiseBuffer(ac);
    src.loop = true;
    // Le bruit se transpose via la vitesse de lecture.
    src.playbackRate.setValueAtTime(Math.pow(2, semis / 12), t0);
    detuneParam = src.detune;
    source = src;
  } else {
    const osc = ac.createOscillator();
    osc.type = def.wave;
    osc.frequency.setValueAtTime(f0, t0);
    pitchParam = osc.frequency;
    detuneParam = osc.detune;
    source = osc;
    if (def.arp) {
      const steps = Math.ceil((end - t0) / def.arpRate);
      for (let k = 0; k < Math.min(steps, 512); k++) {
        const semi = def.arp[k % def.arp.length];
        osc.frequency.setValueAtTime(f0 * Math.pow(2, semi / 12), t0 + k * def.arpRate);
      }
    }
  }
  nodes.push(source);

  if (def.slide) {
    const slideEnd = t0 + (def.slideTime ?? hold);
    detuneParam.setValueAtTime(0, t0);
    detuneParam.linearRampToValueAtTime(def.slide * 100, slideEnd);
  }

  let vibrato: OscillatorNode | null = null;
  if (def.vibrato && pitchParam && def.vibrato.depth > 0) {
    vibrato = ac.createOscillator();
    vibrato.frequency.setValueAtTime(def.vibrato.rate, t0);
    const depth = ac.createGain();
    depth.gain.setValueAtTime(def.vibrato.depth, t0);
    vibrato.connect(depth).connect(pitchParam);
    nodes.push(vibrato, depth);
  }

  let tail: AudioNode = source;
  if (def.filter) {
    const f = ac.createBiquadFilter();
    f.type = def.filter.type;
    f.frequency.setValueAtTime(def.filter.freq, t0);
    f.Q.setValueAtTime(def.filter.q, t0);
    if (def.filter.to !== null) f.frequency.exponentialRampToValueAtTime(def.filter.to, end);
    tail.connect(f);
    tail = f;
    nodes.push(f);
  }

  const env = ac.createGain();
  const g = env.gain;
  g.setValueAtTime(0, t0);
  const attackEnd = t0 + Math.max(def.attack, 0.001);
  if (attackEnd < noteOff) {
    g.linearRampToValueAtTime(peak, attackEnd);
    const decayEnd = attackEnd + def.decay;
    if (def.decay > 0 && decayEnd < noteOff) {
      g.linearRampToValueAtTime(peak * def.sustain, decayEnd);
      g.setValueAtTime(peak * def.sustain, noteOff);
    } else {
      g.linearRampToValueAtTime(adsLevel(def, peak, hold), noteOff);
    }
  } else {
    g.linearRampToValueAtTime(adsLevel(def, peak, hold), noteOff);
  }
  g.linearRampToValueAtTime(0, end);
  tail.connect(env);
  nodes.push(env);
  tail = env;

  if (def.pan && typeof (ac as AudioContext).createStereoPanner === "function") {
    const p = ac.createStereoPanner();
    p.pan.setValueAtTime(def.pan, t0);
    tail.connect(p);
    tail = p;
    nodes.push(p);
  }
  tail.connect(dest);

  const stopAt = end + 0.02;
  if (def.wave === "noise") (source as AudioBufferSourceNode).start(t0, random() * 0.9);
  else source.start(t0);
  source.stop(stopAt);
  opts.onStarted?.();
  vibrato?.start(t0);
  vibrato?.stop(stopAt);
  source.onended = () => {
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        /* déjà déconnecté */
      }
    }
    opts.onEnded?.();
  };
  return end;
}
