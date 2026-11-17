import { describe, expect, it } from "vitest";
import { readMonde } from "./format";
import { generateTile, heightAt, TileManager } from "./infini";

const MONDE = {
  models: { arbre: { parts: [{ name: "t", cylinder: [0.2, 2], at: [0, 1, 0] }] }, rocher: { parts: [{ name: "r", sphere: 0.5 }] } },
  infini: {
    seed: "vallee", tile: 32, radius: 2, follow: "heros",
    ground: { relief: "= 2 * noise(x / 50, z / 50)", color: "#6b8f4e" },
    biomes: { field: "= noise(x / 100, z / 100)", list: [{ to: 0, name: "prairie", color: "#8fbf5a" }, { to: 1, name: "foret", color: "#3f7a3a" }] },
    layers: [
      { model: "arbre", cell: 4, density: "= biome == 'foret' ? 0.8 : 0.05" },
      { models: ["rocher"], cell: 10, density: 0.3 },
      { model: "lit" },
    ],
  },
};

describe("monde infini", () => {
  it("lecture : calques, biomes, modèles du catalogue résolus, inconnus signalés", () => {
    const m = readMonde(MONDE);
    expect(m.infini!.layers.length).toBe(3);
    expect(m.models.has(m.infini!.layers[2].models[0])).toBe(true);
    expect(m.infini!.biomes.map((b) => b.name)).toEqual(["prairie", "foret"]);
    expect(m.place.length).toBe(0);
  });

  it("tuile déterministe, identifiants stables, objets posés sur le relief", () => {
    const s = readMonde(MONDE).infini!;
    const a = generateTile(s, 3, -2), b = generateTile(s, 3, -2);
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
    expect(a.items.length).toBeGreaterThan(0);
    for (const it of a.items) {
      expect(it.x).toBeGreaterThanOrEqual(96);
      expect(it.x).toBeLessThan(128);
      expect(it.y).toBeCloseTo(heightAt(s, it.x, it.z), 6);
    }
  });

  it("la forêt est plus dense que la prairie", () => {
    const s = readMonde(MONDE).infini!;
    let foret = 0, prairie = 0;
    for (let cx = -6; cx < 6; cx++)
      for (let cz = -6; cz < 6; cz++) {
        const t = generateTile(s, cx, cz);
        const trees = t.items.filter((i) => i.layer === 0).length;
        if (t.biome === "foret") foret += trees;
        else prairie += trees;
      }
    expect(foret).toBeGreaterThan(prairie);
  });

  it("retouches du joueur : objet retiré, objet ajouté", () => {
    const s = readMonde(MONDE).infini!;
    const t = generateTile(s, 0, 0);
    const id = t.items[0].id;
    const e = generateTile(s, 0, 0, { remove: [id], add: [{ model: "rocher", x: 3, z: 4 }] });
    expect(e.items.some((i) => i.id === id)).toBe(false);
    expect(e.items.some((i) => i.model === "rocher" && i.x === 3)).toBe(true);
  });

  it("chargement autour du centre, relâche derrière, tuile entrée signalée", () => {
    const tm = new TileManager();
    tm.set(readMonde(MONDE).infini!);
    const entered: string[] = [];
    tm.onEnter = (e) => entered.push(`${e.cx},${e.cz}`);
    for (let k = 0; k < 10; k++) tm.update(0, 0, 1000);
    expect(tm.tiles.size).toBe(21);
    expect(tm.tiles.has("0,0")).toBe(true);
    for (let k = 0; k < 10; k++) tm.update(10 * 32, 0, 1000);
    expect(tm.tiles.has("0,0")).toBe(false);
    expect(tm.tiles.has("10,0")).toBe(true);
    expect(entered).toEqual(["0,0", "10,0"]);
  });
});
