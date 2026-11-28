import { describe, expect, it } from "vitest";
import { composeScene } from "../scene/compose";
import { ROLE } from "../style/roles";
import { water as waterGen, waterModel } from "./water";

// paramètres partiels : le générateur complète les défauts
const water = { build: (p: Record<string, unknown>, ctx: unknown) => waterGen.build(p as never, ctx as never) };

const lowest = (mesh: { vertexCount: number; pos: ArrayLike<number> }) => {
  let y = Infinity;
  for (let v = 0; v < mesh.vertexCount; v++) y = Math.min(y, mesh.pos[v * 3 + 1]);
  return y;
};

describe("fond des points d'eau", () => {
  it("la piscine a une cuve sous le sol, reliée à la nappe, et ouvre le sol au-dessus", () => {
    const a = water.build({ kind: "pool", length: 8, width: 4 }, 1 as never);
    expect(lowest(a.mesh)).toBeLessThan(-1);
    const holes = a.extra?.holes as number[][];
    expect(holes).toHaveLength(1);
    expect(holes[0].slice(0, 3)).toEqual([0, 4, 2]);
    // les parois montent jusqu'au niveau de l'eau
    const t = waterModel({ kind: "pool", length: 8, width: 4 }).tanks![0];
    expect(t.top).toBeGreaterThanOrEqual(waterModel({ kind: "pool" }).center[1]);
  });

  it("la mare a une cuvette qui remonte jusqu'à sa berge, au contour ondulé", () => {
    const m = waterModel({ kind: "pond", length: 6, width: 4 });
    const t = m.tanks![0];
    expect(t.shape).toBe("bowl");
    expect(t.depth).toBeGreaterThan(0.5);
    expect(t.hole?.seed).toBeDefined();
    // l'ouverture du sol ne dépasse pas la lèvre de la cuvette
    expect(t.hole!.hx).toBeLessThan(t.hx * (1 + 0.2 / t.hx));
  });

  it("l'eau trouble ou limpide est portée par ses sommets ; le bassin maçonné garde son fond au-dessus du sol", () => {
    const pond = water.build({ kind: "pond" }, 1 as never).mesh, pool = water.build({ kind: "pool" }, 1 as never).mesh;
    const aoOf = (m: typeof pond) => m.ao[m.role.findIndex((r) => r === ROLE.water)];
    expect(aoOf(pond)).toBeLessThan(0.5);
    expect(aoOf(pool)).toBe(1);
    const basin = water.build({ kind: "basin" }, 1 as never);
    expect(basin.extra?.holes).toBeUndefined();
    expect(lowest(basin.mesh)).toBeGreaterThan(-0.05);
  });

  it("la scène publie les ouvertures en coordonnées monde", () => {
    const model = composeScene({ recipe: { size: [20, 20], ground: { relief: 0 }, layers: [{ id: "p", gen: "water.pool", place: { at: [{ x: 3, z: -2, yaw: 90 }] } }] }, seed: 1 });
    expect(model.holes).toHaveLength(1);
    const [x, z, hx, hz, yaw, shape] = model.holes![0];
    expect(x).toBeCloseTo(3);
    expect(z).toBeCloseTo(-2);
    expect([hx, hz]).toEqual([4, 2]);
    expect(Math.abs(yaw)).toBeGreaterThan(1);
    expect(shape).toBe(0);
  });
});
