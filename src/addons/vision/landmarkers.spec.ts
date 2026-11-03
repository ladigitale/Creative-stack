import { describe, expect, it } from "vitest";
import { facesFromMediaPipe, posesFromMediaPipe } from "./landmarkers";
import { mpFaceResult } from "./test-bodies";

describe("facesFromMediaPipe", () => {
  it("points et blendshapes", () => {
    const faces = facesFromMediaPipe(mpFaceResult({ jawOpen: 0.4, eyeBlinkLeft: 0.2 }));
    expect(faces).toHaveLength(1);
    expect(faces[0].landmarks).toHaveLength(478);
    expect(faces[0].blendshapes).toEqual({ jawOpen: 0.4, eyeBlinkLeft: 0.2 });
  });
  it("ignore les visages incomplets et les catégories sans score", () => {
    expect(facesFromMediaPipe({ faceLandmarks: [[{ x: 0, y: 0, z: 0 }]] })).toEqual([]);
    const r = mpFaceResult({ a: 1 });
    r.faceBlendshapes[0].categories.push({ categoryName: "b" } as never);
    expect(facesFromMediaPipe(r)[0].blendshapes).toEqual({ a: 1 });
    expect(facesFromMediaPipe({})).toEqual([]);
  });
});

describe("posesFromMediaPipe", () => {
  const lm = Array.from({ length: 33 }, (_, i) => ({ x: i / 33, y: 0.5, z: 0, visibility: 0.8 }));
  it("33 points avec visibilité, monde optionnel", () => {
    const poses = posesFromMediaPipe({ landmarks: [lm], worldLandmarks: [lm.map(({ x, y, z }) => ({ x, y, z }))] });
    expect(poses).toHaveLength(1);
    expect(poses[0].landmarks[5].visibility).toBe(0.8);
    expect(poses[0].world).toHaveLength(33);
  });
  it("visibilité absente = 1 ; poses incomplètes ignorées", () => {
    expect(posesFromMediaPipe({ landmarks: [lm.map(({ x, y, z }) => ({ x, y, z }))] })[0].landmarks[0].visibility).toBe(1);
    expect(posesFromMediaPipe({ landmarks: [lm.slice(0, 10)] })).toEqual([]);
  });
});
