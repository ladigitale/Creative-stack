import { describe, expect, it } from "vitest";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { composeVector } from "../vector/compose";
import { VectorScene } from "../vector/scene";
import { validPath } from "../vector/shape";
import { GENERATORS } from "./index";
import { PET_KINDS } from "./pet";

const make = (params: Record<string, unknown>) => {
  const g = GENERATORS.pet;
  const issues = new Issues();
  const p = resolveParams(g.schema, params, { rng: new Rng(1), vars: {} }, issues, "");
  return { asset: g.build(p as never, { rng: new Rng("p"), issues, path: "" }), issues };
};

describe("objets pour animaux", () => {
  it("chaque objet : au sol, ancre spot dans l'emprise ou devant, budget", () => {
    for (const kind of PET_KINDS) {
      const { asset, issues } = make({ kind });
      expect(issues.list, kind).toEqual([]);
      expect(asset.mesh.bounds().min[1], kind).toBeGreaterThan(-0.01);
      expect(asset.height, kind).toBeGreaterThan(0.05);
      expect(asset.height, kind).toBeLessThan(2.4);
      expect(asset.mesh.triangleCount, kind).toBeLessThan(4000);
      const sp = asset.anchors.spot.pos;
      expect(sp[1], kind).toBeGreaterThanOrEqual(0);
      expect(sp[1], kind).toBeLessThanOrEqual(asset.height + 0.15);
      expect((asset.extra!.affords as string[]).length, kind).toBeGreaterThan(0);
    }
  });

  it("à la taille de l'animal : une niche pour cheval est bien plus grande qu'une niche pour chat", () => {
    const horse = make({ kind: "kennel", for: "horse" }).asset, cat = make({ kind: "kennel", for: "cat" }).asset, dog = make({ kind: "kennel" }).asset;
    expect(horse.height).toBeGreaterThan(dog.height * 2.4);
    expect(cat.height).toBeLessThan(dog.height * 0.6);
  });

  it("basse-cour vectorielle sans chemin invalide", () => {
    const model = composeVector({
      recipe: { size: [16, 10], ground: { relief: 0 }, layers: [{ id: "a", gen: "pet", count: 10, place: { poisson: [-6, -3, 6, 3], minDist: 1.6 }, params: { kind: "= pick('kennel', 'bowl', 'trough', 'birdfeeder', 'birdcage', 'hutch', 'henhouse', 'cattree', 'aquarium', 'birdbath', 'hayrack')" } }] },
      seed: 5,
    });
    for (const camera of ["side", "oblique"] as const) {
      const shapes = new VectorScene(model, { camera }).staticShapes(0).shapes;
      expect(shapes.length).toBeGreaterThan(150);
      expect(shapes.filter((s) => !validPath(s.d)).length).toBe(0);
    }
  });
});
