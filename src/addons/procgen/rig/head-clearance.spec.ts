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

describe("marche et course : les bras ne traversent pas les cuisses", () => {
  it("5 styles × marche, course × cycle complet", () => {
    const bad: string[] = [];
    for (const archetype of ["chibi", "cartoon", "stylized", "realistic", "heroic"])
      for (const figure of ["masculine", "feminine"]) {
        const p = resolveParams(character.schema, { archetype, figure, detail: "crowd", item: "none", build: 0.6 }, { rng: new Rng("w"), vars: {} }, new Issues());
        const a = character.build(p as never, { rng: new Rng("w"), issues: new Issues(), path: "" });
        const sk = a.skeleton!, info = rigInfo(sk);
        const leg = info.thigh + info.shin;
        for (const speed of [leg * 1.6, leg * 3.2])
          for (let i = 0; i < 12; i++) {
            const st: MotionState = { speed, phase: i / 12, time: 1 + i * 0.1, action: "idle", actionTime: 0, actionWeight: 0, mood: "neutral", turn: 0, seed: 3 };
            const W = sk.world(humanoidPose(sk, info, st).pose);
            for (const s of ["l", "r"])
              for (const pt of [sk.headOf(W, `hand.${s}`), sk.tailOf(W, `hand.${s}`)] as V3[])
                for (const t of ["l", "r"]) {
                  const A = sk.headOf(W, `thigh.${t}`), B = sk.tailOf(W, `thigh.${t}`);
                  const ab = sub(B, A);
                  const u = Math.max(0, Math.min(1, ((pt[0] - A[0]) * ab[0] + (pt[1] - A[1]) * ab[1] + (pt[2] - A[2]) * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
                  const q = add(A, scale(ab, u));
                  const r = sk.bones[sk.index[`thigh.${t}`]].radius[0];
                  if (len(sub(pt, q)) < r) bad.push(`${archetype} ${figure} v=${(speed / leg).toFixed(1)} φ=${(i / 12).toFixed(2)} main ${s} dans cuisse ${t}`);
                }
          }
      }
    expect(bad.slice(0, 10)).toEqual([]);
  }, 60000);
});
