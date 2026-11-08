import { describe, expect, it } from "vitest";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { humanoidPose, rigInfo, type MotionState } from "../rig/locomotion";
import { composeVector } from "../vector/compose";
import { ActorSim } from "../vector/actors";
import { VectorScene, mergeSorted } from "../vector/scene";
import { validPath } from "../vector/shape";
import { character } from "./character";
import { GENERATORS } from "./index";
import { TOOL_KINDS, TOOLS, heldToolParts } from "./tool";
import { dqSkinPoint, dualQuat } from "../rig/skeleton";

const make = (gen: string, params: Record<string, unknown>, seed: string | number = 1) => {
  const g = GENERATORS[gen];
  const issues = new Issues();
  const p = resolveParams(g.schema, params, { rng: new Rng(seed), vars: {} }, issues, "");
  return { asset: g.build(p as never, { rng: new Rng(`t/${seed}`), issues, path: "" }), issues };
};

describe("outils à main", () => {
  it("chaque outil, chaque pose : posé au sol, taille réelle, ancre de prise, budget", () => {
    for (const kind of TOOL_KINDS) {
      for (const pose of ["lying", "leaning", "upright"]) {
        const { asset, issues } = make("tool", { kind, pose });
        expect(issues.list, `${kind}/${pose}`).toEqual([]);
        const b = asset.mesh.bounds();
        expect(b.min[1], `${kind}/${pose}`).toBeGreaterThan(-0.01);
        expect(asset.mesh.triangleCount, `${kind}/${pose}`).toBeLessThan(600);
        expect(asset.anchors.grip, kind).toBeDefined();
        const len = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
        expect(len, kind).toBeGreaterThan(0.12);
        expect(len, kind).toBeLessThan(2.5);
      }
      expect(["hammer", "sweep", "dig", "carry"]).toContain(TOOLS[kind].use);
    }
    // couché : à plat (bas), planté : debout (haut)
    expect(make("tool", { kind: "rake", pose: "lying" }).asset.height).toBeLessThan(0.1);
    expect(make("tool", { kind: "rake", pose: "upright" }).asset.height).toBeGreaterThan(1.4);
  });

  it("un personnage tient un outil : prise à l'origine, maillage dans la main", () => {
    for (const kind of TOOL_KINDS) {
      const t = heldToolParts(kind, 1.7)!;
      expect(t.handle, kind).toBeGreaterThan(0.002);
    }
    for (const kind of ["rake", "hammer", "broom", "fishingrod"]) {
      const issues = new Issues();
      const p = resolveParams(character.schema, { item: `tool.${kind}`, detail: "crowd" }, { rng: new Rng(kind), vars: {} }, issues);
      expect(issues.list.filter((i) => i.code !== "info"), kind).toEqual([]);
      const plain = resolveParams(character.schema, { item: "none", detail: "crowd" }, { rng: new Rng(kind), vars: {} }, new Issues());
      const a = character.build(p as never, { rng: new Rng(kind), issues, path: "" });
      const b = character.build(plain as never, { rng: new Rng(kind), issues, path: "" });
      expect(a.mesh.triangleCount, kind).toBeGreaterThan(b.mesh.triangleCount);
    }
  });

  it("outil tenu, bras au repos ou en marchant : la tête reste au-dessus du sol (3D, skinning réel)", () => {
    for (const kind of TOOL_KINDS) {
      const issues = new Issues();
      const cp = resolveParams(character.schema, { archetype: "stylized", detail: "crowd", item: `tool.${kind}`, height: 1.7 }, { rng: new Rng("g"), vars: {} }, issues);
      const a = character.build(cp as never, { rng: new Rng("g"), issues, path: "" });
      const sk = a.skeleton!, info = rigInfo(sk);
      for (const [speed, phase] of [[0, 0], [1.4, 0.25], [1.4, 0.75]]) {
        const st: MotionState = { speed, phase, time: 1, action: speed ? "walk" : "idle", actionTime: 1, actionWeight: 0, mood: "neutral", turn: 0, seed: 1 };
        const { pose } = humanoidPose(sk, info, st, [0, 0, 0], 0);
        const dq = sk.skinMatrices(sk.world(pose)).map(dualQuat);
        const m = a.mesh;
        let minY = Infinity;
        for (let v = 0; v < m.vertexCount; v++) minY = Math.min(minY, dqSkinPoint(m.getPos(v), dq, m.skin!.slice(v * 4, v * 4 + 4), m.weight!.slice(v * 4, v * 4 + 4))[1]);
        expect(minY, `${kind} v=${speed}`).toBeGreaterThan(-0.03);
      }
    }
  });

  it("actions d'usage : frapper, balayer, bêcher bougent le haut du corps dans le temps", () => {
    const issues = new Issues();
    const cp = resolveParams(character.schema, { archetype: "stylized", detail: "crowd", item: "tool.hammer" }, { rng: new Rng("u"), vars: {} }, issues);
    const sk = character.build(cp as never, { rng: new Rng("u"), issues, path: "" }).skeleton!;
    const info = rigInfo(sk);
    for (const action of ["hammer", "sweep", "dig"] as const) {
      const at = (t: number): MotionState => ({ speed: 0, phase: 0, time: t, action, actionTime: t, actionWeight: 1, mood: "neutral", turn: 0, seed: 1 });
      const p0 = humanoidPose(sk, info, at(0.1), [0, 0, 0], 0).pose, p1 = humanoidPose(sk, info, at(0.4), [0, 0, 0], 0).pose;
      const ua = (p0.rot as Record<string, number[]>)["upperarm.r"], ub = (p1.rot as Record<string, number[]>)["upperarm.r"];
      expect(Math.abs(ua[0] - ub[0]) + Math.abs(ua[1] - ub[1]) + Math.abs(ua[2] - ub[2]), action).toBeGreaterThan(0.02);
    }
  });

  it("atelier en vectoriel : outils posés et tenus, actions d'usage, aucun chemin invalide", () => {
    const model = composeVector({
      recipe: {
        size: [14, 10],
        ground: { relief: 0 },
        layers: [
          { id: "outils", gen: "tool", count: 6, place: { poisson: [-4, -3, 4, 1], minDist: 1 }, params: { kind: "= pick('rake', 'shovel', 'hammer', 'saw', 'broom', 'axe')", pose: "= pick('lying', 'leaning')" } },
          { id: "jardiniers", gen: "character", count: 3, place: { at: [{ x: -2, z: 2, yaw: 0 }, { x: 0, z: 2, yaw: 0 }, { x: 2, z: 2, yaw: 0 }] }, params: { item: "= pick('tool.rake', 'tool.hammer', 'tool.spade')", detail: "crowd" }, action: "= pick('sweep', 'hammer', 'dig')" },
        ],
      },
      seed: 4,
    });
    for (const camera of ["side", "oblique"] as const) {
      const sc = new VectorScene(model, { camera });
      const sim = new ActorSim();
      sim.setModel(model);
      for (let i = 0; i < 20; i++) sim.update(1 / 30);
      const shapes = mergeSorted(sc.staticShapes(0).shapes, sc.dynamicShapes(0, 0, sim.poses()));
      expect(shapes.length).toBeGreaterThan(200);
      expect(shapes.filter((s) => !validPath(s.d)).length).toBe(0);
    }
  });
});
