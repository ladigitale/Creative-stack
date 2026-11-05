import { describe, expect, it } from "vitest";
import { JOINT_NAMES, bodyMetrics, jointAngles, jointsByName, mirrorPose, swapSide, type PosePoint } from "./pose";

/** Corps de face : épaules à y=0,3, hanches à 0,6 (buste 0,3), poignets à la hauteur donnée. */
function body(wristY = 0.3, lean = 0): PosePoint[] {
  const lm: PosePoint[] = JOINT_NAMES.map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
  const set = (n: (typeof JOINT_NAMES)[number], x: number, y: number) => (lm[JOINT_NAMES.indexOf(n)] = { x, y, z: 0, visibility: 0.9 });
  set("leftShoulder", 0.4 + lean, 0.3);
  set("rightShoulder", 0.6 + lean, 0.3);
  set("leftHip", 0.45, 0.6);
  set("rightHip", 0.55, 0.6);
  set("leftWrist", 0.2, wristY);
  set("rightWrist", 0.8, 0.6);
  return lm;
}

describe("pose", () => {
  it("33 noms, swapSide symétrique", () => {
    expect(JOINT_NAMES).toHaveLength(33);
    expect(swapSide("leftWrist")).toBe("rightWrist");
    expect(swapSide("rightFootIndex")).toBe("leftFootIndex");
    expect(swapSide("nose")).toBe("nose");
  });
  it("jointsByName : échange gauche/droite quand demandé", () => {
    const lm = body();
    const plain = jointsByName(lm, false);
    const swapped = jointsByName(lm, true);
    expect(plain.leftWrist.x).toBe(0.2);
    expect(swapped.rightWrist.x).toBe(0.2);
    expect(swapped.nose).toEqual(plain.nose);
  });
  it("raise : à l'épaule 0,5, au-dessus plus, à la hanche 0", () => {
    const at = (y: number) => bodyMetrics(jointsByName(body(y), false)).raiseLeft;
    expect(at(0.3)).toBeCloseTo(0.5);
    expect(at(0)).toBeCloseTo(1);
    expect(at(0.6)).toBeCloseTo(0);
    expect(at(-5)).toBe(1);
  });
  it("span, lean, centre des hanches", () => {
    const m = bodyMetrics(jointsByName(body(0.3, 0.1), false));
    expect(m.span).toBeGreaterThan(2.5);
    expect(m.lean).toBeGreaterThan(0.2);
    expect(m.x).toBeCloseTo(0.5);
    expect(m.y).toBeCloseTo(0.6);
  });
  it("mirrorPose garde la visibilité", () => {
    expect(mirrorPose([{ x: 0.2, y: 0.4, z: 0, visibility: 0.7 }])).toEqual([{ x: 0.8, y: 0.4, z: 0, visibility: 0.7 }]);
  });
  it("angles : bras tendu = 1, bras plié = bas ; genoux et accroupissement", () => {
    const lm = body();
    const set = (n: (typeof JOINT_NAMES)[number], x: number, y: number) => (lm[JOINT_NAMES.indexOf(n)] = { x, y, z: 0, visibility: 0.9 });
    // bras gauche tendu à l'horizontale, bras droit plié à angle droit
    set("leftElbow", 0.3, 0.3);
    set("leftWrist", 0.2, 0.3);
    set("rightElbow", 0.7, 0.3);
    set("rightWrist", 0.7, 0.2);
    // jambes : gauche tendue, droite pliée à angle droit
    set("leftKnee", 0.45, 0.8);
    set("leftAnkle", 0.45, 1.0);
    set("rightKnee", 0.55, 0.8);
    set("rightAnkle", 0.65, 0.8);
    const a = jointAngles(jointsByName(lm, false));
    expect(a.elbowLeft).toBeCloseTo(1, 2);
    expect(a.elbowRight).toBeCloseTo((90 - 45) / 135, 2);
    expect(a.kneeLeft).toBeCloseTo(1, 2);
    expect(a.kneeRight).toBeCloseTo((90 - 45) / 135, 2);
    expect(a.squat).toBeCloseTo(1 - (1 + 45 / 135) / 2, 2);
  });
  it("angles : points absents ou confondus = articulation tendue (pas de NaN)", () => {
    const a = bodyMetrics(jointsByName(body(), false));
    for (const k of ["elbowLeft", "elbowRight", "kneeLeft", "kneeRight", "squat"] as const) expect(Number.isFinite(a[k])).toBe(true);
  });
});
