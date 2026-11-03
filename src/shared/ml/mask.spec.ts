import { describe, expect, it } from "vitest";
import { maskStats, maskToRgba } from "./mask";

/** Masque 4×2 : colonnes 2 et 3 de la ligne 0 à 255. */
const M = new Uint8ClampedArray([0, 0, 255, 255, 0, 0, 0, 0]);

describe("maskStats", () => {
  it("couverture, centre, boîte", () => {
    const s = maskStats(M, 4, 2);
    expect(s.coverage).toBeCloseTo(2 / 8);
    expect(s.cx).toBeCloseTo(0.75); // pixels 2 et 3 → (2,5 + 0,5)/4 … moyenne 2,5 → 3/4
    expect(s.cy).toBeCloseTo(0.25); // ligne 0 → 0,5/2
    expect([s.x0, s.x1, s.y0, s.y1]).toEqual([0.5, 1, 0, 0.5]);
  });
  it("miroir : x inversé", () => {
    const s = maskStats(M, 4, 2, 128, true);
    expect(s.cx).toBeCloseTo(0.25);
    expect([s.x0, s.x1]).toEqual([0, 0.5]);
  });
  it("seuil ; masque vide ou taille nulle : neutre", () => {
    expect(maskStats(M, 4, 2, 256).coverage).toBe(0);
    expect(maskStats(new Uint8ClampedArray(8), 4, 2)).toMatchObject({ coverage: 0, cx: 0.5, cy: 0.5 });
    expect(maskStats([], 0, 0).coverage).toBe(0);
  });
});

describe("maskToRgba", () => {
  it("gray : r=g=b=masque, alpha 255", () => {
    const px = maskToRgba(M, 4, 2, "gray", false, false);
    expect(px).toHaveLength(32);
    expect([...px.slice(8, 12)]).toEqual([255, 255, 255, 255]);
    expect([...px.slice(0, 4)]).toEqual([0, 0, 0, 255]);
  });
  it("alpha : blanc, alpha = masque", () => {
    const px = maskToRgba(M, 4, 2, "alpha", false, false);
    expect([...px.slice(8, 12)]).toEqual([255, 255, 255, 255]);
    expect([...px.slice(0, 4)]).toEqual([255, 255, 255, 0]);
  });
  it("miroir et inversion", () => {
    const mirrored = maskToRgba(M, 4, 2, "gray", true, false);
    expect(mirrored[0]).toBe(255); // pixel 0 ← colonne 3
    expect(mirrored[8]).toBe(0); // pixel 2 ← colonne 1
    const inv = maskToRgba(M, 4, 2, "gray", false, true);
    expect(inv[0]).toBe(255);
    expect(inv[8]).toBe(0);
  });
});
