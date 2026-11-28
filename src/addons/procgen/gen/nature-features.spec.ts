import { describe, expect, it } from "vitest";
import { composeScene } from "../scene/compose";
import { ROLE } from "../style/roles";
import { lavaModel } from "./lava";
import { waterModel } from "./water";
import { partsToMesh } from "./parts";

describe("éléments naturels : chute d'eau, source chaude, geyser, mare gelée, lave", () => {
  const m = composeScene({
    recipe: {
      size: [40, 30],
      ground: { relief: 0 },
      layers: [
        { id: "chute", gen: "water", place: { at: [{ x: -12, z: 0 }] }, params: { kind: "waterfall", height: 10 } },
        { id: "source", gen: "water", place: { at: [{ x: -3, z: 8 }] }, params: { kind: "hotspring" } },
        { id: "geyser", gen: "water", place: { at: [{ x: -8, z: 10 }] }, params: { kind: "geyser" } },
        { id: "glace", gen: "water", place: { at: [{ x: -15, z: 10 }] }, params: { kind: "frozen" } },
        { id: "volcan", gen: "lava", place: { at: [{ x: 8, z: -4 }] }, params: { kind: "volcano" } },
        { id: "lac", gen: "lava", place: { at: [{ x: 3, z: 8 }] }, params: { kind: "pool" } },
        { id: "coulee", gen: "lava", place: { at: [{ x: 14, z: 8 }] }, params: { kind: "flow" } },
      ],
    },
    seed: 1,
  });
  const obj = (id: string) => m.objects.find((o) => o.id === id)!;
  it("tous placés, sans problème signalé", () => {
    for (const id of ["chute.0", "source.0", "geyser.0", "glace.0", "volcan.0", "lac.0", "coulee.0"]) expect(obj(id), id).toBeTruthy();
    expect(m.issues.filter((i) => i.code !== "info")).toEqual([]);
  });
  it("chute haute avec son pied et son sommet ; évent du geyser ; vapeur de la source ; cratère du volcan", () => {
    expect(obj("chute.0").height).toBeGreaterThan(9);
    expect(obj("chute.0").anchors["fall.top"][1]).toBeGreaterThan(9);
    expect(obj("geyser.0").anchors.vent).toBeDefined();
    expect(obj("source.0").anchors.steam).toBeDefined();
    expect(obj("volcan.0").anchors.vent[1]).toBeGreaterThan(4);
  });
  it("la lave est incandescente (rôle fire), la chute a une lame d'eau", () => {
    for (const kind of ["pool", "flow", "volcano"]) {
      const mesh = partsToMesh(lavaModel({ kind }).parts);
      expect(Array.from(mesh.role).includes(ROLE.fire), kind).toBe(true);
    }
    expect(Array.from(partsToMesh(waterModel({ kind: "waterfall", height: 10 }).parts).role).includes(ROLE.water)).toBe(true);
  });
});
