import { describe, expect, it } from "vitest";
import {
  clamp,
  matrix,
  rand,
  randInt,
  range,
  rotate,
  immutableSet,
} from "./helpers";

describe("interactive helpers", () => {
  it("rand is deterministic for a seed sequence", () => {
    const a = rand(1);
    const b = rand(a.seed);
    const a2 = rand(1);
    expect(a.value).toBeGreaterThanOrEqual(0);
    expect(a.value).toBeLessThan(1);
    expect(a2.value).toBe(a.value);
    expect(b.seed).not.toBe(a.seed);
  });

  it("randInt stays in range", () => {
    let seed = 42;
    for (let i = 0; i < 20; i++) {
      const r = randInt(seed, 7);
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThan(7);
      seed = r.seed;
    }
  });

  it("matrix / rotate / set / clamp / range", () => {
    expect(matrix(2, 3, 1)).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
    expect(rotate([
      [1, 2],
      [3, 4],
    ])).toEqual([
      [3, 1],
      [4, 2],
    ]);
    expect(immutableSet({ a: { b: 1 } }, "a.b", 2)).toEqual({ a: { b: 2 } });
    expect(clamp(5, 0, 3)).toBe(3);
    expect(range(3)).toEqual([0, 1, 2]);
  });
});
