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
