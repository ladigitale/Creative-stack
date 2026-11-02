import { describe, expect, it } from "vitest";
import { assignRoles, metricsOf, mirrorPoints, openness, palmCenter, pinch, roll, type Point } from "./hands";

/** Main synthétique : poignet en (cx, cy+0,25), bases des doigts à cy, bouts à cy - reach. */
function hand(cx: number, cy: number, reach: number, thumbTipNearIndex = false, tilt = 0): Point[] {
  const lm: Point[] = Array.from({ length: 21 }, () => ({ x: cx, y: cy, z: 0 }));
  lm[0] = { x: cx, y: cy + 0.25, z: 0 };
  const bases = [5, 9, 13, 17];
  const tips = [8, 12, 16, 20];
  bases.forEach((b, i) => {
    const x = cx + (i - 1) * 0.04;
    lm[b] = { x, y: cy, z: 0 };
    lm[tips[i]] = { x: x + tilt, y: cy - reach, z: 0 };
  });
  lm[4] = thumbTipNearIndex ? { x: lm[8].x + 0.005, y: lm[8].y + 0.005, z: 0 } : { x: cx - 0.18, y: cy, z: 0 };
  return lm;
}

describe("métriques de main", () => {
  it("openness : poing ≈ 0, main ouverte ≈ 1", () => {
    expect(openness(hand(0.5, 0.5, 0.01))).toBeLessThan(0.2);
    expect(openness(hand(0.5, 0.5, 0.4))).toBeGreaterThan(0.9);
  });
  it("pinch : bouts qui se touchent ≈ 1, écartés ≈ 0", () => {
    expect(pinch(hand(0.5, 0.5, 0.3, true))).toBeGreaterThan(0.9);
    expect(pinch(hand(0.5, 0.5, 0.3, false))).toBe(0);
  });
  it("roll : verticale 0,5, penchée de chaque côté", () => {
    expect(roll(hand(0.5, 0.5, 0.3))).toBeCloseTo(0.5, 2);
    const right = hand(0.5, 0.5, 0.3);
    right[9] = { x: right[0].x + 0.2, y: right[0].y, z: 0 };
    expect(roll(right)).toBeGreaterThan(0.9);
    const left = hand(0.5, 0.5, 0.3);
    left[9] = { x: left[0].x - 0.2, y: left[0].y, z: 0 };
    expect(roll(left)).toBeLessThan(0.1);
  });
  it("palmCenter / metricsOf bornés 0..1", () => {
    const m = metricsOf(hand(0.3, 0.6, 0.3));
    expect(palmCenter(hand(0.3, 0.6, 0.3)).x).toBeCloseTo(0.3, 1);
    for (const k of ["pinch", "openness", "roll"] as const) {
      expect(m[k]).toBeGreaterThanOrEqual(0);
      expect(m[k]).toBeLessThanOrEqual(1);
    }
    expect(m.tipY).toBeLessThan(m.y);
  });
  it("mirrorPoints", () => {
    expect(mirrorPoints([{ x: 0.2, y: 0.4, z: 1 }])).toEqual([{ x: 0.8, y: 0.4, z: 1 }]);
  });
});

describe("assignRoles", () => {
  it("deux mains : la plus à gauche est left, quel que soit l'ordre", () => {
    expect(assignRoles([{ x: 0.8, y: 0.5 }, { x: 0.2, y: 0.5 }], {})).toEqual(["right", "left"]);
    expect(assignRoles([{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }], {})).toEqual(["left", "right"]);
  });
  it("une main : garde son rôle en traversant le centre", () => {
    expect(assignRoles([{ x: 0.4, y: 0.5 }], { right: { x: 0.55, y: 0.5 } })).toEqual(["right"]);
  });
  it("une main sans mémoire : étiquette du modèle, sinon moitié d'écran", () => {
    expect(assignRoles([{ x: 0.7, y: 0.5, label: "Left" }], {})).toEqual(["left"]);
    expect(assignRoles([{ x: 0.7, y: 0.5 }], {})).toEqual(["right"]);
    expect(assignRoles([{ x: 0.3, y: 0.5 }], {})).toEqual(["left"]);
  });
  it("mémoire trop lointaine ignorée", () => {
    expect(assignRoles([{ x: 0.9, y: 0.9, label: "Left" }], { right: { x: 0.1, y: 0.1 } })).toEqual(["left"]);
  });
  it("aucune main", () => {
    expect(assignRoles([], {})).toEqual([]);
  });
});
