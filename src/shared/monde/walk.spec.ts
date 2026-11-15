import { describe, expect, it } from "vitest";
import { MondeDriver } from "./driver";
import { readMonde } from "./format";

const piece = (place: unknown[]) =>
  readMonde({
    unite: "cm",
    espace: { contour: [[0, 0], [420, 0], [420, 310], [0, 310]], hauteur: 250, bords: [{ bord: 3, ouvertures: [{ type: "porte", at: 150 }] }], zones: [{ nom: "plancher", revetement: "parquet" }] },
    models: { perso: { unite: "cm", parts: [{ name: "corps", box: [40, 170, 30], at: [0, 85, 0] }] } },
    place,
  });
const drive = (place: unknown[]) => {
  const d = new MondeDriver();
  d.setMonde(piece(place), 0);
  d.step(0);
  return d;
};

describe("déplacements en jeu qui respectent les obstacles", () => {
  it("sans obstacle : le point demandé est atteint", () => {
    const d = drive([{ model: "perso", name: "p", at: [100, 0, 100] }]);
    const g = d.guard("p", { x: 2.5, z: 1.5, collide: true })!;
    expect(g.walked).toEqual({ x: 2.5, z: 1.5, hits: [], blocked: false });
  });

  it("contre un meuble : glisse le long, ou s'arrête avec bloquer", () => {
    const d = drive([
      { model: "perso", name: "p", at: [100, 0, 150] },
      { model: "commode", name: "c", at: [200, 0, 150], params: { largeur: 80 } },
    ]);
    // vers la commode, en biais : avance en z le long de sa face
    const g = d.guard("p", { x: 3.0, z: 2.0, collide: "glisser" })!;
    expect(g.walked.hits).toContain("c");
    expect(g.walked.blocked).toBe(true);
    expect(g.walked.x).toBeLessThan(1.6);
    expect(g.walked.z).toBeCloseTo(2.0, 1);
    const b = d.guard("p", { x: 3.0, z: 2.0, collide: "bloquer" })!;
    expect(b.walked.x).toBeLessThan(1.6);
    expect(b.walked.z).toBeLessThan(2.0);
    // le patch rendu porte le point atteint
    expect(b.patch.x).toBe(b.walked.x);
  });

  it("un mur arrête, la porte laisse passer", () => {
    const d = drive([{ model: "perso", name: "p", at: [60, 0, 150] }]);
    // mur x = 0 hors de la porte (porte centrée en z = 1,5) : arrêté
    const wall = drive([{ model: "perso", name: "p", at: [60, 0, 60] }]).guard("p", { x: -1, z: 0.6, collide: "bloquer" })!;
    expect(wall.walked.blocked).toBe(true);
    expect(wall.walked.x).toBeGreaterThan(0.1);
    expect(wall.walked.hits.some((h) => h.startsWith("mur"))).toBe(true);
    // par la porte : on sort
    const out = d.guard("p", { x: -1, z: 1.5, collide: "bloquer" })!;
    expect(out.walked.blocked).toBe(false);
    expect(out.walked.x).toBe(-1);
  });

  it("déjà dans un obstacle : peut en sortir ; sans collide, rien n'est corrigé", () => {
    const d = drive([
      { model: "perso", name: "p", at: [200, 0, 150] },
      { model: "commode", name: "c", at: [200, 0, 150] },
    ]);
    expect(d.guard("p", { x: 1.0, z: 1.5, collide: true })!.walked.blocked).toBe(false);
    expect(d.guard("p", { x: 1.0, z: 1.5 })).toBeNull();
    expect(d.guard("p", { ry: 1, collide: true })).toBeNull();
  });
});
