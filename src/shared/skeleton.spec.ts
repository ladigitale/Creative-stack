import { describe, expect, it } from "vitest";
import { Rig, aimAngle, dir, perp, wrap180, type BoneSpec } from "./skeleton";

const bone = (name: string, parent: string | null, o: Partial<BoneSpec> = {}): BoneSpec => ({
  name,
  parent,
  length: 100,
  angle: 0,
  at: 1,
  offset: 0,
  min: -180,
  max: 180,
  ...o,
});
const near = (a: number, b: number, d = 5) => expect(a).toBeCloseTo(b, d);

describe("angles", () => {
  it("wrap180 : ramène dans ]-180, 180]", () => {
    expect(wrap180(190)).toBe(-170);
    expect(wrap180(-190)).toBe(170);
    expect(wrap180(180)).toBe(180);
    expect(wrap180(-180)).toBe(180);
    expect(wrap180(720)).toBe(0);
  });
  it("dir / perp : 0 = bas, positif = sens horaire à l'écran", () => {
    near(dir(0).x, 0);
    near(dir(0).y, 1);
    near(dir(90).x, -1); // bas → gauche
    near(dir(180).y, -1); // haut
    near(dir(-90).x, 1); // droite
    near(perp(0).x, 1); // l'os pointe vers le bas : « à droite » = +x
    near(perp(180).x, -1);
  });
  it("aimAngle : inverse de dir ; aspect ; vecteur nul", () => {
    near(aimAngle(0, 1)!, 0);
    near(aimAngle(-1, 0)!, 90);
    near(aimAngle(0, -1)!, 180);
    near(aimAngle(1, 0)!, -90);
    near(aimAngle(0.1, 0.1, 2)!, Math.atan2(-0.2, 0.1) * (180 / Math.PI));
    expect(aimAngle(0, 0)).toBeNull();
    for (const a of [-170, -45, 0, 33, 120]) near(wrap180(aimAngle(dir(a).x, dir(a).y)! - a), 0, 6);
  });
});

describe("Rig : structure", () => {
  it("ordre parents d'abord, même déclaré à l'envers", () => {
    const r = new Rig([bone("b", "a"), bone("a", null), bone("c", "b")]);
    expect(r.order).toEqual(["a", "b", "c"]);
    expect(r.errors).toEqual([]);
  });
  it("erreurs : parent inconnu, cycle, doublon, sans nom, trop d'os", () => {
    expect(new Rig([bone("a", "zz")]).errors[0]).toContain('parent "zz" inconnu');
    const cyc = new Rig([bone("a", "b"), bone("b", "a")]);
    expect(cyc.order).toEqual([]);
    expect(cyc.errors.join()).toContain("cycle");
    expect(new Rig([bone("a", null), bone("a", null)]).errors[0]).toContain("deux fois");
    expect(new Rig([bone("", null)]).errors[0]).toContain("sans nom");
    const many = Array.from({ length: 70 }, (_, i) => bone(`b${i}`, null));
    const r = new Rig(many);
    expect(r.order).toHaveLength(64);
    expect(r.errors.join()).toContain("64 au plus");
  });
  it("un descendant d'un os écarté est écarté", () => {
    const r = new Rig([bone("a", "zz"), bone("b", "a")]);
    expect(r.order).toEqual([]);
    expect(r.errors).toHaveLength(2);
  });
});

describe("Rig : résolution", () => {
  const arm = () => new Rig([bone("haut", null, { length: 100 }), bone("bas", "haut", { length: 80 })]);

  it("repos : rz = 0, chaîne vers le bas depuis la racine", () => {
    const s = arm().solve({ x: 200, y: 50 });
    expect(s.map((b) => b.rz)).toEqual([0, 0]);
    near(s[0].x, 200);
    near(s[0].y, 50);
    near(s[0].y2, 150);
    near(s[1].x, 200);
    near(s[1].y, 150);
    near(s[1].y2, 230);
  });

  it("delta : tourne autour de l'articulation ; l'enfant suit (sens horaire = vers la gauche)", () => {
    const s = arm().solve({ x: 0, y: 0 }, { haut: { delta: 90 } });
    near(s[0].rz, Math.PI / 2);
    near(s[0].x2, -100);
    near(s[0].y2, 0);
    near(s[1].x, -100);
    near(s[1].x2, -180); // l'enfant hérite : pointe aussi vers la gauche
    near(s[1].rz, Math.PI / 2); // direction absolue changée de 90° par rapport au repos
  });

  it("world : direction absolue, quel que soit l'angle de repos du parent", () => {
    const s = arm().solve({ x: 0, y: 0 }, { haut: { world: 0 }, bas: { world: -90 } });
    near(s[1].angle, -90);
    near(s[1].x2, 80); // vers la droite
    near(s[1].rz, -Math.PI / 2);
    // le parent tourne : l'enfant garde sa direction monde
    const t = arm().solve({ x: 0, y: 0 }, { haut: { world: 90 }, bas: { world: -90 } });
    near(t[1].angle, -90);
    near(t[1].x, -100);
    near(t[1].x2, -20);
  });

  it("world l'emporte sur delta ; pilote absent : repos", () => {
    const s = arm().solve({ x: 0, y: 0 }, { haut: { world: 90, delta: 10 }, bas: undefined });
    near(s[0].angle, 90);
    near(s[1].angle, 90); // repos relatif : suit le parent
    near(s[1].rz, Math.PI / 2);
  });

  it("limites min / max : locales, par rapport au repos", () => {
    const r = new Rig([bone("haut", null), bone("coude", "haut", { min: 0, max: 150, angle: 0 })]);
    const flex = r.solve({ x: 0, y: 0 }, { coude: { delta: -40 } });
    near(flex[1].angle, 0); // plié dans le mauvais sens : bloqué
    near(r.solve({ x: 0, y: 0 }, { coude: { delta: 200 } })[1].angle, 150);
    near(r.solve({ x: 0, y: 0 }, { coude: { world: 120 } })[1].angle, 120);
    near(r.solve({ x: 0, y: 0 }, { coude: { world: -90 } })[1].angle, 0);
  });

  it("angle de repos : l'os est dessiné dans sa pose de repos (rz = 0), pas dans celle des angles nuls", () => {
    // torse « vers le haut » au repos : angle 180
    const r = new Rig([bone("torse", null, { angle: 180 }), bone("tete", "torse", { length: 40 })]);
    const rest = r.solve({ x: 0, y: 100 });
    expect(rest.map((b) => b.rz)).toEqual([0, 0]);
    near(rest[0].y2, 0); // pointe vers le haut
    near(rest[1].y2, -40);
    const lean = r.solve({ x: 0, y: 100 }, { torse: { world: 170 } }); // penché de 10° vers la gauche
    near(lean[0].rz, -10 * (Math.PI / 180));
    near(lean[1].rz, -10 * (Math.PI / 180));
  });

  it("at et offset : épaule sur le côté de l'extrémité du torse", () => {
    const r = new Rig([bone("torse", null, { angle: 180, length: 100 }), bone("bras", "torse", { offset: 40, angle: 180 })]);
    const s = r.solve({ x: 300, y: 300 });
    // torse vers le haut : « à droite d'un parent qui pointe vers le bas » devient la gauche de l'écran
    near(s[1].x, 260);
    near(s[1].y, 200);
    near(s[1].y2, 300); // le bras repart vers le bas (180 + 180 = 360)
    const mid = new Rig([bone("a", null, { length: 100 }), bone("b", "a", { at: 0.5, offset: 0 })]).solve({ x: 0, y: 0 });
    near(mid[1].y, 50);
    const base = new Rig([bone("a", null, { length: 100 }), bone("b", "a", { at: 0 })]).solve({ x: 0, y: 0 });
    near(base[1].y, 0);
  });

  it("le décalage tourne avec le parent", () => {
    const r = new Rig([bone("torse", null, { angle: 180, length: 100 }), bone("bras", "torse", { offset: 40, angle: 180 })]);
    const s = r.solve({ x: 0, y: 0 }, { torse: { world: 90 } }); // couché vers la gauche
    near(s[0].x2, -100);
    // perp(90) = (cos 90, sin 90) = (0, 1) : le décalage devient vertical
    near(s[1].x, -100);
    near(s[1].y, 40);
  });

  it("scale : longueurs, segments et décalages ; rz inchangé", () => {
    const r = new Rig([bone("torse", null, { length: 100 }), bone("bras", "torse", { offset: 40 })], { scale: 2 });
    const s = r.solve({ x: 0, y: 0 });
    near(s[0].y2, 200);
    near(s[0].length, 200);
    near(s[1].y, 200);
    near(s[1].x, 80);
    expect(r.solve({ x: 0, y: 0 }, { torse: { delta: 30 } })[0].rz).toBeCloseTo(30 * (Math.PI / 180), 6);
  });

  it("scale invalide : 1 ; valeurs non finies dans un pilote : ignorées", () => {
    const r = new Rig([bone("a", null)], { scale: -3 });
    near(r.solve({ x: 0, y: 0 })[0].y2, 100);
    near(r.solve({ x: 0, y: 0 }, { a: { world: Number.NaN, delta: Number.NaN } })[0].angle, 0);
  });

  it("os de longueur 0 (bassin) : l'enfant est décalé depuis l'origine", () => {
    const r = new Rig([bone("bassin", null, { length: 0 }), bone("cuisse", "bassin", { offset: -24 })]);
    const s = r.solve({ x: 100, y: 100 });
    near(s[1].x, 76);
    near(s[1].y, 100);
    near(s[1].y2, 200);
  });
});
