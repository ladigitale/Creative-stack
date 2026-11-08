import { afterEach, describe, expect, it, vi } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine } from "../../shared/audio/engine";
import { FakeAudioContext } from "../sound/fake-audio";
import { analyserSettings, estimatePitch, readAnalyserParams, type SonicAudioAnalyser } from "./analyser";
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
