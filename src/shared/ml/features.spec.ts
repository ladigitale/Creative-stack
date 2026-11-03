import { describe, expect, it } from "vitest";
import { blendFeatures, extractFeatures, handFeatures, poseFeatures } from "./features";

const hand = (cx: number, cy: number, scale = 1) => {
  const lm = Array.from({ length: 21 }, (_, i) => ({ x: cx + ((i % 5) * 0.02 - 0.04) * scale, y: cy - (i / 21) * 0.2 * scale, z: 0 }));
  lm[0] = { x: cx, y: cy, z: 0 };
  lm[9] = { x: cx, y: cy - 0.2 * scale, z: 0 };
  return lm;
};

describe("features", () => {
  it("main : invariante à la position et à l'échelle", () => {
    const a = handFeatures(hand(0.3, 0.7, 1))!;
    const b = handFeatures(hand(0.6, 0.5, 2))!;
    expect(a).toHaveLength(42);
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
    expect(a[0]).toBe(0); // le poignet est l'origine
  });

  it("main : refuse une liste incomplète ou une paume de taille nulle", () => {
    expect(handFeatures([{ x: 0, y: 0 }])).toBeNull();
    expect(handFeatures(Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 })))).toBeNull();
    expect(handFeatures("x")).toBeNull();
  });

  it("corps : 66 valeurs, invariant", () => {
    const body = (dx: number, s: number) => {
      const lm = Array.from({ length: 33 }, (_, i) => ({ x: 0.5 + dx + (i % 3) * 0.01 * s, y: 0.5 + (i / 33) * 0.1 * s }));
      lm[11] = { x: 0.4 + dx, y: 0.3 };
      lm[12] = { x: 0.6 + dx, y: 0.3 };
      lm[23] = { x: 0.45 + dx, y: 0.3 + 0.3 * s };
      lm[24] = { x: 0.55 + dx, y: 0.3 + 0.3 * s };
      return lm;
    };
    expect(poseFeatures(body(0, 1))).toHaveLength(66);
    expect(poseFeatures(body(0, 1))![0]).toBeCloseTo(poseFeatures(body(0, 1))![0]);
    expect(poseFeatures(body(0, 1).slice(0, 10))).toBeNull();
  });

  it("blendshapes : ordre stable par nom", () => {
    expect(blendFeatures({ b: 0.2, a: 0.1, c: 0.3, d: 0, e: 1 })).toEqual([0.1, 0.2, 0.3, 0, 1]);
    expect(blendFeatures({ a: 1 })).toBeNull();
    expect(blendFeatures({ a: 1, b: "x", c: 1, d: 1, e: 1 })).toBeNull();
  });

  it("extractFeatures : auto, main demandée, rien de visible", () => {
    const out = { hands: [{ role: "left", landmarks: hand(0.3, 0.6) }, { role: "right", landmarks: hand(0.7, 0.6) }] };
    expect(extractFeatures(out, "auto")).toHaveLength(42);
    expect(extractFeatures(out, "hand", "right")).toHaveLength(42);
    expect(extractFeatures({ hands: [{ role: "left", landmarks: hand(0.3, 0.6) }] }, "hand", "right")).toBeNull();
    expect(extractFeatures({ hands: [] })).toBeNull();
    expect(extractFeatures({ present: 0, blend: { a: 1, b: 1, c: 1, d: 1, e: 1 } }, "face")).toBeNull();
    expect(extractFeatures({ present: 1, blend: { a: 1, b: 1, c: 1, d: 1, e: 1 } })).toHaveLength(5);
    expect(extractFeatures(null)).toBeNull();
  });
});
