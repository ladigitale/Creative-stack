import { describe, expect, it } from "vitest";
import { compileMap } from "../../shared/ml/map-expr";
import { FaceTrackerCore } from "./face-state";
import { fakeFace } from "./test-bodies";

const core = (o: Partial<ConstructorParameters<typeof FaceTrackerCore>[0]> = {}) =>
  new FaceTrackerCore({ smooth: 0, holdMs: 150, mirror: false, ...o });

describe("FaceTrackerCore", () => {
  it("sans visage : present 0, valeurs neutres", () => {
    const out = core().update([], 0);
    expect(out).toMatchObject({ present: 0, count: 0, mouthOpen: 0, yaw: 0 });
    expect(out.faces).toEqual([]);
  });

  it("un visage : position, expressions, blendshapes bruts", () => {
    const out = core().update([fakeFace(0.3, 0.4, { jawOpen: 0.8, mouthSmileLeft: 1, mouthSmileRight: 1 })], 0);
    expect(out.present).toBe(1);
    expect(out.count).toBe(1);
    expect(out.x).toBeCloseTo(0.3);
    expect(out.y).toBeCloseTo(0.4);
    expect(out.mouthOpen).toBe(0.8);
    expect(out.smile).toBe(1);
    expect(out.blend.jawOpen).toBe(0.8);
    expect(out.faces[0].landmarks).toBeUndefined();
  });

  it("miroir : x inversé, côtés des clignements échangés quand l'image n'est pas un miroir", () => {
    const blend = { eyeBlinkLeft: 1, eyeBlinkRight: 0 };
    const plain = core({ mirror: false }).update([fakeFace(0.2, 0.5, blend)], 0);
    const mirrored = core({ mirror: true }).update([fakeFace(0.2, 0.5, blend)], 0);
    expect(mirrored.x).toBeCloseTo(1 - plain.x);
    expect(mirrored.blinkLeft).toBe(1);
    expect(plain.blinkRight).toBe(1);
  });

  it("landmarks publiés à la demande seulement", () => {
    const out = core({ landmarks: true }).update([fakeFace()], 0);
    expect(out.faces[0].landmarks).toHaveLength(478);
  });

  it("hold-ms : valeur gardée puis present 0 sans effacer la dernière valeur", () => {
    const c = core({ holdMs: 100 });
    c.update([fakeFace(0.7, 0.5, { jawOpen: 0.9 })], 0);
    expect(c.update([], 50).present).toBe(1);
    const gone = c.update([], 200);
    expect(gone.present).toBe(0);
    expect(gone.mouthOpen).toBe(0.9);
    expect(gone.x).toBeCloseTo(0.7);
  });

  it("lissage : un saut est amorti", () => {
    const c = core({ smooth: 0.9 });
    const a = c.update([fakeFace(0.3, 0.5)], 0).x;
    const b = c.update([fakeFace(0.5, 0.5)], 33).x;
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(0.5);
  });

  it("map : clés dérivées", () => {
    const out = core({ map: compileMap("cut=500+mouthOpen*4000; vol=present ? 1-blinkRight : 0") }).update(
      [fakeFace(0.5, 0.5, { jawOpen: 0.5, eyeBlinkLeft: 0.25 })],
      0,
    );
    expect(out.cut).toBeCloseTo(2500);
    expect(out.vol).toBeCloseTo(0.75);
  });
});
