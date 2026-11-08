import { describe, expect, it } from "vitest";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { composeVector } from "../vector/compose";
import { VectorScene } from "../vector/scene";
import { validPath } from "../vector/shape";
import { CONTAINER_KINDS, FILLS } from "./container";
import { GENERATORS } from "./index";
import { ROLE } from "../style/roles";

const make = (params: Record<string, unknown>) => {
  const g = GENERATORS.container;
  const issues = new Issues();
  const p = resolveParams(g.schema, params, { rng: new Rng(1), vars: {} }, issues, "");
  return { asset: g.build(p as never, { rng: new Rng("c"), issues, path: "" }), issues };
};

describe("contenants", () => {
  it("chaque contenant, ouvert ou fermé : posé au sol, taille plausible, budget", () => {
    for (const kind of CONTAINER_KINDS)
      for (const open of [true, false]) {
        const { asset, issues } = make({ kind, open });
        expect(issues.list, kind).toEqual([]);
        const b = asset.mesh.bounds();
        expect(b.min[1], `${kind}/${open}`).toBeGreaterThan(-0.01);
        expect(asset.height, kind).toBeGreaterThan(0.1);
        expect(asset.height, kind).toBeLessThan(1.4);
        expect(asset.mesh.triangleCount, `${kind}/${open}`).toBeLessThan(6000);
        expect((asset.extra!.affords as string[]).length).toBeGreaterThan(0);
      }
  });

  it("le contenu s'ajoute dans l'ouverture, pas quand c'est fermé", () => {
    for (const fill of FILLS.filter((f) => f !== "none")) {
      const full = make({ kind: "crate", open: true, fill }).asset, empty = make({ kind: "crate", open: true }).asset;
      expect(full.mesh.triangleCount, fill).toBeGreaterThan(empty.mesh.triangleCount);
      expect(full.mesh.bounds().max[1], fill).toBeLessThan(0.75);
    }
    const apples = make({ kind: "basket", fill: "apples" }).asset;
    expect(apples.mesh.role.includes(ROLE.red)).toBe(true);
    const closed = make({ kind: "chest", open: false, fill: "gold" }).asset, closedEmpty = make({ kind: "chest", open: false }).asset;
    expect(closed.mesh.triangleCount).toBe(closedEmpty.mesh.triangleCount);
  });

  it("un coffre ouvert est plus haut qu'un coffre fermé (couvercle levé sur sa charnière)", () => {
    expect(make({ kind: "chest", open: true }).asset.height).toBeGreaterThan(make({ kind: "chest", open: false }).asset.height + 0.15);
  });

  it("marché en vectoriel sans chemin invalide", () => {
    const model = composeVector({
      recipe: { size: [16, 10], ground: { relief: 0 }, layers: [{ id: "c", gen: "container", count: 12, place: { poisson: [-6, -3, 6, 3], minDist: 1.2 }, params: { kind: "= pick('crate', 'basket', 'bucket', 'chest', 'sack', 'jar', 'pallet', 'wheeliebin', 'toolbox', 'cooler')", fill: "= pick('apples', 'sand', 'water', 'logs', 'tools', 'flowers', 'gold')" } }] },
      seed: 3,
    });
    for (const camera of ["side", "oblique"] as const) {
      const shapes = new VectorScene(model, { camera }).staticShapes(0).shapes;
      expect(shapes.length).toBeGreaterThan(200);
      expect(shapes.filter((s) => !validPath(s.d)).length).toBe(0);
    }
  });
});
