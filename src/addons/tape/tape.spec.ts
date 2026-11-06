import { describe, expect, it } from "vitest";
import "./index";
import { HighPass, LeakyIntegrator, RateMapper, deadzone, ema, omegaToRate, scrubRate, TURNTABLE_33_DEG_PER_SEC } from "./mapping";
import { TapeVoice, reverseBuffer } from "./voice";

class P {
  value = 1;
  setTargetAtTime = (v: number) => (this.value = v);
  setValueAtTime = (v: number) => (this.value = v);
  linearRampToValueAtTime = (v: number) => (this.value = v);
  cancelScheduledValues() {}
}
type Src = { buffer: AudioBuffer | null; loop: boolean; loopStart: number; loopEnd: number; playbackRate: P; startOffset: number; stopped: boolean; onended: (() => void) | null };

function fakeCtx() {
  const sources: Src[] = [];
  const ctx = {
    currentTime: 0,
    createGain: () => ({ gain: new P(), connect() {}, disconnect() {} }),
    createBufferSource: () => {
      const s = {
        buffer: null, loop: false, loopStart: 0, loopEnd: 0, playbackRate: new P(), startOffset: -1, stopped: false, onended: null,
        connect() {}, disconnect() {}, addEventListener() {},
        start(_w: number, off: number) { s.startOffset = off; },
        stop() { s.stopped = true; },
      } as unknown as Src;
      sources.push(s);
      return s;
    },
    createBuffer: (ch: number, len: number, sr: number) => {
      const data = Array.from({ length: ch }, () => new Float32Array(len));
      return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: (c: number) => data[c] } as unknown as AudioBuffer;
    },
  };
  return { ctx: ctx as unknown as BaseAudioContext, raw: ctx, sources };
}

function buf(ctx: BaseAudioContext, seconds = 10, sr = 100) {
  const b = ctx.createBuffer(1, seconds * sr, sr);
  b.getChannelData(0).forEach((_, i, a) => (a[i] = i));
  return b;
}

describe("mapping", () => {
  it("convertit la rotation d'un plateau en vitesse", () => {
    expect(omegaToRate(TURNTABLE_33_DEG_PER_SEC)).toBeCloseTo(1);
    expect(omegaToRate(-2 * TURNTABLE_33_DEG_PER_SEC)).toBeCloseTo(-2);
    expect(omegaToRate(NaN)).toBe(0);
  });

  it("rattrape un écart en avant, en arrière, et s'arrête sur la cible", () => {
    expect(scrubRate(4800, 48000)).toBeGreaterThan(0);
    expect(scrubRate(-4800, 48000)).toBeLessThan(0);
    expect(scrubRate(10, 48000)).toBe(0);
    expect(scrubRate(Infinity, 48000)).toBe(0);
  });

  it("zone morte et lissage", () => {
    expect(deadzone(0.2, 0.5)).toBe(0);
    expect(deadzone(-0.8, 0.5)).toBe(-0.8);
    expect(ema(0, 1, 40, 40)).toBeCloseTo(1 - Math.exp(-1));
    expect(ema(0, 1, 10, 0)).toBe(1);
  });

  it("le passe-haut retire la gravité constante", () => {
    const hp = new HighPass(300);
    let y = 0;
    for (let i = 0; i < 200; i++) y = hp.feed(9.81, 16);
    expect(Math.abs(y)).toBeLessThan(1e-9);
    expect(Math.abs(hp.feed(15, 16))).toBeGreaterThan(4);
  });

  it("l'intégrateur à fuite revient vers 0", () => {
    const i = new LeakyIntegrator(100);
    i.feed(10, 100);
    const v = i.value;
    expect(v).toBeGreaterThan(0);
    for (let k = 0; k < 50; k++) i.feed(0, 100);
    expect(Math.abs(i.value)).toBeLessThan(v / 100);
  });

  it("mode accel : une secousse lance la bande puis elle retombe, gravité ignorée", () => {
    const m = new RateMapper({ mode: "accel", scale: 1, smoothMs: 0, deadzone: 0.1 });
    let t = 0;
    let r = 0;
    for (let k = 0; k < 40; k++) r = m.feed(9.81, (t += 16));
    expect(r).toBe(0);
    let peak = 0;
    for (let k = 0; k < 10; k++) peak = Math.max(peak, Math.abs(m.feed(9.81 + 20, (t += 16))));
    expect(peak).toBeGreaterThan(0.1);
    for (let k = 0; k < 400; k++) r = m.feed(9.81, (t += 16));
    expect(r).toBe(0);
  });

  it("mode omega avec échelle personnalisée", () => {
    const m = new RateMapper({ mode: "omega", scale: 100, smoothMs: 0 });
    expect(m.feed(100, 16)).toBeCloseTo(1);
    expect(m.feed(-300, 32)).toBeCloseTo(-3);
  });
});

describe("TapeVoice", () => {
  it("inverse un buffer", () => {
    const { ctx } = fakeCtx();
    const b = buf(ctx, 1, 4);
    expect([...reverseBuffer(ctx, b).getChannelData(0)]).toEqual([3, 2, 1, 0]);
  });

  it("avance au rythme de la vitesse", () => {
    const { ctx, raw } = fakeCtx();
    const v = new TapeVoice(ctx, buf(ctx), {} as AudioNode);
    v.setRate(2);
    raw.currentTime = 1;
    expect(v.position()).toBeCloseTo(2);
    v.setRate(-1);
    raw.currentTime = 2;
    expect(v.position()).toBeCloseTo(1);
  });

  it("change de sens sur la copie inversée à la position équivalente", () => {
    const { ctx, raw, sources } = fakeCtx();
    const v = new TapeVoice(ctx, buf(ctx), {} as AudioNode);
    v.seek(3);
    v.setRate(1);
    expect(sources.at(-1)!.startOffset).toBeCloseTo(3);
    raw.currentTime = 1;
    v.setRate(-1.5);
    const rev = sources.at(-1)!;
    expect(rev.startOffset).toBeCloseTo(10 - 4);
    expect(rev.playbackRate.value).toBeCloseTo(1.5);
    expect(sources[0].stopped || sources[1].stopped).toBe(true);
  });

  it("un même sens ne recrée pas la source", () => {
    const { ctx, sources } = fakeCtx();
    const v = new TapeVoice(ctx, buf(ctx), {} as AudioNode);
    v.setRate(1);
    const n = sources.length;
    v.setRate(2.5);
    expect(sources.length).toBe(n);
    expect(sources.at(-1)!.playbackRate.value).toBeCloseTo(2.5);
  });

  it("s'arrête à vitesse nulle et garde sa position", () => {
    const { ctx, raw, sources } = fakeCtx();
    const v = new TapeVoice(ctx, buf(ctx), {} as AudioNode);
    v.setRate(1);
    raw.currentTime = 2;
    v.setRate(0);
    expect(sources.at(-1)!.stopped).toBe(true);
    raw.currentTime = 5;
    expect(v.position()).toBeCloseTo(2);
    expect(v.playing).toBe(false);
  });

  it("sans boucle, ne repart pas au-delà de la fin ni avant le début", () => {
    const { ctx, sources } = fakeCtx();
    const v = new TapeVoice(ctx, buf(ctx), {} as AudioNode);
    v.seek(10);
    const n = sources.length;
    v.setRate(1);
    expect(sources.length).toBe(n);
    v.setRate(-1);
    expect(sources.length).toBe(n + 1);
  });

  it("en boucle, la position tourne dans la région", () => {
    const { ctx, raw } = fakeCtx();
    const v = new TapeVoice(ctx, buf(ctx), {} as AudioNode);
    v.loop = true;
    v.loopStart = 2;
    v.loopEnd = 4;
    v.seek(2);
    v.setRate(1);
    raw.currentTime = 3;
    expect(v.position()).toBeCloseTo(3);
    v.setRate(-1);
    raw.currentTime = 4.5;
    expect(v.position()).toBeGreaterThanOrEqual(2);
    expect(v.position()).toBeLessThan(4);
  });

  it("ignore une vitesse non numérique", () => {
    const { ctx } = fakeCtx();
    const v = new TapeVoice(ctx, buf(ctx), {} as AudioNode);
    v.setRate(NaN);
    expect(v.currentRate).toBe(0);
  });
});

describe("sonic-tape", () => {
  it("est enregistré et expose un état initial", () => {
    const el = document.createElement("sonic-tape") as HTMLElement & { getState(): { status: string; rate: number } };
    expect(el.getState()).toMatchObject({ status: "idle", rate: 0 });
  });
});
