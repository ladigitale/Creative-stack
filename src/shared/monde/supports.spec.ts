import { describe, expect, it } from "vitest";
import { mondeSummary, readMonde } from "./format";
import { MondeDriver } from "./driver";
import { boundsOf, surfaceOf, turnY } from "./supports";
import { m4, m4Compose } from "./math";

const models = {
  table: {
    parts: [
      { name: "plateau", box: [1.6, 0.05, 0.8], at: [0, 0.75, 0], surface: "top" },
      { name: "pied", cylinder: [0.03, 0.75], at: [0.7, 0.375, 0.3], mirror: "x" },
      { name: "tablette", box: [1.2, 0.02, 0.4], at: [0, 0.3, 0], surface: "bas" },
    ],
  },
  paquet: { parts: [{ name: "boite", box: [0.3, 0.2, 0.2], at: [0, 0.1, 0] }] },
  livre: { parts: [{ box: [0.15, 0.03, 0.22], at: [0, 0.015, 0] }] },
  arbre: { parts: [{ name: "tronc", cylinder: [0.2, 2], at: [0, 1, 0] }] },
  maison: { famille: "batiment", parts: [{ box: [6, 3, 6], at: [0, 1.5, 0] }] },
};

describe("emprises et surfaces", () => {
  it("mesure le modèle au repos et ses surfaces", () => {
    const m = readMonde({ models, place: [{ model: "table", name: "t" }] });
    const table = m.models.get("table")!;
    const b = boundsOf(table)!;
    expect(b.min[1]).toBeCloseTo(0);
    expect(b.max[1]).toBeCloseTo(0.775);
    expect(b.max[0]).toBeCloseTo(0.8);
    expect(surfaceOf(table, "top")).toMatchObject({ y: expect.closeTo(0.775, 5), x0: expect.closeTo(-0.8, 5), z1: expect.closeTo(0.4, 5) });
    expect(surfaceOf(table, "bas")!.y).toBeCloseTo(0.31);
    // une pièce est adressable par son nom, même sans `surface`
    expect(surfaceOf(table, "tablette")).not.toBeNull();
    expect(surfaceOf(table, "piedL")!.y).toBeCloseTo(0.75);
    expect(surfaceOf(table, "absente")).toBeNull();
  });

  it("turnY suit la convention de m4Compose", () => {
    const mat = m4Compose(m4(), 0, 0, 0, 0, 0.7, 0, 1, 1, 1);
    const [x, z] = turnY(2, 3, 0.7);
    expect(x).toBeCloseTo(mat[0] * 2 + mat[8] * 3);
    expect(z).toBeCloseTo(mat[2] * 2 + mat[10] * 3);
  });
});

describe("pose sur un appui", () => {
  it("pose sur le dessus, dans le repère de l'appui tourné, quel que soit l'ordre d'écriture", () => {
    const m = readMonde({
      models,
      place: [
        { model: "paquet", name: "colis", on: "t1", at: [0.5, 0.1] },
        { model: "table", name: "t1", at: [4, 0, 2], rot: [0, 90, 0] },
        { model: "livre", name: "l", on: "colis" },
        { model: "paquet", name: "bas", on: "t1@bas" },
      ],
    });
    expect(m.issues).toEqual([]);
    const colis = m.place.find((p) => p.name === "colis")!;
    const [dx, dz] = turnY(0.5, 0.1, Math.PI / 2);
    expect(colis.at[0]).toBeCloseTo(4 + dx);
    expect(colis.at[2]).toBeCloseTo(2 + dz);
    expect(colis.at[1]).toBeCloseTo(0.775);
    expect(colis.rot[1]).toBeCloseTo(Math.PI / 2);
    expect(colis.on).toMatchObject({ support: "t1", surface: "top" });
    // chaîne : le livre repose sur le paquet
    expect(m.place.find((p) => p.name === "l")!.at[1]).toBeCloseTo(0.775 + 0.2);
    expect(m.place.find((p) => p.name === "bas")!.at[1]).toBeCloseTo(0.31);
    expect(mondeSummary(m).instances.find((i) => i.name === "colis")).toMatchObject({ on: "t1@top" });
  });

  it("ramène dans le contour et signale ce qui dépasse ou se chevauche", () => {
    const m = readMonde({
      models,
      place: [
        { model: "table", name: "t" },
        { model: "paquet", name: "a", on: "t", at: [5, 0] },
        { model: "paquet", name: "b", on: "t", at: [0.6, 0] },
        { model: "maison", name: "trop", on: "t" },
      ],
    });
    const a = m.place.find((p) => p.name === "a")!;
    expect(a.at[0]).toBeCloseTo(0.8 - 0.15);
    expect(m.conflicts).toEqual(expect.arrayContaining([{ a: "a", b: "t@top", type: "hors-appui" }, { a: "b", b: "a", type: "chevauchement" }, { a: "trop", b: "t@top", type: "hors-appui" }]));
    expect(mondeSummary(m).conflicts).toHaveLength(m.conflicts.length);
  });

  it("semis et pile sur une surface : sans chevauchement, à la bonne hauteur", () => {
    const m = readMonde({
      models,
      place: [
        { model: "table", name: "t" },
        { model: "livre", on: "t", scatter: 6, spacing: 0.02 },
        { model: "paquet", on: "t@bas", stack: 3 },
      ],
    });
    const livres = m.place.filter((p) => p.model === "livre");
    expect(livres.length).toBeGreaterThanOrEqual(4);
    for (const l of livres) {
      expect(l.at[1]).toBeCloseTo(0.775);
      expect(Math.abs(l.at[0])).toBeLessThanOrEqual(0.8);
      expect(Math.abs(l.at[2])).toBeLessThanOrEqual(0.4);
    }
    for (let i = 0; i < livres.length; i++) for (let j = i + 1; j < livres.length; j++) expect(Math.hypot(livres[i].at[0] - livres[j].at[0], livres[i].at[2] - livres[j].at[2])).toBeGreaterThan(0.2);
    const pile = m.place.filter((p) => p.model === "paquet").map((p) => p.at[1]);
    expect(pile).toHaveLength(3);
    expect(pile[1] - pile[0]).toBeCloseTo(0.2);
    expect(pile[2] - pile[0]).toBeCloseTo(0.4);
  });

  it("au sol : base posée, écart minimal et zones à éviter", () => {
    const m = readMonde({
      models: { ...models, bille: { parts: [{ sphere: 0.5 }] } },
      place: [
        { model: "maison", name: "m1", at: [0, 0, 0] },
        { model: "bille", name: "b", on: "sol", at: [20, 0, 0] },
        { model: "arbre", scatter: 120, area: [-12, -12, 12, 12], spacing: 1, avoid: ["batiment"] },
      ],
    });
    expect(m.place.find((p) => p.name === "b")!.at[1]).toBeCloseTo(0.5);
    const arbres = m.place.filter((p) => p.model === "arbre");
    expect(arbres.length).toBeGreaterThan(30);
    for (const a of arbres) expect(Math.max(Math.abs(a.at[0]), Math.abs(a.at[2]))).toBeGreaterThan(3.2 - 1e-6);
    for (let i = 0; i < arbres.length; i++) for (let j = i + 1; j < arbres.length; j++) expect(Math.hypot(arbres[i].at[0] - arbres[j].at[0], arbres[i].at[2] - arbres[j].at[2])).toBeGreaterThanOrEqual(1.4 - 1e-6);
  });

  it("un semis sans spacing ni avoid garde exactement ses positions d'avant", () => {
    const a = readMonde({ models, place: [{ model: "arbre", scatter: 20, area: [-5, -5, 5, 5], seed: 3 }] });
    const b = readMonde({ models, place: [{ model: "arbre", scatter: 20, area: [-5, -5, 5, 5], seed: 3 }, { model: "table", name: "t" }, { model: "livre", on: "t" }] });
    expect(b.place.slice(0, 20).map((p) => p.at)).toEqual(a.place.map((p) => p.at));
  });

  it("appui inconnu : signalé, l'objet reste placé", () => {
    const m = readMonde({ models, place: [{ model: "livre", name: "l", on: "fantome", at: [1, 2, 3] }, { model: "table", name: "t" }, { model: "livre", on: "t@zzz" }] });
    expect(m.place).toHaveLength(3);
    const msgs = m.issues.map((i) => i.message).join("|");
    expect(msgs).toContain("appui inconnu");
    expect(msgs).toContain("surface inconnue");
  });
});

describe("pilote : une instance posée suit son appui", () => {
  const monde = () =>
    readMonde({
      models,
      place: [
        { model: "table", name: "t1", at: [0, 0, 0] },
        { model: "table", name: "t2", at: [5, 0, 0] },
        { model: "paquet", name: "colis", on: "t1", at: [0.4, 0] },
        { model: "livre", name: "l", on: "colis" },
      ],
    });

  it("déplacer et tourner l'appui déplace ce qu'il porte, de proche en proche", () => {
    const d = new MondeDriver();
    d.setMonde(monde(), 0);
    d.step(0);
    d.apply("t1", { x: 2, z: 1, ry: Math.PI / 2 }, 0, false, true);
    d.step(1);
    const c = d.instances.get("colis")!, l = d.instances.get("l")!;
    const [dx, dz] = turnY(0.4, 0, Math.PI / 2);
    expect(c.t.x).toBeCloseTo(2 + dx);
    expect(c.t.z).toBeCloseTo(1 + dz);
    expect(c.t.y).toBeCloseTo(0.775);
    expect(c.t.ry).toBeCloseTo(Math.PI / 2);
    expect(l.t.x).toBeCloseTo(c.t.x);
    expect(l.t.y).toBeCloseTo(0.975);
  });

  it("nodes.on change d'appui (avec trajet), null détache, une position détache aussi", () => {
    const d = new MondeDriver();
    d.setMonde(monde(), 0);
    d.step(0);
    d.apply("colis", { on: "t2@top", at: [-0.2, 0.1], ease: { ms: 100 }, lift: 0.3 }, 0, true, true);
    d.step(50);
    const c = d.instances.get("colis")!;
    expect(c.t.x).toBeGreaterThan(0.4);
    expect(c.t.x).toBeLessThan(4.8);
    expect(c.liftY).toBeCloseTo(0.3);
    d.step(100);
    expect(c.t.x).toBeCloseTo(4.8);
    expect(c.t.z).toBeCloseTo(0.1);
    expect(c.t.y).toBeCloseTo(0.775);
    // le livre a suivi le paquet
    expect(d.instances.get("l")!.t.x).toBeCloseTo(4.8);
    d.apply("t2", { x: 6 }, 100, false, true);
    d.step(101);
    expect(c.t.x).toBeCloseTo(5.8);
    d.apply("colis", { on: null }, 101, false, true);
    d.apply("t2", { x: 9 }, 101, false, true);
    d.step(102);
    expect(c.t.x).toBeCloseTo(5.8);
    d.apply("colis", { on: "t2" }, 102, false, true);
    d.apply("colis", { x: 1, y: 0, z: 1 }, 103, false, true);
    expect(c.carry).toBeNull();
    expect(c.t.x).toBe(1);
  });

  it("relire le même monde garde l'appui choisi en jeu", () => {
    const d = new MondeDriver();
    d.setMonde(monde(), 0);
    d.apply("colis", { on: "t2" }, 0, false, true);
    d.setMonde(monde(), 1);
    expect(d.instances.get("colis")!.carry!.support).toBe("t2");
  });
});
