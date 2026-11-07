import { describe, expect, it } from "vitest";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { composeScene } from "../scene/compose";
import { GENERATORS } from "./index";

const make = (gen: string, params: Record<string, unknown>, seed: string | number = 1) => {
  const g = GENERATORS[gen];
  const issues = new Issues();
  const p = resolveParams(g.schema, params, { rng: new Rng(seed), vars: {} }, issues, "");
  return { asset: g.build(p as never, { rng: new Rng(`t/${seed}`), issues, path: "" }), issues };
};

describe("environnement : bâtiments, végétation, objets", () => {
  it("chaque style de bâtiment se construit, porte devant (+z), emprise et budget tenus", () => {
    const styles = (GENERATORS.building.schema.style as { options: readonly string[] }).options;
    for (const style of styles) {
      const { asset, issues } = make("building", { style, floors: 2, bays: 3 }, style);
      expect(issues.list, style).toEqual([]);
      const door = asset.anchors.door.pos;
      expect(door[2], style).toBeGreaterThan(0);
      expect(Math.abs(door[0]), style).toBeLessThan(asset.footprint.hx + 0.01);
      expect(asset.mesh.triangleCount, style).toBeLessThan(9000);
      const b = asset.mesh.bounds();
      expect(b.max[2], style).toBeLessThan(asset.footprint.hz + 0.6);
    }
  });

  it("deux maisons de graines différentes ne se ressemblent pas", () => {
    const sig = (seed: number) => {
      const { asset } = make("building", { style: "bourg", floors: 2, bays: 3 }, seed);
      return `${asset.mesh.triangleCount}/${asset.footprint.hx.toFixed(2)}/${asset.height.toFixed(2)}`;
    };
    const set = new Set([1, 2, 3, 4, 5, 6].map(sig));
    expect(set.size).toBeGreaterThanOrEqual(5);
    expect(sig(3)).toBe(sig(3));
  });

  it("objets, véhicules et plantes : tous les types existent et restent sobres", () => {
    for (const [gen, key, max] of [["prop", "kind", 2600], ["vehicle", "kind", 2500], ["plant", "species", 3000]] as const) {
      const opts = (GENERATORS[gen].schema[key] as { options: readonly string[] }).options;
      for (const k of opts) {
        const { asset, issues } = make(gen, { [key]: k, variant: 1 });
        expect(issues.list, `${gen}.${k}`).toEqual([]);
        expect(asset.mesh.triangleCount, `${gen}.${k}`).toBeGreaterThan(0);
        expect(asset.mesh.triangleCount, `${gen}.${k}`).toBeLessThan(max);
      }
    }
  });

  it("espèces d'arbres, formes de buissons, minéraux", { timeout: 60000 }, () => {
    for (const species of (GENERATORS.tree.schema.species as { options: readonly string[] }).options) {
      const { asset } = make("tree", { species, height: 6, variant: 0 });
      expect(asset.mesh.triangleCount, species).toBeLessThan(9000);
      expect(asset.height, species).toBeGreaterThan(3);
    }
    for (const shape of (GENERATORS.bush.schema.shape as { options: readonly string[] }).options) expect(make("bush", { shape }).asset.mesh.triangleCount, shape).toBeGreaterThan(50);
    for (const kind of (GENERATORS.rock.schema.kind as { options: readonly string[] }).options) expect(make("rock", { kind }).asset.mesh.triangleCount, kind).toBeGreaterThan(10);
  });

  it("mur le long d'un tracé : drapé sur le relief et bloque la navigation sans grand disque", () => {
    const m = composeScene({
      recipe: {
        size: [30, 20],
        ground: { relief: 1.5, scale: 8 },
        layers: [
          { id: "mur", gen: "wall", place: { at: [[0, 0]] }, params: { kind: "drystone", points: [[-12, 0], [0, 3], [12, 0]], gaps: 0 } },
          { id: "arbres", gen: "tree", count: 10, place: { poisson: true, minDist: 2 }, params: { species: "oak", height: 4 } },
        ],
      },
      seed: 2,
    });
    expect(m.issues.filter((i) => i.code !== "info")).toEqual([]);
    expect(m.nav!.free(0, 3)).toBe(false);
    expect(m.nav!.free(0, -6)).toBe(true);
    // un arbre peut pousser à 4 m du mur (pas d'emprise circulaire géante)
    expect(m.objects.filter((o) => o.layer === "arbres").length).toBeGreaterThanOrEqual(6);
  });
});
