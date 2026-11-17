import { describe, expect, it } from "vitest";
import { readMonde } from "./format";
import { mondeParams, openingIndex } from "./edit";

const monde = (params: Record<string, unknown> = {}) => ({
  unite: "cm",
  espace: { contour: [[0, 0], [350, 0], [350, 300], [0, 300]], hauteur: 250, bords: [0, 1, 2, 3].map((b) => ({ bord: b })) },
  ouvertures: [{ type: "porte", bord: 3, at: 105, params }, { type: "fenetre", bord: 1, at: 150 }],
  place: [],
});

/** Position (unité du document) d'une pièce du modèle de la porte. */
function partAt(params: Record<string, unknown>, part: string): number[] {
  const m = readMonde(monde(params));
  const inst = m.place.find((p) => p.name === "porte0")!;
  const md = m.models.get(inst.model)!;
  const p = md.parts.find((q) => q.name === part) as unknown as { at?: number[]; t?: number[]; pos?: number[] };
  return (p.at ?? p.t ?? p.pos ?? []) as number[];
}

describe("porte : sens", () => {
  it("nomme les ouvertures comme l'espace et règle leurs paramètres (sauf la taille)", () => {
    const w = monde();
    expect(openingIndex(w, "porte0")).toBe(0);
    expect(openingIndex(w, "fenetre0")).toBe(1);
    const n = mondeParams(w, "porte0", { charniere: "droite", largeur: 120 }) as ReturnType<typeof monde>;
    expect(n.ouvertures[0].params).toEqual({ charniere: "droite" });
  });
  it("lit les réglages de sens sans erreur", () => {
    for (const charniere of ["gauche", "droite"]) for (const ouvre of ["dedans", "dehors"]) for (const angle of [0, 45, 90]) {
      const m = readMonde(monde({ charniere, ouvre, angle }));
      expect(m.issues, `${charniere} ${ouvre} ${angle}`).toEqual([]);
    }
  });
  it("le battant entrouvert passe du côté choisi, la poignée du côté opposé aux gonds", () => {
    const at = (o: Record<string, unknown>, part: string) => partAt(o, part);
    expect(JSON.stringify(at({}, "battant"))).not.toBe("[]");
    expect(at({ ouvre: "dedans", angle: 45 }, "battant")[2]).toBeGreaterThan(0);
    expect(at({ ouvre: "dehors", angle: 45 }, "battant")[2]).toBeLessThan(0);
    expect(at({ charniere: "gauche" }, "poignee")[0]).toBeGreaterThan(0);
    expect(at({ charniere: "droite" }, "poignee")[0]).toBeLessThan(0);
    expect(at({ ouvre: "dehors" }, "gond")[2]).toBeLessThan(0);
  });
});
