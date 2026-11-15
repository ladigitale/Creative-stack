import { describe, expect, it } from "vitest";
import { CATALOGUE } from "./catalogue";
import { LIMITS, mondeSummary, readMonde } from "./format";
import { boundsOf } from "./supports";

type Spec = { default: unknown; options?: unknown[]; min?: number; max?: number; type?: string };
const specs = (name: string) => (CATALOGUE[name] as { params: Record<string, Spec> }).params;

/** Jeux de valeurs à essayer : le défaut, puis chaque option de chaque choix, puis les bornes des longueurs. */
function variations(name: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{}];
  for (const [k, sp] of Object.entries(specs(name))) {
    for (const o of sp.options ?? []) out.push({ [k]: o });
    if (typeof sp.default === "boolean") out.push({ [k]: !sp.default });
    if (sp.min !== undefined) out.push({ [k]: sp.min });
    if (sp.max !== undefined) out.push({ [k]: sp.max });
  }
  return out;
}

describe("catalogue de mobilier", () => {
  for (const name of Object.keys(CATALOGUE)) {
    it(`${name} : toutes les options se lisent sans problème et tiennent debout`, () => {
      const pose = (CATALOGUE[name] as { pose: string }).pose;
      for (const params of variations(name)) {
        const m = readMonde({ place: [{ model: name, name: "x", params }] });
        expect(m.issues, `${name} ${JSON.stringify(params)}`).toEqual([]);
        const model = m.models.get(m.place[0].model)!;
        expect(model.parts.length).toBeLessThanOrEqual(LIMITS.partsPerModel);
        const b = boundsOf(model)!;
        expect(b, name).not.toBeNull();
        for (const v of [...b.min, ...b.max]) expect(Number.isFinite(v)).toBe(true);
        // conventions de pose : base au sol, dos au mur, accroche au plafond
        if (pose === "sol" || pose === "dessus") expect(b.min[1], `${name} base`).toBeGreaterThanOrEqual(-1e-6);
        if (pose === "sol" || pose === "dessus") expect(b.min[1]).toBeLessThan(0.05);
        if (pose === "mur") expect(b.min[2], `${name} dos`).toBeGreaterThanOrEqual(-1e-6);
        if (pose === "plafond") expect(b.max[1], `${name} accroche`).toBeLessThanOrEqual(1e-6);
        expect(b.max[1] - b.min[1]).toBeLessThan(4);
      }
    });
  }

  it("les longueurs se donnent dans l'unité du document", () => {
    const enM = readMonde({ place: [{ model: "lit", name: "l", params: { largeur: 1.4, type: "mezzanine" } }] });
    const enCm = readMonde({ unite: "cm", place: [{ model: "lit", name: "l", at: [200, 0, 100], params: { largeur: 140, type: "mezzanine" } }] });
    expect(enCm.issues).toEqual([]);
    const a = boundsOf(enM.models.get(enM.place[0].model)!)!, b = boundsOf(enCm.models.get(enCm.place[0].model)!)!;
    for (let i = 0; i < 3; i++) {
      expect(b.min[i]).toBeCloseTo(a.min[i]);
      expect(b.max[i]).toBeCloseTo(a.max[i]);
    }
    expect(a.max[0] - a.min[0]).toBeGreaterThan(1.4);
    expect(a.max[1]).toBeGreaterThan(1.9);
    expect(enCm.place[0].at).toEqual([2, 0, 1]);
    // fiche publiée dans l'unité du document
    const info = mondeSummary(enCm).prefabs!.lit;
    expect(info.params.largeur).toMatchObject({ default: 90, unit: "cm", options: [90, 120, 140, 160] });
    expect(mondeSummary(enM).prefabs!.lit.params.largeur).toMatchObject({ default: 0.9, unit: "m" });
  });

  it("un modèle écrit du même nom remplace celui du catalogue ; un nom inconnu reste signalé", () => {
    const m = readMonde({ models: { lit: { parts: [{ name: "mien", box: [1, 1, 1] }] } }, place: [{ model: "lit" }, { model: "licorne" }] });
    expect(m.models.get("lit")!.parts[0].name).toBe("mien");
    expect(m.issues.map((i) => i.message).join("|")).toContain("modèle inconnu « licorne »");
  });

  it("seuls les modèles utilisés sont construits", () => {
    const m = readMonde({ place: [{ model: "tapis" }] });
    expect([...m.models.keys()].every((k) => k.startsWith("tapis~"))).toBe(true);
  });

  it("une chambre entière tient en quelques lignes", () => {
    const m = readMonde({
      unite: "cm",
      espace: { contour: [[0, 0], [420, 0], [420, 310], [0, 310]], hauteur: 250, plafond: true, bords: [{ bord: 1, ouvertures: [{ type: "fenetre", at: 155, largeur: 140 }] }], zones: [{ nom: "plancher", revetement: "parquet" }] },
      place: [
        { model: "lit", name: "lit", against: "mur2", at: 80, params: { type: "mezzanine" } },
        { model: "bureau", name: "bureau", against: "mur0", at: 300, params: { largeur: 140, caisson: true } },
        { model: "lampe", on: "bureau", at: [-45, 0] },
        { model: "etagere", on: "mur0", at: [110, 120] },
        { model: "armoire", against: "mur3", at: 90, params: { portes: "coulissantes", largeur: 150 } },
        { model: "rideau", on: "mur1", at: [155, 5], params: { largeur: 180, hauteur: 230 } },
        { model: "suspension", on: "plafond", at: [210, 155] },
        { model: "tapis", on: "plancher", at: [230, 150], params: { forme: "rond", largeur: 140 } },
        { model: "coussin", on: "lit", stack: 2 },
        { model: "plante", on: "plancher", at: [380, 270], params: { forme: "palmier", taille: 150 } },
      ],
    });
    expect(m.issues).toEqual([]);
    expect(m.place.length).toBeGreaterThan(15);
    // la lampe est sur le plateau du bureau, le coussin sur le matelas de la mezzanine
    const lampe = m.place.find((p) => p.model.startsWith("lampe~"))!;
    expect(lampe.at[1]).toBeCloseTo(0.74);
    const coussin = m.place.find((p) => p.model.startsWith("coussin~"))!;
    expect(coussin.at[1]).toBeCloseTo(1.86, 1);
  });
});
