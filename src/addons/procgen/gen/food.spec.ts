import { describe, expect, it } from "vitest";
import { FOOD_KINDS, FOOD_VARIANTS, foodModel } from "./food";
import { partsBounds, partsToMesh } from "./parts";
import { composeScene } from "../scene/compose";
import { readFish } from "../render/fish";

describe("aliments et boissons", () => {
  it("chaque sorte, chaque variante : un maillage fini, à taille réelle (moins de 70 cm)", () => {
    for (const kind of FOOD_KINDS)
      for (let v = 0; v < FOOD_VARIANTS[kind].length; v++) {
        const m = foodModel({ kind, variant: v });
        const mesh = partsToMesh(m.parts);
        expect(mesh.vertexCount, `${kind}:${v}`).toBeGreaterThan(20);
        const bb = partsBounds(m.parts);
        expect(bb.max[1] - bb.min[1], `${kind}:${v}`).toBeLessThan(0.7);
        expect(Math.max(bb.max[0] - bb.min[0], bb.max[2] - bb.min[2]), `${kind}:${v}`).toBeLessThan(0.7);
        expect(bb.min[1], `${kind}:${v}`).toBeGreaterThan(-0.01);
      }
  });
  it("posés sur la table avec onTop", () => {
    const m = composeScene({
      recipe: {
        size: [6, 6],
        layers: [
          { id: "table", gen: "prop", place: { at: [{ x: 0, z: 0 }] }, params: { kind: "table" } },
          { id: "plats", gen: "food", onTop: true, place: { at: [{ x: 0.1, z: 0 }] }, params: { kind: "pizza" } },
          { id: "sol", gen: "food", place: { at: [{ x: 2, z: 2 }] }, params: { kind: "pizza" } },
        ],
      },
      seed: 1,
    });
    const t = m.objects.find((o) => o.id === "table.0")!;
    expect(m.objects.find((o) => o.id === "plats.0")!.pos[1]).toBeGreaterThan(t.pos[1] + t.height * 0.8);
    expect(m.objects.find((o) => o.id === "sol.0")!.pos[1]).toBeLessThan(0.05);
  });
});

describe("poissons", () => {
  it("lecture de la clé fish", () => {
    expect(readFish(true)).toMatchObject({ density: 1 });
    expect(readFish(false)).toBeNull();
    expect(readFish(2)!.density).toBe(2);
    expect(readFish({ density: 0.5, colors: ["orange", "nope"] })!.colors.length).toBe(1);
  });
});
