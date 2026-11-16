import { describe, expect, it } from "vitest";
import { mondeAdd, WALL_DECO_Y } from "./edit-add";

const monde = {
  unite: "cm",
  espace: { contour: [[0, 0], [350, 0], [350, 300], [0, 300]], hauteur: 250, bords: [0, 1, 2, 3].map((b) => ({ bord: b })) },
  catalogue: ["poster", "cadre", "lit"],
  place: [],
};

type Pl = { name: string; at: number[] };

describe("mondeAdd : décoration murale", () => {
  it("accroche un poster ajouté sans hauteur vers 1,2 m", () => {
    const m = mondeAdd(monde, { model: "poster", params: { largeur: 50, hauteur: 70 } }) as { place: Pl[] };
    const p = m.place[m.place.length - 1];
    expect(p.at[1] / 100).toBeCloseTo(WALL_DECO_Y, 1);
  });
  it("laisse un meuble au sol", () => {
    const m = mondeAdd(monde, { model: "lit" }) as { place: Pl[] };
    const p = m.place[m.place.length - 1];
    expect(Math.abs((p.at?.[1] ?? 0) / 100)).toBeLessThan(0.05);
  });
});
