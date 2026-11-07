import { describe, expect, it } from "vitest";
import { composeScene, type Recipe } from "./compose";
import { SCENES } from "./library";
import { GENERATORS, generatorCatalog } from "../gen/index";

const small: Recipe = {
  size: [40, 24],
  params: { n: { default: 4, min: 0, max: 10 } },
  ground: { relief: 0.4 },
  paths: [{ id: "rue", points: [[-20, 0], [20, 0]], width: 4, kind: "street", sidewalk: 1.5 }],
  layers: [
    { id: "maisons", gen: "building", count: "= n", place: { along: "rue", side: "right", spacing: 9 }, params: { floors: "= randint(1, 3)", bays: 2, depth: 6 } },
    { id: "arbres", gen: "tree", count: 12, place: { poisson: true, minDist: 3 }, params: { species: "= pick('oak', 'pine')", height: "= rand(4, 8)" } },
    { id: "lampes", gen: "prop.lamp", count: 3, place: { along: "rue", side: "left", spacing: 12, offset: -1 } },
  ],
  zones: [{ id: "entree", at: "maisons.0.door", r: 1.2 }],
  actors: { hero: { params: { archetype: "chibi", height: 1, detail: "crowd" }, at: [0, 3] } },
};

describe("composition", () => {
  it("déterministe : même graine → mêmes objets, mêmes positions", { timeout: 30000 }, () => {
    const a = composeScene({ recipe: small, seed: 5 });
    const b = composeScene({ recipe: small, seed: 5 });
    expect(a.objects.map((o) => [o.id, o.pos.map((x) => x.toFixed(3))])).toEqual(b.objects.map((o) => [o.id, o.pos.map((x) => x.toFixed(3))]));
  });

  it("ids stables par couche ; modifier un objet ne déplace pas les autres", () => {
    const a = composeScene({ recipe: small, seed: 5 });
    const b = composeScene({ recipe: small, seed: 5, edits: { "maisons.1": { floors: 3 } } });
    const posA = Object.fromEntries(a.objects.map((o) => [o.id, o.pos.join()]));
    for (const o of b.objects) if (o.id !== "maisons.1" && o.layer !== "arbres") expect(o.pos.join()).toBe(posA[o.id]);
    expect(b.objects.find((o) => o.id === "maisons.1")!.params.floors).toBe(3);
    expect(a.objects.filter((o) => o.layer === "maisons").map((o) => o.id)).toEqual(["maisons.0", "maisons.1", "maisons.2", "maisons.3"]);
  });

  it("paramètres de scène, zones sur ancres, acteurs, lumières, navigation", () => {
    const m = composeScene({ recipe: small, seed: 2, params: { n: 2 } });
    expect(m.objects.filter((o) => o.layer === "maisons")).toHaveLength(2);
    expect(m.zones[0]).toMatchObject({ id: "entree" });
    expect(m.actors.map((a) => a.id)).toEqual(["hero"]);
    expect(m.lights.length).toBe(3);
    const house = m.objects.find((o) => o.layer === "maisons")!;
    expect(m.nav!.free(house.pos[0], house.pos[2])).toBe(false);
    expect(m.nav!.path([-15, 2.5], [15, 2.5])).not.toBeNull();
  });

  it("les maisons « le long de la rue » ne mordent pas sur la chaussée", () => {
    const m = composeScene({ recipe: small, seed: 3 });
    for (const o of m.objects.filter((x) => x.layer === "maisons")) expect(Math.abs(o.pos[2]) - o.footprint.hz).toBeGreaterThan(2 + 1.5 - 0.3);
  });

  it("erreurs de l'agent : signalées, structurées, sans casser le rendu", () => {
    const m = composeScene({
      recipe: { ...small, layers: [...(small.layers ?? []), { id: "x", gen: "bulding", count: 1 }, { id: "y", gen: "tree", count: 2, params: { specis: "oak", height: 99 } }] },
      seed: 1,
      params: { nn: 3 },
    });
    const codes = m.issues.map((i) => `${i.path}:${i.code}:${i.didYouMean ?? ""}`);
    expect(codes).toContain("x.0:unknown:building");
    expect(codes.some((c) => c.startsWith("params.nn:unknown"))).toBe(true);
    expect(codes.some((c) => c.includes("specis:unknown:species"))).toBe(true);
    expect(m.objects.length).toBeGreaterThan(5);
  });

  it("instanciation : les arbres répétés partagent quelques variantes", () => {
    const m = composeScene({ recipe: { size: [60, 60], ground: { relief: 0 }, layers: [{ id: "a", gen: "tree", count: 60, place: { poisson: true, minDist: 2 }, params: { species: "oak", height: "= rand(4, 9)" } }] }, seed: 1 });
    expect(m.instances.reduce((s, g) => s + g.matrices.length, 0)).toBeGreaterThan(40);
    expect(m.instances.length).toBeLessThanOrEqual(8);
  });

  it("toutes les scènes de la bibliothèque se composent sans erreur de recette", () => {
    for (const [name, r] of Object.entries(SCENES)) {
      if (["vapeur", "neon", "marche", "rue", "personnages", "village", "port"].includes(name)) continue; // personnages nombreux : couverts ailleurs (durée)
      const m = composeScene({ recipe: r, seed: 1 });
      const bad = m.issues.filter((i) => i.code !== "info");
      expect(bad.map((i) => `${i.path}: ${i.message}`), name).toEqual([]);
      expect(m.objects.length, name).toBeGreaterThan(0);
    }
  }, 120000);

  it("catalogue : chaque générateur décrit ses paramètres", () => {
    const cat = generatorCatalog();
    expect(cat.map((g) => g.id).sort()).toEqual(Object.keys(GENERATORS).sort());
    for (const g of cat) for (const [, p] of Object.entries(g.params)) expect((p as { doc: string }).doc.length).toBeGreaterThan(2);
  });
});
