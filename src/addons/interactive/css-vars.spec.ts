import { describe, expect, it } from "vitest";
import { isSafeVar } from "./css-vars";

describe("sonic-css-vars : valeurs acceptées", () => {
  it("couleurs et variables du thème", () => {
    expect(isSafeVar("--sc-base", "#150a2e")).toBe(true);
    expect(isSafeVar("--sc-primary", "rgb(255, 122, 26)")).toBe(true);
    expect(isSafeVar("--sc-info", "rebeccapurple")).toBe(true);
    expect(isSafeVar("--sc-base-100", "var(--sc-base)")).toBe(true);
    expect(isSafeVar("--sc-base-200", "color-mix(in srgb,var(--sc-base) 78%,var(--sc-base-content))")).toBe(true);
    expect(isSafeVar("--sc-base-300", "color-mix(in srgb,var(--sc-base) 70%,transparent)")).toBe(true);
    expect(isSafeVar("--sc-border-width", 2)).toBe(true);
    expect(isSafeVar("color-scheme", "dark")).toBe(true);
  });

  it("refuse les autres noms et les valeurs qui sortent d'une couleur", () => {
    expect(isSafeVar("background", "#fff")).toBe(false);
    expect(isSafeVar("--other", "#fff")).toBe(false);
    expect(isSafeVar("--sc-base", "url(https://x.test/a.png)")).toBe(false);
    expect(isSafeVar("--sc-base", "red; position: fixed")).toBe(false);
    expect(isSafeVar("--sc-base", "linear-gradient(red, blue)")).toBe(false);
    expect(isSafeVar("--sc-base", "red}body{display:none")).toBe(false);
    expect(isSafeVar("--sc-base", "color-mix(in srgb,url(x) 50%,red)")).toBe(false);
    expect(isSafeVar("color-scheme", "dark; x")).toBe(false);
    expect(isSafeVar("--sc-base", NaN)).toBe(false);
  });
});
