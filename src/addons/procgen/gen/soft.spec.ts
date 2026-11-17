import { describe, expect, it } from "vitest";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { composeScene, MAX_SOFT_OBJECTS } from "../scene/compose";
import { HairSim } from "../../../shared/sim/hair";
import { SoftSim } from "../../../shared/sim/soft";
import { character } from "./character";
import { frozenPlates, makePieceSim, restSim, scalePiece } from "./soft";
import { TEXTILE_KINDS, textile } from "./textile";
import type { SoftPiece } from "./types";

const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function buildChar(params: Record<string, unknown>, seed = "tissus") {
  const issues = new Issues();
  const rng = new Rng(seed);
  const p = resolveParams(character.schema, { detail: "crowd", ...params }, { rng, vars: {} }, issues);
  return character.build(p, { rng, issues, path: "t" });
}
function buildTextile(params: Record<string, unknown>) {
  const issues = new Issues();
  const rng = new Rng("t");
  const p = resolveParams(textile.schema, params, { rng, vars: {} }, issues);
  return { asset: textile.build(p, { rng, issues, path: "t" }), issues };
}

describe("tissus des personnages", () => {
  it("par défaut rien n'est simulé (aspect inchangé)", () => {
    const a = buildChar({ top: "dress", hair: "long", bag: "cape" });
    expect(a.soft).toBeUndefined();
  }, 60000);

  it("cape, jupe, écharpe et mèches à la demande", () => {
    const a = buildChar({ top: "dress", hair: "long", bag: "scarf", cape: "long", soft: "all" });
    const labels = (a.soft ?? []).map((p) => p.label).sort();
    expect(labels).toEqual(["cape", "cheveux", "jupe", "écharpe"].sort());
    const cape = a.soft!.find((p) => p.label === "cape")!;
    expect(cape.bone).toBe("chest");
    // la cape longue descend près des chevilles, la jupe est évasée et repoussée par les jambes
    expect(cape.box!.c[1] - cape.box!.h[1]).toBeLessThan(0.25);
    const jupe = a.soft!.find((p) => p.label === "jupe")!;
    expect(jupe.cloth!.flare!).toBeGreaterThan(1.2);
    expect(jupe.colliders!.some((c) => c.bone === "shin.l")).toBe(true);
    // la cape passe par-dessus la robe (volumes de jupe ajoutés à ses sphères)
    expect(cape.colliders!.filter((c) => c.bone === "pelvis").length).toBeGreaterThan(2);
    const hair = a.soft!.find((p) => p.label === "cheveux")!;
    expect(hair.hair!.cut).toBe("longs");
  }, 60000);

  it("soft: hair seul ne touche pas aux vêtements ; queue de cheval en mèches", () => {
    const a = buildChar({ top: "dress", hair: "ponytail", soft: "hair" });
    expect(a.soft!.map((p) => p.label)).toEqual(["queue de cheval"]);
  }, 60000);

  it("la cape suit son attache : un pas de côté la fait traîner puis la ramène", () => {
    const a = buildChar({ cape: "short" });
    const cape = a.soft![0];
    const s = makePieceSim(cape)!;
    expect(s.kind).toBe("cloth");
    const sim = (s as { sim: SoftSim }).sim;
    for (let i = 0; i < 60; i++) sim.step(1 / 60, ID, [0, -9.81, 0], [0, 0, 0], null);
    const moved = [...ID];
    moved[14] = 0.5; // l'acteur avance de 50 cm (+z)
    sim.step(1 / 60, moved, [0, -9.81, 0], [0, 0, 0], null);
    let z = 0;
    for (let i = 2; i < sim.pos.length; i += 3) z += sim.pos[i];
    // le bas de la cape n'a pas encore suivi
    expect(z / sim.n).toBeLessThan(0.45);
    for (let i = 0; i < 180; i++) sim.step(1 / 60, moved, [0, -9.81, 0], [0, 0, 0], null);
    z = 0;
    for (let i = 2; i < sim.pos.length; i += 3) z += sim.pos[i];
    expect(z / sim.n).toBeGreaterThan(0.3);
  }, 60000);
});

describe("textiles", () => {
  it("chaque objet a son tissu simulé, un drapé figé et des plaques vectorielles", () => {
    for (const kind of TEXTILE_KINDS) {
      const { asset, issues } = buildTextile({ kind });
      expect(issues.list.length).toBe(0);
      expect(asset.soft!.length).toBeGreaterThan(0);
      expect(asset.softFrozen!.vertexCount).toBeGreaterThan(20);
      expect(asset.mesh.vertexCount).toBeGreaterThan(0);
      if (kind !== "windsock") expect(frozenPlates(asset.soft!).length).toBeGreaterThan(0);
    }
    expect(buildTextile({ kind: "laundry", count: 6 }).asset.soft!.length).toBe(6);
    expect(buildTextile({ kind: "curtain" }).asset.soft!.length).toBe(2);
  });

  it("un drapeau flotte dans le sens du vent", () => {
    const flag = buildTextile({ kind: "flag" }).asset.soft![0];
    const s = restSim(flag, 240, [4, 0, 0])!;
    const sim = (s as { sim: SoftSim }).sim;
    let x = 0;
    for (let i = 0; i < sim.pos.length; i += 3) x += sim.pos[i];
    expect(x / sim.n).toBeGreaterThan(0.4);
    const calm = (restSim(flag, 240, [0, 0, 0]) as { sim: SoftSim }).sim;
    let y = 0;
    for (let i = 1; i < calm.pos.length; i += 3) y += calm.pos[i];
    // sans vent, il pend le long du mât
    expect(y / calm.n).toBeLessThan(flag.box!.c[1]);
  });

  it("échelle d'instance : boîte et sphères à l'échelle", () => {
    const p: SoftPiece = { label: "x", role: 1, box: { c: [1, 2, 0], h: [0.5, 0.3, 0.01] }, colliders: [{ c: [0, 1, 0], r: 0.2 }] };
    const q = scalePiece(p, 2);
    expect(q.box!.c).toEqual([2, 4, 0]);
    expect(q.colliders![0].r).toBe(0.4);
  });
});

describe("moteur commun : évasement, cintrage, plis, mèches repoussées", () => {
  it("jupe évasée, cape cintrée, rideau froncé", () => {
    const jupe = new SoftSim({ kind: "jupe", pin: "haut", stiffness: 0.3, weight: 1, damping: 0.1, wind: 1, collide: false, segments: 6, flare: 1.8 }, { c: [0, 1, 0], h: [0.2, 0.3, 0.2] });
    const r0 = Math.hypot(jupe.rest[0], jupe.rest[2]);
    const last = (jupe.rows - 1) * jupe.cols * 3;
    expect(Math.hypot(jupe.rest[last], jupe.rest[last + 2]) / r0).toBeCloseTo(1.8, 3);
    const cape = new SoftSim({ kind: "tissu", pin: "haut", stiffness: 0.4, weight: 1, damping: 0.1, wind: 1, collide: false, segments: 6, curl: 0.1 }, { c: [0, 1, 0], h: [0.3, 0.4, 0.01] });
    expect(cape.cols).toBeGreaterThanOrEqual(7);
    expect(cape.rest[2] - cape.rest[Math.floor(cape.cols / 2) * 3 + 2]).toBeCloseTo(0.1, 3);
    const rid = new SoftSim({ kind: "tissu", pin: "haut", stiffness: 0.4, weight: 1, damping: 0.1, wind: 1, collide: false, segments: 6, pleats: 0.03 }, { c: [0, 1, 0], h: [0.3, 0.4, 0.01] });
    expect(Math.abs(rid.rest[2] - rid.rest[5])).toBeCloseTo(0.06, 3);
  });

  it("les mèches ne traversent pas les épaules", () => {
    const h = new HairSim({ count: 30, length: 0.5, spread: 0, wave: 0, stiffness: 0.2, width: 0.03, color: "", cut: "longs", wind: 0 }, [0, 0, 0], 0.1);
    const at = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1];
    const sph = new Float32Array([0, 1.3, -0.05, 0.15]);
    for (let i = 0; i < 180; i++) h.step(1 / 60, at, [0, -9.81, 0], [0, 0, 0], sph);
    for (let i = 0; i < h.pos.length; i += 3) expect(Math.hypot(h.pos[i], h.pos[i + 1] - 1.3, h.pos[i + 2] + 0.05)).toBeGreaterThan(0.149);
  });
});

describe("composition", () => {
  it("tissus des objets listés, plafonnés, le reste figé dans le décor", () => {
    const recipe = { size: [80, 80] as [number, number], ground: false as const, layers: [{ id: "f", gen: "textile.pennant", count: MAX_SOFT_OBJECTS + 6, place: { grid: [9, 6] as [number, number], spacing: [3, 3] as [number, number] } }] };
    const m = composeScene({ recipe, seed: 1 });
    const n = m.objects.filter((o) => o.layer === "f").length;
    expect(n).toBe(MAX_SOFT_OBJECTS + 6);
    expect(m.softs.length).toBe(MAX_SOFT_OBJECTS);
    expect(m.tiles.some((t) => t.vertexCount > 0)).toBe(true);
    expect(m.windDir).toBeCloseTo((67 * Math.PI) / 180, 6);
    expect(composeScene({ recipe: { ...recipe, windDir: 90 }, seed: 1 }).windDir).toBeCloseTo(Math.PI / 2, 6);
  });
});
