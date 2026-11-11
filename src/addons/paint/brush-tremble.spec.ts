import { describe, expect, it } from "vitest";
import { BRUSH_DEFAULTS, Trembler, noise1, sanitizeBrush } from "./brush";

describe("tremblement du tracé", () => {
  it("sans tremblement : points et pression inchangés", () => {
    const t = new Trembler(42);
    for (let i = 0; i < 20; i++) expect(t.apply(i * 5, 10, 0.8, 0, 20)).toEqual({ x: i * 5, y: 10, p: 0.8 });
  });

  it("avec tremblement : décalage perpendiculaire borné, épaisseur qui respire, déterministe par graine", () => {
    const run = (seed: number) => { const t = new Trembler(seed); const out = []; for (let i = 0; i < 60; i++) out.push(t.apply(i * 4, 100, 1, 1, 20)); return out; };
    const a = run(7), b = run(7), c = run(8);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    // trait horizontal : x intact, y ondule de ±(1,35 × diamètre/2) au plus
    for (const [i, p] of a.entries()) { expect(p.x).toBeCloseTo(i * 4, 6); expect(Math.abs(p.y - 100)).toBeLessThanOrEqual(13.5 + 1e-9); expect(p.p).toBeGreaterThanOrEqual(0.45 - 1e-9); expect(p.p).toBeLessThanOrEqual(1); }
    const ys = a.map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(2);
  });

  it("noise1 dans [0,1] et continu", () => {
    for (let x = 0; x < 10; x += 0.01) { const v = noise1(x, 3); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); expect(Math.abs(noise1(x + 0.001, 3) - v)).toBeLessThan(0.01); }
  });

  it("sanitizeBrush borne tremble", () => {
    expect(sanitizeBrush(BRUSH_DEFAULTS, { tremble: 3 }).tremble).toBe(1);
    expect(sanitizeBrush(BRUSH_DEFAULTS, { tremble: -1 }).tremble).toBe(0);
    expect(sanitizeBrush(BRUSH_DEFAULTS, { tremble: "x" }).tremble).toBe(0);
  });
});
