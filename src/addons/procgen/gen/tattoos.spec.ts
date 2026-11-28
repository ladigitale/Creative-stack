import { describe, expect, it } from "vitest";
import { composeScene } from "../scene/compose";

const verts = (params: Record<string, unknown>) => {
  const m = composeScene({ recipe: { size: [6, 6], layers: [], actors: { a: { params: { top: "tank", bottom: "shorts", hat: "none", item: "none", bag: "none", jewelry: "none", ...params }, at: [0, 0] } } } as never, seed: 4 });
  expect(m.issues.filter((i) => i.message.includes("échec"))).toEqual([]);
  return m.actors[0].asset.mesh.vertexCount;
};

describe("tatouages et piercings", () => {
  it("ajoutent des pièces au personnage, sans erreur ; skis et raquettes aussi", () => {
    const base = verts({});
    expect(verts({ tattoos: "many" })).toBeGreaterThan(base);
    expect(verts({ piercings: "all" })).toBeGreaterThan(base);
    expect(verts({ snow: "skis" })).toBeGreaterThan(base);
    expect(verts({ snow: "snowshoes" })).toBeGreaterThan(base);
  });
  it("aucun tatouage sous une tenue couvrante", () => {
    const covered = { top: "coat", bottom: "trousers", collar: "turtle", over: "jacket" };
    expect(verts({ ...covered, tattoos: "many" })).toBe(verts(covered));
  });
});
