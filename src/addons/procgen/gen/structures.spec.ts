import { describe, expect, it } from "vitest";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { ACTIONS } from "../rig/locomotion";
import { motionFor } from "../rig/motion";
import { composeScene, groundHeight } from "../scene/compose";
import { ActorSim } from "../vector/actors";
import { composeVector } from "../vector/compose";
import { VectorScene } from "../vector/scene";
import { validPath } from "../vector/shape";
import { GENERATORS } from "./index";
import { STRUCTURE_KINDS } from "./structure";
import { PART_VEHICLES, RAIL_TOP } from "./vehicle-parts";
import { WATER_KINDS } from "./water";

const make = (gen: string, params: Record<string, unknown>) => {
  const g = GENERATORS[gen];
  const issues = new Issues();
  const p = resolveParams(g.schema, params, { rng: new Rng(1), vars: {} }, issues, "");
  return { asset: g.build(p as never, { rng: new Rng("s"), issues, path: "" }), issues };
};
const finite = (m: { pos: Float32Array | number[] }) => Array.from(m.pos).every(Number.isFinite);

describe("ouvrages (structure)", () => {
  it("chaque ouvrage : maillage fini, ancres, affordances, budget", () => {
    for (const kind of STRUCTURE_KINDS) {
      const { asset, issues } = make("structure", { kind });
      expect(issues.list, kind).toEqual([]);
      expect(finite(asset.mesh), kind).toBe(true);
      expect(asset.mesh.triangleCount, kind).toBeGreaterThan(20);
      expect(asset.mesh.triangleCount, kind).toBeLessThan(20000);
      expect((asset.extra!.affords as string[]).length, kind).toBeGreaterThan(0);
      expect(asset.anchors.top, kind).toBeDefined();
    }
    for (const form of ["arch", "flat", "truss"]) {
      const b = make("structure", { kind: "bridge", form, length: 12 }).asset;
      expect(b.anchors["entry.0"].pos[2]).toBeCloseTo(-6, 5);
      expect(b.anchors["entry.1"].pos[2]).toBeCloseTo(6, 5);
      expect(b.anchors.deck.pos[1], form).toBeGreaterThan(0.5);
    }
    for (const form of ["round", "pointed", "torii"]) expect(make("structure", { kind: "arch", form }).asset.height).toBeGreaterThan(3);
    // escalier : le palier est à la hauteur demandée
    const st = make("structure", { kind: "stairs", height: 2, steps: 12 }).asset;
    expect(st.anchors.top.pos[1]).toBeCloseTo(2, 5);
    expect((st.extra!.walk as { profile: [number, number][] }[])[0].profile.some(([, y]) => Math.abs(y - 2) < 1e-6)).toBe(true);
  });

  it("un pont enjambe la rivière : chemin d'une berge à l'autre par le tablier, acteurs à la hauteur du tablier", () => {
    const model = composeScene({
      recipe: {
        size: [30, 24],
        ground: { relief: 0, water: -0.3 },
        paths: [{ id: "riv", points: [[-15, 0], [15, 0]], width: 5, kind: "river" }],
        layers: [{ id: "pont", gen: "structure.bridge", place: { across: "riv" } }],
      },
      seed: 1,
    });
    expect(model.issues.filter((i) => i.code !== "info")).toEqual([]);
    const pont = model.objects.find((o) => o.id === "pont.0")!;
    // perpendiculaire à la rivière, longueur ajustée, posé sur les berges (pas dans le lit)
    expect(Math.abs(Math.sin(pont.yaw))).toBeLessThan(0.05);
    expect(pont.footprint.hz).toBeGreaterThan(5);
    expect(pont.pos[1]).toBeGreaterThan(-0.4);
    const nav = model.nav!;
    expect(nav.free(0, 0)).toBe(true);
    expect(nav.free(6, 0)).toBe(false);
    const path = nav.path([0, -9], [0, 9]);
    expect(path).not.toBeNull();
    expect(groundHeight(model, 0, 0)).toBeGreaterThan(1);
    expect(groundHeight(model, 6, 0)).toBeLessThan(-0.5);
    // sans pont, pas de passage
    const none = composeScene({ recipe: { size: [30, 24], ground: { relief: 0, water: -0.3 }, paths: [{ id: "riv", points: [[-15, 0], [15, 0]], width: 5, kind: "river" }] }, seed: 1 });
    expect(none.nav!.path([0, -9], [0, 9])).toBeNull();
  });

  it("un acteur traverse le pont à la hauteur du tablier (vectoriel)", () => {
    const model = composeVector({
      recipe: {
        size: [30, 24],
        ground: { relief: 0, water: -0.3 },
        paths: [{ id: "riv", points: [[-15, 0], [15, 0]], width: 5, kind: "river" }],
        layers: [{ id: "pont", gen: "structure.bridge", place: { across: "riv" } }],
        actors: { h: { at: [0, -9] } },
      },
      seed: 1,
    });
    const sim = new ActorSim();
    sim.setModel(model);
    const events: string[] = [];
    sim.onEvent = (e) => events.push(e.type);
    sim.setActors({ h: { x: 0, z: 9 } });
    let maxY = -Infinity;
    for (let i = 0; i < 30 * 25 && !events.includes("arrive"); i++) {
      sim.update(1 / 30);
      maxY = Math.max(maxY, sim.actors.get("h")!.pos[1]);
    }
    expect(events).toContain("arrive");
    expect(maxY).toBeGreaterThan(1);
  });

  it("dessin vectoriel des ouvrages sans chemin invalide", () => {
    const model = composeVector({
      recipe: { size: [40, 12], ground: { relief: 0 }, layers: STRUCTURE_KINDS.map((kind, i) => ({ id: kind, gen: `structure.${kind}`, place: { at: [[-17 + i * 5, 0]] } })) },
      seed: 3,
    });
    for (const camera of ["side", "oblique"] as const) {
      const shapes = new VectorScene(model, { camera }).staticShapes(0).shapes;
      expect(shapes.length).toBeGreaterThan(300);
      expect(shapes.filter((s) => !validPath(s.d)).length).toBe(0);
    }
  });
});

describe("points d'eau (water)", () => {
  it("chaque point d'eau : eau visible au-dessus du sol, quatre places pour boire devant la margelle", () => {
    for (const kind of WATER_KINDS) {
      for (const shape of ["round", "rect"]) {
        const { asset, issues } = make("water", { kind, shape });
        expect(issues.list, kind).toEqual([]);
        expect(finite(asset.mesh), kind).toBe(true);
        const spots = Object.keys(asset.anchors).filter((k) => /^spot\.\d+$/.test(k));
        expect(spots.length, kind).toBeGreaterThanOrEqual(3);
        for (const k of spots) {
          const sp = asset.anchors[k].pos, ap = asset.anchors[k.replace("spot", "approach")].pos;
          expect(sp[1], kind).toBeGreaterThan(0);
          expect(ap[1], kind).toBe(0);
          expect(Math.hypot(ap[0], ap[2]), kind).toBeGreaterThan(Math.hypot(sp[0], sp[2]));
        }
        expect((asset.extra!.affords as string[]), kind).toContain("drink");
      }
    }
  });
});

describe("véhicules à pièces", () => {
  it("chaque véhicule : maillage fini, roues au sol, taille plausible ; onRails relève wagon et locomotive", () => {
    for (const kind of PART_VEHICLES) {
      const { asset, issues } = make("vehicle", { kind, variant: 1 });
      expect(issues.list, kind).toEqual([]);
      expect(finite(asset.mesh), kind).toBe(true);
      expect(asset.mesh.bounds().min[1], kind).toBeGreaterThan(-0.02);
      expect(asset.mesh.bounds().min[1], kind).toBeLessThan(0.02);
      expect(asset.footprint.hz, kind).toBeGreaterThan(1.5);
      expect(asset.height, kind).toBeGreaterThan(1.2);
      expect(asset.height, kind).toBeLessThan(4.5);
    }
    const w = make("vehicle", { kind: "wagon", onRails: true }).asset;
    expect(Math.abs(w.mesh.bounds().min[1] - RAIL_TOP)).toBeLessThan(0.02);
    const bus = make("vehicle", { kind: "bus" }).asset, car = make("vehicle", { kind: "moderncar" }).asset;
    expect(bus.footprint.hz).toBeGreaterThan(car.footprint.hz * 2);
  });
});

describe("actions boire, manger, dormir", () => {
  const animal = (species: string) => make("animal", { species }).asset;
  const pose = (a: ReturnType<typeof animal>, action: string, reachY?: number) => {
    const { pose } = motionFor(a).pose({ speed: 0, phase: 0, time: 1, action: action as never, actionTime: 1, actionWeight: 1, mood: "calm", turn: 0, seed: 1, reachY } as never);
    return a.skeleton!.world(pose);
  };
  const headY = (a: ReturnType<typeof animal>, W: ReturnType<typeof pose>) => W[a.skeleton!.index.head][13];

  it("liste des actions", () => {
    for (const a of ["drink", "eat", "sleep"]) expect(ACTIONS).toContain(a);
  });

  it("le chien baisse la tête pour boire (moins haut pour une cible haute), se couche pour dormir", () => {
    const dog = animal("dog");
    const idle = pose(dog, "idle"), drink = pose(dog, "drink"), high = pose(dog, "drink", 0.4), sleep = pose(dog, "sleep");
    expect(headY(dog, drink)).toBeLessThan(headY(dog, idle) - 0.2);
    expect(headY(dog, high)).toBeGreaterThan(headY(dog, drink));
    const pel = (W: ReturnType<typeof pose>) => W[dog.skeleton!.index.pelvis][13];
    expect(pel(sleep)).toBeLessThan(pel(idle) * 0.6);
    for (const W of [drink, sleep]) for (const m of W) expect(Array.from(m).every(Number.isFinite)).toBe(true);
    for (const sp of ["horse", "cow", "cat", "chicken", "pigeon", "seagull", "duck"]) {
      const a = animal(sp);
      for (const act of ["drink", "eat", "sleep"]) for (const m of pose(a, act)) expect(Array.from(m).every(Number.isFinite), `${sp} ${act}`).toBe(true);
    }
  });

  it("oiseaux posés : pigeon et goéland", () => {
    const pigeon = animal("pigeon"), gull = animal("seagull"), hen = animal("chicken");
    expect(pigeon.height).toBeLessThan(hen.height);
    expect(gull.height).toBeGreaterThan(pigeon.height);
    expect(pigeon.extra!.species).toBe("pigeon");
  });

  it("couche avec cible : le chien boit au bassin, bouche au-dessus de l'eau, tourné vers elle", () => {
    const model = composeVector({
      recipe: {
        size: [16, 12],
        ground: { relief: 0 },
        layers: [
          { id: "bassin", gen: "water.basin", place: { at: [[0, 0]] } },
          { id: "chiens", gen: "animal.dog", count: 2, action: "drink", target: "bassin.0", place: { at: [[4, 4], [-4, 4]] } },
        ],
      },
      seed: 1,
    });
    expect(model.issues.filter((i) => i.code !== "info")).toEqual([]);
    const b = model.objects.find((o) => o.id === "bassin.0")!;
    for (const [i, a] of model.actors.entries()) {
      expect(a.action).toBe("drink");
      expect(a.reachY!).toBeGreaterThan(0.2);
      const sp = b.anchors[`spot.${i}`];
      const d = Math.hypot(sp[0] - a.pos[0], sp[2] - a.pos[2]);
      expect(d).toBeGreaterThan(0.2);
      expect(d).toBeLessThan(0.9);
      // tourné vers la cible
      const f = [Math.sin(a.yaw), Math.cos(a.yaw)];
      expect(f[0] * (sp[0] - a.pos[0]) + f[1] * (sp[2] - a.pos[2])).toBeGreaterThan(d * 0.95);
    }
  });

  it("intention : marcher jusqu'à l'abreuvoir puis boire ; durée → actionEnd", () => {
    const model = composeVector({
      recipe: { size: [16, 12], ground: { relief: 0 }, layers: [{ id: "abreuvoir", gen: "pet.trough", place: { at: [[0, -2]] } }], actors: { chien: { gen: "animal", params: { species: "dog" }, at: [4, 4] } } },
      seed: 1,
    });
    const sim = new ActorSim();
    sim.setModel(model);
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    sim.onEvent = (e) => events.push(e);
    sim.setActors({ chien: { target: "abreuvoir.0.spot", action: "drink", duration: 2 } });
    const a = sim.actors.get("chien")!;
    expect(a.action).not.toBe("drink");
    let drank = false;
    for (let i = 0; i < 30 * 20 && !events.some((e) => e.type === "actionEnd"); i++) {
      sim.update(1 / 30);
      if (a.action === "drink") drank = true;
    }
    expect(events.map((e) => e.type)).toContain("arrive");
    expect(drank).toBe(true);
    expect(events.find((e) => e.type === "actionEnd")!.payload.action).toBe("drink");
    expect(a.action).toBe("idle");
  });

  it("un personnage dort sur un banc (cible sit.N + action sleep)", () => {
    const model = composeVector({
      recipe: { size: [12, 10], ground: { relief: 0 }, layers: [{ id: "banc", gen: "seat.parkbench", place: { at: [[0, 0]] } }], actors: { h: { target: "banc.0.sit.0", action: "sleep" } } },
      seed: 1,
    });
    const h = model.actors.find((a) => a.id === "h")!;
    expect(h.action).toBe("sleep");
    expect(h.seatY!).toBeGreaterThan(0.3);
  });

});
