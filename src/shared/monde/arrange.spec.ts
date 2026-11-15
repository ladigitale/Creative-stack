import { describe, expect, it } from "vitest";
import { MondeDriver } from "./driver";
import { placedInfo } from "./arrange";
import { readMonde } from "./format";
import { measureGen } from "./supports";

const piece = (place: unknown[], extra: Record<string, unknown> = {}) =>
  readMonde({
    unite: "cm",
    espace: { contour: [[0, 0], [420, 0], [420, 310], [0, 310]], hauteur: 250, plafond: true, bords: [{ bord: 3, ouvertures: [{ type: "porte", at: 250 }] }], zones: [{ nom: "plancher", revetement: "parquet" }] },
    place,
    ...extra,
  });
const drive = (m: ReturnType<typeof readMonde>) => {
  const d = new MondeDriver();
  d.setMonde(m, 0);
  d.step(0);
  return d;
};

describe("rangement : aimantation et place libre", () => {
  it("un meuble à dos se colle au mur dont il s'approche, tourné vers la pièce", () => {
    const d = drive(piece([{ model: "commode", name: "c", at: [200, 0, 150] }]));
    // lâché à 20 cm du mur du fond (z = 3,1) : dos au mur
    const r = d.arrangeTo("c", 2.0, 2.8, 1)!;
    expect(r.snaps).toContain("mur");
    expect(r.at[2]).toBeCloseTo(3.1);
    expect(Math.cos(r.ry)).toBeCloseTo(-1);
    expect(r.valid).toBe(true);
    // lâché au milieu de la pièce : libre, sur la grille de 5 cm, cap gardé
    const r2 = d.arrangeTo("c", 2.03, 1.52, 2)!;
    expect(r2.snaps).not.toContain("mur");
    expect(r2.at[0]).toBeCloseTo(2.05);
    expect(r2.at[2]).toBeCloseTo(1.5);
  });

  it("s'aligne sur le bord d'un voisin proche", () => {
    const d = drive(piece([{ model: "table", name: "a", at: [150, 0, 150], params: { largeur: 120, profondeur: 80 } }, { model: "table", name: "b", at: [300, 0, 250], params: { largeur: 120, profondeur: 80 } }]));
    // b visée à 3 cm de l'alignement des bords gauches (x = 0,9) : ramenée dessus
    const r = d.arrangeTo("b", 1.53, 2.5, 1)!;
    expect(r.snaps).toContain("aligne-x");
    expect(r.at[0]).toBeCloseTo(1.5);
  });

  it("lâché sur un meuble, un objet glisse à la place libre la plus proche ; sans place, la pose est invalide", () => {
    const d = drive(piece([{ model: "armoire", name: "armoire", against: "mur2", at: 200, params: { largeur: 150 } }, { model: "commode", name: "c", at: [100, 0, 100] }]));
    const a = d.instances.get("armoire")!.t;
    const r = d.arrangeTo("c", a.x, a.z - 0.4, 1)!;
    expect(r.valid).toBe(true);
    expect(r.snaps).toContain("deplace");
    // hors de l'armoire maintenant
    const m2 = d.bodies();
    expect(m2.find((b) => b.name === "c")!.at).toEqual(r.at);
    const far = d.arrangeTo("c", 12, 12, 2)!;
    expect(far.valid).toBe(false);
    expect(far.hits).toContain("espace");
  });

  it("ne se pose pas dans le passage de la porte", () => {
    const d = drive(piece([{ model: "commode", name: "c", at: [200, 0, 150] }]));
    // porte sur le mur x = 0, centrée en z = 0,6
    const r = d.arrangeTo("c", 0.2, 0.6, 1)!;
    expect(r.valid).toBe(true);
    expect(r.snaps).toContain("deplace");
    expect(Math.abs(r.at[2] - 0.6)).toBeGreaterThan(0.6);
  });

  it("chaque objet va sur l'appui de sa nature : mur, plafond, dessus d'un meuble", () => {
    const d = drive(
      piece([
        { model: "bureau", name: "bureau", against: "mur0", at: 300, params: { largeur: 140 } },
        { model: "cadre", name: "cadre", on: "mur0", at: [100, 130] },
        { model: "suspension", name: "lustre", on: "plafond", at: [100, 100] },
        { model: "lampe", name: "lampe", on: "plancher", at: [200, 200] },
      ]),
    );
    // cadre visé près du mur du fond : il y passe, à la même hauteur
    const c = d.arrangeTo("cadre", 2, 2.9, 1)!;
    expect(c.carry?.support).toBe("mur2");
    expect(c.at[2]).toBeCloseTo(3.1);
    expect(c.at[1]).toBeCloseTo(1.3);
    const l = d.arrangeTo("lustre", 3, 2, 1)!;
    expect(l.carry?.support).toBe("plafond");
    expect(l.at[1]).toBeCloseTo(2.5);
    expect(l.at[0]).toBeCloseTo(3);
    // lampe lâchée au-dessus du bureau : posée sur son plateau ; puis elle suit le bureau
    const b = d.instances.get("bureau")!.t;
    const p = d.arrangeTo("lampe", b.x, b.z + 0.3, 1)!;
    expect(p.carry?.support).toBe("bureau");
    expect(p.at[1]).toBeCloseTo(0.74);
    d.step(2);
    const before = d.instances.get("lampe")!.t.x;
    d.apply("bureau", { x: b.x - 0.5 }, 3, false, true);
    d.step(4);
    expect(d.instances.get("lampe")!.t.x).toBeCloseTo(before - 0.5);
    // lâchée au sol ensuite : elle se détache
    const s = d.arrangeTo("lampe", 2, 2, 5)!;
    expect(s.carry).toBeNull();
    expect(s.at[1]).toBeCloseTo(0);
  });

  it("nodes.move range l'instance (trajet animé avec ease) et le résultat se traduit en placement durable", () => {
    const m = piece([{ model: "commode", name: "c", at: [200, 0, 150] }, { model: "lampe", name: "l", on: "plancher", at: [100, 100] }]);
    const d = drive(m);
    d.apply("c", { move: [2, 2.9], ease: { ms: 100 } }, 10, true, true);
    d.step(60);
    const t = d.instances.get("c")!.t;
    expect(t.z).toBeGreaterThan(1.5);
    expect(t.z).toBeLessThan(3.1);
    d.step(110);
    expect(t.z).toBeCloseTo(3.1);
    const info = placedInfo("c", d.instances.get("c")!.placed!, d.bodies(), m.unit);
    expect(info).toMatchObject({ objectId: "c", valid: true });
    // en centimètres, comme le document
    expect((info.place.at as number[])[2]).toBeCloseTo(310);
    expect((info.place.rot as number[])[1]).toBeCloseTo(-180, 0);
    // objet posé sur un meuble : on + at relatifs au dessus
    d.arrangeTo("l", t.x, t.z - 0.2, 200);
    const li = placedInfo("l", d.instances.get("l")!.placed!, d.bodies(), m.unit);
    expect(li.place.on).toBe("c");
    expect((li.place.at as number[]).length).toBe(2);
    // relire le monde avec ce placement redonne la même position
    const again = readMonde({
      unite: "cm",
      espace: { contour: [[0, 0], [420, 0], [420, 310], [0, 310]], hauteur: 250 },
      place: [{ model: "commode", name: "c", ...info.place }, { model: "lampe", name: "l", ...li.place }],
    });
    const c2 = again.place.find((p) => p.name === "c")!, l2 = again.place.find((p) => p.name === "l")!;
    expect(c2.at[0]).toBeCloseTo(t.x);
    expect(c2.at[2]).toBeCloseTo(t.z);
    const lt = d.instances.get("l")!;
    d.step(201);
    expect(l2.at[0]).toBeCloseTo(lt.t.x);
    expect(l2.at[1]).toBeCloseTo(lt.t.y);
    expect(l2.at[2]).toBeCloseTo(lt.t.z);
  });
});

describe("modèles procgen : mesurés par le rendu, puis testés comme les autres", () => {
  it("une chaise mesurée gêne un meuble qu'elle traverse, pas la table sous laquelle elle est glissée", () => {
    const spec = { gen: "seat.chair" };
    const world = (x: number, z = 0.55) => ({
      collisions: true,
      models: { chaise: spec, table: { parts: [{ name: "plateau", box: [1.6, 0.04, 0.8], at: [0, 0.74, 0] }], }, bloc: { parts: [{ box: [0.6, 1, 0.6], at: [0, 0.5, 0] }] } },
      place: [{ model: "table", name: "t" }, { model: "bloc", name: "bloc", at: [3, 0, 0] }, { model: "chaise", name: "c", at: [x, 0, z], rot: [0, 180, 0] }],
    });
    const m0 = readMonde(world(0));
    // pas encore mesurée : rien à tester
    expect(m0.conflicts).toEqual([]);
    // maillage d'une chaise : assise 45 × 45 cm à 45 cm, dossier mince à l'arrière jusqu'à 90 cm
    const pos: number[] = [];
    for (const [x, y, z] of [[-0.22, 0, -0.22], [0.22, 0, 0.22], [-0.22, 0.45, -0.22], [0.22, 0.45, 0.22], [-0.22, 0.46, -0.22], [0.22, 0.9, -0.18]]) pos.push(x, y, z);
    expect(measureGen(m0.models.get("chaise")!.gen!, pos)).toBe(true);
    // glissée sous la table (dossier dehors, tourné vers nous) : pas de conflit
    expect(readMonde(world(0)).conflicts).toEqual([]);
    // dans le bloc : conflit
    const hit = readMonde(world(3, 0.2)).conflicts;
    expect(hit.some((c) => c.type === "chevauchement" && [c.a, c.b].sort().join("+") === "bloc+c")).toBe(true);
  });

  it("collisions: \"montrer\" donne les boîtes des objets en conflit", () => {
    const m = readMonde({ collisions: "montrer", models: { bloc: { parts: [{ box: [1, 1, 1], at: [0, 0.5, 0] }] } }, place: [{ model: "bloc", name: "a" }, { model: "bloc", name: "b", at: [0.5, 0, 0] }, { model: "bloc", name: "c", at: [5, 0, 0] }] });
    expect(m.conflicts).toHaveLength(1);
    expect(m.marks).toHaveLength(2);
    expect(readMonde({ collisions: true, models: { bloc: { parts: [{ box: [1, 1, 1] }] } }, place: [{ model: "bloc" }, { model: "bloc" }] }).marks).toEqual([]);
  });

  it("mur plein près du point visé : un meuble au sol prend la place libre du sol, un cadre un autre mur", () => {
    const d = drive(
      piece([
        { model: "armoire", name: "a1", against: "mur2", at: 110, params: { largeur: 200 } },
        { model: "armoire", name: "a2", against: "mur2", at: 310, params: { largeur: 200 } },
        { model: "commode", name: "c", at: [100, 0, 100] },
        { model: "cadre", name: "cadre", on: "mur0", at: [100, 130] },
      ]),
    );
    // commode lâchée devant les armoires, assez près du mur pour s'y aimanter : le mur est plein
    const r = d.arrangeTo("c", 2.1, 2.3, 1)!;
    expect(r.valid).toBe(true);
    expect(r.snaps).toContain("deplace");
    expect(r.hits).toEqual([]);
    // cadre visé sur le mur des armoires : il va sur un autre mur
    const c = d.arrangeTo("cadre", 2.1, 2.95, 2)!;
    expect(c.valid).toBe(true);
    expect(c.carry?.support).not.toBe("mur2");
  });
});

describe("conflits de la scène après un rangement", () => {
  it("le pilote recalcule les conflits sur les positions courantes", () => {
    const m = piece([
      { model: "commode", name: "c1", at: [200, 0, 150] },
      { model: "commode", name: "c2", at: [210, 0, 150] },
    ], { collisions: "montrer" });
    expect(m.collide).toBe("montrer");
    expect(m.conflicts.some((c) => c.type === "chevauchement")).toBe(true);
    const d = drive(m);
    expect(d.collisions()!.marks.length).toBeGreaterThan(0);
    d.arrangeTo("c2", 2.1, 1.5, 1);
    const after = d.collisions()!;
    expect(after.conflicts.filter((c) => c.type === "chevauchement")).toEqual([]);
    expect(after.marks).toEqual([]);
  });

  it("sans recherche de collisions, rien à recalculer", () => {
    const d = drive(readMonde({ collisions: false, models: { b: { parts: [{ box: [1, 1, 1] }] } }, place: [{ model: "b", name: "x" }] }));
    expect(d.collisions()).toBeNull();
  });

  it("un objet sans nom posé sur un meuble nommé est nommé, suit son appui et se déplace lui-même", () => {
    const m = piece([
      { model: "bureau", name: "bureau", against: "mur0", at: 300, params: { largeur: 140 } },
      { model: "lampe", on: "bureau", at: [-50, 0] },
      { model: "cadre", on: "mur0", at: [100, 130] },
    ]);
    const lampe = m.place.find((p) => p.model.startsWith("lampe"))!;
    expect(lampe.name).toBe("bureau-lampe1");
    // sur un mur : reste du décor
    expect(m.place.find((p) => p.model.startsWith("cadre"))!.name).toBe("");
    const d = drive(m);
    const before = { ...d.instances.get("bureau-lampe1")!.t };
    const r = d.arrangeTo("bureau", 1.0, 0.3, 1)!;
    expect(r.valid).toBe(true);
    d.step(2);
    const after = d.instances.get("bureau-lampe1")!.t;
    expect(after.x - before.x).toBeCloseTo(r.at[0] - 3.0, 1);
    expect(d.movable("bureau-lampe1")).toBe(true);
    expect(d.movable("mur0")).toBe(false);
  });
});
