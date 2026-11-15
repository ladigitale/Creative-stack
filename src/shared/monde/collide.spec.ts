import { describe, expect, it } from "vitest";
import { boxesOf, penetration, type Obb } from "./collide";
import { readMonde } from "./format";

const box = (c: [number, number, number], h: [number, number, number], yaw = 0): Obb => ({ c, ax: [[Math.cos(yaw), 0, -Math.sin(yaw)], [0, 1, 0], [Math.sin(yaw), 0, Math.cos(yaw)]], h });
const pairs = (m: ReturnType<typeof readMonde>, type: string) => m.conflicts.filter((c) => c.type === type).map((c) => [c.a, c.b].sort().join("+"));

describe("boîtes orientées", () => {
  it("pénétration nulle quand un axe sépare, exacte sinon", () => {
    expect(penetration(box([0, 0, 0], [1, 1, 1]), box([2.5, 0, 0], [1, 1, 1]))).toBe(0);
    expect(penetration(box([0, 0, 0], [1, 1, 1]), box([1.7, 0, 0], [1, 1, 1]))).toBeCloseTo(0.3);
    // contact pur : pas de pénétration
    expect(penetration(box([0, 0, 0], [1, 1, 1]), box([2, 0, 0], [1, 1, 1]))).toBeCloseTo(0);
    // une boîte tournée à 45° passe où la boîte englobante se toucherait
    const a = box([0, 0, 0], [1, 1, 1]);
    expect(penetration(a, box([2.3, 0, 0], [1, 1, 1], Math.PI / 4))).toBeGreaterThan(0);
    expect(penetration(a, box([2.3, 0, 2.3], [1, 1, 1], Math.PI / 4))).toBe(0);
    // un plan (épaisseur nulle) coupe un volume
    expect(penetration(box([0, 0, 0], [1, 1, 0]), box([0, 0, 0.2], [0.5, 0.5, 0.5]))).toBeGreaterThan(0.2);
  });

  it("une boîte par pièce dessinée du modèle", () => {
    const m = readMonde({ models: { t: { parts: [{ name: "plateau", box: [1.6, 0.05, 0.8], at: [0, 0.75, 0] }, { name: "pied", cylinder: [0.03, 0.75], at: [0.7, 0.375, 0.3], mirror: "x" }] } }, place: [{ model: "t", name: "t" }] });
    const bs = boxesOf(m.models.get("t")!);
    expect(bs).toHaveLength(3);
    expect(bs[0].h[0]).toBeCloseTo(0.8);
  });
});

const meubles = {
  table: { parts: [{ name: "plateau", box: [1.6, 0.05, 0.8], at: [0, 0.75, 0], surface: "top" }, { name: "tablette", box: [1.2, 0.02, 0.4], at: [0, 0.3, 0] }, { name: "pied", box: [0.05, 0.75, 0.05], at: [0.7, 0.375, 0.3], mirror: "x" }, { name: "piedAr", box: [0.05, 0.75, 0.05], at: [0.7, 0.375, -0.3], mirror: "x" }] },
  tabouret: { parts: [{ box: [0.35, 0.25, 0.35], at: [0, 0.125, 0] }] },
  petit: { parts: [{ box: [0.1, 0.1, 0.1], at: [0, 0.05, 0] }] },
  paquet: { parts: [{ box: [0.4, 0.25, 0.3], at: [0, 0.125, 0] }] },
  planche: { parts: [{ box: [0.2, 0.05, 1.2], at: [0, 0.025, 0] }] },
};

describe("conflits entre objets posés", () => {
  it("un tabouret glissé sous la table ne la touche pas ; posé à travers un pied, si", () => {
    const m = readMonde({ collisions: true, models: meubles, place: [{ model: "table", name: "t" }, { model: "tabouret", name: "dessous", at: [0, 0, 0.1] }, { model: "tabouret", name: "dansPied", at: [0.7, 0, 0.3] }] });
    expect(pairs(m, "chevauchement")).toEqual(["dansPied+t"]);
  });

  it("une pile trop haute sous le plateau est vue ; un objet posé sur son appui ne l'est pas", () => {
    const ok = readMonde({ models: meubles, place: [{ model: "table", name: "t" }, { model: "paquet", name: "p", on: "t" }, { model: "paquet", name: "q", on: "p" }, { model: "paquet", name: "bas", on: "t@tablette" }] });
    expect(ok.conflicts).toEqual([]);
    const ko = readMonde({ models: meubles, place: [{ model: "table", name: "t" }, { model: "paquet", on: "t@tablette", stack: 2 }] });
    expect(ko.conflicts.some((c) => c.type === "chevauchement" && (c.a === "t" || c.b === "t"))).toBe(true);
  });

  it("deux objets longs côte à côte ne se chevauchent pas (un cercle d'emprise le croirait)", () => {
    const m = readMonde({ models: meubles, place: [{ model: "table", name: "t" }, { model: "planche", name: "a", on: "t", at: [-0.15, 0], rot: [0, 90, 0] }, { model: "planche", name: "b", on: "t", at: [-0.15, 0.25], rot: [0, 90, 0] }] });
    expect(m.conflicts).toEqual([]);
    const m2 = readMonde({ models: meubles, place: [{ model: "table", name: "t" }, { model: "planche", name: "a", on: "t", at: [0, 0], rot: [0, 90, 0] }, { model: "planche", name: "b", on: "t", at: [0.3, 0.05], rot: [0, 60, 0] }] });
    expect(pairs(m2, "chevauchement")).toEqual(["a+b"]);
  });

  it("collisions: false coupe la recherche ; un monde sans pose ne la lance pas", () => {
    const place = [{ model: "tabouret", name: "a" }, { model: "tabouret", name: "b", at: [0.1, 0, 0] }];
    expect(readMonde({ models: meubles, place }).conflicts).toEqual([]);
    expect(readMonde({ collisions: true, models: meubles, place }).conflicts).toHaveLength(1);
    expect(readMonde({ collisions: false, models: meubles, place: [...place, { model: "petit", on: "a" }] }).conflicts).toEqual([]);
    // dès qu'un objet est posé, la recherche se fait d'office
    expect(readMonde({ models: meubles, place: [...place, { model: "petit", on: "a" }] }).conflicts).toHaveLength(1);
  });
});

describe("conflits dans une pièce", () => {
  const piece = (place: unknown[]) =>
    readMonde({
      unite: "cm",
      espace: { contour: [[0, 0], [420, 0], [420, 310], [0, 310]], hauteur: 250, bords: [{ bord: 1, ouvertures: [{ type: "fenetre", at: 155, largeur: 140, hauteur: 125, allege: 90 }] }, { bord: 3, ouvertures: [{ type: "porte", at: 250 }] }], zones: [{ nom: "plancher", revetement: "parquet" }] },
      place,
    });

  it("une chambre bien rangée n'a aucun conflit", () => {
    const m = piece([
      { model: "lit", name: "lit", against: "mur2", at: 80, params: { type: "mezzanine" } },
      { model: "bureau", name: "bureau", against: "mur0", at: 300, params: { largeur: 140, caisson: true } },
      { model: "lampe", name: "lampe", on: "bureau", at: [-45, 0] },
      { model: "etagere", name: "etagere", on: "mur0", at: [110, 130] },
      { model: "commode", name: "commode", against: "mur3", at: 150 },
      { model: "rideau", name: "rideau", on: "mur1", at: [155, 3], params: { largeur: 180, hauteur: 235 } },
      { model: "tapis", name: "tapis", on: "plancher", at: [230, 160] },
      { model: "coussin", name: "coussin", on: "lit" },
      { model: "armoire", name: "armoire", against: "mur2", at: 330, params: { largeur: 150 } },
    ]);
    expect(m.issues).toEqual([]);
    expect(m.conflicts).toEqual([]);
  });

  it("meubles l'un dans l'autre, devant la porte, sous la fenêtre trop haut, à travers un mur, hors de la pièce", () => {
    const m = piece([
      { model: "lit", name: "lit", against: "mur2", at: 80 },
      { model: "armoire", name: "armoire", against: "mur2", at: 120 },
      { model: "commode", name: "devantPorte", against: "mur3", at: 250 },
      { model: "armoire", name: "devantFenetre", against: "mur1", at: 155 },
      { model: "commode", name: "bas", against: "mur1", at: 60, params: { hauteur: 80 } },
      { model: "table", name: "traverse", at: [10, 0, 150] },
      { model: "table", name: "dehors", at: [600, 0, 150] },
    ]);
    expect(pairs(m, "chevauchement")).toEqual(expect.arrayContaining(["armoire+lit"]));
    expect(pairs(m, "degagement")).toEqual(expect.arrayContaining(["devantPorte+porte0", "devantFenetre+fenetre0"]));
    // une commode basse sous l'allège ne gêne pas la fenêtre
    expect(m.conflicts.some((c) => c.a === "bas" || c.b === "bas")).toBe(false);
    expect(m.conflicts.some((c) => c.type === "chevauchement" && [c.a, c.b].includes("traverse") && [c.a, c.b].some((n) => n.startsWith("mur")))).toBe(true);
    expect(pairs(m, "hors-espace")).toEqual(expect.arrayContaining(["dehors+espace"]));
  });
});
