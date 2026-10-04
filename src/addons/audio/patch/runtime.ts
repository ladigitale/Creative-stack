/**
 * Runtime d'un patch compilé : chaîne globale construite une fois,
 * un graphe WebAudio par note (voix), polyphonie et vol de voix.
 */
import { midiToFreq } from "../../../shared/audio/notes";
import { MODULES } from "./modules";
import { baseValue, buildModule, type Built } from "./nodes";
import type { CompiledModule, CompiledPatch } from "./compile";

export type RuntimeOptions = {
  bpm: number;
  poly: number;
  steal: "oldest" | "quietest" | "same-note";
  /** Part de la vélocité dans le volume de la voix (0 = ignorée, 1 = proportionnelle). */
  velSense: number;
  /** Volume de sortie du patch. */
  gain: number;
  random?: () => number;
  onVoices?: (count: number) => void;
};

type Voice = {
  midi: number | null;
  vel: number;
  start: number;
  releasedAt: number | null;
  end: number;
  built: Map<string, Built>;
  extra: AudioNode[];
  gate: ConstantSourceNode;
  out: GainNode;
  clock: ConstantSourceNode;
  disposed: boolean;
};

const MIN_RELEASE = 0.01;

export class PatchRuntime {
  readonly output: GainNode;
  private ac: BaseAudioContext;
  private patch: CompiledPatch;
  private opts: RuntimeOptions;
  private global = new Map<string, Built>();
  private voicesBus: GainNode;
  private voices: Voice[] = [];
  private overrides = new Map<string, number | string>();
  private random: () => number;
  private disposed = false;

  constructor(ac: BaseAudioContext, patch: CompiledPatch, opts: RuntimeOptions) {
    this.ac = ac;
    this.patch = patch;
    this.opts = opts;
    this.random = opts.random ?? Math.random;
    this.voicesBus = ac.createGain();
    this.output = ac.createGain();
    this.output.gain.value = opts.gain;
    this.buildGlobal();
  }

  get voiceCount(): number {
    return this.voices.filter((v) => !v.disposed).length;
  }

  /* ---------------------------------------------------------------- */
  /* Chaîne globale                                                    */
  /* ---------------------------------------------------------------- */

  private buildGlobal(): void {
    const t = this.ac.currentTime;
    for (const mod of this.patch.global) {
      const b = buildModule(this.ac, mod, { bpm: this.opts.bpm });
      this.writeBases(mod, b, t, 261.63);
      this.global.set(mod.name, b);
    }
    for (const mod of this.patch.global) this.wireInputs(mod, this.global);
    const outNode = this.patch.out === "voices" ? this.voicesBus : this.global.get(this.patch.out)?.output;
    outNode?.connect(this.output);
    // Modulations globales → globales.
    for (const m of this.patch.mods) {
      const target = this.global.get(m.module);
      if (!target) continue;
      const src = this.global.get(m.from);
      const param = target.params[m.param];
      if (!src || !param) continue;
      const g = this.ac.createGain();
      g.gain.value = m.amount;
      src.output.connect(g).connect(param);
      target.nodes.push(g);
    }
    for (const b of this.global.values()) {
      b.start(t);
      b.trigger?.(t);
    }
  }

  private wireInputs(mod: CompiledModule, built: Map<string, Built>): void {
    const target = built.get(mod.name)!;
    mod.inputs.forEach((name, i) => {
      const dest = target.inputAt ? target.inputAt(i) : target.input;
      if (!dest) return;
      const src = name === "voices" ? this.voicesBus : built.get(name)?.output;
      if (src) src.connect(dest);
    });
  }

  private writeBases(mod: CompiledModule, b: Built, t: number, freq: number, staticMods: Record<string, number> = {}): void {
    for (const [param, ap] of Object.entries(b.params)) {
      const key = `${mod.name}.${param}`;
      const override = this.overrides.get(key);
      const v =
        typeof override === "number"
          ? override
          : baseValue(mod, param, { bpm: this.opts.bpm, freq });
      ap.setValueAtTime(v + (staticMods[param] ?? 0), t);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Voix                                                              */
  /* ---------------------------------------------------------------- */

  /** Démarre une note. `durS` null : tenue jusqu'à noteOff. */
  noteOn(midi: number | null, vel: number, when: number, durS: number | null, sample: string | null = null): boolean {
    if (this.disposed) return false;
    const desc =
      (sample !== null ? this.patch.voices.find((v) => v.sample === sample) : undefined) ??
      (midi !== null ? this.patch.voices.find((v) => v.note === midi) : undefined) ??
      this.patch.voices.find((v) => v.sample === null && v.note === null) ??
      (sample === null ? this.patch.voices[0] : undefined);
    if (!desc) return false;
    this.reap();
    const active = this.voices.filter((v) => v.releasedAt === null || v.end > when);
    if (active.length >= this.opts.poly) this.steal(midi, when);

    const ac = this.ac;
    const freq = midi === null ? 261.63 : midiToFreq(midi);
    const rand = this.random();
    const built = new Map<string, Built>();
    const extra: AudioNode[] = [];

    for (const mod of desc.modules) {
      built.set(mod.name, buildModule(ac, mod, { bpm: this.opts.bpm }));
    }
    // Modulations statiques (vélocité, note, aléa) ajoutées aux valeurs de base.
    const statics = new Map<string, Record<string, number>>();
    for (const m of this.patch.mods) {
      if (!built.has(m.module)) continue;
      const value = m.from === "voice.vel" ? vel : m.from === "voice.note" ? (midi ?? 60) : m.from === "voice.rand" ? rand : null;
      if (value === null) continue;
      const rec = statics.get(m.module) ?? {};
      rec[m.param] = (rec[m.param] ?? 0) + value * m.amount;
      statics.set(m.module, rec);
    }
    // Une voix réservée à une note garde sa hauteur propre (kit : le pad ne transpose pas).
    const pitch = desc.note !== null || desc.sample !== null ? 261.63 : freq;
    for (const mod of desc.modules) this.writeBases(mod, built.get(mod.name)!, when, pitch, statics.get(mod.name));
    for (const mod of desc.modules) this.wireInputs(mod, built);

    // Gate (0/1) disponible comme source de modulation.
    const gate = ac.createConstantSource();
    gate.offset.setValueAtTime(0, when);
    gate.offset.setValueAtTime(1, when);
    extra.push(gate);

    // Modulations dynamiques (enveloppes, LFO, audio, gate).
    for (const m of this.patch.mods) {
      const target = built.get(m.module);
      const param = target?.params[m.param];
      if (!target || !param) continue;
      let src: AudioNode | null = null;
      if (m.from === "voice.gate") src = gate;
      else if (m.from === "voice.pitch") {
        const c = ac.createConstantSource();
        c.offset.value = freq;
        extra.push(c);
        src = c;
      } else if (!m.from.startsWith("voice.")) src = built.get(m.from)?.output ?? this.global.get(m.from)?.output ?? null;
      if (!src) continue;
      const g = ac.createGain();
      g.gain.value = m.amount;
      src.connect(g).connect(param);
      extra.push(g);
    }

    // Sortie de voix : vélocité + anti-clic.
    const out = ac.createGain();
    const level = 1 - this.opts.velSense + this.opts.velSense * vel;
    out.gain.setValueAtTime(0, when);
    out.gain.linearRampToValueAtTime(level, when + 0.003);
    const voiceOut = desc.out ? built.get(desc.out)?.output : null;
    voiceOut?.connect(out);
    out.connect(this.voicesBus);
    extra.push(out);

    // Horloge de la voix : son `onended` libère tous les nœuds.
    const clock = ac.createConstantSource();
    clock.offset.value = 0;
    clock.connect(out.gain);
    extra.push(clock);

    for (const b of built.values()) {
      b.start(when);
      b.trigger?.(when);
    }
    gate.start(when);
    clock.start(when);

    const voice: Voice = { midi, vel, start: when, releasedAt: null, end: Infinity, built, extra, gate, out, clock, disposed: false };
    clock.onended = () => this.disposeVoice(voice);
    this.voices.push(voice);
    if (durS !== null) this.release(voice, when + Math.max(0.005, durS));
    this.opts.onVoices?.(this.voiceCount);
    return true;
  }

  noteOff(midi: number | null, when: number): void {
    for (const v of this.voices) {
      if (v.releasedAt === null && v.midi === midi) this.release(v, when);
    }
  }

  allNotesOff(when = this.ac.currentTime): void {
    for (const v of this.voices) if (v.releasedAt === null || v.end > when + 0.02) this.release(v, when, 0.01);
  }

  private release(v: Voice, when: number, fast?: number): void {
    if (v.disposed) return;
    const t = Math.max(when, v.start + 0.003);
    let tail = MIN_RELEASE;
    if (fast !== undefined) {
      tail = fast;
    } else {
      for (const b of v.built.values()) {
        const r = b.release?.(t);
        if (r !== undefined) tail = Math.max(tail, r);
      }
    }
    v.gate.offset.setValueAtTime(0, t);
    const g = v.out.gain;
    g.cancelScheduledValues(t);
    if (fast !== undefined) {
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + fast);
    } else {
      // l'enveloppe fait le relâchement ; on coupe proprement à la fin
      const level = 1 - this.opts.velSense + this.opts.velSense * v.vel;
      g.setValueAtTime(level, t + Math.max(0, tail - 0.005));
      g.linearRampToValueAtTime(0, t + tail);
    }
    v.releasedAt = t;
    v.end = t + tail;
    const stopAt = v.end + 0.02;
    for (const b of v.built.values()) b.stop(stopAt);
    v.gate.stop(stopAt);
    v.clock.stop(stopAt + 0.01);
  }

  private steal(midi: number | null, when: number): void {
    const candidates = this.voices.filter((v) => !v.disposed && (v.releasedAt === null || v.end > when));
    let victim: Voice | undefined;
    if (this.opts.steal === "same-note") victim = candidates.find((v) => v.midi === midi);
    if (!victim && this.opts.steal === "quietest") victim = [...candidates].sort((a, b) => a.vel - b.vel)[0];
    victim ??= candidates[0];
    if (victim) this.release(victim, when, 0.008);
  }

  private disposeVoice(v: Voice): void {
    if (v.disposed) return;
    v.disposed = true;
    for (const b of v.built.values()) for (const n of b.nodes) safeDisconnect(n);
    for (const n of v.extra) safeDisconnect(n);
    this.reap();
    this.opts.onVoices?.(this.voiceCount);
  }

  private reap(): void {
    this.voices = this.voices.filter((v) => !v.disposed);
  }

  /* ---------------------------------------------------------------- */
  /* Paramètres                                                        */
  /* ---------------------------------------------------------------- */

  /** Change un paramètre (rampe si AudioParam). Vaut pour la chaîne globale, les voix actives et les suivantes. */
  setParam(module: string, param: string, value: number | string, rampS = 0.02, when = this.ac.currentTime): boolean {
    const mod = [...this.patch.voice, ...this.patch.global].find((m) => m.name === module);
    if (!mod || !MODULES[mod.type].params[param]) return false;
    this.overrides.set(`${module}.${param}`, value);
    const apply = (b: Built | undefined) => {
      if (!b) return;
      const ap = b.params[param];
      if (ap && typeof value === "number") {
        ap.cancelScheduledValues(when);
        ap.setValueAtTime(ap.value, when);
        if (rampS > 0) ap.linearRampToValueAtTime(value, when + rampS);
        else ap.setValueAtTime(value, when);
      } else {
        b.setters[param]?.(value, when, rampS);
      }
    };
    if (mod.scope === "global") apply(this.global.get(module));
    else for (const v of this.voices) if (!v.disposed) apply(v.built.get(module));
    // Paramètres non temps réel (enveloppe, forme…) : pris en compte aux notes suivantes.
    if (!MODULES[mod.type].params[param].audio && typeof value === "number") mod.params[param] = value;
    else if (typeof value === "string" && MODULES[mod.type].params[param].values?.includes(value)) mod.params[param] = value;
    return true;
  }

  /** Arrête le patch : fondu, puis libération. */
  dispose(fadeS = 0.05): void {
    if (this.disposed) return;
    this.disposed = true;
    const t = this.ac.currentTime;
    this.allNotesOff(t);
    this.output.gain.cancelScheduledValues(t);
    this.output.gain.setValueAtTime(this.output.gain.value, t);
    this.output.gain.linearRampToValueAtTime(0, t + fadeS);
    const stopAt = t + fadeS + 0.05;
    for (const b of this.global.values()) b.stop(stopAt);
    setTimeout(() => {
      for (const b of this.global.values()) for (const n of b.nodes) safeDisconnect(n);
      safeDisconnect(this.voicesBus);
      safeDisconnect(this.output);
    }, (fadeS + 0.2) * 1000);
  }
}

function safeDisconnect(n: AudioNode): void {
  try {
    n.disconnect();
  } catch {
    /* déjà déconnecté */
  }
}
