import { describe, expect, it } from "vitest";
import { resolveStyle } from "./style";
import { encodeRoleFinishes, readRoleFinishes } from "./finishes";
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
});
