import { describe, expect, it } from "vitest";
import { OneEuro, oneEuroFor } from "./one-euro";

describe("OneEuro", () => {
  it("première valeur inchangée, bruit lissé à l'arrêt", () => {
    const f = new OneEuro(0.5, 8);
    expect(f.filter(0.5, 0)).toBe(0.5);
    let maxDev = 0;
    for (let i = 1; i <= 60; i++) {
      const noisy = 0.5 + (i % 2 ? 0.01 : -0.01);
      maxDev = Math.max(maxDev, Math.abs(f.filter(noisy, i * 33) - 0.5));
    }
    expect(maxDev).toBeLessThan(0.006);
  });
  it("suit un mouvement rapide avec un faible retard", () => {
    const f = new OneEuro(0.5, 8);
    f.filter(0, 0);
    let y = 0;
    for (let i = 1; i <= 30; i++) y = f.filter(i / 30, i * 33);
    expect(y).toBeGreaterThan(0.85);
  });
  it("oneEuroFor(0) désactive le lissage", () => {
    expect(oneEuroFor(0)).toBeNull();
    expect(oneEuroFor(0.5)).toBeInstanceOf(OneEuro);
    expect(oneEuroFor(NaN)).toBeNull();
  });
});

import { Smoother } from "./one-euro";

describe("Smoother", () => {
  it("un filtre par clé, amortit un saut, reset repart de zéro", () => {
    const s = new Smoother(0.9);
    expect(s.apply("a", 0.5, 0)).toBe(0.5);
    expect(s.apply("b", 0.1, 0)).toBe(0.1);
    const next = s.apply("a", 0.9, 33);
    expect(next).toBeGreaterThan(0.5);
    expect(next).toBeLessThan(0.9);
    s.reset();
    expect(s.apply("a", 0.9, 66)).toBe(0.9);
  });
  it("smooth 0 : valeur inchangée", () => {
    expect(new Smoother(0).apply("a", 0.3, 0)).toBe(0.3);
  });
});
