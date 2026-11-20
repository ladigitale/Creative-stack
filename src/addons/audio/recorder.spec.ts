import { describe, expect, it } from "vitest";
import { onOff } from "./recorder";

describe("sonic-audio-recorder : control.recording", () => {
  it("accepte les booléens et les valeurs d'un bouton bascule", () => {
    expect(onOff(true)).toBe(true);
    expect(onOff(false)).toBe(false);
    expect(onOff("on")).toBe(true);
    expect(onOff("yes")).toBe(true);
    expect(onOff("")).toBe(false);
    expect(onOff(null)).toBe(false);
    expect(onOff("false")).toBe(false);
    expect(onOff("0")).toBe(false);
    expect(onOff(undefined)).toBeUndefined();
    expect(onOff({})).toBeUndefined();
  });
});
