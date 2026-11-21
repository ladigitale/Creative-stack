import { describe, expect, it } from "vitest";
import { computePeaks, formatTime, placeholderPeaks, readSrc } from "./player";

describe("sonic-audio-player", () => {
  it("lit une URL ou une SonicMediaRef", () => {
    expect(readSrc(" data:audio/webm;base64,AA ")).toBe("data:audio/webm;base64,AA");
    expect(readSrc({ url: "blob:x" })).toBe("blob:x");
    expect(readSrc(null)).toBe("");
    expect(readSrc({ blob: 1 })).toBe("");
  });

  it("formate le temps", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(7.9)).toBe("0:07");
    expect(formatTime(75)).toBe("1:15");
    expect(formatTime(Infinity)).toBe("0:00");
    expect(formatTime(NaN)).toBe("0:00");
  });

  it("calcule des crêtes normalisées", () => {
    const data = new Float32Array(1000);
    for (let i = 500; i < 1000; i++) data[i] = i % 2 ? 0.5 : -0.25;
    const p = computePeaks(data, 4);
    expect(p).toHaveLength(4);
    expect(p[0]).toBe(0);
    expect(p[3]).toBeCloseTo(1);
    expect(computePeaks(new Float32Array(0), 3)).toEqual([0, 0, 0]);
    expect(computePeaks(new Float32Array(10), 5)).toEqual([0, 0, 0, 0, 0]);
  });

  it("garde les mêmes barres d'attente pour une même URL", () => {
    const a = placeholderPeaks("data:audio/webm;base64,AAAA", 20);
    expect(a).toEqual(placeholderPeaks("data:audio/webm;base64,AAAA", 20));
    expect(a.every((v) => v >= 0.25 && v <= 0.7)).toBe(true);
  });
});
