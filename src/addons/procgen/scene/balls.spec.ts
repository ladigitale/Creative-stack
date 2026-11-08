import { describe, expect, it } from "vitest";
import { composeVector } from "../vector/compose";
import { ActorSim } from "../vector/actors";
import { VectorScene, mergeSorted } from "../vector/scene";
import { validPath } from "../vector/shape";
import { BallWorld } from "./balls";

const field = (extra: Record<string, unknown> = {}) =>
  composeVector({
    recipe: {
      size: [30, 20],
      ground: { relief: 0 },
      layers: [{ id: "ballon", gen: "ball.soccer", place: { at: [{ x: 0, z: 0, yaw: 0 }] } }, { id: "boule", gen: "ball.petanque", place: { at: [{ x: 4, z: 3, yaw: 0 }] } }],
      ...extra,
    },
    seed: 1,
  });

describe("ballons dynamiques", () => {
  it("un coup fait rouler le ballon, qui ralentit, tourne sur lui-même et s'arrête", () => {
    const m = field();
    const w = new BallWorld(m);
    expect(w.count).toBe(2);
    const b = w.byId.get(m.objects[0].id)!;
    expect(b.r).toBeCloseTo(0.11, 2);
    w.kick(b.id, [5, 0, 0]);
    const events: string[] = [];
    let t = 0;
    for (; t < 30 && w.moving; t += 1 / 60) w.step(1 / 60, () => 0, () => true, [], (e) => events.push(e.type));
    expect(w.moving).toBe(false);
    expect(b.pos[0]).toBeGreaterThan(4);
    expect(b.pos[0]).toBeLessThan(14.9);
    expect(b.pos[1]).toBeCloseTo(0.11, 2);
    expect(Math.abs(b.spin[3])).toBeLessThan(0.999);
    expect(events).toContain("rest");
  });

  it("un ballon lâché rebondit selon sa restitution ; une boule de pétanque ne rebondit presque pas", () => {
    const m = field();
    const w = new BallWorld(m);
    const peak = (id: string) => {
      const b = w.byId.get(id)!;
      b.pos[1] = 2;
      b.awake = true;
      let fell = false, best = 0;
      for (let i = 0; i < 300; i++) {
        w.step(1 / 120, () => 0, () => true);
        if (b.vel[1] > 0) fell = true;
        if (fell) best = Math.max(best, b.pos[1]);
      }
      return best;
    };
    const soccer = peak(m.objects[0].id), petanque = peak(m.objects[1].id);
    expect(soccer).toBeGreaterThan(0.9);
    expect(petanque).toBeLessThan(0.3);
  });

  it("rebond sur un obstacle, un autre ballon et le bord de la scène", () => {
    const m = field();
    const w = new BallWorld(m);
    const a = w.byId.get(m.objects[0].id)!, b = w.byId.get(m.objects[1].id)!;
    b.pos = [3, b.r, 0];
    w.kick(a.id, [6, 0, 0]);
    for (let i = 0; i < 120; i++) w.step(1 / 60, () => 0, (x) => x < 20);
    expect(b.awake || Math.abs(b.pos[0] - 3) > 0.2).toBe(true);
    expect(b.pos[0]).toBeGreaterThan(3);
    w.kick(a.id, [-40, 0, 0]);
    for (let i = 0; i < 240; i++) w.step(1 / 60, () => 0, () => true);
    expect(a.pos[0]).toBeGreaterThan(-15);
  });

  it("un acteur va tirer dans le ballon ; le ballon part, entre dans la zone du but", () => {
    const m = field({ zones: [{ id: "but", at: [9, 0], r: 1.5 }], actors: { joueur: { at: [-3, 0], facing: 90 } } });
    const sim = new ActorSim();
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    sim.onEvent = (e) => events.push(e);
    sim.setModel(m);
    const id = m.objects.find((o) => o.generator === "ball" && o.layer === "ballon")!.id;
    sim.setActors({ joueur: { target: id, action: "kick", power: 9, loft: 0 } });
    for (let i = 0; i < 600; i++) sim.update(1 / 60);
    expect(events.some((e) => e.type === "kick" && e.payload.ball === id)).toBe(true);
    expect(events.some((e) => e.type === "enter" && e.payload.zone === "but" && e.payload.ball === id)).toBe(true);
    expect(sim.ballState()[id].x).toBeGreaterThan(5);
  });

  it("dribble : un acteur qui marche dans le ballon le pousse ; dessin vectoriel du ballon en mouvement", () => {
    const m = field({ actors: { joueur: { at: [-2, 0], facing: 90 } } });
    const sim = new ActorSim();
    sim.setModel(m);
    const id = m.objects[0].id;
    sim.setActors({ joueur: { vx: 1, vz: 0 } });
    for (let i = 0; i < 180; i++) sim.update(1 / 60);
    expect(sim.ballState()[id].x).toBeGreaterThan(0.5);
    const sc = new VectorScene(m, { camera: "oblique" });
    const shapes = mergeSorted(sc.staticShapes(0).shapes, sc.dynamicShapes(0, 0, sim.poses(), sim.ballPoses()));
    const mine = shapes.filter((s) => s.objId === m.objects[0].obj);
    expect(mine.length).toBeGreaterThan(5);
    expect(shapes.filter((s) => !validPath(s.d)).length).toBe(0);
  });
});
