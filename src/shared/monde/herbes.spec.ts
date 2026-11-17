import { describe, expect, it } from "vitest";
import { readMonde } from "./format";
import { readHerbes, shares, sowField } from "./herbes";

describe("herbes", () => {
  it("lit les champs, leurs sortes et leurs erreurs", () => {
    const issues: { path: string; message: string }[] = [];
    const f = readHerbes([{ type: "blé", zone: [0, 0, 4, 2], hauteur: [1, 1.2] }, { type: "cactus", zone: [0, 0, 1, 1] }, { type: "herbe", zone: [1, 2] }], issues);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe("ble");
    expect(f[0].height).toEqual([1, 1.2]);
    expect(issues.map((i) => i.path)).toEqual(["herbes.1", "herbes.2.zone"]);
    expect(readMonde({ herbes: [{ zone: [0, 0, 2, 2] }] }).herbes[0].kind).toBe("herbe");
  });
  it("sème selon la densité, dans la zone, hors du décor, de façon reproductible", () => {
    const [f] = readHerbes([{ type: "herbe", zone: [0, 0, 10, 10], densite: 50 }], []);
    const a = sowField(f, 1e9);
    const n = a.length / 6;
    expect(n).toBeGreaterThan(4000);
    expect(n).toBeLessThanOrEqual(5000);
    for (let i = 0; i < a.length; i += 6) {
      expect(a[i]).toBeGreaterThanOrEqual(0);
      expect(a[i]).toBeLessThanOrEqual(10);
      expect(a[i + 3]).toBeGreaterThanOrEqual(f.height[0]);
      expect(a[i + 3]).toBeLessThanOrEqual(f.height[1]);
    }
    expect(Array.from(sowField(f, 1e9).slice(0, 12))).toEqual(Array.from(a.slice(0, 12)));
    const free = sowField(f, 1e9, [{ lo: [2, 2], hi: [6, 6] }]);
    for (let i = 0; i < free.length; i += 6) expect(free[i] > 2 && free[i] < 6 && free[i + 1] > 2 && free[i + 1] < 6).toBe(false);
    expect(free.length / 6).toBeLessThan(n * 0.9);
  });
  it("polygone et budget partagé", () => {
    const [tri, big] = readHerbes([{ zone: [[0, 0], [4, 0], [0, 4]], densite: 100 }, { zone: [0, 0, 100, 100] }], []);
    const t = sowField(tri, 1e9);
    for (let i = 0; i < t.length; i += 6) expect(t[i] + t[i + 1]).toBeLessThanOrEqual(4.01);
    const s = shares([tri, big], 60000);
    expect(s[0] + s[1]).toBeLessThanOrEqual(60000);
    expect(sowField(big, s[1]).length / 6).toBeLessThanOrEqual(s[1]);
  });
});
