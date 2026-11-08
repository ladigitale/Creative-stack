import { describe, expect, it } from "vitest";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { composeVector } from "../vector/compose";
import { ActorSim } from "../vector/actors";
import { VectorScene } from "../vector/scene";
import { validPath } from "../vector/shape";
import { GENERATORS } from "./index";
import { partsToMesh, readParts } from "./parts";
import { SIGNS, STREET_KINDS } from "./street";
import { ROLE } from "../style/roles";

const make = (params: Record<string, unknown>) => {
  const g = GENERATORS.street;
  const issues = new Issues();
  const p = resolveParams(g.schema, params, { rng: new Rng(1), vars: {} }, issues, "");
  return { asset: g.build(p as never, { rng: new Rng("s"), issues, path: "" }), issues };
};

describe("mobilier urbain", () => {
  it("chaque objet : au sol, hauteur plausible, budget", () => {
    for (const kind of STREET_KINDS) {
      const { asset, issues } = make({ kind });
      expect(issues.list, kind).toEqual([]);
      expect(asset.mesh.bounds().min[1], kind).toBeGreaterThan(-0.01);
      expect(asset.height, kind).toBeGreaterThan(0.01);
      expect(asset.height, kind).toBeLessThan(6.5);
      expect(asset.mesh.triangleCount, kind).toBeLessThan(3000);
    }
    expect(make({ kind: "streetlight" }).asset.anchors.light).toBeDefined();
  });

  it("panneaux : chaque face a ses couleurs, devant le poteau", () => {
    const want: Record<string, number[]> = { stop: [ROLE.red, ROLE.white], yield: [ROLE.red, ROLE.white], noentry: [ROLE.red, ROLE.white], parking: [ROLE.blue, ROLE.white], danger: [ROLE.red, ROLE.black] };
    for (const sign of SIGNS) {
      const m = make({ kind: "roadsign", sign }).asset.mesh;
      expect(m.bounds().max[1], sign).toBeGreaterThan(2.45);
      for (const r of want[sign] ?? []) expect(m.role.includes(r), `${sign}`).toBe(true);
    }
    const red = make({ kind: "trafficlight", state: "red" }).asset.mesh, green = make({ kind: "trafficlight", state: "green" }).asset.mesh;
    expect(red.role.includes(ROLE.red) && !red.role.includes(ROLE.green)).toBe(true);
    expect(green.role.includes(ROLE.green) && !green.role.includes(ROLE.red)).toBe(true);
  });

  it("plaque : polygone convexe extrudé, lu sans risque depuis une recette", () => {
    const { parts, problems } = readParts([{ t: "plate", c: [0, 1, 0], pts: [[0, 0], [1, 0], [0.5, 1]], d: 0.01, role: "red" }, { t: "plate", pts: [[0, 0], [1, 1]] }]);
    expect(parts.length).toBe(1);
    expect(problems.length).toBe(1);
    const m = partsToMesh(parts);
    expect(m.triangleCount).toBe(2 + 6);
  });

  it("table de pique-nique : quatre places face à la table ; rue vectorielle sans chemin invalide", () => {
    const model = composeVector({
      recipe: {
        size: [20, 12],
        ground: { relief: 0 },
        layers: [
          { id: "table", gen: "street.picnictable", place: { at: [{ x: 0, z: 0, yaw: 0 }] } },
          { id: "rue", gen: "street", count: 10, place: { poisson: [-8, -5, 8, -1.5], minDist: 1.6 }, params: { kind: "= pick('streetlight', 'trafficlight', 'roadsign', 'trafficcone', 'barrier', 'bikerack', 'recycling', 'phonebooth', 'litterbin', 'manhole')", sign: "= pick('stop', 'yield', 'parking', 'danger')" } },
        ],
        actors: { a: { at: [0, 3] }, b: { at: [0, -3] } },
      },
      seed: 2,
    });
    const t = model.objects.find((o) => o.generator === "street" && o.layer === "table")!;
    const sim = new ActorSim();
    sim.setModel(model);
    sim.setActors({ a: { target: `${t.id}.sit.0`, action: "sit" }, b: { target: `${t.id}.sit.1`, action: "sit" } });
    for (let i = 0; i < 400; i++) sim.update(1 / 30);
    const a = sim.actors.get("a")!, b = sim.actors.get("b")!;
    expect(a.action).toBe("sit");
    expect(b.action).toBe("sit");
    // face à face de part et d'autre de la table
    expect(Math.cos(a.yaw - b.yaw)).toBeLessThan(-0.9);
    expect(Math.cos(a.yaw) * (0 - a.pos[2])).toBeGreaterThan(0);
    for (const camera of ["side", "oblique"] as const) {
      const shapes = new VectorScene(model, { camera }).staticShapes(0).shapes;
      expect(shapes.filter((s) => !validPath(s.d)).length).toBe(0);
    }
  });
});
