import { describe, expect, it } from "vitest";
import { readMonde } from "./format";
import { boundsOf, inPolygon } from "./supports";
import { TEX_KINDS } from "./textures";

const chambre = {
  unite: "cm",
  espace: {
    contour: [[0, 0], [420, 0], [420, 310], [0, 310]],
    hauteur: 250,
    plafond: true,
    bords: [
      { couleur: "#f4f1ea" },
      { bord: 1, ouvertures: [{ type: "fenetre", at: 150, largeur: 120, hauteur: 125, allege: 90 }] },
      { bord: 3, couleur: "#2f5d62", ouvertures: [{ type: "porte", at: 60 }] },
    ],
    zones: [{ nom: "plancher", revetement: "parquet" }],
  },
  models: {
    etagere: { parts: [{ name: "planche", box: [80, 3, 22], at: [0, 1.5, 11], matiere: "chene" }] },
    lit: { parts: [{ name: "sommier", box: [90, 40, 190], at: [0, 20, 95], matiere: "pin" }] },
    suspension: { parts: [{ name: "fil", cylinder: [0.5, 40], at: [0, -20, 0] }, { name: "globe", sphere: 12, at: [0, -50, 0], glow: 0.8 }] },
    tapis: { parts: [{ box: [120, 1, 80], at: [0, 0.5, 0], color: "#c0392b" }] },
  },
  place: [
    { model: "etagere", name: "e1", on: "mur0", at: [200, 150] },
    { model: "lit", name: "lit", against: "mur2", at: 60 },
    { model: "suspension", name: "lampe", on: "plafond", at: [210, 155] },
    { model: "tapis", name: "tapis", on: "plancher", at: [210, 155] },
  ],
};

describe("espace : pièce", () => {
  const m = readMonde(chambre);
  const at = (n: string) => m.place.find((p) => p.name === n)!.at;

  it("murs, sol, plafond et menuiseries deviennent des instances nommées, sans problème signalé", () => {
    expect(m.issues).toEqual([]);
    for (const n of ["plancher", "mur0", "mur1", "mur2", "mur3", "plafond", "fenetre0", "porte0"]) expect(m.place.some((p) => p.name === n), n).toBe(true);
    // en mètres une fois lu
    const mur0 = m.models.get(m.place.find((p) => p.name === "mur0")!.model)!;
    const b = boundsOf(mur0)!;
    expect(b.max[1]).toBeCloseTo(2.5);
    expect(b.max[0] - b.min[0]).toBeCloseTo(4.2 + 0.1);
    expect(b.max[2]).toBeCloseTo(0);
    expect(b.min[2]).toBeCloseTo(-0.1);
  });

  it("le sol épouse le contour, dessus à hauteur zéro", () => {
    const sol = m.models.get(m.place.find((p) => p.name === "plancher")!.model)!;
    const b = boundsOf(sol)!;
    expect(b.min[0]).toBeCloseTo(0);
    expect(b.max[0]).toBeCloseTo(4.2);
    expect(b.min[2]).toBeCloseTo(0);
    expect(b.max[2]).toBeCloseTo(3.1);
    expect(b.max[1]).toBeCloseTo(0, 2);
    expect(sol.parts[0].tex?.kind).toBe("parquet");
  });

  it("une ouverture découpe le mur : allège, linteau, trumeaux", () => {
    const mur1 = m.models.get(m.place.find((p) => p.name === "mur1")!.model)!;
    const pans = mur1.parts.filter((p) => p.name.startsWith("pan"));
    expect(pans).toHaveLength(4);
    // aucune pièce du mur ne couvre le centre de la fenêtre (à 1,5 m du coin gauche, 1,5 m de haut)
    const L = 3.1;
    const cx = -L / 2 + 1.5, cy = 1.5;
    for (const p of pans) {
      const [w, h] = p.shape!.a;
      const inside = Math.abs(p.at[0] - cx) < w / 2 - 1e-6 && Math.abs(p.at[1] - cy) < h / 2 - 1e-6;
      expect(inside).toBe(false);
    }
    // la fenêtre est dans l'épaisseur du mur, à la hauteur de l'allège, dans la pièce ou sur son bord
    const f = at("fenetre0");
    expect(f[1]).toBeCloseTo(0.9);
    expect(f[0]).toBeCloseTo(4.2 + 0.05);
    const fen = m.models.get(m.place.find((p) => p.name === "fenetre0")!.model)!;
    expect(boundsOf(fen)!.max[1]).toBeCloseTo(1.25);
  });

  it("les murs sont des appuis verticaux, le plafond un appui par-dessous, le sol un appui en coordonnées de la pièce", () => {
    // mur0 : bord z = 0, vu de l'intérieur ; l'étagère a le dos au mur, sa base à 1,5 m
    const e = at("e1");
    expect(e[2]).toBeCloseTo(0);
    expect(e[1]).toBeCloseTo(1.5);
    expect(e[0] > 0.4 && e[0] < 3.8).toBe(true);
    // lit contre le mur du fond (z = 3,1), base au sol, à l'intérieur de la pièce
    const l = at("lit");
    expect(l[1]).toBeCloseTo(0);
    expect(l[2]).toBeCloseTo(3.1);
    const lit = m.place.find((p) => p.name === "lit")!;
    // son avant (z local +) regarde l'intérieur : cap du mur du fond
    expect(Math.abs(Math.cos(lit.rot[1]) + 1)).toBeLessThan(1e-6);
    // suspension : son point le plus haut touche le plafond, au point demandé de la pièce
    const s = at("lampe");
    expect(s[0]).toBeCloseTo(2.1);
    expect(s[2]).toBeCloseTo(1.55);
    expect(s[1]).toBeCloseTo(2.5);
    const t = at("tapis");
    expect(t[0]).toBeCloseTo(2.1);
    expect(t[2]).toBeCloseTo(1.55);
    expect(t[1]).toBeCloseTo(0, 2);
  });

  it("gauche et droite d'un mur se lisent de l'intérieur", () => {
    // mur0 (z = 0) vu de l'intérieur : on regarde vers -z, la droite est du côté des x croissants, la gauche en x = 0
    const m2 = readMonde({ ...chambre, place: [{ model: "etagere", name: "g", on: "mur0", at: [50, 100] }, { model: "etagere", name: "d", on: "mur0", at: [370, 100] }] });
    const g = m2.place.find((p) => p.name === "g")!.at[0], d = m2.place.find((p) => p.name === "d")!.at[0];
    expect(g).toBeCloseTo(0.5);
    expect(d).toBeCloseTo(3.7);
  });
});

describe("espace : jardin", () => {
  const contour = [[0, 0], [18, 0], [18, 12], [6, 14], [0, 12]];
  const massif = [[12, 8], [17, 8], [17, 11], [12, 11]];
  const m = readMonde({
    espace: {
      contour,
      bords: [{ type: "haie", hauteur: 1.6 }, { bord: 0, ouvertures: [{ type: "portail", at: 9 }] }],
      zones: [
        { nom: "pelouse", revetement: "gazon" },
        { nom: "terrasse", contour: [[1, 1], [7, 1], [7, 5], [1, 5]], revetement: "dalles" },
        { nom: "massif", contour: massif, revetement: "paillis", layers: [{ model: "fleur", cell: 0.5, density: 0.5, spacing: 0.05 }] },
      ],
    },
    models: { fleur: { parts: [{ sphere: 0.08, at: [0, 0.2, 0], color: "#e11d48" }] }, chaise: { parts: [{ box: [0.4, 0.45, 0.4], at: [0, 0.225, 0] }] } },
    place: [{ model: "chaise", name: "c", on: "terrasse", at: [3, 2] }],
  });

  it("clôture procgen par bord, interrompue au portail ; zones posées ; massif semé dans son contour", () => {
    expect(m.issues).toEqual([]);
    const haies = [...m.models.values()].filter((md) => md.gen?.id === "wall");
    expect(haies).toHaveLength(6);
    for (const h of haies) expect(h.gen!.params.kind).toBe("hedge");
    expect(m.place.some((p) => p.name === "portail0")).toBe(true);
    for (const n of ["pelouse", "terrasse", "massif"]) expect(m.place.some((p) => p.name === n)).toBe(true);
    const fleurs = m.place.filter((p) => p.model === "fleur");
    expect(fleurs.length).toBeGreaterThan(20);
    for (const f of fleurs) expect(inPolygon(f.at[0], f.at[2], massif)).toBe(true);
    const c = m.place.find((p) => p.name === "c")!.at;
    expect(c[0]).toBeCloseTo(3);
    expect(c[2]).toBeCloseTo(2);
  });

  it("contour concave : la face d'appui de chaque mur regarde l'intérieur", () => {
    const L = [[0, 0], [6, 0], [6, 3], [3, 3], [3, 6], [0, 6]];
    const r = readMonde({ espace: { contour: L, hauteur: 2.5 }, models: { cadre: { parts: [{ box: [0.4, 0.3, 0.02], at: [0, 0.15, 0.01] }] } }, place: L.map((_, i) => ({ model: "cadre", name: `c${i}`, on: `mur${i}`, at: [0.5, 1.2] })) });
    expect(r.issues).toEqual([]);
    for (let i = 0; i < L.length; i++) {
      const p = r.place.find((q) => q.name === `c${i}`)!;
      // un pas vers l'avant du cadre (son +z) reste dans la pièce
      const x = p.at[0] + Math.sin(p.rot[1]) * 0.2, z = p.at[2] + Math.cos(p.rot[1]) * 0.2;
      expect(inPolygon(x, z, L), `mur${i}`).toBe(true);
    }
  });

  it("erreurs signalées sans lever", () => {
    const r = readMonde({ espace: { contour: [[0, 0], [1, 0]], bords: [{ type: "zzz" }] } });
    expect(r.issues[0].path).toBe("espace.contour");
    const r2 = readMonde({ espace: { contour: [[0, 0], [4, 0], [4, 4], [0, 4]], hauteur: 2.5, bords: [{ type: "brique" }, { bord: 0, ouvertures: [{ type: "hublot", at: 1 }] }], zones: [{ revetement: "lave" }] } });
    const msgs = r2.issues.map((i) => i.message).join("|");
    expect(msgs).toContain("type de bord inconnu");
    expect(msgs).toContain("revêtement inconnu");
  });
});

describe("textures de sol", () => {
  it("les revêtements existent", () => {
    for (const k of ["parquet", "chevron", "moquette", "beton", "gravier", "dalles", "paillis"]) expect(TEX_KINDS).toContain(k);
  });
});
