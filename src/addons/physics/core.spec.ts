import { describe, expect, it } from "vitest";
import { parseBody, parseJoint, PhysicsWorld, type PhysicsEvent } from "./core";

const world = (o: Partial<ConstructorParameters<typeof PhysicsWorld>[0]> = {}) =>
  new PhysicsWorld({ width: 800, height: 600, scale: 50, gravity: [0, 9.8], bounds: "walls", collideMin: 0, outMargin: 50, ...o });
const body = (o: Record<string, unknown>) => parseBody(o, "b").spec;
const run = (w: PhysicsWorld, seconds: number) => {
  const events: PhysicsEvent[] = [];
  for (let i = 0; i < Math.round(seconds * 60); i++) events.push(...w.step(1 / 60));
  return events;
};

describe("parseBody / parseJoint", () => {
  it("attributs SDUI et JSON du store donnent la même description", () => {
    const a = parseBody({ name: "p", type: "kinematic", shape: "box", w: "120", h: "16", "fixed-rotation": "", tags: "paddle player", "clamp-x": "60 740" }, "x").spec;
    const b = parseBody({ name: "p", type: "kinematic", shape: "box", w: 120, h: 16, fixedRotation: true, tags: ["paddle", "player"], clampX: [60, 740] }, "x").spec;
    expect(a).toEqual(b);
    expect(a.clampX).toEqual([60, 740]);
    expect(parseBody({ r: 10 }, "auto").spec).toMatchObject({ name: "auto", shape: "circle", type: "dynamic" });
    expect(parseBody({ shape: "polygon", points: "0,0 10,0" }, "p").errors[0]).toContain("3 à 8 points");
    expect(parseBody({ shape: "blob" }, "q").errors[0]).toContain("inconnue");
    expect(parseBody({ shape: "polygon", points: "-10,0 10,0 0,-20" }, "t").spec.points).toEqual([[-10, 0], [10, 0], [0, -20]]);
    expect(parseJoint({ type: "spring" }, 0).errors[0]).toContain("inconnu");
    expect(parseJoint({ type: "revolute", a: "x" }, 1).errors[0]).toContain("requis");
    expect(parseJoint({ type: "revolute", a: "x", b: "y", at: "10 20", "motor-speed": 90 }, 2).spec).toMatchObject({ x: 10, y: 20, motorSpeed: 90 });
  });
});

describe("PhysicsWorld", () => {
  it("chute libre (g = 9,8 m/s² à 50 px/m) puis repos sur le sol, choc signalé", () => {
    const w = world();
    w.upsert(body({ name: "ball", shape: "circle", r: 10, x: 400, y: 100, tags: "ball" }));
    w.step(1 / 60);
    for (let i = 0; i < 29; i++) w.step(1 / 60);
    // 0,5 s : Δy = ½ g t² = 1,225 m = 61 px
    expect(w.bodyState("ball")!.y).toBeGreaterThan(155);
    expect(w.bodyState("ball")!.y).toBeLessThan(167);
    const ev = run(w, 3);
    const hit = ev.find((e) => e.type === "collide");
    expect(hit).toMatchObject({ type: "collide", a: expect.stringMatching(/ball|wall-bottom/), tagsA: expect.any(Array) });
    expect(hit && hit.type === "collide" && hit.impulse > 0).toBe(true);
    expect(w.bodyState("ball")!.y).toBeCloseTo(590, 0);
  });

  it("rebond : restitution 1 garde la vitesse, 0 l'amortit", () => {
    const w = world({ gravity: [0, 0] });
    w.upsert(body({ name: "a", r: 10, x: 400, y: 300, vx: 300, restitution: 1, friction: 0 }));
    w.upsert(body({ name: "b", r: 10, x: 400, y: 200, vx: 300, restitution: 0, friction: 0 }));
    run(w, 2);
    expect(Math.abs(w.bodyState("a")!.vx)).toBeGreaterThan(290);
    expect(Math.abs(w.bodyState("b")!.vx)).toBeLessThan(5);
  });

  it("capteur : entrée et sortie ; sortie du monde ; seuil de choc", () => {
    const w = world({ gravity: [0, 0], bounds: "none", collideMin: 100 });
    w.upsert(body({ name: "zone", type: "static", w: 100, h: 100, x: 400, y: 300, sensor: "" }));
    w.upsert(body({ name: "p", r: 5, x: 200, y: 300, vx: 400, tags: "probe" }));
    const ev = run(w, 2.5);
    expect(ev.filter((e) => e.type === "enter" || e.type === "leave").map((e) => e.type)).toEqual(["enter", "leave"]);
    expect(ev.find((e) => e.type === "enter")).toEqual({ type: "enter", sensor: "zone", body: "p", tags: ["probe"] });
    expect(ev.find((e) => e.type === "out")).toEqual({ type: "out", body: "p", tags: ["probe"], side: "right" });
    expect(ev.filter((e) => e.type === "out").length).toBe(1);
    expect(ev.some((e) => e.type === "collide")).toBe(false);
  });

  it("pilotage : vitesse imposée, borne clamp-x, impulsion et placement par compteur", () => {
    const w = world({ gravity: [0, 0] });
    w.upsert(body({ name: "pad", type: "kinematic", w: 100, h: 10, x: 400, y: 550, "clamp-x": "100 700" }));
    w.upsert(body({ name: "ball", r: 8, x: 400, y: 500 }));
    w.drive({ pad: { vx: 600 }, ball: { impulse: { n: 0, x: 0, y: -5 } } });
    for (let i = 0; i < 90; i++) {
      w.drive({ pad: { vx: 600 } });
      w.step(1 / 60);
    }
    expect(w.bodyState("pad")!.x).toBe(700);
    expect(w.bodyState("ball")!.vy).toBe(0);
    w.drive({ ball: { impulse: { n: 1, x: 0, y: -5 } } });
    w.step(1 / 60);
    expect(w.bodyState("ball")!.vy).toBeLessThan(-10);
    w.drive({ ball: { impulse: { n: 1, x: 0, y: -5 } } }); // même compteur : rien
    const vy = w.bodyState("ball")!.vy;
    w.step(1 / 60);
    expect(w.bodyState("ball")!.vy).toBeCloseTo(vy, 0);
    w.drive({ ball: { set: { n: 1, x: 100, y: 100 } } });
    w.drive({ ball: { set: { n: 2, x: 100, y: 100 } } });
    expect(w.bodyState("ball")).toMatchObject({ x: 100, y: 100, vx: 0, vy: 0 });
  });

  it("liste du store : ajout, mise à jour sans recréer, retrait", () => {
    const w = world({ gravity: [0, 0] });
    let owned = new Set<string>();
    const bricks = (names: string[]) => names.map((n, i) => body({ name: n, type: "static", w: 40, h: 20, x: 100 + i * 50, y: 100, tags: "brick" }));
    owned = w.syncSet(owned, bricks(["b1", "b2", "b3"]));
    const b2 = w.bodies.get("b2");
    owned = w.syncSet(owned, bricks(["b1", "b2"]).map((b) => ({ ...b, fill: "red" })));
    expect([...w.bodies.keys()].sort()).toEqual(["b1", "b2"]);
    expect(w.bodies.get("b2")).toBe(b2);
    expect(w.specs.get("b2")!.fill).toBe("red");
    owned = w.syncSet(owned, bricks(["b1"]).map((b) => ({ ...b, w: 80 })));
    expect(w.bodies.get("b1")).not.toBe(undefined);
    expect(owned).toEqual(new Set(["b1"]));
  });

  it("joints : pendule (revolute) et ressort (distance), moteur", () => {
    const w = world({ bounds: "none" });
    w.upsert(body({ name: "pivot", type: "static", r: 4, x: 400, y: 100 }));
    w.upsert(body({ name: "bob", r: 10, x: 500, y: 100 }));
    w.upsert(body({ name: "wheel", r: 30, x: 200, y: 300, "gravity-scale": 0 }));
    w.upsert(body({ name: "axle", type: "static", r: 2, x: 200, y: 300, collides: "none" }));
    w.setJoints([
      parseJoint({ type: "distance", a: "pivot", b: "bob" }, 0).spec!,
      parseJoint({ type: "revolute", a: "axle", b: "wheel", motor: 180, "max-torque": 1e4 }, 1).spec!,
    ]);
    run(w, 1);
    const bob = w.bodyState("bob")!;
    expect(Math.hypot(bob.x - 400, bob.y - 100)).toBeCloseTo(100, -1);
    expect(bob.y).toBeGreaterThan(130);
    // moteur à 180°/s : environ un demi-tour par seconde
    expect(Math.abs(w.bodyState("wheel")!.angle)).toBeGreaterThan(150);
    expect(w.errors).toEqual([]);
    w.setJoints([parseJoint({ type: "weld", a: "bob", b: "nope" }, 2).spec!]);
    expect(w.errors[0]).toContain("introuvable");
  });

  it("glisser : le corps suit le pointeur", () => {
    const w = world({ gravity: [0, 0] });
    w.upsert(body({ name: "box", w: 40, h: 40, x: 200, y: 200 }));
    expect(w.bodyAt(205, 195)).toBe("box");
    expect(w.bodyAt(500, 500)).toBe(null);
    expect(w.startDrag("box", 205, 195)).toBe(true);
    w.moveDrag(400, 300);
    run(w, 1.5);
    w.endDrag();
    const s = w.bodyState("box")!;
    expect(Math.hypot(s.x - 395, s.y - 305)).toBeLessThan(15);
  });
});
