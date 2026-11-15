import { describe, expect, it } from "vitest";
import { groundPoint, projOf } from "./view2d";

const screen = (view: "top" | "iso" | "side" | "front", x: number, y: number, z: number) => {
  const p = projOf(view);
  return [10 + (p.px[0] * x + p.px[1] * y + p.px[2] * z) * 50, 20 + (p.py[0] * x + p.py[1] * y + p.py[2] * z) * 50];
};

describe("groundPoint : point du sol visé à l'écran", () => {
  it("inverse exact en vue de dessus et iso, à la hauteur donnée", () => {
    for (const view of ["top", "iso"] as const) {
      const [lx, ly] = screen(view, 1.3, 0.75, -2.1);
      const [x, z] = groundPoint(projOf(view), 50, 10, 20, lx, ly, 0.75, [0, 0]);
      expect(x).toBeCloseTo(1.3);
      expect(z).toBeCloseTo(-2.1);
    }
  });

  it("profil et face : l'axe horizontal de l'écran, l'autre gardé", () => {
    const [sx, sy] = screen("side", 1.3, 0, 4);
    expect(groundPoint(projOf("side"), 50, 10, 20, sx, sy, 0, [0, 0.5])).toEqual([expect.closeTo(1.3), 0.5]);
    const [fx, fy] = screen("front", 2, 0, 1.7);
    expect(groundPoint(projOf("front"), 50, 10, 20, fx, fy, 0, [2, 0])).toEqual([2, expect.closeTo(1.7)]);
  });
});
