import { afterEach, describe, expect, it, vi } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine } from "../../shared/audio/engine";
import { FakeAudioContext } from "../sound/fake-audio";
import { analyserSettings, estimatePitch, parseFeatures, readAnalyserParams, type SonicAudioAnalyser } from "./analyser";
import { registerStore, unregisterStore, type SonicActionMessage } from "../interactive/registry";
import "./analyser";
import { safeSampleUrl } from "./sampler";

const SR = 44100;
const tone = (hz: number, harmonics = [1], n = 2048) =>
  Float32Array.from({ length: n }, (_, i) => harmonics.reduce((a, amp, k) => a + amp * Math.sin((2 * Math.PI * hz * (k + 1) * i) / SR), 0) * 0.5);

describe("estimatePitch", () => {
  it("sinus et sons riches en harmoniques, sans erreur d'octave", () => {
    for (const hz of [82.41, 110, 220, 440, 659.25, 880]) {
      expect(estimatePitch(tone(hz), SR)!, `${hz} Hz`).toBeCloseTo(hz, -0.3);
      expect(estimatePitch(tone(hz, [1, 0.6, 0.4, 0.3]), SR)!, `${hz} Hz riche`).toBeCloseTo(hz, -0.3);
    }
  });

  it("silence et bruit : null", () => {
    expect(estimatePitch(new Float32Array(2048), SR)).toBeNull();
    let seed = 1;
    const noise = Float32Array.from({ length: 2048 }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.8);
    expect(estimatePitch(noise, SR)).toBeNull();
  });
});

describe("safeSampleUrl", () => {
  it("accepte https, blob, data:audio et relatif ; refuse le reste", () => {
    for (const ok of ["https://cdn.example.org/kick.wav", "blob:https://x/1", "data:audio/wav;base64,AAA", "sons/kick.wav", "/s/a.mp3"]) {
      expect(safeSampleUrl(ok), ok).toBe(true);
    }
    for (const bad of ["javascript:alert(1)", "http://insecure.org/a.wav", "data:text/html,<b>", "file:///etc/passwd", "ftp://x/a", ""]) {
      expect(safeSampleUrl(bad), bad).toBe(false);
    }
  });
});

describe("sonic-audio-analyser : pilotage par DataProvider", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    AudioEngine.reset();
    AudioEngine.setContextFactory(null);
    vi.restoreAllMocks();
  });

  it("readAnalyserParams : clés reconnues, bornes, fft en puissance de 2", () => {
    expect(readAnalyserParams({ bands: 200, fft: 1000, smoothing: 2, pitch: true, onsetThreshold: "3", rate: 0, autre: 1 })).toEqual({
      bands: 64, fft: 1024, smoothing: 0.99, pitch: true, onsetThreshold: 3, rate: 1,
    });
    expect(readAnalyserParams({ fft: "abc", pitch: "oui" })).toEqual({});
    expect(readAnalyserParams(null)).toEqual({});
  });

  it("analyserSettings : params l'emporte sur les attributs ; 0 = défaut pour bands, fft, rate", () => {
    const attrs = { bands: 0, fft: 0, smoothing: 0, pitch: false, onsetThreshold: 1.5, rate: 0 };
    expect(analyserSettings(attrs)).toEqual({ bands: 16, fft: 2048, smoothing: 0, pitch: false, onsetThreshold: 1.5, rate: 30 });
    expect(analyserSettings(attrs, { bands: 8, pitch: true })).toMatchObject({ bands: 8, pitch: true, smoothing: 0 });
  });

  it("sans WebAudio : status unsupported avec une erreur lisible", async () => {
    document.body.innerHTML = `<sonic-audio-analyser out-data-provider="anU"></sonic-audio-analyser>`;
    await (document.querySelector("sonic-audio-analyser") as SonicAudioAnalyser).updateComplete;
    expect(get("anU")).toMatchObject({ status: "unsupported", error: expect.stringContaining("WebAudio") });
  });

  it("params en direct : reconfigure le même AnalyserNode et publie les réglages", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null); // pas de canvas sous jsdom
    const nodes: FakeAnalyser[] = [];
    class Ctx extends FakeAudioContext {
      createAnalyser() {
        const a = new FakeAnalyser(this);
        nodes.push(a);
        return a;
      }
    }
    AudioEngine.setContextFactory(() => new Ctx() as unknown as BaseAudioContext);
    await AudioEngine.get().unlock();
    document.body.innerHTML = `<sonic-audio-analyser params="anP" out-data-provider="anS" fft="1024"></sonic-audio-analyser>`;
    const el = document.querySelector("sonic-audio-analyser") as SonicAudioAnalyser;
    await el.updateComplete;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].fftSize).toBe(1024);
    set("anP", { fft: 512, smoothing: 0.2, bands: 8, pitch: true, rate: 60 });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].fftSize).toBe(512);
    expect(nodes[0].smoothingTimeConstant).toBe(0.2);
    expect(el.settings()).toMatchObject({ fft: 512, bands: 8, pitch: true, rate: 60 });
    expect(get("anS")).toMatchObject({ error: null, settings: { fft: 512, bands: 8, smoothing: 0.2, pitch: true, rate: 60 } });
    // clé retirée : l'attribut reprend la main
    set("anP", { bands: 8 });
    expect(nodes[0].fftSize).toBe(1024);
    expect(nodes[0].smoothingTimeConstant).toBe(0.7);
  });
});

describe("sonic-audio-analyser : analyse musicale (features)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    AudioEngine.reset();
    AudioEngine.setContextFactory(null);
    unregisterStore("rythme");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("parseFeatures : mots reconnus seulement", () => {
    expect(parseFeatures("tempo  pitch,onset autre pitch")).toEqual(["pitch", "onset", "tempo"]);
    expect(parseFeatures("")).toEqual([]);
  });

  const run = async (html: string, seconds: number) => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const nodes: ScriptedAnalyser[] = [];
    class Ctx extends FakeAudioContext {
      createAnalyser() {
        const a = new ScriptedAnalyser(this, () => now);
        nodes.push(a);
        return a;
      }
    }
    AudioEngine.setContextFactory(() => new Ctx() as unknown as BaseAudioContext);
    await AudioEngine.get().unlock();
    document.body.innerHTML = html;
    const el = document.querySelector("sonic-audio-analyser") as SonicAudioAnalyser;
    await el.updateComplete;
    const loop = (el as unknown as { loop: () => void }).loop;
    for (now = 1; now < seconds * 1000; now += 1000 / 60) loop();
    return { el, node: nodes[0] };
  };

  it("pitch, attaques et tempo : A4, une attaque par clic, 120 BPM, actions vers le store", async () => {
    const actions: SonicActionMessage[] = [];
    registerStore({ id: "rythme", dispatch: (a) => actions.push(a), getState: () => null, reset: () => {} });
    await run(`<sonic-audio-analyser features="pitch onset tempo" target="rythme" out-data-provider="anM" fft="1024"></sonic-audio-analyser>`, 9);
    const st = get("anM") as Record<string, any>;
    expect(st.features).toEqual(["pitch", "onset", "tempo"]);
    expect(st.pitch).toMatchObject({ note: "A4", midi: 69 });
    expect(Math.abs(st.pitch.cents)).toBeLessThanOrEqual(5);
    expect(st.pitchHz).toBeCloseTo(440, -1);
    expect(st.attack.count).toBeGreaterThanOrEqual(17);
    expect(st.attack.count).toBeLessThanOrEqual(18);
    expect(st.attack.lastOnsetAt).toBeGreaterThan(8000);
    expect(Math.abs(st.tempo.bpm - 120)).toBeLessThanOrEqual(2);
    expect(st.tempo.confidence).toBeGreaterThan(0.2);
    expect(st.tempo.phase).toBeGreaterThanOrEqual(0);
    expect(st.tempo.phase).toBeLessThan(1);
    const onsets = actions.filter((a) => a.type === "audio:onset");
    const beats = actions.filter((a) => a.type === "audio:beat");
    expect(onsets).toHaveLength(st.attack.count);
    expect(onsets[0].payload).toMatchObject({ count: 1, strength: expect.any(Number) });
    expect(beats.length).toBeGreaterThanOrEqual(8);
    expect(beats.at(-1)!.payload).toMatchObject({ beat: st.tempo.beat });
  });

  it("sans features : aucune clé ajoutée, spectre lu seulement aux publications", async () => {
    const { node } = await run(`<sonic-audio-analyser out-data-provider="anD" rate="10"></sonic-audio-analyser>`, 2);
    const st = get("anD") as Record<string, unknown>;
    expect(st).not.toHaveProperty("tempo");
    expect(st).not.toHaveProperty("pitch");
    expect(st).not.toHaveProperty("attack");
    expect(node.reads).toBeLessThanOrEqual(21);
  });
});

/** Analyseur factice : sinus 440 Hz, spectre qui monte d'un coup toutes les 500 ms (clic). */
class ScriptedAnalyser {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  reads = 0;
  private seed = 3;
  constructor(
    readonly context: FakeAudioContext,
    private clock: () => number,
  ) {}
  connect(n: unknown) {
    return n;
  }
  disconnect() {}
  getFloatTimeDomainData(a: Float32Array) {
    const t0 = this.clock() / 1000;
    for (let i = 0; i < a.length; i++) a[i] = 0.5 * Math.sin(2 * Math.PI * 440 * (t0 + i / this.context.sampleRate));
  }
  getByteFrequencyData(a: Uint8Array) {
    this.reads++;
    const t = this.clock();
    const click = t % 500 < 1000 / 60;
    for (let i = 0; i < a.length; i++) {
      this.seed = (this.seed * 16807) % 2147483647;
      a[i] = click ? 220 : 30 + (this.seed % 6);
    }
  }
}

class FakeAnalyser {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  constructor(readonly context: FakeAudioContext) {}
  connect(n: unknown) {
    return n;
  }
  disconnect() {}
  getFloatTimeDomainData() {}
  getByteFrequencyData() {}
}
