import { describe, expect, it } from "vitest";
import { type V3, add, len, scale, sub } from "../core/math";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { character } from "../gen/character";
import { type Action, type MotionState, humanoidPose, rigInfo } from "./locomotion";

describe("gestes : la main ne traverse jamais la tête", () => {
  const ARCH = ["chibi", "cartoon", "stylized", "realistic", "heroic"];
  const ACTIONS: Action[] = ["idle", "wave", "point", "cheer", "talk", "carry", "think", "hammer", "sweep", "dig", "drink", "eat"];
  it("5 styles × 12 gestes × 8 instants", () => {
    const bad: string[] = [];
    for (const archetype of ARCH) {
      const p = resolveParams(character.schema, { archetype, detail: "crowd", item: "none" }, { rng: new Rng("h"), vars: {} }, new Issues());
      const a = character.build(p as never, { rng: new Rng("h"), issues: new Issues(), path: "" });
      const sk = a.skeleton!, info = rigInfo(sk);
      const hb = sk.bone("head")!;
      const R = Math.max(hb.radius[0], len(sub(hb.tail, hb.head)) * 0.5);
      for (const action of ACTIONS)
        for (let i = 0; i < 8; i++) {
          const t = 1 + i * 0.29;
          const st: MotionState = { speed: 0, phase: 0, time: t, action, actionTime: t, actionWeight: 1, mood: "neutral", turn: 0, seed: 3 };
          const W = sk.world(humanoidPose(sk, info, st).pose);
          const c = scale(add(sk.headOf(W, "head"), sk.tailOf(W, "head")), 0.5);
          // les gestes qui vont au visage peuvent le toucher, pas y entrer
          const touch = action === "eat" || action === "drink" || action === "think";
          for (const s of ["l", "r"]) {
            for (const pt of [sk.headOf(W, `hand.${s}`), sk.tailOf(W, `hand.${s}`), sk.headOf(W, `forearm.${s}`)] as V3[]) {
              const d = len(sub(pt, c)) / R;
              if (d < (touch ? 0.85 : 1)) bad.push(`${archetype} ${action} t=${t.toFixed(2)} ${s} : ${d.toFixed(2)} R`);
            }
          }
        }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  }, 60000);
});
