import { afterEach, describe, expect, it, vi } from "vitest";
import { compilePatch, type PatchNode } from "./compile";
import { sampleOscRate } from "./nodes";
import { PatchRuntime } from "./runtime";
import { SampleBank } from "../../../shared/audio/samples";
import "../modules-elements";

const n = (tag: string, attrs: Record<string, string> = {}, children?: PatchNode[]): PatchNode => ({ tag, attrs, children });

class Param {
  constructor(public value = 0) {}
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
  outs: unknown[] = [];
  started: [number, number | undefined] | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  constructor(
    public kind: string,
    extra: Record<string, unknown> = {},
  ) {
    Object.assign(this, extra);
  }
  connect<T>(x: T): T {
    this.outs.push(x);
    return x;
  }
  disconnect() {
    this.outs = [];
  }
  start(t: number, offset?: number) {
    this.started = [t, offset];
  }
  stop(t: number) {
    this.stoppedAt = t;
  }
}

class Ctx {
  currentTime = 0;
  sampleRate = 48000;
  destination = new Node("dest");
  created: Node[] = [];
  private make(kind: string, extra: Record<string, unknown> = {}) {
    const x = new Node(kind, extra);
    this.created.push(x);
    return x;
  }
  createGain() {
    return this.make("gain", { gain: new Param(1) });
  }
  createConstantSource() {
    return this.make("const", { offset: new Param(1) });
  }
  createBufferSource() {
    return this.make("buffer", { buffer: null, loop: false, loopStart: 0, loopEnd: 0, playbackRate: new Param(1), detune: new Param(0) });
  }
  createBuffer(_c: number, len: number) {
    const d = new Float32Array(len);
    return { getChannelData: () => d, length: len, duration: len / 48000 };
  }
  buffers() {
    return this.created.filter((x) => x.kind === "buffer") as (Node & { playbackRate: Param; detune: Param; loop: boolean; loopStart: number; loopEnd: number; buffer: unknown })[];
  }
}

const sample = { duration: 2, length: 96000, numberOfChannels: 1, sampleRate: 48000 } as unknown as AudioBuffer;

function setup(attrs: Record<string, string>, extra: PatchNode[] = []) {
  vi.spyOn(SampleBank.prototype, "request").mockImplementation(() => {});
  vi.spyOn(SampleBank.prototype, "buffer").mockImplementation((spec: string) => (spec === "takes.voix" ? sample : null));
  const compiled = compilePatch([n("sonic-voice", {}, [n("sonic-sample-osc", { name: "s", sample: "takes.voix", ...attrs }), ...extra])]);
  expect(compiled.errors).toEqual([]);
  const ac = new Ctx();
  const rt = new PatchRuntime(ac as unknown as BaseAudioContext, compiled, { bpm: 120, poly: 8, steal: "oldest", velSense: 0.6, gain: 0.6 });
  return { ac, rt, compiled };
}

describe("sonic-sample-osc", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sampleOscRate : A4 → A5 = 2, semi, MIDI, root invalide = C4", () => {
    expect(sampleOscRate(880, "A4")).toBeCloseTo(2, 6);
    expect(sampleOscRate(440, "A4")).toBeCloseTo(1, 6);
    expect(sampleOscRate(220, 69)).toBeCloseTo(0.5, 6);
    expect(sampleOscRate(440, "A4", 12)).toBeCloseTo(2, 6);
    expect(sampleOscRate(261.63, "zz")).toBeCloseTo(1, 3);
  });

  it("compilation : sample demandé à la banque, erreurs lisibles", () => {
    const ok = compilePatch([n("sonic-voice", {}, [n("sonic-sample-osc", { sample: "takes.voix", root: "A3", loop: "" })])]);
    expect(ok.errors).toEqual([]);
    expect(ok.samples).toEqual(["takes.voix"]);
    expect(compilePatch([n("sonic-voice", {}, [n("sonic-sample-osc")])]).errors.join()).toContain("sample requis");
    expect(compilePatch([n("sonic-voice", {}, [n("sonic-sample-osc", { sample: "a.wav", root: "H9" })])]).errors.join()).toContain("root");
    expect(compilePatch([n("sonic-voice", {}, [n("sonic-sample-osc", { sample: "a.wav", "freq-hz": "abc" })])]).errors.join()).toContain("freq-hz");
    expect(customElements.get("sonic-sample-osc")).toBeTruthy();
  });

  it("voix : transposé selon la note (A5 sur un sample en A4 = vitesse 2), départ, boucle", () => {
    const { ac, rt } = setup({ root: "A4", start: "0.25", loop: "on", "loop-start": "0.5", "loop-end": "1.5" });
    rt.noteOn(81, 1, 0, 0.5); // A5
    const [src] = ac.buffers();
    expect(src.buffer).toBe(sample);
    expect(src.playbackRate.value).toBeCloseTo(2, 6);
    expect(src.started).toEqual([0, 0.25]);
    expect(src).toMatchObject({ loop: true, loopStart: 0.5, loopEnd: 1.5 });
    rt.noteOn(57, 1, 0.1, 0.5); // A3
    expect(ac.buffers()[1].playbackRate.value).toBeCloseTo(0.5, 6);
    // réglage en direct de la boucle (sonic-param)
    expect(rt.setParam("s", "loop", "off", 0.2)).toBe(true);
    expect(ac.buffers()[0].loop).toBe(false);
  });

  it("freq-hz fixe et sample absent : vitesse fixe ; note muette sans planter", () => {
    const fixed = setup({ root: "A4", "freq-hz": "220" });
    fixed.rt.noteOn(81, 1, 0, 0.5);
    expect(fixed.ac.buffers()[0].playbackRate.value).toBeCloseTo(0.5, 6);
    vi.restoreAllMocks();
    vi.spyOn(SampleBank.prototype, "request").mockImplementation(() => {});
    vi.spyOn(SampleBank.prototype, "buffer").mockReturnValue(null);
    const compiled = compilePatch([n("sonic-voice", {}, [n("sonic-sample-osc", { sample: "vide.wav" })])]);
    const ac = new Ctx();
    const rt = new PatchRuntime(ac as unknown as BaseAudioContext, compiled, { bpm: 120, poly: 8, steal: "oldest", velSense: 0.6, gain: 0.6 });
    expect(rt.noteOn(60, 1, 0, 0.5)).toBe(true);
    expect(ac.buffers()).toHaveLength(0);
  });
});
