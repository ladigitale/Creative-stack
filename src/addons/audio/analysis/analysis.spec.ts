import { describe, expect, it } from "vitest";
import { hzToNote, yinPitch } from "./pitch";
import { OnsetDetector, spectralFlux } from "./onset";
import { BeatClock, estimateTempo, OnsetEnvelope } from "./tempo";

const SR = 44100;
const tone = (hz: number, harmonics = [1], n = 2048, amp = 0.5) =>
  Float32Array.from({ length: n }, (_, i) => harmonics.reduce((a, h, k) => a + h * Math.sin((2 * Math.PI * hz * (k + 1) * i) / SR), 0) * amp);

let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/** Spectre d'amplitude façon AnalyserNode (fenêtre de Blackman, dB ramenés à 0..1 sur -100..-30 dB). */
function spectrum(frame: Float32Array): Float32Array {
  const n = frame.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / n) + 0.08 * Math.cos((4 * Math.PI * i) / n);
    re[i] = frame[i] * w;
  }
  // FFT radix 2 itérative
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(a * k);
        const s = Math.sin(a * k);
        const xr = re[i + k + len / 2] * c - im[i + k + len / 2] * s;
        const xi = re[i + k + len / 2] * s + im[i + k + len / 2] * c;
        re[i + k + len / 2] = re[i + k] - xr;
        im[i + k + len / 2] = im[i + k] - xi;
        re[i + k] += xr;
        im[i + k] += xi;
      }
    }
  }
  const out = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    const db = 20 * Math.log10(Math.hypot(re[i], im[i]) / n + 1e-12);
    out[i] = Math.max(0, Math.min(1, (db + 100) / 70));
  }
  return out;
}

describe("yinPitch", () => {
  it("sinus 440 Hz → A4 à ±5 cents, netteté élevée", () => {
    const p = yinPitch(tone(440), SR)!;
    expect(p.note).toBe("A4");
    expect(p.midi).toBe(69);
    expect(Math.abs(p.cents)).toBeLessThanOrEqual(5);
    expect(Math.abs(p.hz - 440)).toBeLessThan(1.5);
    expect(p.clarity).toBeGreaterThan(0.9);
  });

  it("sons riches en harmoniques, sans erreur d'octave ; notes et cents", () => {
    for (const hz of [82.41, 110, 196, 261.63, 659.25, 987.77]) {
      const p = yinPitch(tone(hz, [1, 0.6, 0.4, 0.3]), SR)!;
      expect(p, `${hz} Hz`).not.toBeNull();
      expect(Math.abs(1200 * Math.log2(p.hz / hz)), `${hz} Hz`).toBeLessThan(5);
    }
    expect(yinPitch(tone(261.63 * Math.pow(2, 0.3 / 12)), SR)).toMatchObject({ note: "C4", cents: 30 });
  });

  it("silence et bruit : null", () => {
    expect(yinPitch(new Float32Array(2048), SR)).toBeNull();
    expect(yinPitch(Float32Array.from({ length: 2048 }, () => (rnd() - 0.5) * 0.8), SR)).toBeNull();
  });

  it("hzToNote", () => {
    expect(hzToNote(440)).toEqual({ note: "A4", midi: 69, cents: 0 });
    expect(hzToNote(277.18)).toMatchObject({ note: "C#4", midi: 61 });
    expect(hzToNote(0)).toBeNull();
  });
});

describe("OnsetDetector", () => {
  it("flux spectral : hausses seulement", () => {
    expect(spectralFlux(null, [1, 1])).toBe(0);
    expect(spectralFlux([0, 1], [1, 0])).toBe(0.5);
  });

  it("seuil adaptatif : une attaque par clic, rien sur un fond stable", () => {
    const d = new OnsetDetector();
    let count = 0;
    for (let f = 0; f < 300; f++) {
      const t = f * (1000 / 60);
      const click = f % 30 === 10; // 2 par seconde
      const flux = 0.003 + rnd() * 0.002 + (click ? 0.08 : 0);
      const r = d.push(flux, t);
      if (r.onset) {
        count++;
        expect(r.strength).toBeGreaterThan(0.5);
      }
    }
    expect(count).toBe(10);
  });
});

describe("estimateTempo", () => {
  it("enveloppe de clics à 120 BPM (images à 60 Hz irrégulières) → 120 ± 2", () => {
    const env = new OnsetEnvelope(50, 8);
    let t = 0;
    let lastClick = -1;
    while (t < 9000) {
      t += 1000 / 60 + (rnd() - 0.5) * 6;
      const k = Math.floor(t / 500);
      env.add(t, k !== lastClick ? 1 : 0);
      lastClick = k;
    }
    const est = estimateTempo(env.values(), env.fps)!;
    expect(Math.abs(est.bpm - 120)).toBeLessThanOrEqual(2);
    expect(est.confidence).toBeGreaterThan(0.3);
  });

  it("chaîne complète : signal de clics à 120 BPM → flux spectral → attaques → 120 ± 2", () => {
    const len = Math.round(SR * 9);
    const audio = new Float32Array(len);
    for (let i = 0; i < len; i++) audio[i] = (rnd() - 0.5) * 0.002;
    for (let c = 0.25; c < 9; c += 0.5) {
      const s = Math.round(c * SR);
      for (let i = 0; i < 400 && s + i < len; i++) audio[s + i] += (rnd() - 0.5) * 1.6 * Math.exp(-i / 80);
    }
    const det = new OnsetDetector();
    const env = new OnsetEnvelope(50, 8);
    const beat = new BeatClock();
    let prev: Float32Array | null = null;
    let onsets = 0;
    let beats = 0;
    const hop = SR / 60;
    for (let f = 0; (f + 1) * hop + 1024 < len; f++) {
      const start = Math.round(f * hop);
      const spec = spectrum(audio.subarray(start, start + 1024));
      const tMs = ((start + 1024) / SR) * 1000;
      const r = det.push(spectralFlux(prev, spec), tMs);
      prev = spec;
      if (r.onset) onsets++;
      env.add(tMs, r.novelty);
      if (f % 15 === 0 && tMs > 3000) {
        const est = estimateTempo(env.values(), env.fps);
        if (est) beat.sync(env.endMs - est.lastBeatAgo * 1000, est.bpm);
      }
      if (beat.update(tMs).beat) beats++;
    }
    expect(onsets).toBeGreaterThanOrEqual(16);
    expect(onsets).toBeLessThanOrEqual(18);
    const est = estimateTempo(env.values(), env.fps)!;
    expect(Math.abs(est.bpm - 120)).toBeLessThanOrEqual(2);
    expect(beats).toBeGreaterThanOrEqual(10);
    expect(beats).toBeLessThanOrEqual(13);
  });

  it("autres tempos et cas vides", () => {
    for (const bpm of [66, 75, 90, 100, 140, 174, 195]) {
      const env = new OnsetEnvelope(50, 8);
      const period = 60000 / bpm;
      for (let t = 0; t < 8500; t += 1000 / 60) env.add(t, t % period < 1000 / 60 ? 1 : 0);
      expect(Math.abs(estimateTempo(env.values(), env.fps)!.bpm - bpm), `${bpm}`).toBeLessThanOrEqual(2);
    }
    expect(estimateTempo(new Float32Array(400), 50)).toBeNull();
    expect(estimateTempo(new Float32Array(50), 50)).toBeNull();
  });

  it("BeatClock : un temps par période, phase 0..1", () => {
    const b = new BeatClock();
    b.sync(0, 120);
    let beats = 0;
    for (let t = 1; t <= 4000; t += 16) if (b.update(t).beat) beats++;
    expect(beats).toBe(8);
    expect(b.update(4250).phase).toBeCloseTo(0.5, 1);
  });
});
