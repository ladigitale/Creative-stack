import { describe, expect, it } from "vitest";
import { HARMONY_RULES, harmony, hueOffsets, oklchToHex, parseHex, rgbToOklch, sanitizeRule, toHex } from "./core";

const hueDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

describe("conversions", () => {
  it("hex ↔ OKLCH aller-retour", () => {
    for (const hex of ["#000000", "#ffffff", "#c2410c", "#1d4ed8", "#15803d", "#808080"]) {
      expect(oklchToHex(rgbToOklch(parseHex(hex)!))).toBe(hex);
    }
  });
  it("valeurs de référence OKLCH", () => {
    const red = rgbToOklch([1, 0, 0]);
    expect(red.l).toBeCloseTo(0.628, 2);
    expect(red.c).toBeCloseTo(0.2577, 2);
    expect(red.h).toBeCloseTo(29.23, 0);
    expect(rgbToOklch([1, 1, 1]).l).toBeCloseTo(1, 3);
  });
  it("lit #rgb et refuse le reste", () => {
    expect(toHex(parseHex("#f80")!)).toBe("#ff8800");
    expect(parseHex("red")).toBeNull();
    expect(parseHex("#12345g")).toBeNull();
    expect(parseHex(12)).toBeNull();
  });
  it("hors gamut : baisse la saturation, garde la teinte", () => {
    const hex = oklchToHex({ l: 0.7, c: 0.5, h: 150 });
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(hueDiff(rgbToOklch(parseHex(hex)!).h, 150)).toBeLessThan(3);
  });
});

describe("règles", () => {
  it("décalages de teinte", () => {
    expect(hueOffsets("complementary")).toEqual([0, 180]);
    expect(hueOffsets("triadic")).toEqual([0, 120, 240]);
    expect(hueOffsets("square")).toEqual([0, 90, 180, 270]);
    expect(hueOffsets("split", 30)).toEqual([0, 150, 210]);
    expect(hueOffsets("tetradic", 30)).toEqual([0, 60, 180, 240]);
    expect(hueOffsets("analogous", 20)).toEqual([0, -20, 20, -40, 40]);
  });
  it("noms tolérés", () => {
    expect(sanitizeRule("Triadic")).toBe("triadic");
    expect(sanitizeRule("triade")).toBe("triadic");
    expect(sanitizeRule("split-complementary")).toBe("split");
    expect(sanitizeRule("n'importe", "mono")).toBe("mono");
  });
});

describe("harmony", () => {
  it("les teintes suivent la règle, à la clarté de la base", () => {
    const base = "#c2410c";
    const b = rgbToOklch(parseHex(base)!);
    const p = harmony({ base, rule: "triadic" });
    expect(p).toHaveLength(3);
    expect(p[0].hex).toBe(base);
    expect(p[0].role).toBe("base");
    for (let i = 0; i < 3; i++) {
      expect(hueDiff(p[i].hue, b.h + [0, 120, 240][i])).toBeLessThan(0.5);
      expect(p[i].l).toBeCloseTo(b.l, 2);
    }
  });
  it("complète par des nuances jusqu'au nombre demandé, sans doublon", () => {
    for (const rule of HARMONY_RULES) {
      for (const count of [1, 4, 8, 12]) {
        const p = harmony({ base: "#1d4ed8", rule, count });
        expect(p).toHaveLength(count);
        expect(new Set(p.map((c) => c.hex)).size).toBe(count);
      }
    }
  });
  it("monochrome : une seule teinte, clartés étagées", () => {
    const p = harmony({ base: "#15803d", rule: "mono", count: 7 });
    const h = p[0].hue;
    for (const c of p) expect(hueDiff(c.hue, h)).toBeLessThan(0.5);
    expect(new Set(p.map((c) => c.l)).size).toBe(7);
    expect(harmony({ base: "#15803d", rule: "mono" })).toHaveLength(5);
  });
  it("base invalide ou grise : palette quand même", () => {
    expect(harmony({ base: "pas une couleur", rule: "complementary" })).toHaveLength(2);
    const grey = harmony({ base: "#808080", rule: "complementary" });
    expect(grey[0].hex).not.toBe(grey[1].hex);
  });
});
