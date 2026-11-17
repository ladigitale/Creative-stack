import { describe, expect, it } from "vitest";
import { readFinish, readMonde, readPhoto, FINIS } from "./format";

describe("finis des matières", () => {
  it("fini prêt, valeurs changées, erreurs signalées", () => {
    const issues: string[] = [];
    const f = readFinish({ fini: "verre", rough: 0.3 }, (m) => issues.push(m))!;
    expect(f.glass).toBe(1);
    expect(f.rough).toBe(0.3);
    expect(readFinish("titane", (m) => issues.push(m))!.metal).toBe(0);
    expect(issues.length).toBe(1);
    expect(readFinish(undefined, () => {})).toBeNull();
    expect(Object.keys(FINIS)).toEqual(expect.arrayContaining(["chrome", "verre", "velours", "laque"]));
  });

  it("une matière du nuancier apporte son fini ; l'environnement suit les reflets", () => {
    const m = readMonde({
      catalogue: ["lampe"],
      models: { vase: { parts: [{ name: "v", cylinder: [0.1, 0.3], matiere: "verre" }, { name: "pied", box: [0.2, 0.02, 0.2], matiere: "chrome" }] } },
      place: [{ model: "vase", at: [0, 0, 0] }],
    });
    const parts = m.models.get(m.place[0].model)!.parts;
    expect(parts[0].finish!.glass).toBe(1);
    expect(parts[1].finish!.metal).toBe(1);
    expect(m.environnement).toBe("studio");
    expect(readMonde({ models: { b: { parts: [{ name: "b", box: [1, 1, 1] }] } } }).environnement).toBe("aucun");
    expect(readMonde({ environnement: "exterieur" }).environnement).toBe("exterieur");
  });

  it("fini écrit sur une pièce, tiré par une expression de prefab", () => {
    const m = readMonde({ catalogue: ["cadre"], place: [{ model: "cadre", params: { miroir: true } }] });
    const p = m.models.get(m.place[0].model)!.parts.find((x) => x.name === "glace")!;
    expect(p.finish!.metal).toBe(1);
    expect(p.finish!.rough).toBe(0);
  });
});

describe("rendu photo", () => {
  it("lit les réglages et les borne", () => {
    expect(readPhoto(undefined)).toBeNull();
    expect(readPhoto(false)).toBeNull();
    expect(readPhoto(true)).toMatchObject({ echantillons: 200, rebonds: 5, attente: 600, filtre: "" });
    expect(readPhoto({ filtre: "peinture", tramage: true })).toMatchObject({ echantillons: 12, rebonds: 3, tramage: 0.6, echelle: 0.5, touche: 5 });
    expect(readPhoto({ filtre: "lisse" })).toMatchObject({ echantillons: 32, echelle: 1 });
    expect(readPhoto({ echantillons: 99999, rebonds: 0, attente: -5 })).toMatchObject({ echantillons: 4000, rebonds: 1, attente: 0 });
    expect(readMonde({ photo: { rebonds: 3 } }).photo).toMatchObject({ echantillons: 200, rebonds: 3, attente: 600 });
    expect(readMonde({}).photo).toBeNull();
  });
});
