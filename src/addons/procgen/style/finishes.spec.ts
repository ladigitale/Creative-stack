import { describe, expect, it } from "vitest";
import { resolveStyle } from "./style";
import { FIN_ROWS, encodeRoleFinishes, encodeRoleTex, finishMotif, readRoleFinishes, type FinishMotif } from "./finishes";
import { ROLES } from "./roles";
import { readMonde } from "../../../shared/monde/format";

describe("finis par rôle (procgen)", () => {
  it("jeton de style matieres : rôles procgen ou du format, finis prêts ou réglés", () => {
    const s = resolveStyle({ preset: "doux", matieres: { metal: "chrome", maillot: { fini: "velours", rough: 0.9 } } });
    expect(s.finishes.metal?.metal).toBe(1);
    expect(s.finishes.cloth1?.sheen).toBe(1);
    const a = encodeRoleFinishes(s.finishes);
    const i = ROLES.indexOf("metal");
    expect(a[i * 4]).toBeCloseTo(1.04, 5);
    expect(a[i * 4 + 1]).toBe(1);
    // rôle sans fini : 0 (éclairage du style)
    expect(a[ROLES.indexOf("skin") * 4]).toBe(0);
  });
  it("erreurs : rôle ou fini inconnus", () => {
    const bad: string[] = [];
    readRoleFinishes({ nimbus: "chrome", metal: "gelee" }, (r, m) => bad.push(`${r}: ${m}`));
    expect(bad.length).toBe(2);
  });
  it("modèle gen : finis par rôle et accessoires portés par les os", () => {
    const m = readMonde({
      models: {
        heros: {
          gen: "character",
          finish: { maillot: "velours" },
          parts: [
            { name: "cape", parent: "torse", box: [0.5, 0.8, 0.02], souple: "tissu" },
            { name: "gant", parent: "main", box: [0.08, 0.1, 0.05], mirror: "x" },
            { name: "cou", sphere: 0.1 },
            { name: "rien", parent: "tete" },
          ],
        },
      },
    });
    const h = m.models.get("heros")!;
    expect(h.gen?.finishes?.maillot?.sheen).toBe(1);
    const acc = h.parts.filter((p) => p.accessory).map((p) => p.name);
    expect(acc).toEqual(expect.arrayContaining(["cape", "gantL", "gantR"]));
    expect(h.parts[h.parts.findIndex((p) => p.name === "cape")].soft?.kind).toBe("tissu");
    // un nom d'os ou un accessoire sans forme est refusé
    expect(m.issues.filter((i) => /accessoire d'un modèle gen/.test(i.message)).length).toBe(2);
  });

  it("finis texturés : motif par défaut du fini, du rôle, ou écrit ; table par rôle", () => {
    const s = resolveStyle({ matieres: { road: "pave", wall: "brique", bark: "ecorce", stone: { fini: "pierre", profondeur: 0.2 }, trim: { relief: 0.5 }, roof: { fini: "brique", motif: "ecailles", echelle: 4 } } });
    expect(finishMotif("road", s.finishes.road!).kind).toBe("dalles");
    expect(finishMotif("wall", s.finishes.wall!).kind).toBe("brique");
    expect(finishMotif("bark", s.finishes.bark!).kind).toBe("fourrure");
    // fini sans nom : motif du rôle
    expect(finishMotif("trim", s.finishes.trim!).kind).toBe("pierre");
    expect(s.finishes.roof!.motif).toMatchObject({ kind: "ecailles", scale: 4 });
    expect(s.finishes.stone!.depth).toBe(0.2);
    const used: FinishMotif[] = [];
    const layerOf = (m: FinishMotif) => {
      const i = used.findIndex((u) => u.kind === m.kind && u.seed === m.seed);
      return i >= 0 ? i : used.push(m) - 1;
    };
    const { data, on } = encodeRoleTex(layerOf, s.finishes);
    expect(on).toBe(true);
    const n = ROLES.length;
    const road = ROLES.indexOf("road");
    expect(data.length).toBe(n * FIN_ROWS * 4);
    expect(data[road * 4]).toBeCloseTo(0.7); // relief du pavé
    expect(data[road * 4 + 1]).toBeCloseTo(0.7); // profondeur
    expect(data[(n + road) * 4]).toBeGreaterThan(0.5); // couche + 1
    expect(data[(n + road) * 4 + 1]).toBeCloseTo(3.5); // répétitions par mètre
    // brique et ecailles, dalles, fourrure, pierre (deux rôles) : 5 motifs distincts
    expect(used.map((u) => u.kind).sort()).toEqual(["brique", "dalles", "ecailles", "fourrure", "pierre"]);
  });
  it("finis texturés : rien d'allumé pour des finis lisses ; verre et eau ; caoutchouc rehaussé", () => {
    const lisse = resolveStyle({ matieres: { metal: "chrome", cloth1: "satine" } });
    expect(encodeRoleTex(() => 0, lisse.finishes).on).toBe(false);
    expect(encodeRoleTex(() => 0, {}).on).toBe(false);
    const s = resolveStyle({ matieres: { glass: "verre", water: "eau", black: "caoutchouc", red: { fini: "caoutchouc", relief: 0 } } });
    const { data, on } = encodeRoleTex(() => 0, s.finishes);
    expect(on).toBe(true);
    const n = ROLES.length, g = ROLES.indexOf("glass"), w = ROLES.indexOf("water");
    expect(data[(n + g) * 4 + 2]).toBe(1);
    expect(data[(n + g) * 4 + 3]).toBeCloseTo(1.5);
    expect(data[(n + w) * 4 + 3]).toBeCloseTo(1.33);
    // verre sans cartes : pas de couche de motif
    expect(data[(n + g) * 4]).toBe(0);
    expect(s.finishes.black!.relief).toBeGreaterThan(0);
    expect(s.finishes.red!.relief).toBe(0);
  });
  it("finis texturés : motif inconnu signalé", () => {
    const bad: string[] = [];
    const f = readRoleFinishes({ wall: { fini: "brique", motif: "zebre" } }, (r, m) => bad.push(`${r}: ${m}`));
    expect(bad.length).toBe(1);
    expect(f.wall?.relief).toBeGreaterThan(0);
  });
});
