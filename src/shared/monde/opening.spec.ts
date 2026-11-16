import { describe, expect, it } from "vitest";
import { readMonde } from "./format";
import { edgeUnderRay, slideOpening } from "./opening";
import { mondePlace } from "./edit";
import { MondeDriver } from "./driver";

const chambre = {
  unite: "cm",
  espace: {
    contour: [[0, 0], [350, 0], [350, 300], [0, 300]],
    hauteur: 250,
    bords: [{ bord: 2, ouvertures: [{ type: "fenetre", at: 175, largeur: 120 }] }],
  },
  ouvertures: [
    { type: "porte", bord: 3, at: 105 },
    { type: "fenetre", bord: 1, at: 150, largeur: 120, hauteur: 125, allege: 90 },
  ],
  place: [],
};

describe("ouvertures posées à part (monde.ouvertures)", () => {
  const m = readMonde(chambre);

  it("deviennent des menuiseries comme celles des bords, avec leur rang et leur bord", () => {
    expect(m.issues).toEqual([]);
    expect(m.openings.porte0).toMatchObject({ index: 0, bord: 3, at: 105 });
    // noms dans l'ordre de la liste : fenetre0 est celle de monde.ouvertures, celle écrite dans un bord est fixe
    expect(m.openings.fenetre0).toMatchObject({ index: 1, bord: 1, at: 150 });
    expect(m.openings.fenetre1.index).toBe(-1);
    expect(m.edges.map((e) => e.bord)).toEqual([0, 1, 2, 3]);
  });

  it("gardent leur nom quand elles changent de mur", () => {
    const moved = readMonde({ ...chambre, ouvertures: [{ ...chambre.ouvertures[0], bord: 0, at: 250 }, chambre.ouvertures[1]] });
    expect(moved.openings.porte0).toMatchObject({ index: 0, bord: 0 });
    expect(moved.openings.fenetre0.index).toBe(1);
  });

  it("glisse sur le mur le plus proche du point, au pas de 5 cm, sans dépasser du mur", () => {
    // près du mur du haut (z = 0), vers x = 2 m
    const s = slideOpening(m, "porte0", 2.02, 0.2)!;
    expect(s.ouverture).toEqual({ index: 0, bord: 0, at: 200 });
    // dans l'épaisseur du mur (10 cm)
    expect(s.z).toBeCloseTo(-0.05, 3);
    const bout = slideOpening(m, "porte0", 3.4, 0.02)!;
    // son milieu reste à une demi-largeur du bout du mur
    expect(bout.ouverture.at).toBeCloseTo(350 - m.openings.porte0.w / 2, 4);
  });

  it("ne chevauche pas une autre ouverture : se range contre elle", () => {
    // sur le mur du bas, la fenêtre fixe occupe 115…235
    const s = slideOpening(m, "porte0", 1.75, 2.9, 2)!;
    expect(s.ouverture.bord).toBe(2);
    expect(Math.abs(s.ouverture.at - 175)).toBeCloseTo((m.openings.porte0.w + 120) / 2, 4);
  });

  it("refuse les ouvertures fixes", () => {
    expect(slideOpening(m, "fenetre1", 1, 0.1)).toBeNull();
  });

  it("rayon : touche le mur vu de l'intérieur, traverse celui vu de dehors", () => {
    // caméra au sud, dehors (z = 6 m), qui regarde vers le nord : le mur du bas (z = 3) est vu de dos
    const hit = edgeUnderRay(m.edges, [1.5, 1, 6], [0, 0, -1])!;
    expect(hit.bord).toBe(0);
    expect(hit.z).toBeCloseTo(0, 1);
  });

  it("$mondePlace recopie bord et at dans monde.ouvertures", () => {
    const next = mondePlace(chambre, { objectId: "porte0", place: {}, ouverture: { index: 0, bord: 0, at: 200 } }) as typeof chambre;
    expect(next.ouvertures[0]).toEqual({ type: "porte", bord: 0, at: 200 });
    expect(next.ouvertures[1]).toBe(chambre.ouvertures[1]);
    expect(chambre.ouvertures[0].bord).toBe(3);
  });

  it("le pilote les rend saisissables et publie leur place", () => {
    const d = new MondeDriver();
    d.setMonde(m, 0);
    expect(d.movable("porte0")).toBe(true);
    expect(d.movable("fenetre1")).toBe(false);
    expect(d.movable("mur0")).toBe(false);
    const res = d.arrangeTo("porte0", 2, 0.1, 0)!;
    expect(res.ouverture).toEqual({ index: 0, bord: 0, at: 200 });
    expect(d.instances.get("porte0")!.t.x).toBeCloseTo(2, 3);
  });
});
