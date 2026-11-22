import { describe, expect, it } from "vitest";
import { steadyCorners, type Corners } from "./steady";

const quad = (dx = 0, dy = 0): Corners => [
  { x: 0.2 + dx, y: 0.2 + dy }, { x: 0.8 + dx, y: 0.2 + dy }, { x: 0.8 + dx, y: 0.8 + dy }, { x: 0.2 + dx, y: 0.8 + dy },
];

describe("steadyCorners", () => {
  it("attend n mesures", () => {
    expect(steadyCorners([quad(), quad()])).toBeNull();
  });

  it("refuse tant que la zone bouge, accepte une fois immobile", () => {
    expect(steadyCorners([quad(0), quad(0.02), quad(0.04)])).toBeNull();
    const r = steadyCorners([quad(0.04), quad(0.001), quad(-0.002), quad(0.0015)]);
    expect(r?.index).toBe(3);
    // médiane des trois dernières : 0.001, -0.002, 0.0015 → 0.001
    expect(r?.corners[0].x).toBeCloseTo(0.201, 6);
  });

  it("ignore une mesure aberrante isolée grâce à la médiane, mais pas un saut", () => {
    expect(steadyCorners([quad(), quad(0.05), quad()])).toBeNull();
  });

  it("ignore les zones incomplètes", () => {
    expect(steadyCorners([quad(), quad(), quad().slice(0, 3)])).toBeNull();
  });
});
