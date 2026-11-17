import { describe, expect, it } from "vitest";
import { parseColorList, parseCssColor } from "./theme-colors";

describe("couleurs du thème (sonic-shader colors)", () => {
  it("liste : espaces ou virgules, fonctions gardées entières, 8 au plus", () => {
    expect(parseColorList("--sc-base-50 --sc-accent, #ff0080")).toEqual(["--sc-base-50", "--sc-accent", "#ff0080"]);
    expect(parseColorList("rgb(1, 2, 3) --x")).toEqual(["rgb(1, 2, 3)", "--x"]);
    expect(parseColorList(Array.from({ length: 12 }, (_, i) => `--c${i}`).join(" "))).toHaveLength(8);
    expect(parseColorList("")).toEqual([]);
  });

  it("formats de getComputedStyle et hexadécimal", () => {
    expect(parseCssColor("rgb(255, 0, 51)")).toEqual([1, 0, 0.2, 1]);
    expect(parseCssColor("rgba(0, 0, 0, 0.5)")).toEqual([0, 0, 0, 0.5]);
    expect(parseCssColor("rgb(255 128 0 / 25%)")?.map((n) => Math.round(n * 100) / 100)).toEqual([1, 0.5, 0, 0.25]);
    expect(parseCssColor("color(srgb 0.1 0.2 0.3)")).toEqual([0.1, 0.2, 0.3, 1]);
    expect(parseCssColor("#d7f23f")?.map((n) => Math.round(n * 255))).toEqual([215, 242, 63, 255]);
    expect(parseCssColor("#fff8")?.[3]).toBeCloseTo(0.533, 2);
    expect(parseCssColor("oklch(0.7 0.1 120)")).toBeNull();
    expect(parseCssColor("")).toBeNull();
  });
});
