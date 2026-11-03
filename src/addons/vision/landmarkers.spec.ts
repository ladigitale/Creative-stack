import { describe, expect, it } from "vitest";
import { detectionsFromMediaPipe, facesFromMediaPipe, posesFromMediaPipe } from "./landmarkers";
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

describe("detectionsFromMediaPipe", () => {
  const det = (name: string, score: number, ox: number, oy: number, w: number, h: number) => ({
    boundingBox: { originX: ox, originY: oy, width: w, height: h },
    categories: [{ categoryName: name, score }],
  });
  it("normalise par la taille de l'image, trie par score, borne à 0..1", () => {
    const out = detectionsFromMediaPipe({
      size: { width: 640, height: 480 },
      detections: [det("cup", 0.6, 64, 48, 128, 96), det("person", 0.9, -10, 0, 700, 480)],
    });
    expect(out.map((d) => d.label)).toEqual(["person", "cup"]);
    expect(out[1].x).toBeCloseTo(0.1);
    expect(out[1].y).toBeCloseTo(0.1);
    expect(out[1].w).toBeCloseTo(0.2);
    expect(out[1].h).toBeCloseTo(0.2);
    expect(out[0].x).toBe(0);
    expect(out[0].x + out[0].w).toBe(1);
  });
  it("seuil de score ; sans taille ou sans boîte : rien", () => {
    expect(detectionsFromMediaPipe({ size: { width: 10, height: 10 }, detections: [det("a", 0.2, 0, 0, 5, 5)] }, 0.5)).toEqual([]);
    expect(detectionsFromMediaPipe({ detections: [det("a", 0.9, 0, 0, 5, 5)] })).toEqual([]);
    expect(detectionsFromMediaPipe({ size: { width: 10, height: 10 }, detections: [{ categories: [] }] })).toEqual([]);
  });
});
