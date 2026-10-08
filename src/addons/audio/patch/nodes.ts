/**
 * Construction WebAudio d'un module compilé. Chaque builder renvoie ses
 * entrées / sortie, ses AudioParam modulables et ses réglages « composites ».
 * Les valeurs de base des AudioParam sont écrites par le runtime.
 */
import { MODULES, tempoToSeconds } from "./modules";
import type { CompiledModule } from "./compile";
import { SampleBank } from "../../../shared/audio/samples";

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
  /** Synchro dure : fréquence de l'oscillateur maître. */
  setSync?(hz: number, time: number): void;
  nodes: AudioNode[];
};

export type BuildContext = {
  bpm: number;
  /** Processeurs AudioWorklet chargés dans ce contexte (sinon : repli natif). */
  worklet?: boolean;
  /** Fréquence de la note (voix) : hauteur relative des grains. */
  freq?: number;
};

/** Modules dont la version native (sans AudioWorklet) perd quelque chose : message pour l'état du patch. */
export function fallbackWarning(mod: CompiledModule): string | null {
  if (mod.type === "sonic-osc" && mod.params.sync) return `${mod.name} : synchro dure indisponible sans AudioWorklet (oscillateur simple)`;
  if (mod.type === "sonic-ladder") return `${mod.name} : ladder remplacé par deux filtres natifs (sans AudioWorklet)`;
  if (mod.type === "sonic-fold") return `${mod.name} : fold natif, amount et bias non modulables (sans AudioWorklet)`;
  if (mod.type === "sonic-karplus") return `${mod.name} : corde approchée par un filtre résonant (sans AudioWorklet)`;
  return null;
}

function workletNode(ac: BaseAudioContext, name: string, opts: AudioWorkletNodeOptions): AudioWorkletNode {
  return new AudioWorkletNode(ac, name, { outputChannelCount: [1], ...opts });
}

/** Arrête le processeur après `t` (sinon il resterait actif après déconnexion). */
function stopWorklet(ac: BaseAudioContext, node: AudioWorkletNode, t: number): void {
  const delay = Math.max(0, (t - ac.currentTime) * 1000) + 50;
  setTimeout(() => {
    try {
      node.port.postMessage("stop");
    } catch {
      /* déjà fermé */
    }
  }, delay);
}

/** Nuage de grains (natif : AudioBufferSource programmés en avance). */
class GrainCloud {
  readonly out: GainNode;
  position = 0.5;
  spread = 0.05;
  size = 0.08;
  density = 24;
  pitch = 0;
  jitter = 0;
  private nextT = 0;
  private stopAt = Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seed = 0x2f6b9a31;

  constructor(
    private ac: BaseAudioContext,
    private spec: string,
    private ratio: number,
  ) {
    this.out = ac.createGain();
    SampleBank.get().request(spec);
  }

  private rnd(): number {
    let s = this.seed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.seed = s;
    return (s >>> 0) / 4294967296;
  }

  start(t: number): void {
    this.nextT = t;
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
  }

  stop(t: number): void {
    this.stopAt = t;
  }

  private tick(): void {
    const ac = this.ac;
    const horizon = ac.currentTime + 0.12;
    if (this.nextT >= this.stopAt || ac.currentTime > this.stopAt) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    const buf = SampleBank.get().buffer(this.spec);
    let n = 0;
    while (this.nextT < horizon && this.nextT < this.stopAt && n++ < 64) {
      const t = Math.max(this.nextT, ac.currentTime);
      if (buf) this.grain(buf, t);
      const period = 1 / Math.max(0.5, this.density);
      this.nextT += period * (0.85 + this.rnd() * 0.3);
    }
  }

  private grain(buf: AudioBuffer, t: number): void {
    const ac = this.ac;
    const size = Math.max(0.005, this.size);
    const rate = this.ratio * Math.pow(2, (this.pitch + this.jitter * (this.rnd() * 2 - 1)) / 12);
    const span = size * rate;
    const pos = Math.min(1, Math.max(0, this.position + this.spread * (this.rnd() * 2 - 1)));
    const offset = Math.max(0, Math.min(buf.duration - span, pos * buf.duration - span / 2));
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ac.createGain();
    const peak = 1 / Math.sqrt(Math.max(1, this.density * size));
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + size * 0.4);
    g.gain.setValueAtTime(peak, t + size * 0.6);
    g.gain.linearRampToValueAtTime(0, t + size);
    src.connect(g).connect(this.out);
    src.start(t, offset, span);
    src.stop(t + size + 0.01);
    src.onended = () => {
      try {
        g.disconnect();
      } catch {
        /* ok */
      }
    };
  }
}

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
      if (p.sync && ctx.worklet) {
        const node = track(workletNode(ac, "cs-osc", { numberOfInputs: 0, numberOfOutputs: 1, processorOptions: { wave: p.wave } }));
        const pm = node.parameters as unknown as Map<string, AudioParam>;
        pm.get("pw")!.value = Number(p.pw) || 0.5;
        const level = track(ac.createGain());
        node.connect(level);
        const b = base();
        b.setters.wave = (v) => node.port.postMessage({ wave: String(v) });
        return {
          ...b,
          start: () => undefined,
          stop: (t) => stopWorklet(ac, node, t),
          setSync: (hz, t) => pm.get("syncHz")!.setValueAtTime(hz, t),
          input: null,
          output: level,
          params: { "freq-hz": pm.get("frequency")!, detune: pm.get("detune")!, level: level.gain },
        };
      }
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
    case "sonic-audio-input": {
      // Le runtime branche la source externe sur `input` ; `output` = niveau.
      const level = track(ac.createGain());
      return { ...base(), input: level, output: level, params: { level: level.gain } };
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
    case "sonic-ladder": {
      if (ctx.worklet) {
        const node = track(workletNode(ac, "cs-ladder", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" }));
        const pm = node.parameters as unknown as Map<string, AudioParam>;
        return {
          ...base(),
          stop: (t) => stopWorklet(ac, node, t),
          input: node,
          output: node,
          params: { "freq-hz": pm.get("frequency")!, res: pm.get("resonance")!, drive: pm.get("drive")!, detune: pm.get("detune")! },
        };
      }
      // repli : deux passe-bas en série, fréquence et résonance partagées
      const drive = track(ac.createGain());
      const f1 = track(ac.createBiquadFilter());
      const f2 = track(ac.createBiquadFilter());
      const freq = track(ac.createConstantSource());
      const det = track(ac.createConstantSource());
      const res = track(ac.createConstantSource());
      const resQ = track(ac.createGain());
      for (const f of [f1, f2]) {
        f.type = "lowpass";
        f.frequency.value = 0;
        f.detune.value = 0;
        freq.connect(f.frequency);
        det.connect(f.detune);
      }
      f1.Q.value = 0.5;
      f2.Q.value = 0.7;
      resQ.gain.value = 14;
      res.connect(resQ).connect(f2.Q);
      det.offset.value = 0;
      drive.connect(f1).connect(f2);
      sources.push(freq, det, res);
      return { ...base(), input: drive, output: f2, params: { "freq-hz": freq.offset, res: res.offset, drive: drive.gain, detune: det.offset } };
    }
    case "sonic-fold": {
      if (ctx.worklet) {
        const node = track(workletNode(ac, "cs-fold", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" }));
        const pm = node.parameters as unknown as Map<string, AudioParam>;
        pm.get("mix")!.value = Number(p.mix);
        const b = base();
        b.setters.mix = (v, t) => pm.get("mix")!.setValueAtTime(Number(v), t);
        return { ...b, stop: (t) => stopWorklet(ac, node, t), input: node, output: node, params: { amount: pm.get("amount")!, bias: pm.get("bias")! } };
      }
      const ws = track(ac.createWaveShaper());
      ws.curve = shaperCurve("fold", Math.max(0.01, Number(p.amount)));
      ws.oversample = "4x";
      const b = base();
      b.setters.amount = (v) => (ws.curve = shaperCurve("fold", Math.max(0.01, Number(v))));
      return { ...b, input: ws, output: ws, params: {} };
    }
    case "sonic-karplus": {
      const level = track(ac.createGain());
      const decay = Number(p.decay);
      if (ctx.worklet) {
        const node = track(workletNode(ac, "cs-karplus", { numberOfInputs: 1, numberOfOutputs: 1 }));
        const pm = node.parameters as unknown as Map<string, AudioParam>;
        pm.get("decay")!.value = decay;
        pm.get("damp")!.value = Number(p.damp);
        node.connect(level);
        const b = base();
        b.setters.decay = (v, t) => pm.get("decay")!.setValueAtTime(Number(v), t);
        b.setters.damp = (v, t) => pm.get("damp")!.setValueAtTime(Number(v), t);
        return {
          ...b,
          stop: (t) => stopWorklet(ac, node, t),
          trigger: (t) => {
            const g = pm.get("gate")!;
            g.setValueAtTime(0, Math.max(0, t - 0.001));
            g.setValueAtTime(1, t);
          },
          release: (t) => {
            pm.get("gate")!.setValueAtTime(0, t);
            return Math.min(decay, 6);
          },
          input: null,
          output: level,
          params: { "freq-hz": pm.get("frequency")!, detune: pm.get("detune")!, level: level.gain },
        };
      }
      // repli : rafale de bruit dans un passe-bande très résonant
      const burst = track(ac.createBufferSource());
      burst.buffer = noiseBuffer(ac, "white");
      const env = track(ac.createGain());
      const bp = track(ac.createBiquadFilter());
      bp.type = "bandpass";
      env.gain.value = 0;
      burst.connect(env).connect(bp).connect(level);
      sources.push(burst);
      const b = base();
      return {
        ...b,
        trigger: (t) => {
          const hz = p["freq-hz"] === "voice.pitch" ? (ctx.freq ?? 261.63) : Number(p["freq-hz"]);
          const q = Math.min(1000, (Math.PI * Math.max(20, hz) * decay) / 6.9);
          bp.Q.value = q;
          env.gain.setValueAtTime(Math.sqrt(q) * 0.6, t);
          env.gain.setTargetAtTime(0, t + 0.005, 0.004 + Number(p.damp) * 0.01);
        },
        release: () => Math.min(decay, 6),
        input: null,
        output: level,
        params: { "freq-hz": bp.frequency, detune: bp.detune, level: level.gain },
      };
    }
    case "sonic-resonator": {
      const input = track(ac.createGain());
      const sum = track(ac.createGain());
      const freq = track(ac.createConstantSource());
      const det = track(ac.createConstantSource());
      sources.push(freq, det);
      const ratios = (p.partials as number[])?.length ? (p.partials as number[]).slice(0, 16) : [1, 2, 3, 4, 5, 6];
      const filters: BiquadFilterNode[] = [];
      ratios.forEach((r, i) => {
        const f = track(ac.createBiquadFilter());
        f.type = "bandpass";
        f.frequency.value = 0;
        f.Q.value = Number(p.q);
        const scale = track(ac.createGain());
        scale.gain.value = r;
        freq.connect(scale).connect(f.frequency);
        det.connect(f.detune);
        const g = track(ac.createGain());
        g.gain.value = 1 / Math.sqrt(i + 1);
        input.connect(f).connect(g).connect(sum);
        filters.push(f);
      });
      const level = track(ac.createGain());
      const makeup = track(ac.createGain());
      makeup.gain.value = Math.sqrt(Number(p.q)) * 0.5;
      sum.connect(makeup).connect(level);
      const b = base();
      b.setters.q = (v, t) => {
        for (const f of filters) f.Q.setValueAtTime(Number(v), t);
        makeup.gain.setValueAtTime(Math.sqrt(Number(v)) * 0.5, t);
      };
      return { ...b, input, output: level, params: { "freq-hz": freq.offset, detune: det.offset, level: level.gain } };
    }
    case "sonic-grain": {
      const ratio = (ctx.freq ?? 261.63) / 261.63;
      const cloud = new GrainCloud(ac, String(p.sample), ratio);
      cloud.position = Number(p.position);
      cloud.spread = Number(p.spread);
      cloud.size = Number(p["size-s"]);
      cloud.density = Number(p.density);
      cloud.pitch = Number(p.pitch);
      cloud.jitter = Number(p.jitter);
      track(cloud.out);
      const b = base();
      const field = { position: "position", spread: "spread", "size-s": "size", density: "density", pitch: "pitch", jitter: "jitter" } as const;
      for (const [param, key] of Object.entries(field)) {
        b.setters[param] = (v) => {
          const n = Number(v);
          if (Number.isFinite(n)) cloud[key] = n;
        };
      }
      return { ...b, start: (t) => cloud.start(t), stop: (t) => cloud.stop(t), input: null, output: cloud.out, params: { level: cloud.out.gain } };
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
  if (param === "freq-hz" && v === "voice.pitch") return ctx.freq;
  if (typeof v === "number") return v;
  const spec = MODULES[mod.type].params[param];
  return typeof spec?.default === "number" ? spec.default : 0;
}
