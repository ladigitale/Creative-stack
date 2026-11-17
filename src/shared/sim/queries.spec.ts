import { describe, expect, it } from "vitest";
import { readMonde } from "../monde/format";
import { MondeDriver } from "../monde/driver";
import { GameProbe, rayObb } from "./queries";
import { boxesOf } from "../monde/collide";

const MONDE = {
  models: {
    caisse: { parts: [{ name: "c", box: [1, 1, 1], at: [0, 0.5, 0] }] },
    heros: { parts: [{ name: "corps", box: [0.5, 1.8, 0.5], at: [0, 0.9, 0] }], collider: { capsule: [0.3, 1.2] } },
    fantome: { parts: [{ name: "f", box: [1, 1, 1], at: [0, 0.5, 0] }], collider: "none" },
    zone: { parts: [{ name: "z", box: [2, 0.1, 2], at: [0, 0.05, 0] }], collider: { box: [2, 2, 2] } },
  },
  place: [
    { model: "caisse", name: "c1", at: [0, 0, 5], tags: ["cible"] },
    { model: "caisse", at: [0, 0, 10] },
    { model: "heros", name: "heros", at: [0, 0, 0] },
    { model: "fantome", name: "f1", at: [0, 0, 3] },
    { model: "zone", name: "porte", at: [6, 0, 0], sensor: true },
  ],
};

function setup() {
  const m = readMonde(MONDE);
  const d = new MondeDriver();
  d.setMonde(m, 0);
  const p = new GameProbe();
  p.set(m);
  return { m, d, p };
}

describe("formes de collision", () => {
  it("collider écrit (capsule, aucune) remplace les boîtes des pièces", () => {
    const { m } = setup();
    const hb = boxesOf(m.models.get("heros")!);
    expect(hb.length).toBe(1);
    expect(hb[0].h[0]).toBeCloseTo(0.3);
    expect(hb[0].h[1]).toBeCloseTo(0.9);
    expect(boxesOf(m.models.get("fantome")!)).toEqual([]);
  });
  it("un capteur ne crée ni conflit ni obstacle", () => {
    const { m, d } = setup();
    expect(m.place.find((p) => p.name === "porte")!.sensor).toBe(true);
    expect(d.bodies().some((b) => b.name === "porte")).toBe(false);
  });
});

describe("requêtes", () => {
  it("rayon : première boîte touchée, normale, distance ; le fantôme est traversé", () => {
    const { d, p } = setup();
    const r = p.apply({ vise: { n: 1, ray: { from: [0, 0.5, 1], dir: [0, 0, 1], max: 30 } } }, d)!;
    expect(r.vise.hit).toBe(true);
    expect(r.vise.instance).toBe("c1");
    expect(r.vise.dist).toBeCloseTo(3.5, 3);
    expect(r.vise.normal).toEqual([0, 0, -1]);
  });
  it("masque et ignore ; sol touché par un rayon descendant", () => {
    const { d, p } = setup();
    const r = p.apply({ a: { n: 1, ray: { from: [0, 0.5, 1], dir: [0, 0, 1] }, mask: ["decor"] }, b: { n: 1, ray: { from: [2, 3, 0], dir: [0, -1, 0] } } }, d)!;
    expect(r.a.dist).toBeCloseTo(8.5, 3);
    expect(r.b.model).toBe("sol");
    expect(r.b.dist).toBeCloseTo(3);
  });
  it("une réponse par hausse de n", () => {
    const { d, p } = setup();
    expect(p.apply({ s: { n: 1, sphere: { at: [0, 0.5, 5], r: 0.2 } } }, d)!.s.instance).toBe("c1");
    expect(p.apply({ s: { n: 1, sphere: { at: [0, 0.5, 5], r: 0.2 } } }, d)).toBeNull();
  });
  it("boîte : tout ce qui chevauche", () => {
    const { d, p } = setup();
    const r = p.apply({ z: { n: 1, box: { lo: [-1, 0, -1], hi: [1, 2, 11] } } }, d)!;
    expect(r.z.all!.map((a) => a.instance).sort()).toEqual(["", "c1", "heros"]);
  });
  it("rayon contre boîte tournée", () => {
    const b = { c: [0, 0, 5] as [number, number, number], ax: [[Math.SQRT1_2, 0, -Math.SQRT1_2], [0, 1, 0], [Math.SQRT1_2, 0, Math.SQRT1_2]] as never, h: [1, 1, 1] as [number, number, number] };
    const h = rayObb([0, 0, 0], [0, 0, 1], b, 10)!;
    expect(h.t).toBeCloseTo(5 - Math.SQRT2, 3);
  });
});

describe("capteurs", () => {
  it("entrée puis sortie d'une instance", () => {
    const { d, p } = setup();
    expect(p.step(d).events).toEqual([]);
    d.instances.get("heros")!.t.x = 6;
    const e1 = p.step(d).events;
    expect(e1.map((e) => [e.type, e.sensor, e.instance])).toEqual([["enter", "porte", "heros"]]);
    expect(p.step(d).events).toEqual([]);
    d.instances.get("heros")!.t.x = 0;
    expect(p.step(d).events.map((e) => e.type)).toEqual(["leave"]);
  });
});
