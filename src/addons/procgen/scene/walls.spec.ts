import { describe, expect, it } from "vitest";
import { composeVector } from "../vector/compose";
import { ActorSim } from "../vector/actors";
import { SCENES } from "./library";
import type { ObjectInfo, Recipe } from "./compose";

/** Le point (x, z) est-il dans l'emprise nue (sans marge) d'un bâtiment ? */
function insideBuilding(objects: readonly ObjectInfo[], x: number, z: number): string | null {
  for (const o of objects) {
    if (o.generator.split(".")[0] !== "building") continue;
    const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
    const dx = x - o.pos[0], dz = z - o.pos[2];
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    if (Math.abs(lx) < o.footprint.hx - 0.05 && Math.abs(lz) < o.footprint.hz - 0.05) return o.id;
  }
  return null;
}

function run(sim: ActorSim, objects: readonly ObjectInfo[], seconds: number, from = 0): string[] {
  const bad: string[] = [];
  for (let i = 0; i < seconds * 30; i++) {
    sim.update(1 / 30);
    if (i < from * 30) continue;
    for (const [id, a] of sim.actors) {
      const b = insideBuilding(objects, a.pos[0], a.pos[2]);
      if (b) bad.push(`${id} dans ${b} à t=${(i / 30).toFixed(1)} (${a.pos[0].toFixed(2)}, ${a.pos[2].toFixed(2)})`);
    }
  }
  return bad;
}

describe("on ne traverse pas les murs", () => {
  const house: Recipe = {
    size: [30, 20],
    ground: { relief: 0 },
    layers: [{ id: "maison", gen: "building", place: { at: [[0, 0]] }, params: { kind: "house" } }],
  };

  it("contourne une maison pour aller de l'autre côté", { timeout: 60000 }, () => {
    const model = composeVector({ recipe: { ...house, actors: { h: { at: [-9, 0.3], params: { item: "none" } } } }, seed: 1 });
    const sim = new ActorSim();
    sim.setModel(model);
    sim.setActors({ h: { x: 9, z: -0.2 } });
    expect(run(sim, model.objects, 25)).toEqual([]);
    const a = sim.actors.get("h")!;
    expect(Math.hypot(a.pos[0] - 9, a.pos[2] + 0.2)).toBeLessThan(1);
  });

  it("une cible au milieu de la maison : on s'arrête devant, sans entrer", () => {
    const model = composeVector({ recipe: { ...house, actors: { h: { at: [-9, 0], params: { item: "none" } } } }, seed: 1 });
    const sim = new ActorSim();
    sim.setModel(model);
    sim.setActors({ h: { x: 0, z: 0 } });
    expect(run(sim, model.objects, 20)).toEqual([]);
  });

  it("des flâneurs dans le village ne passent jamais dans une maison", { timeout: 120000 }, () => {
    const recipe = { ...SCENES.village, actors: Object.fromEntries([0, 1, 2, 3, 4, 5].map((k) => [`f${k}`, { at: [-6 + k * 2.4, 3 - k] as [number, number], behavior: "wander" as const, params: { item: "none" } }])) };
    const model = composeVector({ recipe, seed: 3 });
    const sim = new ActorSim();
    sim.setModel(model);
    // une seconde pour sortir d'une maison si la graine en a posé un dedans, puis plus jamais dedans
    expect(run(sim, model.objects, 60, 1)).toEqual([]);
  });
});
