import { describe, expect, it } from "vitest";
import { readMonde } from "../monde/format";
import { MondeDriver } from "../monde/driver";
import { eulerFromQuat, loadRapier, quatFromEuler, RigidWorld } from "./rigid";

const caisse = { parts: [{ name: "c", box: [0.5, 0.5, 0.5], at: [0, 0.25, 0], color: "#a07040" }] };
const balle = { parts: [{ name: "b", sphere: 0.2, at: [0, 0.2, 0], color: "#e33" }] };

async function world(src: Record<string, unknown>) {
  const R = await loadRapier();
  const m = readMonde(src);
  const d = new MondeDriver();
  d.setMonde(m, 0);
  return { w: new RigidWorld(R, m, d), d, m };
}
const run = (w: RigidWorld, s: number) => {
  for (let i = 0; i < s * 60; i++) w.step(1 / 60);
};

describe("physique 3D (Rapier)", () => {
  it("rotations : euler XYZ ⇄ quaternion", () => {
    for (const e of [[0.3, -0.7, 1.1], [0, 1.2, 0], [-1, 0.2, 0.4]] as const) {
      const r = eulerFromQuat(quatFromEuler(e[0], e[1], e[2]));
      r.forEach((v, i) => expect(v).toBeCloseTo(e[i], 5));
    }
  });

  it("une caisse tombe sur le sol et s'endort ; le repos est signalé", async () => {
    const { w, d } = await world({ physique: true, models: { caisse }, place: [{ model: "caisse", name: "c1", at: [0, 3, 0], corps: "dynamique" }] });
    run(w, 4);
    const t = d.instances.get("c1")!.t;
    expect(t.y).toBeGreaterThan(-0.02);
    expect(t.y).toBeLessThan(0.05);
    expect(w.active).toBe(false);
    expect(w.rested?.c1).toBeTruthy();
    // le choc au sol est signalé
    expect(w.contacts.some((c) => c.a === "c1" || c.b === "c1")).toBe(true);
    w.dispose();
  });

  it("impulsion et téléportation par compteurs ; la première lecture ne fait rien", async () => {
    const { w, d } = await world({ physique: true, models: { balle }, place: [{ model: "balle", name: "b", at: [0, 0, 0], corps: { type: "dynamique", masse: 1 } }] });
    run(w, 1);
    w.applyOrders({ b: { impulse: { n: 1, x: 5, y: 0, z: 0 } } });
    run(w, 0.2);
    expect(Math.abs(d.instances.get("b")!.t.x)).toBeLessThan(0.01);
    w.applyOrders({ b: { impulse: { n: 2, x: 5, y: 0, z: 0 } } });
    run(w, 0.5);
    expect(d.instances.get("b")!.t.x).toBeGreaterThan(0.5);
    w.applyOrders({ b: { impulse: { n: 2, x: 5, y: 0, z: 0 }, set: { n: 1, x: -3, y: 2, z: 0 } } });
    w.applyOrders({ b: { impulse: { n: 2, x: 5, y: 0, z: 0 }, set: { n: 2, x: -3, y: 2, z: 0 } } });
    run(w, 1 / 60);
    expect(d.instances.get("b")!.t.x).toBeCloseTo(-3, 1);
    // un corps absent de la première lecture : son premier compteur compte
    w.applyOrders({ autre: {}, b: { impulse: { n: 2 }, set: { n: 2 } } });
    w.dispose();
  });

  it("premier ordre d'un corps après une première lecture vide", async () => {
    const { w, d } = await world({ physique: true, models: { balle }, place: [{ model: "balle", name: "b", at: [0, 0, 0], corps: { type: "dynamique", masse: 1 } }] });
    w.applyOrders({});
    w.applyOrders({ b: { set: { n: 1, x: 0, y: 0.5, z: 0 }, impulse: { n: 1, toward: [5, 0.5, 0], power: 3 } } });
    run(w, 0.5);
    expect(d.instances.get("b")!.t.x).toBeGreaterThan(0.5);
    w.dispose();
  });

  it("le décor arrête les corps ; une instance sans corps pousse comme un obstacle mobile", async () => {
    const mur = { parts: [{ name: "m", box: [0.2, 2, 4], at: [0, 1, 0], color: "#ccc" }] };
    const { w, d } = await world({
      physique: true,
      models: { caisse, mur, balle },
      place: [
        { model: "mur", at: [2, 0, 0] },
        { model: "balle", name: "b", at: [0, 0, 0], corps: { type: "dynamique", vitesse: [6, 0, 0] } },
        { model: "caisse", name: "pousseur", at: [-3, 0, 2] },
        { model: "caisse", name: "cible", at: [-1.5, 0, 2], corps: "dynamique" },
      ],
    });
    run(w, 2);
    expect(d.instances.get("b")!.t.x).toBeLessThan(1.9);
    // le pousseur avance (comme piloté par nodes) et déplace la cible
    for (let i = 0; i < 90; i++) {
      d.instances.get("pousseur")!.t.x += 0.03;
      w.step(1 / 60);
    }
    expect(d.instances.get("cible")!.t.x).toBeGreaterThan(-1.2);
    w.dispose();
  });

  it("charnière avec butées : une porte pivote sans tomber", async () => {
    const porte = { parts: [{ name: "p", box: [1, 2, 0.05], at: [0.5, 1, 0], color: "#fff" }] };
    const { w, d } = await world({
      physique: { sol: false, liaisons: [{ type: "charniere", a: "porte", at: [0, 1, 0], axe: [0, 1, 0], butees: [-90, 90] }] },
      models: { porte },
      place: [{ model: "porte", name: "porte", at: [0, 0, 0], corps: "dynamique" }],
    });
    run(w, 1);
    expect(d.instances.get("porte")!.t.y).toBeCloseTo(0, 1);
    w.applyOrders({ porte: { impulse: { n: 0, x: 0, y: 0, z: 0 } } });
    w.applyOrders({ porte: { impulse: { n: 1, x: 0, y: 0, z: 40, at: [1, 1, 0] } } });
    run(w, 2);
    const ry = Math.abs(d.instances.get("porte")!.t.ry);
    expect(ry).toBeGreaterThan(0.2);
    expect(ry).toBeLessThan(Math.PI / 2 + 0.1);
    expect(d.instances.get("porte")!.t.y).toBeCloseTo(0, 1);
    w.dispose();
  });

  it("vitesse imposée sur un axe et rotation bloquée (personnage)", async () => {
    const perso = { parts: [{ name: "p", capsule: [0.3, 1.2], at: [0, 0.9, 0], color: "#36c" }] };
    const { w, d } = await world({ physique: true, models: { perso }, place: [{ model: "perso", name: "joueur", at: [0, 0, 0], corps: { type: "dynamique", bloqueRotation: ["x", "z"] } }] });
    w.applyOrders({ joueur: { vx: 2 } });
    run(w, 1);
    const t = d.instances.get("joueur")!.t;
    expect(t.x).toBeGreaterThan(1.6);
    expect(Math.abs(t.rx) + Math.abs(t.rz)).toBeLessThan(0.01);
    w.dispose();
  });

  it("format : corps sans nom refusé, liaison inconnue signalée", () => {
    const m = readMonde({ physique: { liaisons: [{ type: "colle", a: "x" }] }, models: { caisse }, place: [{ model: "caisse", corps: "dynamique" }] });
    expect(m.issues.some((i) => /placement nommé/.test(i.message))).toBe(true);
    expect(m.issues.some((i) => /liaison « colle »/.test(i.message))).toBe(true);
    expect(m.physics?.gravity).toEqual([0, -9.81, 0]);
  });
});

describe("chocs", () => {
  it("un seul choc à l'atterrissage, aucun tant que la caisse reste posée", async () => {
    const R = await loadRapier();
    const m = readMonde({ physique: true, models: { caisse }, place: [{ model: "caisse", name: "c", at: [0, 2, 0], corps: { type: "dynamique", rebond: 0 } }] });
    const d = new MondeDriver();
    d.setMonde(m, 0);
    const w = new RigidWorld(R, m, d);
    let n = 0;
    for (let i = 0; i < 240; i++) {
      w.step(1 / 60);
      n += w.contacts.length;
      w.contacts = [];
    }
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(2);
    w.dispose();
  });
});
