import { describe, expect, it } from "vitest";
import { simplifyMesh } from "./simplify";
import { ellipsoid, box } from "./prims";
import { Mesh } from "./mesh";

describe("simplification pour la vue de loin", () => {
  it("réduit fortement les triangles en gardant l'emprise et les rôles", () => {
    const m = new Mesh().append(ellipsoid(1, 0.6, 0.8, 4, 32, 20)).append(box(0.3, 0.3, 0.3, 7), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1]);
    const s = simplifyMesh(m, 0.2);
    expect(s.triangleCount).toBeLessThan(m.triangleCount * 0.6);
    expect(s.triangleCount).toBeGreaterThan(20);
    const b0 = m.bounds(), b1 = s.bounds();
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(b1.min[k] - b0.min[k])).toBeLessThan(0.25);
      expect(Math.abs(b1.max[k] - b0.max[k])).toBeLessThan(0.25);
    }
    expect(new Set(s.role)).toEqual(new Set(m.role));
    expect(s.pos.every(Number.isFinite) && s.nrm.every(Number.isFinite)).toBe(true);
  });
});
