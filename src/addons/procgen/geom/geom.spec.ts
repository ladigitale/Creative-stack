import { describe, expect, it } from "vitest";
import { type V3, cross, dot, norm, sub } from "../core/math";
import { Mesh } from "./mesh";
import { box, cylinder, ellipsoid, extrude, grid, icosphere, lathe, ngon, triangulate, tube } from "./prims";
import { Field, polygonize } from "./implicit";

/** Part des triangles dont l'orientation (sens direct) concorde avec les normales de leurs sommets. */
export function windingAgreement(m: Mesh): number {
  let ok = 0;
  const n = m.idx.length / 3;
  for (let t = 0; t < m.idx.length; t += 3) {
    const [a, b, c] = [m.idx[t], m.idx[t + 1], m.idx[t + 2]];
    const fn = cross(sub(m.getPos(b), m.getPos(a)), sub(m.getPos(c), m.getPos(a)));
    const vn = norm([0, 1, 2].reduce((s, k) => [s[0] + m.getNrm(m.idx[t + k])[0], s[1] + m.getNrm(m.idx[t + k])[1], s[2] + m.getNrm(m.idx[t + k])[2]] as V3, [0, 0, 0] as V3));
    if (Math.hypot(...fn) < 1e-10 || dot(fn, vn) > 0) ok++;
  }
  return n ? ok / n : 1;
}

describe("primitives", () => {
  const cases: [string, Mesh][] = [
    ["box", box(1, 0.5, 0.3, 0)],
    ["box arrondie", box(1, 0.5, 0.3, 0, 0.1, 3)],
    ["ellipsoïde", ellipsoid(1, 0.6, 0.4, 0)],
    ["icosphère", icosphere(2)],
    ["tour", lathe([[0.3, 0], [0.4, 0.5], [0.2, 1]], 0)],
    ["cylindre", cylinder(0.2, 0.1, 1, 0)],
    ["tube", tube([[0, 0, 0], [0, 1, 0], [0.3, 2, 0.2]], [0.2, 0.15, 0.05], 0)],
    ["extrusion", extrude([[0, 0], [1, 0], [1, 1], [0.5, 1.5], [0, 1]], 0.2, 0, 0.03)],
    ["grille", grid(2, 2, 4, 4, 0)],
  ];
  for (const [name, m] of cases)
    it(`${name} : faces orientées vers l'extérieur`, () => {
      expect(m.triangleCount).toBeGreaterThan(0);
      expect(windingAgreement(m)).toBeGreaterThan(0.97);
    });

  it("triangulation d'un polygone concave", () => {
    const star = ngon(10, 1).map((p, i) => (i % 2 ? [p[0] * 0.4, p[1] * 0.4] : p) as [number, number]);
    expect(triangulate(star).length).toBe((10 - 2) * 3);
  });
});

describe("surface implicite", () => {
  it("sphère : maillage fermé, orienté, sur la surface", () => {
    const f = new Field([{ kind: "sphere", c: [0, 0, 0], r: 0.5, role: 3, tag: 0 }]);
    const { mesh } = polygonize(f, { cell: 0.05, smooth: 2 });
    expect(mesh.triangleCount).toBeGreaterThan(300);
    expect(windingAgreement(mesh)).toBeGreaterThan(0.98);
    for (let i = 0; i < mesh.vertexCount; i += 7) expect(Math.abs(Math.hypot(...mesh.getPos(i)) - 0.5)).toBeLessThan(0.03);
  });

  it("union douce seulement entre les paires déclarées", () => {
    const a = { kind: "sphere" as const, c: [-0.32, 0, 0] as V3, r: 0.3, role: 0, tag: 0 };
    const b = { kind: "sphere" as const, c: [0.32, 0, 0] as V3, r: 0.3, role: 1, tag: 1 };
    const hard = new Field([a, b]);
    const soft = new Field([a, b], [{ a: 0, b: 1, k: 0.15 }]);
    // au milieu, l'union douce comble le creux, l'union dure non
    expect(hard.distance([0, 0.2, 0])).toBeGreaterThan(soft.distance([0, 0.2, 0]) + 0.02);
  });

  it("segmentation : chaque sommet connaît sa primitive dominante", () => {
    const f = new Field([
      { kind: "capsule", a: [0, 0, 0], b: [0, 1, 0], ra: 0.15, rb: 0.1, role: 0, tag: 0 },
      { kind: "capsule", a: [0, 1, 0], b: [0.6, 1.4, 0], ra: 0.1, rb: 0.08, role: 1, tag: 1 },
    ], [{ a: 0, b: 1, k: 0.06 }]);
    const { mesh, owner } = polygonize(f, { cell: 0.03 });
    expect(owner.length).toBe(mesh.vertexCount);
    const xs = [...owner].map((o, i) => (o === 1 ? mesh.getPos(i)[0] : NaN)).filter((x) => !Number.isNaN(x));
    expect(xs.length).toBeGreaterThan(20);
    expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeGreaterThan(0.2);
  });
});
