import { describe, expect, it } from "vitest";
import { loadRapier } from "../../../shared/sim/rigid-core";
import { type Recipe, composeScene } from "./compose";
import { ProcgenRigid, autoShape, dynShapes, meshBounds } from "./rigid";

const io = { actorPose: () => null, objectPose: () => null };

async function scene(recipe: Recipe) {
  const R = await loadRapier();
  const m = composeScene({ recipe, seed: 1 });
  const bounds = (o: (typeof m.objects)[number]) => {
    const g = m.instances.find((x) => x.objs.includes(o.obj));
    return g ? meshBounds(g.mesh.pos, o.scale) : null;
  };
  return { m, w: new ProcgenRigid(R, m, io, bounds) };
}
const run = (w: ProcgenRigid, s: number) => {
  for (let i = 0; i < s * 60; i++) w.stepScene(1 / 60);
};

describe("physique 3D des scènes procgen", () => {
  it("sans `physics` : aucun corps, aucun moteur demandé (rétrocompatible)", () => {
    const m = composeScene({ recipe: { size: [10, 10], layers: [{ id: "b", gen: "ball.soccer", place: { at: [[0, 0]] } }, { id: "c", gen: "prop.crate", place: { at: [[2, 0]] } }] }, seed: 1 });
    expect(m.physics).toBeNull();
    expect(m.objects.every((o) => !o.body)).toBe(true);
  });

  it("une couche avec `physics` active le moteur ; les ballons deviennent dynamiques ; `physics: false` les en sort", () => {
    const m = composeScene({
      recipe: {
        size: [10, 10],
        layers: [
          { id: "caisses", gen: "prop.crate", physics: { body: "dynamic", mass: 12 }, place: { at: [{ x: 0, z: 0, y: 2 }] } },
          { id: "ballons", gen: "ball.soccer", place: { at: [[2, 0]] } },
          { id: "fixe", gen: "ball.soccer", physics: false, place: { at: [[-2, 0]] } },
        ],
      },
      seed: 1,
    });
    expect(m.physics).not.toBeNull();
    const caisse = m.objects.find((o) => o.id === "caisses.0")!;
    expect(caisse.body?.kind).toBe("dynamic");
    expect(caisse.body?.mass).toBe(12);
    expect(caisse.pos[1]).toBeGreaterThan(1.5);
    expect(m.objects.find((o) => o.id === "ballons.0")!.body?.shape).toBe("sphere");
    expect(m.objects.find((o) => o.id === "fixe.0")!.body).toBeUndefined();
  });

  it("formes automatiques : ballon sphère, tonneau cylindre, chaise enveloppe, caisse boîte", () => {
    const m = composeScene({ recipe: { size: [10, 10], physics: true, layers: [{ id: "t", gen: "prop.barrel", physics: "dynamic", place: { at: [[0, 0]] } }, { id: "s", gen: "seat.chair", physics: "dynamic", place: { at: [[3, 0]] } }, { id: "c", gen: "prop.crate", physics: "dynamic", place: { at: [[-3, 0]] } }] }, seed: 1 });
    const by = (id: string) => m.objects.find((o) => o.id === id)!;
    expect(autoShape(by("t.0"), by("t.0").body!)).toBe("cylindre");
    expect(autoShape(by("s.0"), by("s.0").body!)).toBe("enveloppe");
    expect(autoShape(by("c.0"), by("c.0").body!)).toBe("boite");
    const g = m.instances.find((x) => x.objs.includes(by("s.0").obj))!;
    const sh = dynShapes(by("s.0"), by("s.0").body!, meshBounds(g.mesh.pos, by("s.0").scale));
    expect(sh[0].kind).toBe("hull");
  });

  it("une caisse lâchée tombe sur le sol et s'endort ; choc et repos signalés ; plus rien ne bouge ensuite", async () => {
    const { m, w } = await scene({ size: [12, 12], ground: { relief: 0 }, layers: [{ id: "c", gen: "prop.crate", physics: "dynamic", place: { at: [{ x: 0, z: 0, y: 3 }] } }] });
    const o = m.objects[0];
    expect(o.pos[1]).toBeGreaterThan(2.5);
    const contacts: unknown[] = [];
    for (let i = 0; i < 300; i++) {
      w.stepScene(1 / 60);
      contacts.push(...w.takeContacts());
    }
    expect(o.pos[1]).toBeLessThan(0.3);
    expect(o.pos[1]).toBeGreaterThan(-0.2);
    expect(contacts.length).toBeGreaterThan(0);
    expect(w.rested?.["c.0"]).toBeTruthy();
    expect(w.moving).toBe(false);
    expect(w.stepScene(1 / 60)).toEqual([]);
    w.dispose();
  });

  it("un tir fait rouler le ballon, qui ralentit et s'arrête (`rest`), et reste dans la scène", async () => {
    const { m, w } = await scene({ size: [16, 10], ground: { relief: 0 }, physics: true, layers: [{ id: "b", gen: "ball.soccer", place: { at: [[0, 0]] } }] });
    run(w, 1);
    w.takeEvents();
    expect(w.kickBody("b.0", [6, 0, 0])).toBe(true);
    run(w, 0.5);
    expect(m.objects[0].pos[0]).toBeGreaterThan(1.5);
    run(w, 20);
    const ev = w.takeEvents();
    expect(ev.some((e) => e.type === "rest" && e.payload.ball === "b.0")).toBe(true);
    // les bords de la scène retiennent le ballon
    expect(Math.abs(m.objects[0].pos[0])).toBeLessThan(8.01);
    w.dispose();
  });

  it("eau : une caisse de bois flotte (et `splash`) ; zones = capteurs", async () => {
    const { m, w } = await scene({
      size: [20, 20],
      ground: { relief: 0, water: 1.5 },
      zones: [{ id: "but", box: [-1, -1, 1, 1] }],
      layers: [{ id: "c", gen: "prop.crate", physics: "dynamic", place: { at: [{ x: 0, z: 0, y: 3 }] } }],
    });
    run(w, 6);
    const ev = w.takeEvents();
    expect(ev.some((e) => e.type === "splash")).toBe(true);
    // flotte : le pied reste près de la surface, au-dessus du fond
    expect(m.objects[0].pos[1]).toBeGreaterThan(0.6);
    w.dispose();
    const s2 = await scene({ size: [20, 10], ground: { relief: 0 }, zones: [{ id: "but", box: [5, -2, 7, 2] }], physics: true, layers: [{ id: "b", gen: "ball.soccer", place: { at: [[0, 0]] } }] });
    run(s2.w, 0.5);
    s2.w.kickBody("b.0", [8, 0, 0]);
    run(s2.w, 3);
    expect(s2.w.takeEvents().some((e) => e.type === "enter" && e.payload.zone === "but" && e.payload.ball === "b.0")).toBe(true);
    s2.w.dispose();
  });

  it("requêtes : un rayon touche la caisse ; ordres `forces` (impulsion à compteur)", async () => {
    const { w } = await scene({ size: [12, 12], ground: { relief: 0 }, layers: [{ id: "c", gen: "prop.crate", physics: { body: "dynamic", mass: 5 }, place: { at: [[0, 0]] } }] });
    run(w, 1);
    const hit = w.query({ ray: { from: [-5, 0.3, 0], dir: [1, 0, 0] } });
    expect(hit.hit).toBe(true);
    expect(hit.objectId).toBe("c.0");
    const ground = w.query({ ray: { from: [3, 5, 3], dir: [0, -1, 0] } });
    expect(ground.hit).toBe(true);
    expect(Number(ground.y)).toBeCloseTo(0, 1);
    w.applyOrders({ "c.0": { impulse: { n: 1, x: 60 } } });
    w.applyOrders({ "c.0": { impulse: { n: 2, x: 60 } } });
    run(w, 1);
    expect(w.pose("c.0")!.x).toBeGreaterThan(0.5);
    w.dispose();
  });

  it("liaison : une caisse pendue à une corde reste sous son point d'attache", async () => {
    const { w } = await scene({ size: [12, 12], ground: { relief: 0 }, physics: { joints: [{ type: "rope", a: "c.0", at: [0, 4, 0], length: 1.5 }] }, layers: [{ id: "c", gen: "prop.crate", physics: "dynamic", place: { at: [{ x: 0, z: 0, y: 2.5 }] } }] });
    run(w, 3);
    expect(w.pose("c.0")!.y).toBeGreaterThan(1.8);
    w.dispose();
  });
});
