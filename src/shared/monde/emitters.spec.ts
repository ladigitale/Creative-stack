import { describe, expect, it } from "vitest";
import { readMonde, mondeSummary } from "./format";

describe("monde.emitters", () => {
  it("résout un modèle en pièces et un prefab paramétré, sans rien ajouter au décor", () => {
    const m = readMonde({
      models: {
        boule: { parts: [{ name: "b", sphere: 0.1, color: "#ff7700" }] },
        rat: { params: { taille: { default: 1, min: 0.5, max: 2, step: 0.1 } }, parts: [{ name: "corps", box: ["= 0.3 * taille", 0.1, 0.12], at: [0, 0.05, 0] }] },
      },
      place: [{ model: "boule", at: [0, 0, 0] }],
      emitters: {
        blaster: { model: "boule", speed: 20, mask: ["ennemi"] },
        rats: { model: "rat", max: 50, params: { taille: "= rand(0.8, 1.3)" }, flock: { seek: "heros" } },
        perdu: { model: "inconnu" },
      },
    });
    expect(m.place.length).toBe(1);
    expect(m.emitters.map((e) => e.id)).toEqual(["blaster", "rats"]);
    expect(m.emitters[0].variants).toEqual([{ model: "boule", roles: {} }]);
    expect(m.emitters[1].behavior).toBe("flock");
    expect(m.emitters[1].variants.length).toBeGreaterThan(1);
    for (const v of m.emitters[1].variants) expect(m.models.has(v.model)).toBe(true);
    expect(m.issues.some((i) => i.path === "emitters.perdu.model")).toBe(true);
    expect((mondeSummary(m) as { emitters?: unknown[] }).emitters?.length).toBe(2);
  });

  it("convertit les longueurs de l'unité du document", () => {
    const m = readMonde({ unite: "cm", models: { b: { parts: [{ name: "b", sphere: 5 }] } }, emitters: { e: { model: "b", at: [100, 50, 0], speed: 1000, radius: 10 } } });
    const e = m.emitters[0];
    expect(e.at).toEqual([1, 0.5, 0]);
    expect(e.speed).toEqual([10, 10]);
    expect(e.radius).toBeCloseTo(0.1);
  });
});
