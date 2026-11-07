/**
 * Runtime d'un patch compilé : chaîne globale construite une fois,
 * un graphe WebAudio par note (voix), polyphonie et vol de voix.
 */
import { midiToFreq } from "../../../shared/audio/notes";
import { ACTIVE_PARAM, MODULES, type VoiceExpression } from "./modules";
import { baseValue, buildModule, type Built } from "./nodes";
import { parseActive, type CompiledMod, type CompiledModule, type CompiledPatch } from "./compile";

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
  /** Processeurs AudioWorklet disponibles (sinon : modules en repli natif). */
  worklet?: boolean;
  /**
   * Élagage par note : un module dont le volume (`gain` d'un sonic-vca, `level` d'une source…) vaut 0
   * sans modulation, ou un câble nommé de profondeur nulle, n'est pas construit, ni ce qui ne nourrit que lui.
   * Une valeur remontée pendant une note tenue vaut pour les notes suivantes.
   */
  prune?: boolean;
};

export type ParamValue = number | string | number[];

/** Tirage aléatoire reproductible (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Jitter = { rel: number; abs: number };

type Voice = {
  midi: number | null;
  vel: number;
  start: number;
  releasedAt: number | null;
  /** Voix volée : en fondu de sortie, ne compte plus dans la polyphonie. */
  stolen: boolean;
  end: number;
  built: Map<string, Built>;
  extra: AudioNode[];
  gate: ConstantSourceNode;
  /** Expressions : bend (cents), pressure (0..1), timbre (0..1). */
  expr: { bend: ConstantSourceNode; pressure: ConstantSourceNode; timbre: ConstantSourceNode };
  out: GainNode;
  clock: ConstantSourceNode;
  /** Câbles nommés de la voix (amount / depth pilotables pendant la note). */
  modGains: { mod: CompiledMod; gain: GainNode }[];
  /** Aléa tiré pour cette note, par `module.param`. */
  jit: Map<string, Jitter>;
  disposed: boolean;
};

const MIN_RELEASE = 0.01;
/** Fondu de sortie d'une voix volée ou relancée (s) : assez long pour éviter le clic, assez court pour rester instantané. */
const STEAL_FADE_S = 0.012;

/** Fige un AudioParam à sa valeur au temps `t` (cancelAndHoldAtTime si disponible), sans saut. */
function holdAt(p: AudioParam, t: number): void {
  const h = (p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam }).cancelAndHoldAtTime;
  if (typeof h === "function") {
    h.call(p, t);
  } else {
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
  }
}

export class PatchRuntime {
  readonly output: GainNode;
  private ac: BaseAudioContext;
  private patch: CompiledPatch;
  private opts: RuntimeOptions;
  private global = new Map<string, Built>();
  private voicesBus: GainNode;
  private voices: Voice[] = [];
  private overrides = new Map<string, ParamValue>();
  private random: () => number;
  private disposed = false;
  private globalModGains: { mod: CompiledMod; gain: GainNode }[] = [];
  private modNames: Set<string>;
  /** Aléa déclaré par sonic-param (random / random-abs), par `module.param`. */
  private jitterSpecs = new Map<string, Jitter>();

  constructor(ac: BaseAudioContext, patch: CompiledPatch, opts: RuntimeOptions) {
    this.ac = ac;
    this.patch = patch;
    this.opts = opts;
    this.random = opts.random ?? Math.random;
    this.modNames = new Set(patch.mods.map((m) => m.name).filter((n): n is string => !!n));
    for (const p of patch.params) {
      if (p.kind === "module" && (p.random > 0 || p.randomAbs > 0)) this.jitterSpecs.set(`${p.module}.${p.param}`, { rel: p.random, abs: p.randomAbs });
    }
    this.voicesBus = ac.createGain();
    this.output = ac.createGain();
    this.output.gain.value = opts.gain;
    this.buildGlobal();
  }

  get voiceCount(): number {
    return this.voices.filter((v) => !v.disposed).length;
  }

  /** Gain effectif d'un câble : amount (piloté ou compilé) × depth. */
  private modGain(m: CompiledMod): number {
    let amount = m.amount;
    let depth = 1;
    if (m.name) {
      const a = this.overrides.get(`${m.name}.amount`);
      if (typeof a === "number") amount = m.exp ? a * 100 : a;
      const d = this.overrides.get(`${m.name}.depth`);
      if (typeof d === "number") depth = d;
      else if (Array.isArray(d)) {
        // profondeur par source (câble multi-source) ; rang absent = 0
        const v = d[m.index ?? 0];
        depth = typeof v === "number" && Number.isFinite(v) ? v : 0;
      }
    }
    return amount * depth;
  }

  private activeOf(mod: CompiledModule): number {
    const o = this.overrides.get(`${mod.name}.${ACTIVE_PARAM}`);
    return typeof o === "number" ? o : mod.active;
  }

  private numberOf(mod: CompiledModule, param: string): number | null {
    const o = this.overrides.get(`${mod.name}.${param}`);
    if (typeof o === "number") return o;
    const v = mod.params[param];
    return typeof v === "number" ? v : null;
  }

  /**
   * Modules à construire pour une note : remontée depuis la sortie de la voix
   * (entrées audio et sources de modulation), sans les modules inactifs ni,
   * avec `prune`, les branches muettes.
   */
  plan(modules: CompiledModule[], out: string | null): Set<string> {
    const prune = !!this.opts.prune;
    const byName = new Map(modules.map((m) => [m.name, m]));
    const modsTo = new Map<string, CompiledMod[]>();
    for (const m of this.patch.mods) {
      if (!byName.has(m.module)) continue;
      if (prune && this.modGain(m) === 0) continue;
      const list = modsTo.get(m.module) ?? [];
      list.push(m);
      modsTo.set(m.module, list);
    }
    const silent = (mod: CompiledModule): boolean => {
      if (!this.activeOf(mod)) return true;
      if (!prune) return false;
      for (const p of ["gain", "level"]) {
        if (!MODULES[mod.type].params[p]?.audio) continue;
        if (this.numberOf(mod, p) === 0 && !(modsTo.get(mod.name) ?? []).some((m) => m.param === p)) return true;
      }
      return false;
    };
    const need = new Set<string>();
    const stack = out ? [out] : [];
    while (stack.length) {
      const name = stack.pop()!;
      if (need.has(name)) continue;
      const mod = byName.get(name);
      if (!mod || silent(mod)) continue;
      need.add(name);
      for (const i of mod.inputs) stack.push(i);
      for (const m of modsTo.get(name) ?? []) if (byName.has(m.from)) stack.push(m.from);
      // la synchro dure lit le maître
      if (mod.type === "sonic-osc" && mod.params.sync) stack.push(String(mod.params.sync));
    }
    return need;
  }

  /** Valeur avec l'aléa de la note, bornée par le paramètre. */
  private jittered(mod: CompiledModule, param: string, v: number, jit: Jitter | undefined): number {
    if (!jit) return v;
    const spec = MODULES[mod.type].params[param];
    let n = v * (1 + jit.rel) + jit.abs;
    if (spec?.min !== undefined) n = Math.max(spec.min, n);
    if (spec?.max !== undefined) n = Math.min(spec.max, n);
    return n;
  }

  /* ---------------------------------------------------------------- */
  /* Chaîne globale                                                    */
  /* ---------------------------------------------------------------- */

  private buildGlobal(): void {
    const t = this.ac.currentTime;
    for (const mod of this.patch.global) {
      const b = buildModule(this.ac, mod, { bpm: this.opts.bpm, worklet: this.opts.worklet, freq: 261.63 });
      this.writeBases(mod, b, t, 261.63);
      this.global.set(mod.name, b);
    }
    this.applySync(this.patch.global, this.global, t, 261.63);
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
      g.gain.value = this.modGain(m);
      src.output.connect(g).connect(param);
      target.nodes.push(g);
      if (m.name) this.globalModGains.push({ mod: m, gain: g });
    }
    for (const b of this.global.values()) {
      b.start(t);
      b.trigger?.(t);
    }
  }

  /** Synchro dure : chaque esclave reçoit la fréquence de base de son maître. */
  private applySync(mods: CompiledModule[], built: Map<string, Built>, t: number, freq: number): void {
    for (const mod of mods) {
      const ref = mod.type === "sonic-osc" ? String(mod.params.sync ?? "") : "";
      if (!ref) continue;
      const master = mods.find((m) => m.name === ref);
      const b = built.get(mod.name);
      if (master && b?.setSync) b.setSync(baseValue(master, "freq-hz", { bpm: this.opts.bpm, freq }), t);
    }
  }

  private wireInputs(mod: CompiledModule, built: Map<string, Built>): void {
    const target = built.get(mod.name);
    if (!target) return;
    mod.inputs.forEach((name, i) => {
      const dest = target.inputAt ? target.inputAt(i) : target.input;
      if (!dest) return;
      const src = name === "voices" ? this.voicesBus : built.get(name)?.output;
      if (src) src.connect(dest);
    });
  }

  private writeBases(mod: CompiledModule, b: Built, t: number, freq: number, staticMods: Record<string, number> = {}, jit?: Map<string, Jitter>): void {
    for (const [param, ap] of Object.entries(b.params)) {
      const key = `${mod.name}.${param}`;
      const override = this.overrides.get(key);
      const v =
        typeof override === "number"
          ? override
          : baseValue(mod, param, { bpm: this.opts.bpm, freq });
      ap.setValueAtTime(this.jittered(mod, param, v, jit?.get(key)) + (staticMods[param] ?? 0), t);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Voix                                                              */
  /* ---------------------------------------------------------------- */

  /** Démarre une note. `durS` null : tenue jusqu'à noteOff. */
  noteOn(midi: number | null, vel: number, when: number, durS: number | null, sample: string | null = null, initial: VoiceExpression = {}): boolean {
    if (this.disposed) return false;
    const desc =
      (sample !== null ? this.patch.voices.find((v) => v.sample === sample) : undefined) ??
      (midi !== null ? this.patch.voices.find((v) => v.note === midi) : undefined) ??
      this.patch.voices.find((v) => v.sample === null && v.note === null) ??
      (sample === null ? this.patch.voices[0] : undefined);
    if (!desc) return false;
    this.reap();
    this.allocate(midi, when);

    const ac = this.ac;
    const freq = midi === null ? 261.63 : midiToFreq(midi);
    const rand = this.random();
    const built = new Map<string, Built>();
    const extra: AudioNode[] = [];

    // Une voix réservée à une note garde sa hauteur propre (kit : le pad ne transpose pas).
    const pitch = desc.note !== null || desc.sample !== null ? 261.63 : freq;
    // Graphe de la note : seulement ce qui atteint la sortie (modules actifs, branches non muettes).
    const need = this.plan(desc.modules, desc.out);
    const modules = desc.modules.filter((m) => need.has(m.name));
    // Aléa de la note (sonic-param random / random-abs).
    const jit = new Map<string, Jitter>();
    for (const [key, spec] of this.jitterSpecs) {
      if (!need.has(key.slice(0, key.lastIndexOf(".")))) continue;
      jit.set(key, { rel: (this.random() * 2 - 1) * spec.rel, abs: (this.random() * 2 - 1) * spec.abs });
    }
    for (const mod of modules) {
      // paramètres non temps réel (enveloppe, q…) : l'aléa s'applique à la construction
      let m = mod;
      for (const [param, ps] of Object.entries(MODULES[mod.type].params)) {
        const j = jit.get(`${mod.name}.${param}`);
        const v = mod.params[param];
        if (!j || ps.audio || typeof v !== "number") continue;
        if (m === mod) m = { ...mod, params: { ...mod.params } };
        m.params[param] = this.jittered(mod, param, v, j);
      }
      built.set(mod.name, buildModule(ac, m, { bpm: this.opts.bpm, worklet: this.opts.worklet, freq: pitch, random: this.random }));
    }
    // Modulations statiques (vélocité, note, aléa) ajoutées aux valeurs de base.
    const statics = new Map<string, Record<string, number>>();
    for (const m of this.patch.mods) {
      if (!built.has(m.module)) continue;
      const value = m.from === "voice.vel" ? vel : m.from === "voice.note" ? (midi ?? 60) : m.from === "voice.rand" ? rand : null;
      if (value === null) continue;
      const rec = statics.get(m.module) ?? {};
      rec[m.param] = (rec[m.param] ?? 0) + value * this.modGain(m);
      statics.set(m.module, rec);
    }
    for (const mod of modules) this.writeBases(mod, built.get(mod.name)!, when, pitch, statics.get(mod.name), jit);
    for (const mod of modules) this.wireInputs(mod, built);
    this.applySync(modules, built, when, pitch);

    // Gate (0/1) disponible comme source de modulation.
    const gate = ac.createConstantSource();
    gate.offset.setValueAtTime(0, when);
    gate.offset.setValueAtTime(1, when);
    extra.push(gate);

    // Expressions (MPE, pitch bend, aftertouch) : bend en cents vers chaque oscillateur
    // qui suit la note, pression et timbre comme sources de modulation.
    const exprNode = (v: number) => {
      const c = ac.createConstantSource();
      c.offset.value = v;
      extra.push(c);
      return c;
    };
    const expr = {
      bend: exprNode(clampNum(initial.bend ?? 0, -96, 96) * 100),
      pressure: exprNode(clampNum(initial.pressure ?? 0, 0, 1)),
      timbre: exprNode(clampNum(initial.timbre ?? 0, 0, 1)),
    };
    for (const mod of modules) {
      // tout module qui suit la note (oscillateur, corde, résonateur) suit aussi le bend
      if (mod.params["freq-hz"] === "voice.pitch") {
        const detune = built.get(mod.name)?.params.detune;
        if (detune) expr.bend.connect(detune);
      }
    }

    // Modulations dynamiques (enveloppes, LFO, audio, gate).
    const modGains: Voice["modGains"] = [];
    for (const m of this.patch.mods) {
      const target = built.get(m.module);
      const param = target?.params[m.param];
      if (!target || !param) continue;
      let src: AudioNode | null = null;
      if (m.from === "voice.gate") src = gate;
      else if (m.from === "voice.pressure") src = expr.pressure;
      else if (m.from === "voice.timbre") src = expr.timbre;
      else if (m.from === "voice.bend") {
        // en demi-tons (le nœud porte des cents)
        const g = ac.createGain();
        g.gain.value = 0.01;
        expr.bend.connect(g);
        extra.push(g);
        src = g;
      }
      else if (m.from === "voice.pitch") {
        const c = ac.createConstantSource();
        c.offset.value = freq;
        extra.push(c);
        src = c;
      } else if (!m.from.startsWith("voice.")) src = built.get(m.from)?.output ?? this.global.get(m.from)?.output ?? null;
      if (!src) continue;
      const amount = this.modGain(m);
      if (amount === 0 && this.opts.prune) continue;
      const g = ac.createGain();
      g.gain.value = amount;
      src.connect(g).connect(param);
      extra.push(g);
      if (m.name) modGains.push({ mod: m, gain: g });
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
    for (const c of Object.values(expr)) c.start(when);

    const voice: Voice = { midi, vel, start: when, releasedAt: null, stolen: false, end: Infinity, built, extra, gate, expr, out, clock, modGains, jit, disposed: false };
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

  /** Expressions d'une note tenue (dernière voix de cette note) : bend en demi-tons, pression et timbre 0..1. */
  expression(midi: number | null, e: VoiceExpression, when: number): boolean {
    let hit = false;
    for (const v of this.voices) {
      if (v.disposed || v.midi !== midi || v.end < when) continue;
      hit = true;
      const t = Math.max(when, v.start);
      const set = (node: ConstantSourceNode, value: number) => {
        node.offset.cancelScheduledValues(t);
        node.offset.setTargetAtTime(value, t, 0.004);
      };
      if (typeof e.bend === "number" && Number.isFinite(e.bend)) set(v.expr.bend, clampNum(e.bend, -96, 96) * 100);
      if (typeof e.pressure === "number" && Number.isFinite(e.pressure)) set(v.expr.pressure, clampNum(e.pressure, 0, 1));
      if (typeof e.timbre === "number" && Number.isFinite(e.timbre)) set(v.expr.timbre, clampNum(e.timbre, 0, 1));
    }
    return hit;
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
    if (fast === undefined) g.cancelScheduledValues(t);
    if (fast !== undefined) {
      holdAt(g, t);
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
    for (const c of Object.values(v.expr)) c.stop(stopAt);
    v.clock.stop(stopAt + 0.01);
  }

  /** Voix qui sonnent encore à `when` (tenues ou en relâchement), hors voix volées. */
  private sounding(when: number): Voice[] {
    return this.voices.filter((v) => !v.disposed && !v.stolen && (v.releasedAt === null || v.end > when));
  }

  /**
   * Place pour une nouvelle note, polyphonie stricte (les queues de relâchement comptent) :
   * 1. la même note qui sonne encore est relancée (pas de doublon, pas de voix perdue) ;
   * 2. sinon, au-delà de `poly`, on libère d'abord les voix déjà relâchées (la plus ancienne),
   *    puis les voix tenues selon `steal` (plus ancienne, plus douce, même note).
   * Les voix libérées s'éteignent en un court fondu (pas de clic).
   */
  private allocate(midi: number | null, when: number): void {
    if (midi !== null) {
      for (const v of this.sounding(when)) if (v.midi === midi) this.choke(v, when);
    }
    let live = this.sounding(when);
    while (live.length >= this.opts.poly) {
      const victim = this.pickVictim(live, midi);
      if (!victim) break;
      this.choke(victim, when);
      live = this.sounding(when);
    }
  }

  private pickVictim(live: Voice[], midi: number | null): Voice | undefined {
    const byStart = (a: Voice, b: Voice) => a.start - b.start;
    const released = live.filter((v) => v.releasedAt !== null).sort((a, b) => (a.releasedAt ?? 0) - (b.releasedAt ?? 0));
    if (released.length) return released[0];
    const held = [...live].sort(byStart);
    if (this.opts.steal === "same-note") return held.find((v) => v.midi === midi) ?? held[0];
    if (this.opts.steal === "quietest") return [...held].sort((a, b) => a.vel - b.vel || byStart(a, b))[0];
    return held[0];
  }

  /** Coupe une voix en fondu court (vol de voix, relance de la même note). */
  private choke(v: Voice, when: number): void {
    if (v.disposed || v.stolen) return;
    v.stolen = true;
    this.release(v, Math.max(when, v.start), STEAL_FADE_S);
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

  /**
   * Change un paramètre (rampe si AudioParam). Vaut pour la chaîne globale, les voix actives et les suivantes.
   * `module` peut aussi être un câble nommé (`amount`, `depth`) ; `active` (0/1) vaut pour les notes suivantes.
   */
  setParam(module: string, param: string, value: ParamValue | boolean, rampS = 0.02, when = this.ac.currentTime): boolean {
    if (this.modNames.has(module)) {
      const okList = param === "depth" && Array.isArray(value) && value.every((x) => Number.isFinite(x));
      if ((param !== "amount" && param !== "depth") || (!okList && (typeof value !== "number" || !Number.isFinite(value)))) return false;
      this.overrides.set(`${module}.${param}`, value);
      const retarget = (list: { mod: CompiledMod; gain: GainNode }[]) => {
        for (const { mod, gain } of list) if (mod.name === module) ramp(gain.gain, this.modGain(mod), when, rampS);
      };
      retarget(this.globalModGains);
      for (const v of this.voices) if (!v.disposed) retarget(v.modGains);
      return true;
    }
    const mod = [...this.patch.voice, ...this.patch.global].find((m) => m.name === module);
    if (!mod) return false;
    if (param === ACTIVE_PARAM) {
      const a = parseActive(value);
      if (a === null) return false;
      this.overrides.set(`${module}.${param}`, a);
      return true;
    }
    const spec = MODULES[mod.type].params[param];
    if (!spec || typeof value === "boolean") return false;
    let v: ParamValue = value;
    if (spec.list) {
      const list = Array.isArray(value) ? value.map(Number) : String(value).split(/[\s,]+/).filter(Boolean).map(Number);
      if (list.some((x) => !Number.isFinite(x))) return false;
      v = list.slice(0, 64);
    }
    this.overrides.set(`${module}.${param}`, v);
    const apply = (b: Built | undefined, jit?: Map<string, Jitter>) => {
      if (!b) return;
      const ap = b.params[param];
      if (ap && typeof v === "number") ramp(ap, this.jittered(mod, param, v, jit?.get(`${module}.${param}`)), when, rampS);
      else b.setters[param]?.(v, when, rampS);
    };
    if (mod.scope === "global") apply(this.global.get(module));
    else for (const voice of this.voices) if (!voice.disposed) apply(voice.built.get(module), voice.jit);
    // Paramètres non temps réel (enveloppe, forme, partiels…) : pris en compte aux notes suivantes.
    if (!spec.audio && typeof v === "number") mod.params[param] = v;
    else if (Array.isArray(v)) mod.params[param] = v;
    else if (typeof v === "string" && spec.values?.includes(v)) mod.params[param] = v;
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Entrées externes (sonic-audio-input)                                    */
  /* ---------------------------------------------------------------- */

  private attached = new Map<string, AudioNode>();

  /** Modules sonic-audio-input : nom et référence de source (`#mic`, `#id`). */
  inputs(): { name: string; source: string }[] {
    return this.patch.global
      .filter((m) => m.type === "sonic-audio-input")
      .map((m) => ({ name: m.name, source: String(m.params.source ?? "#mic").trim() || "#mic" }));
  }

  /** Branche (ou débranche avec null) une source externe sur un sonic-audio-input. Ne touche qu'à sa propre connexion. */
  attachInput(name: string, node: AudioNode | null): boolean {
    if (this.disposed) return false;
    const dest = this.global.get(name)?.input;
    if (!dest) return false;
    const prev = this.attached.get(name);
    if (prev === node) return true;
    if (prev) {
      try {
        prev.disconnect(dest);
      } catch {
        /* déjà débranché */
      }
      this.attached.delete(name);
    }
    if (node) {
      node.connect(dest);
      this.attached.set(name, node);
    }
    return true;
  }

  inputNode(name: string): AudioNode | null {
    return this.global.get(name)?.input ?? null;
  }

  isInputAttached(name: string): boolean {
    return this.attached.has(name);
  }

  /** Arrête le patch : fondu, puis libération. */
  dispose(fadeS = 0.05): void {
    if (this.disposed) return;
    for (const name of [...this.attached.keys()]) this.attachInput(name, null);
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

function ramp(p: AudioParam, v: number, when: number, rampS: number): void {
  p.cancelScheduledValues(when);
  p.setValueAtTime(p.value, when);
  if (rampS > 0) p.linearRampToValueAtTime(v, when + rampS);
  else p.setValueAtTime(v, when);
}

function clampNum(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function safeDisconnect(n: AudioNode): void {
  try {
    n.disconnect();
  } catch {
    /* déjà déconnecté */
  }
}
