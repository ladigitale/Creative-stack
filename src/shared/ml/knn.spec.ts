import { describe, expect, it } from "vitest";
import { KnnClassifier } from "./knn";

const fill = (c: KnnClassifier, label: string, center: number[], n = 5) => {
  for (let i = 0; i < n; i++) c.add(label, center.map((v) => v + (i % 2 ? 0.01 : -0.01)));
};

describe("KnnClassifier", () => {
  it("classe d'après les exemples, confiance et scores normalisés", () => {
    const c = new KnnClassifier(3);
    fill(c, "A", [0, 0]);
    fill(c, "B", [1, 1]);
    const p = c.classify([0.05, 0.02])!;
    expect(p.label).toBe("A");
    expect(p.confidence).toBeGreaterThan(0.95);
    expect(p.scores.A + p.scores.B).toBeCloseTo(1);
    expect(p.nearest).toBeLessThan(0.1);
    expect(c.classify([0.95, 1.1])!.label).toBe("B");
  });

  it("zone intermédiaire : confiance plus basse", () => {
    const c = new KnnClassifier(5);
    fill(c, "A", [0, 0]);
    fill(c, "B", [1, 0]);
    const mid = c.classify([0.5, 0])!;
    expect(mid.confidence).toBeLessThan(0.75);
  });

  it("distances par étiquette, comptes", () => {
    const c = new KnnClassifier();
    fill(c, "A", [0, 0], 3);
    fill(c, "B", [3, 4], 2);
    const p = c.classify([0, 0])!;
    expect(p.distances.B).toBeCloseTo(5, 1);
    expect(c.counts()).toEqual({ A: 3, B: 2 });
    expect(c.size).toBe(5);
  });

  it("refuse les vecteurs invalides ou de mauvaise dimension", () => {
    const c = new KnnClassifier();
    expect(c.add("", [1])).toBe(false);
    expect(c.add("A", [])).toBe(false);
    expect(c.add("A", [1, NaN])).toBe(false);
    expect(c.add("A", [1, 2])).toBe(true);
    expect(c.add("A", [1, 2, 3])).toBe(false);
    expect(c.classify([1, 2, 3])).toBeNull();
    expect(new KnnClassifier().classify([1])).toBeNull();
  });

  it("clear : une étiquette ou tout", () => {
    const c = new KnnClassifier();
    fill(c, "A", [0, 0], 2);
    fill(c, "B", [1, 1], 2);
    c.clear("A");
    expect(c.counts()).toEqual({ B: 2 });
    c.clear();
    expect(c.size).toBe(0);
    expect(c.add("Z", [1, 2, 3])).toBe(true); // la dimension est libre après un clear complet
  });

  it("plafond : retire un exemple de l'étiquette la plus fournie", () => {
    const c = new KnnClassifier(3, 6);
    fill(c, "A", [0, 0], 5);
    fill(c, "B", [1, 1], 3);
    expect(c.size).toBe(6);
    expect(c.counts().B).toBe(3);
  });

  it("sérialisation aller-retour ; état invalide ignoré", () => {
    const c = new KnnClassifier();
    fill(c, "A", [0, 0], 2);
    const state = JSON.parse(JSON.stringify(c.serialize()));
    const d = new KnnClassifier();
    expect(d.load(state)).toBe(true);
    expect(d.classify([0, 0])!.label).toBe("A");
    expect(d.load({ v: 2 })).toBe(false);
    expect(d.load({ v: 1, dim: 2, examples: [{ label: "A", vec: [1] }] })).toBe(false);
    expect(d.load({ v: 1, dim: 1, examples: [{ label: "A", vec: ["x"] }] })).toBe(false);
    expect(d.load(null)).toBe(false);
    expect(d.size).toBe(2); // inchangé après un état invalide
  });
});
