import { describe, expect, it } from "vitest";
import { faceExpressions, faceMetrics, mirrorFace } from "./face";
import type { Point } from "./hands";

/** Visage synthétique de face : joues en (cx ± w/2), yeux à cy - 0,05, nez à cy, menton à cy + 0,12. */
function face(cx = 0.5, cy = 0.5, w = 0.3, noseDx = 0, tilt = 0): Point[] {
  const lm: Point[] = Array.from({ length: 478 }, () => ({ x: cx, y: cy, z: 0 }));
  lm[234] = { x: cx - w / 2, y: cy, z: 0 };
  lm[454] = { x: cx + w / 2, y: cy, z: 0 };
  const ey = cy - 0.06;
  lm[33] = { x: cx - 0.11, y: ey - tilt, z: 0 };
  lm[133] = { x: cx - 0.04, y: ey - tilt, z: 0 };
  lm[263] = { x: cx + 0.11, y: ey + tilt, z: 0 };
  lm[362] = { x: cx + 0.04, y: ey + tilt, z: 0 };
  lm[1] = { x: cx + noseDx, y: cy, z: 0.05 };
  lm[152] = { x: cx, y: cy + 0.12, z: 0 };
  return lm;
}

describe("faceMetrics", () => {
  it("de face : yaw ≈ 0, taille = largeur des joues", () => {
    const m = faceMetrics(face());
    expect(m.yaw).toBeCloseTo(0, 5);
    expect(m.size).toBeCloseTo(0.3, 5);
    expect(m.x).toBe(0.5);
  });
  it("yaw : signe et bornes", () => {
    expect(faceMetrics(face(0.5, 0.5, 0.3, 0.1)).yaw).toBeGreaterThan(0.5);
    expect(faceMetrics(face(0.5, 0.5, 0.3, -0.1)).yaw).toBeLessThan(-0.5);
    expect(faceMetrics(face(0.5, 0.5, 0.3, 0.5)).yaw).toBe(1);
  });
  it("roll : œil droit de l'écran plus bas → positif", () => {
    expect(faceMetrics(face(0.5, 0.5, 0.3, 0, 0.03)).roll).toBeGreaterThan(0.1);
    expect(faceMetrics(face(0.5, 0.5, 0.3, 0, -0.03)).roll).toBeLessThan(-0.1);
  });
  it("pitch borné", () => {
    const m = faceMetrics(face());
    expect(m.pitch).toBeGreaterThanOrEqual(-1);
    expect(m.pitch).toBeLessThanOrEqual(1);
  });
  it("mirrorFace", () => {
    expect(mirrorFace([{ x: 0.2, y: 0.3, z: 1 }])).toEqual([{ x: 0.8, y: 0.3, z: 1 }]);
  });
});

describe("faceExpressions", () => {
  const s = { jawOpen: 0.7, mouthSmileLeft: 0.4, mouthSmileRight: 0.6, browInnerUp: 0.3, browOuterUpLeft: 0.6, browOuterUpRight: 0.0, eyeBlinkLeft: 0.9, eyeBlinkRight: 0.1 };
  it("valeurs dérivées", () => {
    const e = faceExpressions(s, true);
    expect(e.mouthOpen).toBe(0.7);
    expect(e.smile).toBeCloseTo(0.5);
    expect(e.browUp).toBeCloseTo(0.3);
    expect(e.blinkLeft).toBe(0.9);
    expect(e.blinkRight).toBe(0.1);
  });
  it("image non miroir : côtés échangés", () => {
    const e = faceExpressions(s, false);
    expect(e.blinkLeft).toBe(0.1);
    expect(e.blinkRight).toBe(0.9);
  });
  it("regard : vers la droite de l'écran, borné", () => {
    const right = faceExpressions({ eyeLookOutRight: 1, eyeLookInLeft: 1 }, true);
    expect(right.gazeX).toBe(1);
    const left = faceExpressions({ eyeLookOutLeft: 1, eyeLookInRight: 1 }, true);
    expect(left.gazeX).toBe(-1);
    expect(faceExpressions({ eyeLookUpLeft: 1, eyeLookUpRight: 1 }, true).gazeY).toBe(1);
    expect(faceExpressions({}, true).gazeX).toBe(0);
  });
});
