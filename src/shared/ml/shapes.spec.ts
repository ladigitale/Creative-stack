import { describe, expect, it } from "vitest";
import { FACE_CONTOURS, HAND_BONES, POSE_BONES, buildShapes, detectKind } from "./shapes";

const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i / n, y: 0.5, z: 0 }));

describe("shapes", () => {
  it("indices des segments dans les bornes", () => {
    expect(HAND_BONES.flat().every((i) => i >= 0 && i < 21)).toBe(true);
    expect(POSE_BONES.flat().every((i) => i >= 0 && i < 33)).toBe(true);
    expect(Object.values(FACE_CONTOURS).flat().every((i) => i >= 0 && i < 468)).toBe(true);
  });

  it("detectKind d'après les clés", () => {
    expect(detectKind({ hands: [] })).toBe("hands");
    expect(detectKind({ faces: [] })).toBe("face");
    expect(detectKind({ poses: [] })).toBe("pose");
    expect(detectKind({})).toBeNull();
    expect(detectKind(null)).toBeNull();
  });

  it("mains : segments + points par rôle", () => {
    const shapes = buildShapes({ hands: [{ role: "left", landmarks: pts(21) }, { role: "right", landmarks: pts(21) }] }, "auto");
    expect(shapes.filter((s) => s.type === "line")).toHaveLength(HAND_BONES.length * 2);
    const dots = shapes.filter((s) => s.type === "dots");
    expect(dots).toHaveLength(2);
    expect(dots.map((d) => d.role)).toEqual(["left", "right"]);
  });

  it("options : points seuls, segments seuls", () => {
    const data = { hands: [{ role: "left", landmarks: pts(21) }] };
    expect(buildShapes(data, "hands", { points: true, bones: false }).every((s) => s.type === "dots")).toBe(true);
    expect(buildShapes(data, "hands", { points: false, bones: true }).every((s) => s.type === "line")).toBe(true);
  });

  it("corps : segments et points", () => {
    const shapes = buildShapes({ poses: [{ landmarks: pts(33) }] }, "pose");
    expect(shapes.filter((s) => s.type === "line")).toHaveLength(POSE_BONES.length);
    expect(shapes.some((s) => s.type === "dots" && s.pts.length === 33)).toBe(true);
  });

  it("visage : contours fermés et points ; rien sans landmarks", () => {
    const shapes = buildShapes({ faces: [{ landmarks: pts(478) }] }, "face");
    const lines = shapes.filter((s) => s.type === "line");
    expect(lines).toHaveLength(Object.keys(FACE_CONTOURS).length);
    expect(lines.some((l) => l.type === "line" && l.closed)).toBe(true);
    expect(buildShapes({ faces: [{ blend: {} }] }, "face")).toEqual([]);
  });

  it("objets : rectangles étiquetés, boîtes invalides ignorées", () => {
    const shapes = buildShapes({ objects: [{ label: "cup", score: 0.91, x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, { label: "x", x: "a" }] }, "auto");
    expect(shapes).toEqual([{ type: "rect", x: 0.1, y: 0.2, w: 0.3, h: 0.4, role: "o0", label: "cup 91%" }]);
    expect(detectKind({ objects: [] })).toBe("objects");
  });

  it("données mal formées : liste vide, jamais d'exception", () => {
    expect(buildShapes({ hands: [{ landmarks: [{ x: "a", y: 1 }] }] }, "hands")).toEqual([]);
    expect(buildShapes({ hands: [{ landmarks: pts(5) }] }, "hands")).toEqual([]);
    expect(buildShapes({ hands: "x" }, "hands")).toEqual([]);
    expect(buildShapes(undefined, "auto")).toEqual([]);
    expect(buildShapes({ hands: [] }, "pose")).toEqual([]);
  });
});
