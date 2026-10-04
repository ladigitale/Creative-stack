import { describe, expect, it } from "vitest";
import { estimatePitch } from "./analyser";
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
