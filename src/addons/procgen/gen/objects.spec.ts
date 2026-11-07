import { describe, expect, it } from "vitest";
import { dot, norm } from "../core/math";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { composeVector } from "../vector/compose";
import { ActorSim } from "../vector/actors";
import { VectorScene, mergeSorted } from "../vector/scene";
import { validPath } from "../vector/shape";
import { humanoidPose, rigInfo, type MotionState } from "../rig/locomotion";
import { character } from "./character";
import { BALL_KINDS, BALLS, ballSpec } from "./ball";
import { GENERATORS } from "./index";
import { readParts } from "./parts";
import { SEAT_KINDS, USERS } from "./seat";
import { type Region, clipHemisphere, icosahedron, labelAt, regionOutlines, tennisSeam } from "./sphere-pattern";
import { ROLE, ROLES } from "../style/roles";
import { SCENES } from "../scene/library";

const make = (gen: string, params: Record<string, unknown>, seed: string | number = 1) => {
  const g = GENERATORS[gen];
  const issues = new Issues();
  const p = resolveParams(g.schema, params, { rng: new Rng(seed), vars: {} }, issues, "");
  return { asset: g.build(p as never, { rng: new Rng(`t/${seed}`), issues, path: "" }), issues, p };
};

/** Tous les triangles n'ont qu'un rôle (bords nets, aucun escalier). */
const cleanRoles = (m: { idx: number[]; role: number[] }) => {
  for (let t = 0; t < m.idx.length; t += 3) if (m.role[m.idx[t]] !== m.role[m.idx[t + 1]] || m.role[m.idx[t]] !== m.role[m.idx[t + 2]]) return false;
  return true;
};

describe("objets du quotidien : ballons", () => {
  it("chaque ballon : taille réelle, motif net, physique et affordances publiées, budget tenu", () => {
    for (const kind of BALL_KINDS) {
      const { asset, issues } = make("ball", { kind });
      expect(issues.list, kind).toEqual([]);
      const def = BALLS[kind];
      expect(asset.mesh.triangleCount, kind).toBeGreaterThan(300);
      expect(asset.mesh.triangleCount, kind).toBeLessThan(6000);
      expect(cleanRoles(asset.mesh), kind).toBe(true);
      const b = asset.mesh.bounds();
      expect(b.min[1], kind).toBeGreaterThan(-def.d * 0.06);
      // ovales couchés : la hauteur est le petit diamètre
      const want = def.lying ? def.d * def.S[0] : def.d;
      expect(asset.height, kind).toBeCloseTo(want, 2);
      const ph = asset.extra!.physics as { mass: number; restitution: number; radius: number };
      expect(ph.mass, kind).toBeGreaterThan(0);
      expect(ph.restitution, kind).toBeGreaterThan(0);
      expect((asset.extra!.affords as string[]).length, kind).toBeGreaterThan(0);
      expect(asset.anchors.grip, kind).toBeDefined();
    }
  });

  it("football : 12 pentagones noirs sur fond blanc ; basket orange à coutures noires", () => {
    const { asset } = make("ball", { kind: "soccer" });
    const roles = new Set(asset.mesh.role);
    expect(roles.has(ROLE.white) && roles.has(ROLE.black)).toBe(true);
    const pat = ballSpec({ kind: "soccer" }).pattern;
    const { v } = icosahedron();
    expect(new Set(v.map((p) => labelAt(pat, p))).size).toBe(12);
    const basket = make("ball", { kind: "basketball" }).asset.mesh;
    expect(basket.role.includes(ROLE.orange) && basket.role.includes(ROLE.black)).toBe(true);
  });

  it("diamètre, écrasement et couleurs réglables ; billard numéroté", () => {
    const giant = make("ball", { kind: "beach", diameter: 2 }).asset;
    expect(giant.height).toBeCloseTo(2, 1);
    const flat = make("ball", { kind: "soccer", squash: 0.4 }).asset;
    expect(flat.height).toBeLessThan(0.22 * 0.7);
    const red = make("ball", { kind: "gym", color: "red" }).asset;
    expect(red.mesh.role.includes(ROLE.red)).toBe(true);
    const nine = make("ball", { kind: "billiard", number: 9 }).asset.mesh;
    expect(nine.role.includes(ROLE.yellow) && nine.role.includes(ROLE.white)).toBe(true);
    const eight = make("ball", { kind: "billiard", number: 8 }).asset.mesh;
    expect(eight.role.includes(ROLE.black)).toBe(true);
  });

  it("découpe par l'hémisphère visible : tout point gardé est devant, le bord suit la silhouette", () => {
    const view = norm([0.3, 0.2, 1]);
    const regions: Region[] = [{ k: "lune", a0: 0, a1: 1 }, { k: "band", n: [0, 1, 0], lo: -0.3, hi: 0.3 }, { k: "cap", c: [1, 0, 0], cos: 0.5 }];
    for (const r of regions) {
      for (const out of regionOutlines(r)) for (const p of clipHemisphere(out, view)) expect(dot(p, view)).toBeGreaterThan(-1e-6);
    }
    const seam = tennisSeam();
    for (const p of seam) expect(Math.hypot(...p)).toBeCloseTo(1, 6);
  });
});

describe("objets du quotidien : assises", () => {
  it("chaque assise, chaque gabarit : places, ancres devant, budget", () => {
    for (const kind of SEAT_KINDS) {
      for (const user of Object.keys(USERS)) {
        const { asset, issues } = make("seat", { kind, user, variant: 1 });
        const s = USERS[user];
        expect(issues.list, `${kind}/${user}`).toEqual([]);
        expect(asset.mesh.triangleCount, `${kind}/${user}`).toBeGreaterThan(20);
        expect(asset.mesh.triangleCount, `${kind}/${user}`).toBeLessThan(5000);
        const n = asset.extra!.places as number;
        for (let i = 0; i < n; i++) {
          const sit = asset.anchors[`sit.${i}`].pos, ap = asset.anchors[`approach.${i}`].pos;
          expect(sit[1], `${kind}/${user}`).toBeGreaterThan(0.05 * s);
          expect(sit[1], `${kind}/${user}`).toBeLessThan(1.25 * s);
          expect(ap[2], `${kind}/${user}`).toBeGreaterThan(sit[2]);
          expect(Math.abs(sit[0]), `${kind}/${user}`).toBeLessThanOrEqual(asset.footprint.hx + 1e-6);
        }
        expect((asset.extra!.affords as string[]).length).toBeGreaterThan(0);
      }
    }
  });

  it("taille selon l'utilisateur et le nombre de places", () => {
    const adult = make("seat", { kind: "chair" }).asset, child = make("seat", { kind: "chair", user: "child" }).asset;
    expect(child.anchors["sit.0"].pos[1]).toBeCloseTo(adult.anchors["sit.0"].pos[1] * 0.72, 3);
    const b5 = make("seat", { kind: "parkbench", places: 5 }).asset, b2 = make("seat", { kind: "parkbench", places: 2 }).asset;
    expect(b5.footprint.hx).toBeGreaterThan(b2.footprint.hx * 1.8);
    expect(b5.anchors["sit.4"]).toBeDefined();
    const plastic = make("seat", { kind: "monobloc", color: "green" }).asset;
    expect(plastic.mesh.role.every((r) => r === ROLE.green)).toBe(true);
  });

  it("assis sur une chaise : le bassin se pose à hauteur d'assise, les pieds restent au sol", () => {
    const issues = new Issues();
    const cp = resolveParams(character.schema, { archetype: "stylized", detail: "crowd" }, { rng: new Rng("sit"), vars: {} }, issues);
    const asset = character.build(cp as never, { rng: new Rng("sit"), issues, path: "" });
    const sk = asset.skeleton!;
    const info = rigInfo(sk);
    const st = (seatY: number): MotionState => ({ speed: 0, phase: 0, time: 0, action: "sit", actionTime: 1, actionWeight: 1, mood: "neutral", turn: 0, seed: 1, seatY });
    const pelvisY = (seatY: number) => {
      const { pose, feet } = humanoidPose(sk, info, st(seatY), [0, 0, 0], 0);
      return { y: info.hipY + pose.root[1], foot: Math.max(feet.l[1], feet.r[1]) };
    };
    const ground = pelvisY(0), chair = pelvisY(0.45);
    expect(chair.y).toBeGreaterThan(ground.y + 0.2);
    expect(chair.y).toBeGreaterThan(0.45);
    expect(chair.y).toBeLessThan(0.45 + info.thigh * 0.5);
    expect(chair.foot).toBeLessThan(0.02);
  });
});

describe("objets du quotidien : assemblage libre et scène", () => {
  it("pièces lues sans évaluation, bornées, rôles inconnus signalés", () => {
    const { parts, problems } = readParts([
      { t: "box", c: [0, 0.4, 0], h: [0.3, 0.02, 0.2], role: "wood" },
      { t: "rod", a: [0, 0, 0], b: [0, 0.4, 0], r: 0.02, role: "metal" },
      { t: "lathe", c: [0, 0, 0], profile: [[0.1, 0], [0.12, 0.3]], role: "licorne" },
      { t: "eval", code: "alert(1)" },
      { t: "box", c: [999, 0, 0], h: [1, 1, 1], role: "stone" },
    ]);
    expect(parts.length).toBe(4);
    expect(problems.some((m) => m.includes("licorne"))).toBe(true);
    expect(problems.some((m) => m.includes("eval"))).toBe(true);
    expect((parts[3] as { c: number[] }).c[0]).toBeLessThanOrEqual(6);
  });

  it("une brouette décrite par l'agent : maillage, ancres, places assises générées", () => {
    const { asset, issues } = make("assembly", {
      label: "seau",
      parts: [{ t: "lathe", c: [0, 0, 0], profile: [[0.1, 0], [0.13, 0.28]], role: "metal" }, { t: "tube", pts: [[-0.13, 0.28, 0], [0, 0.42, 0], [0.13, 0.28, 0]], r: 0.005, role: "metal" }],
      anchors: { grip: [0, 0.42, 0], "sit.0": [0, 0.28, 0] },
      affords: ["carry", "fill", "sit"],
    });
    expect(issues.list).toEqual([]);
    expect(asset.mesh.triangleCount).toBeGreaterThan(20);
    expect(asset.anchors.grip.pos[1]).toBeCloseTo(0.42);
    expect(asset.anchors["approach.0"]).toBeDefined();
    expect(asset.extra!.affords).toEqual(["carry", "fill", "sit"]);
    const empty = make("assembly", {});
    expect(empty.issues.list.some((i) => i.code === "missing")).toBe(true);
  });

  it("aire de jeux : ballons, assises et assemblages dessinés en vectoriel sans erreur", () => {
    const model = composeVector({ recipe: SCENES["aire-de-jeux"], seed: 3 });
    const gens = new Set(model.objects.map((o) => o.generator));
    for (const g of ["ball", "seat", "assembly"]) expect(gens.has(g), g).toBe(true);
    for (const camera of ["side", "oblique"] as const) {
      const sc = new VectorScene(model, { camera });
      const sim = new ActorSim();
      sim.setModel(model);
      const shapes = mergeSorted(sc.staticShapes(0).shapes, sc.dynamicShapes(0, 0, sim.poses()));
      const mine = shapes.filter((s) => model.objects.some((o) => o.obj === s.objId && (o.generator === "ball" || o.generator === "seat" || o.generator === "assembly")));
      expect(mine.length).toBeGreaterThan(100);
      expect(shapes.filter((s) => !validPath(s.d)).length).toBe(0);
    }
  });

  it("un acteur envoyé sur une place s'y assied face à l'avant du banc", () => {
    const model = composeVector({
      recipe: {
        size: [12, 10],
        ground: { relief: 0 },
        layers: [{ id: "banc", gen: "seat", place: { at: [{ x: 0, z: 0, yaw: 0 }] }, params: { kind: "parkbench", places: 3 } }],
        actors: { h: { at: [3, 3], facing: 0 } },
      },
      seed: 1,
    });
    const sim = new ActorSim();
    const events: { type: string }[] = [];
    sim.onEvent = (e) => events.push(e);
    sim.setModel(model);
    const bench = model.objects.find((o) => o.generator === "seat")!;
    sim.setActors({ h: { target: `${bench.id}.sit.1`, action: "sit" } });
    for (let i = 0; i < 400; i++) sim.update(1 / 30);
    const a = sim.actors.get("h")!;
    expect(events.some((e) => e.type === "arrive")).toBe(true);
    expect(a.action).toBe("sit");
    expect(Math.hypot(a.pos[0] - bench.anchors["sit.1"][0], a.pos[2] - bench.anchors["sit.1"][2])).toBeLessThan(0.01);
    expect(a.seatY).toBeGreaterThan(0.3);
  });

  it("rôles de couleurs franches présents dans la palette", () => {
    for (const r of ["red", "orange", "yellow", "green", "blue", "purple", "white", "black"]) expect(ROLES).toContain(r);
  });
});
