/**
 * Construction WebAudio d'un module compilé. Chaque builder renvoie ses
 * entrées / sortie, ses AudioParam modulables et ses réglages « composites ».
 * Les valeurs de base des AudioParam sont écrites par le runtime.
 */
import { MODULES, tempoToSeconds } from "./modules";
import type { CompiledModule } from "./compile";

export type Built = {
  /** Entrée audio (null pour une source ou un module de contrôle). */
  input: AudioNode | null;
  /** Entrée n° i (mixer : un gain par entrée). */
  inputAt?(i: number): AudioNode;
  output: AudioNode;
  /** AudioParam modulables, par nom de paramètre. */
  params: Record<string, AudioParam>;
  /** Réglages non portés par un AudioParam (mix, type, forme…), appliqués en direct si possible. */
  setters: Record<string, (value: number | string, time: number, rampS: number) => void>;
  /** Démarrage / arrêt des sources internes. */
  start(time: number): void;
  stop(time: number): void;
  /** Enveloppe / gate : déclenchement et relâchement. */
  trigger?(time: number): void;
  release?(time: number): number;
  nodes: AudioNode[];
};

export type BuildContext = {
  bpm: number;
};

/* ------------------------------------------------------------------ */
/* Ressources générées (une fois par contexte)                         */
/* ------------------------------------------------------------------ */

const noiseCache = new WeakMap<BaseAudioContext, Record<string, AudioBuffer>>();

export function noiseBuffer(ac: BaseAudioContext, color: string): AudioBuffer {
  let byColor = noiseCache.get(ac);
  if (!byColor) noiseCache.set(ac, (byColor = {}));
  if (byColor[color]) return byColor[color];
  const len = ac.sampleRate * 2;
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  let seed = 0x2545f491;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296) * 2 - 1;
  };
  if (color === "pink") {
    // Paul Kellet (version économique)
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = rnd();
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    }
  } else if (color === "brown") {
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * rnd()) / 1.02;
      d[i] = last * 3.5;
    }
  } else {
    for (let i = 0; i < len; i++) d[i] = rnd();
  }
  byColor[color] = buf;
  return buf;
}

const irCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();

function impulse(ac: BaseAudioContext, sizeS: number, damp: number): AudioBuffer {
  let cache = irCache.get(ac);
  if (!cache) irCache.set(ac, (cache = new Map()));
  const key = `${sizeS.toFixed(2)}:${damp.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const len = Math.max(1, Math.floor(ac.sampleRate * sizeS));
  const buf = ac.createBuffer(2, len, ac.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let seed = 0x9e3779b9 + c * 7919;
    let lp = 0;
    const coef = 0.05 + damp * 0.9; // filtre passe-bas qui s'assombrit avec le temps
    for (let i = 0; i < len; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const w = ((seed >>> 0) / 4294967296) * 2 - 1;
      const t = i / len;
      const k = Math.min(0.99, coef * t);
      lp = lp * k + w * (1 - k);
      d[i] = lp * Math.pow(1 - t, 3);
    }
  }
  cache.set(key, buf);
  return buf;
}

function shaperCurve(kind: string, drive: number) {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    let y: number;
    if (kind === "hard") y = Math.max(-1, Math.min(1, x * drive));
    else if (kind === "fold") y = Math.sin((x * drive * Math.PI) / 2);
    else if (kind === "bit") {
      const steps = Math.max(2, Math.round(32 / drive));
      y = Math.round(x * steps) / steps;
    } else y = Math.tanh(x * drive) / Math.tanh(drive);
    curve[i] = y;
  }
  return curve;
}

function periodicWave(ac: BaseAudioContext, mod: CompiledModule): PeriodicWave | null {
  const harmonics = mod.params.harmonics as number[];
  if (harmonics?.length) {
    const real = new Float32Array(harmonics.length + 1);
    const imag = new Float32Array(harmonics.length + 1);
    harmonics.forEach((h, i) => (imag[i + 1] = h));
    return ac.createPeriodicWave(real, imag);
  }
  if (mod.params.wave === "pulse") {
    const pw = Number(mod.params.pw);
    const N = 64;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    for (let k = 1; k < N; k++) {
      // série de Fourier d'une impulsion de rapport cyclique pw
      real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * pw);
    }
    return ac.createPeriodicWave(real, imag);
  }
  return null;
}

function seconds(value: number | string | number[], bpm: number, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return tempoToSeconds(value, bpm) ?? fallback;
  return fallback;
}

const ramp = (p: AudioParam, v: number, t: number, r: number) => {
  p.cancelScheduledValues(t);
  p.setValueAtTime(p.value, t);
  if (r > 0) p.linearRampToValueAtTime(v, t + r);
  else p.setValueAtTime(v, t);
};

/* ------------------------------------------------------------------ */

export function buildModule(ac: BaseAudioContext, mod: CompiledModule, ctx: BuildContext): Built {
  const p = mod.params;
  const nodes: AudioNode[] = [];
  const track = <T extends AudioNode>(n: T): T => {
    nodes.push(n);
    return n;
  };
  const sources: AudioScheduledSourceNode[] = [];
  const base = (): Pick<Built, "start" | "stop" | "nodes" | "setters"> => ({
    nodes,
    setters: {},
    start: (t) => sources.forEach((s) => s.start(t)),
    stop: (t) => sources.forEach((s) => s.stop(t)),
  });

  switch (mod.type) {
    case "sonic-osc": {
      const osc = track(ac.createOscillator());
      const wave = periodicWave(ac, mod);
      if (wave) osc.setPeriodicWave(wave);
      else osc.type = p.wave as OscillatorType;
      const level = track(ac.createGain());
      osc.connect(level);
      sources.push(osc);
      const b = base();
      b.setters.wave = (v) => {
        if (typeof v === "string" && v !== "pulse") osc.type = v as OscillatorType;
      };
      return { ...b, input: null, output: level, params: { "freq-hz": osc.frequency, detune: osc.detune, level: level.gain } };
    }
    case "sonic-noise": {
      const src = track(ac.createBufferSource());
      src.buffer = noiseBuffer(ac, String(p.color));
      src.loop = true;
      const level = track(ac.createGain());
      src.connect(level);
      sources.push(src);
      return { ...base(), input: null, output: level, params: { level: level.gain } };
    }
    case "sonic-mixer": {
      const sum = track(ac.createGain());
      const ins: GainNode[] = [];
      const levels = mod.levels;
      return {
        ...base(),
        input: sum,
        inputAt: (i) => {
          if (!ins[i]) {
            const g = track(ac.createGain());
            g.gain.value = levels[i] ?? 1;
            g.connect(sum);
            ins[i] = g;
          }
          return ins[i];
        },
        output: sum,
        params: {},
      };
    }
    case "sonic-filter": {
      const f = track(ac.createBiquadFilter());
      f.type = p.type as BiquadFilterType;
      const b = base();
      b.setters.type = (v) => (f.type = String(v) as BiquadFilterType);
      return { ...b, input: f, output: f, params: { "freq-hz": f.frequency, q: f.Q, "gain-db": f.gain, detune: f.detune } };
    }
    case "sonic-vca": {
      const g = track(ac.createGain());
      return { ...base(), input: g, output: g, params: { gain: g.gain } };
    }
    case "sonic-env": {
      const env = track(ac.createConstantSource());
      env.offset.value = 0;
      sources.push(env);
      const a = Number(p.a), d = Number(p.d), s = Number(p.s), r = Number(p.r);
      let t0 = 0;
      const levelAt = (t: number) => {
        if (t <= 0) return 0;
        if (a > 0 && t < a) return t / a;
        const td = t - a;
        if (d > 0 && td < d) return 1 + ((s - 1) * td) / d;
        return s;
      };
      return {
        ...base(),
        input: null,
        output: env,
        params: {},
        trigger: (t) => {
          t0 = t;
          const o = env.offset;
          o.setValueAtTime(0, t);
          if (a > 0) o.linearRampToValueAtTime(1, t + a);
          else o.setValueAtTime(1, t);
          if (d > 0) o.linearRampToValueAtTime(s, t + a + d);
          else o.setValueAtTime(s, t + a);
        },
        release: (t) => {
          const o = env.offset;
          o.cancelScheduledValues(t);
          o.setValueAtTime(levelAt(t - t0), t);
          o.linearRampToValueAtTime(0, t + Math.max(r, 0.003));
          return Math.max(r, 0.003);
        },
      };
    }
    case "sonic-lfo": {
      const osc = track(ac.createOscillator());
      osc.type = p.wave as OscillatorType;
      sources.push(osc);
      const synced = typeof p.sync === "string" && p.sync ? tempoToSeconds(p.sync, ctx.bpm) : null;
      if (synced) osc.frequency.value = 1 / synced;
      return { ...base(), input: null, output: osc, params: synced ? {} : { "rate-hz": osc.frequency } };
    }
    case "sonic-shaper": {
      const ws = track(ac.createWaveShaper());
      ws.curve = shaperCurve(String(p.curve), Number(p.drive));
      ws.oversample = p.oversample as OverSampleType;
      const b = base();
      b.setters.drive = (v) => (ws.curve = shaperCurve(String(p.curve), Number(v)));
      return { ...b, input: ws, output: ws, params: {} };
    }
    case "sonic-pan": {
      if (typeof (ac as AudioContext).createStereoPanner !== "function") {
        const g = track(ac.createGain());
        return { ...base(), input: g, output: g, params: {} };
      }
      const pan = track(ac.createStereoPanner());
      return { ...base(), input: pan, output: pan, params: { pan: pan.pan } };
    }
    case "sonic-delay": {
      const input = track(ac.createGain());
      const out = track(ac.createGain());
      const dry = track(ac.createGain());
      const wet = track(ac.createGain());
      const delay = track(ac.createDelay(4));
      const tone = track(ac.createBiquadFilter());
      const fb = track(ac.createGain());
      tone.type = "lowpass";
      tone.frequency.value = Number(p.tone);
      const mix = Number(p.mix);
      dry.gain.value = 1 - mix;
      wet.gain.value = mix;
      input.connect(dry).connect(out);
      input.connect(delay);
      delay.connect(wet).connect(out);
      delay.connect(tone).connect(fb).connect(delay);
      const b = base();
      b.setters.mix = (v, t, r) => {
        ramp(dry.gain, 1 - Number(v), t, r);
        ramp(wet.gain, Number(v), t, r);
      };
      b.setters.tone = (v, t, r) => ramp(tone.frequency, Number(v), t, r);
      return { ...b, input, output: out, params: { time: delay.delayTime, feedback: fb.gain } };
    }
    case "sonic-reverb": {
      const input = track(ac.createGain());
      const out = track(ac.createGain());
      const dry = track(ac.createGain());
      const wet = track(ac.createGain());
      const conv = track(ac.createConvolver());
      conv.buffer = impulse(ac, Number(p["size-s"]), Number(p.damp));
      const mix = Number(p.mix);
      dry.gain.value = 1 - mix * 0.5;
      wet.gain.value = mix;
      input.connect(dry).connect(out);
      input.connect(conv).connect(wet).connect(out);
      const b = base();
      b.setters.mix = (v, t, r) => {
        ramp(dry.gain, 1 - Number(v) * 0.5, t, r);
        ramp(wet.gain, Number(v), t, r);
      };
      return { ...b, input, output: out, params: {} };
    }
    case "sonic-chorus": {
      const input = track(ac.createGain());
      const out = track(ac.createGain());
      const dry = track(ac.createGain());
      const wet = track(ac.createGain());
      const delay = track(ac.createDelay(0.1));
      const lfo = track(ac.createOscillator());
      const depth = track(ac.createGain());
      delay.delayTime.value = Number(p.delay) / 1000;
      depth.gain.value = Number(p.depth) / 1000;
      const mix = Number(p.mix);
      dry.gain.value = 1 - mix * 0.5;
      wet.gain.value = mix;
      lfo.connect(depth).connect(delay.delayTime);
      input.connect(dry).connect(out);
      input.connect(delay).connect(wet).connect(out);
      sources.push(lfo);
      const b = base();
      b.setters.mix = (v, t, r) => {
        ramp(dry.gain, 1 - Number(v) * 0.5, t, r);
        ramp(wet.gain, Number(v), t, r);
      };
      b.setters.depth = (v, t, r) => ramp(depth.gain, Number(v) / 1000, t, r);
      return { ...b, input, output: out, params: { "rate-hz": lfo.frequency } };
    }
    case "sonic-comp": {
      const c = track(ac.createDynamicsCompressor());
      return {
        ...base(),
        input: c,
        output: c,
        params: { "threshold-db": c.threshold, ratio: c.ratio, knee: c.knee, attack: c.attack, release: c.release },
      };
    }
  }
  throw new Error(`module ${mod.type} sans builder`);
}

/** Valeur de base d'un AudioParam à partir des paramètres compilés. */
export function baseValue(mod: CompiledModule, param: string, ctx: BuildContext & { freq: number }): number {
  const v = mod.params[param];
  if (mod.type === "sonic-osc" && param === "freq-hz") {
    const hz = v === "voice.pitch" ? ctx.freq : Number(v);
    const semis = Number(mod.params.octave) * 12 + Number(mod.params.semi);
    return Math.min(20000, hz * Math.pow(2, semis / 12));
  }
  if (mod.type === "sonic-delay" && param === "time") return seconds(v, ctx.bpm, 0.25);
  if (typeof v === "number") return v;
  const spec = MODULES[mod.type].params[param];
  return typeof spec?.default === "number" ? spec.default : 0;
}
