import { describe, expect, it } from "vitest";
import { composeScene } from "../scene/compose";
import { PROP_ACTIONS, propsFor } from "./hand-props";
import type { Skeleton } from "../rig/skeleton";

describe("objets tenus le temps d'une action", () => {
  const sk = composeScene({ recipe: { size: [4, 4], actors: { a: { params: { archetype: "stylized", age: "adult", item: "none" }, at: [0, 0] } } }, seed: 1 }).actors[0].asset.skeleton as unknown as Skeleton;
  it("tasse, assiette et fourchette, casserole et cuillère, planche et couteau", () => {
    expect(propsFor("drink", sk).map((p) => p.bone)).toEqual(["hand.r"]);
    const eat = propsFor("eat", sk);
    expect(eat.map((p) => p.bone)).toEqual(["hand.l", "hand.r"]);
    expect(eat[0].flat).toBeDefined();
    expect(propsFor("cook", sk).map((p) => p.bone)).toEqual([null, "hand.r"]);
    expect(propsFor("chop", sk).map((p) => p.bone)).toEqual([null, "hand.r"]);
    for (const a of PROP_ACTIONS) for (const p of propsFor(a, sk)) expect(p.mesh.vertexCount).toBeGreaterThan(8);
    expect(propsFor("wave", sk)).toEqual([]);
  });
});
