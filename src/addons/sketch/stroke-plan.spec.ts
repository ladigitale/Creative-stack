import { describe, expect, it } from "vitest";
import { eachStamp, LOD_PX, strokePlan } from "./render";
import type { Stroke, StrokeBrush } from "./model";

const brush = (o: Partial<StrokeBrush> = {}): StrokeBrush => ({
  size: 10, hardness: 0.8, opacity: 1, spacing: 0.1, color: "#000000", pressure: false, tip: "", angle: 0, angleFollow: false,
  angleJitter: 0, sizeJitter: 0, scatter: 0, roundness: 1, ...o,
});
const line = (b: StrokeBrush, len = 200): Stroke => ({ id: 1, brush: b, pts: [0, 0, 1, len, 0, 1], seed: 7, bbox: { x: 0, y: 0, w: len, h: 1 } });

describe("strokePlan (même décision pour le rendu 2D et le rendu WebGL)", () => {
  it("trait opaque normal : empreintes posées directement", () => {
    expect(strokePlan(line(brush()), 1)).toEqual({ kind: "direct", stampAlpha: 1, blend: undefined });
  });
  it("trait translucide ou en fusion : tampon posé avec l'opacité et le mode du trait", () => {
    expect(strokePlan(line(brush({ opacity: 0.4 })), 1)).toMatchObject({ kind: "group", alpha: 0.4 });
    expect(strokePlan(line(brush({ blend: "multiply" })), 1)).toMatchObject({ kind: "group", blend: "multiply" });
  });
  it("touche unique : posée directement avec son opacité et son mode", () => {
    const one: Stroke = { ...line(brush({ opacity: 0.3, blend: "screen" })), pts: [5, 5, 1], bbox: { x: 0, y: 0, w: 10, h: 10 } };
    expect(strokePlan(one, 1)).toEqual({ kind: "direct", stampAlpha: 0.3, blend: "screen" });
  });
  it("trait minuscule à l'écran : direct, opacité répartie sur les empreintes", () => {
    const p = strokePlan(line(brush({ opacity: 0.5 })), (LOD_PX * 0.5) / 10);
    expect(p.kind).toBe("direct");
    if (p.kind === "direct") expect(p.stampAlpha).toBeLessThan(0.5);
  });
  it("gomme en empreintes : tampon ôté", () => {
    expect(strokePlan({ ...line(brush({ opacity: 0.7 })), erase: true }, 1)).toMatchObject({ kind: "group", erase: true, alpha: 0.7 });
  });
  it("niveau de détail : moins d'empreintes au dézoom, même densité cumulée", () => {
    const st = line(brush({ opacity: 0.5 }), 400);
    let full = 0, far = 0, kmax = 1;
    eachStamp(st, 1, () => full++);
    eachStamp(st, 0.02, (_p, k) => { far++; kmax = Math.max(kmax, k); });
    expect(far).toBeLessThan(full / 3);
    expect(kmax).toBeGreaterThan(1);
  });
});
