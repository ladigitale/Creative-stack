import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { resolve } from "node:path";
import { compilePatch, type PatchNode } from "./compile";
import { PatchRuntime, seededRandom } from "./runtime";

/* ------------------------------------------------------------------ */
/* Faux AudioContext : compte les nœuds créés, garde les valeurs écrites */
/* ------------------------------------------------------------------ */

class Param {
  value = 0;
  constructor(v = 0) {
    this.value = v;
  }
  setValueAtTime(v: number) {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number) {
    this.value = v;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

class Node {
  kind: string;
  outs: unknown[] = [];
  constructor(kind: string, extra: Record<string, unknown> = {}) {
    this.kind = kind;
    Object.assign(this, extra);
  }
  connect<T>(n: T): T {
    this.outs.push(n);
    return n;
  }
  disconnect() {
    this.outs = [];
  }
  start() {}
  stop() {}
  onended: (() => void) | null = null;
}

class FakeContext {
  currentTime = 0;
  sampleRate = 48000;
  created: Node[] = [];
  private make(kind: string, extra: Record<string, unknown> = {}) {
    const n = new Node(kind, extra);
    this.created.push(n);
    return n;
  }
  createGain() {
    return this.make("gain", { gain: new Param(1) });
  }
  createConstantSource() {
    return this.make("const", { offset: new Param(1) });
  }
  createOscillator() {
    return this.make("osc", { frequency: new Param(440), detune: new Param(), type: "sine", setPeriodicWave() {} });
  }
  createBiquadFilter() {
    return this.make("biquad", { type: "lowpass", frequency: new Param(350), Q: new Param(1), gain: new Param(), detune: new Param() });
  }
  createBufferSource() {
    return this.make("buffer", { buffer: null, loop: false, playbackRate: new Param(1) });
  }
  createBuffer(_c: number, len: number) {
    const d = new Float32Array(len);
    return { getChannelData: () => d, length: len };
  }
  createStereoPanner() {
    return this.make("pan", { pan: new Param() });
  }
  count(kind?: string) {
    return kind ? this.created.filter((n) => n.kind === kind).length : this.created.length;
  }
}

const n = (tag: string, attrs: Record<string, string> = {}, children?: PatchNode[]): PatchNode => ({ tag, attrs, children });

function runtime(nodes: PatchNode[], opts: { prune?: boolean; random?: () => number } = {}) {
  const compiled = compilePatch(nodes);
  expect(compiled.errors).toEqual([]);
  const ac = new FakeContext();
  const rt = new PatchRuntime(ac as unknown as BaseAudioContext, compiled, { bpm: 120, poly: 8, steal: "oldest", velSense: 0.6, gain: 0.6, ...opts });
  return { ac, rt, compiled };
}

/** Voix type : deux branches (oscillateur, bruit) sommées, chacune derrière un sonic-vca piloté. */
const twoBranches = (extra: PatchNode[] = []) => [
  n("sonic-voice", { out: "amp" }, [
    n("sonic-osc", { name: "o" }),
    n("sonic-vca", { name: "og", in: "o", gain: "1" }),
    n("sonic-noise", { name: "nz" }),
    n("sonic-filter", { name: "nf", in: "nz" }),
    n("sonic-vca", { name: "ng", in: "nf", gain: "0" }),
    n("sonic-mixer", { name: "mx", in: "og ng" }),
    n("sonic-env", { name: "e" }),
    n("sonic-vca", { name: "amp", in: "mx", gain: "e" }),
    n("sonic-lfo", { name: "l" }),
    n("sonic-mod", { name: "vib", from: "l", to: "o.detune", amount: "10" }),
    ...extra,
  ]),
];

describe("PatchRuntime : graphe par note", () => {
  it("sans élagage : construit tout ce qui atteint la sortie", () => {
    const { ac, rt } = runtime(twoBranches());
    const before = ac.count();
    rt.noteOn(60, 0.8, 0, 0.5);
    expect(ac.count("biquad")).toBe(1);
    expect(ac.count() - before).toBeGreaterThan(10);
  });

  it("prune : la branche dont le volume vaut 0 (sans modulation) n'est pas construite", () => {
    const full = runtime(twoBranches());
    full.rt.noteOn(60, 0.8, 0, 0.5);
    const pruned = runtime(twoBranches(), { prune: true });
    const before = pruned.ac.count();
    pruned.rt.noteOn(60, 0.8, 0, 0.5);
    expect(pruned.ac.count("biquad")).toBe(0); // filtre du bruit absent
    expect(pruned.ac.count("buffer")).toBe(0); // bruit absent
    expect(pruned.ac.count() - before).toBeLessThan(full.ac.count() - 3);
    // la valeur remontée vaut pour la note suivante
    pruned.rt.setParam("ng", "gain", 0.5);
    pruned.rt.noteOn(62, 0.8, 0.1, 0.5);
    expect(pruned.ac.count("biquad")).toBe(1);
  });

  it("câble nommé : depth 0 retire le câble et sa source (prune), amount / depth suivent pendant la note", () => {
    const { ac, rt } = runtime(twoBranches(), { prune: true });
    rt.setParam("vib", "depth", 0);
    rt.noteOn(60, 0.8, 0, 0.5);
    expect(ac.created.filter((x) => x.kind === "osc").length).toBe(1); // LFO non construit
    rt.setParam("vib", "depth", 1);
    rt.noteOn(64, 0.8, 0.1, null);
    const gains = () => ac.created.filter((x) => x.kind === "gain").map((g) => (g as unknown as { gain: Param }).gain.value);
    expect(gains()).toContain(10);
    expect(rt.setParam("vib", "amount", 25)).toBe(true);
    expect(gains()).toContain(25);
    expect(rt.setParam("vib", "depth", 0.5)).toBe(true);
    expect(gains()).toContain(12.5);
    expect(rt.setParam("vib", "gain", 1)).toBe(false);
  });

  it("active : un module inactif et ce qui ne nourrit que lui disparaissent des notes suivantes", () => {
    const { ac, rt } = runtime(twoBranches([n("sonic-param", { to: "nf.active", value: "0" })]));
    rt.setParam("ng", "gain", 1);
    rt.setParam("nf", "active", false);
    rt.noteOn(60, 0.8, 0, 0.5);
    expect(ac.count("biquad")).toBe(0);
    expect(ac.count("buffer")).toBe(0);
    rt.setParam("nf", "active", 1);
    rt.noteOn(62, 0.8, 0.1, 0.5);
    expect(ac.count("biquad")).toBe(1);
  });

  it("random : tirage par note, borné, reproductible avec une graine", () => {
    const nodes = [
      n("sonic-voice", {}, [
        n("sonic-osc", { name: "o" }),
        n("sonic-filter", { name: "f", "freq-hz": "1000" }),
        n("sonic-param", { to: "f.freq-hz", random: "0.2" }),
        n("sonic-param", { to: "o.detune", "random-abs": "15" }),
      ]),
    ];
    const cutoffs = (seed: number) => {
      const { ac, rt } = runtime(nodes, { random: seededRandom(seed) });
      for (let i = 0; i < 5; i++) rt.noteOn(60, 0.8, i * 0.1, 0.05);
      return ac.created.filter((x) => x.kind === "biquad").map((b) => (b as unknown as { frequency: Param }).frequency.value);
    };
    const a = cutoffs(7);
    expect(new Set(a).size).toBe(5);
    for (const v of a) expect(v).toBeGreaterThanOrEqual(800), expect(v).toBeLessThanOrEqual(1200);
    expect(cutoffs(7)).toEqual(a);
    expect(cutoffs(8)).not.toEqual(a);
  });

  it("random sur un paramètre non temps réel (enveloppe) : appliqué à la construction", () => {
    const { compiled } = runtime([
      n("sonic-voice", {}, [n("sonic-osc", { name: "o" }), n("sonic-env", { name: "e", d: "0.5" }), n("sonic-vca", { gain: "e" }), n("sonic-param", { to: "e.d", random: "0.5" })]),
    ]);
    expect(compiled.params[0]).toMatchObject({ random: 0.5 });
  });

  it("résonateur : partiels changés à chaud (repli natif, même nombre)", () => {
    const { ac, rt } = runtime([n("sonic-voice", {}, [n("sonic-noise", { name: "x" }), n("sonic-resonator", { name: "r", in: "x", partials: "1 2 3", jitter: "10" })])], {
      random: seededRandom(1),
    });
    rt.noteOn(57, 0.8, 0, null);
    const bq = ac.created.filter((x) => x.kind === "biquad") as unknown as { detune: Param }[];
    expect(bq.length).toBe(3);
    // désaccord aléatoire de chaque partiel, dans ±10 cents
    for (const b of bq) expect(Math.abs(b.detune.value)).toBeLessThanOrEqual(10);
    expect(rt.setParam("r", "partials", "1 2.76 5.4")).toBe(true);
    expect(rt.setParam("r", "partials", [1, 3, 5])).toBe(true);
    expect(rt.setParam("r", "partials", "1 x")).toBe(false);
  });
});

describe("PatchRuntime : polyphonie", () => {
  const simple = () => [n("sonic-voice", {}, [n("sonic-osc", { name: "o" }), n("sonic-env", { name: "e", r: "2" }), n("sonic-vca", { gain: "e", in: "o" })])];
  const live = (rt: PatchRuntime, t: number) => (rt as unknown as { sounding(t: number): { midi: number | null; releasedAt: number | null }[] }).sounding(t);

  it("poly stricte : les queues de relâchement comptent, la plus ancienne relâchée part d'abord", () => {
    const { rt } = runtime(simple());
    const r = rt as unknown as { opts: { poly: number } };
    r.opts.poly = 3;
    rt.noteOn(60, 0.8, 0, null);
    rt.noteOn(62, 0.8, 0.01, null);
    rt.noteOn(64, 0.8, 0.02, null);
    rt.noteOff(62, 0.1); // 62 en relâchement (2 s)
    rt.noteOn(65, 0.8, 0.2, null);
    expect(live(rt, 0.2).map((v) => v.midi).sort()).toEqual([60, 64, 65]);
    // puis la plus ancienne tenue
    rt.noteOn(67, 0.8, 0.3, null);
    expect(live(rt, 0.3).map((v) => v.midi).sort()).toEqual([64, 65, 67]);
  });

  it("rafale (accord) : jamais plus de poly voix, même au même instant", () => {
    const { rt } = runtime(simple());
    (rt as unknown as { opts: { poly: number } }).opts.poly = 4;
    for (let k = 0; k < 5; k++) for (const m of [48, 52, 55, 60]) rt.noteOn(m + k, 0.8, 1, null);
    expect(live(rt, 1).length).toBe(4);
  });

  it("même note relancée : la voix précédente est coupée (pas de doublon)", () => {
    const { rt } = runtime(simple());
    rt.noteOn(60, 0.8, 0, 0.05);
    rt.noteOn(60, 0.8, 0.02, 0.05);
    rt.noteOn(60, 0.8, 0.04, null);
    expect(live(rt, 0.04).filter((v) => v.midi === 60).length).toBe(1);
  });
});

describe("compilePatch : câbles nommés, active, random", () => {
  it("valide les cibles", () => {
    const ok = compilePatch([
      n("sonic-voice", {}, [
        n("sonic-osc", { name: "o", active: "false" }),
        n("sonic-lfo", { name: "l" }),
        n("sonic-mod", { name: "m", from: "l", to: "o.detune", amount: "5" }),
        n("sonic-mod", { name: "m", from: "l", to: "o.level", amount: "0.1" }),
      ]),
      n("sonic-param", { to: "m.depth", source: "x.d" }),
      n("sonic-param", { to: "o.active", source: "x.a" }),
    ]);
    expect(ok.errors).toEqual([]);
    expect(ok.voice[0].active).toBe(0);
    expect(ok.mods.map((m) => m.name)).toEqual(["m", "m"]);
    expect(ok.params.map((p) => [p.kind, p.module, p.param])).toEqual([
      ["mod", "m", "depth"],
      ["module", "o", "active"],
    ]);
    const bad = compilePatch([
      n("sonic-voice", {}, [n("sonic-osc", { name: "o" }), n("sonic-lfo", { name: "l" }), n("sonic-mod", { name: "o", from: "l", to: "o.detune" }), n("sonic-mod", { name: "k", from: "l", to: "o.detune" })]),
      n("sonic-param", { to: "k.gain", value: "1" }),
    ]);
    expect(bad.errors.join(" | ")).toContain('nom "o" déjà pris');
    expect(bad.errors.join(" | ")).toContain("un câble nommé n'a que amount et depth");
    const glob = compilePatch([n("sonic-voice", {}, [n("sonic-osc")]), n("sonic-delay", { name: "d" }), n("sonic-param", { to: "d.feedback", random: "0.1" })]);
    expect(glob.warnings.join()).toContain("random ne s'applique qu'aux paramètres des modules de sonic-voice");
    expect(glob.params[0].random).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Processeur cs-modal, exécuté hors navigateur                        */
/* ------------------------------------------------------------------ */

type ModalProc = {
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
  configure(o: unknown): void;
  idle: boolean;
};

function loadModal(sampleRate = 48000): new (o: unknown) => ModalProc {
  const registry: Record<string, unknown> = {};
  const src = readFileSync(resolve(process.cwd(), "src/addons/audio/worklet/processors.js"), "utf8");
  runInNewContext(src, {
    AudioWorkletProcessor: class {
      port = { onmessage: null as unknown, postMessage() {} };
    },
    registerProcessor: (name: string, cls: unknown) => (registry[name] = cls),
    sampleRate,
    Math,
    Float64Array,
    Array,
    Number,
  });
  return registry["cs-modal"] as new (o: unknown) => ModalProc;
}

describe("cs-modal (banc modal AudioWorklet)", () => {
  const params = (f: number, q = 200) => ({ frequency: Float32Array.of(f), detune: Float32Array.of(0), q: Float32Array.of(q) });

  /** Énergie par bin de Goertzel sur un signal. */
  const power = (x: number[], f: number, sr: number) => {
    const w = (2 * Math.PI * f) / sr;
    const c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (const v of x) {
      const s = v + c * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    return s1 * s1 + s2 * s2 - c * s1 * s2;
  };

  it("résonne sur ses partiels, se tait et saute les blocs muets", () => {
    const Modal = loadModal();
    const p = new Modal({ processorOptions: { ratios: [1, 3], gains: [1, 1], cents: [0, 0] } });
    const out: number[] = [];
    for (let b = 0; b < 40; b++) {
      const input = new Float32Array(128);
      if (b === 0) input[0] = 1;
      const o = new Float32Array(128);
      p.process([[input]], [[o]], params(440));
      out.push(...o);
    }
    expect(power(out, 440, 48000)).toBeGreaterThan(power(out, 660, 48000) * 50);
    expect(power(out, 1320, 48000)).toBeGreaterThan(power(out, 880, 48000) * 50);
    // après extinction : états à zéro, bloc sauté
    for (let b = 0; b < 2000 && !p.idle; b++) p.process([[new Float32Array(128)]], [[new Float32Array(128)]], params(440, 20));
    expect(p.idle).toBe(true);
  });

  it("nouveaux partiels sans recréer le nœud", () => {
    const Modal = loadModal();
    const p = new Modal({ processorOptions: { ratios: [1] } });
    p.configure({ ratios: [2], gains: [1] });
    const out: number[] = [];
    for (let b = 0; b < 20; b++) {
      const input = new Float32Array(128);
      if (b === 0) input[0] = 1;
      const o = new Float32Array(128);
      p.process([[input]], [[o]], params(300));
      out.push(...o);
    }
    expect(power(out, 600, 48000)).toBeGreaterThan(power(out, 300, 48000) * 50);
  });
});
