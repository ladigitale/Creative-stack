import { describe, expect, it } from "vitest";
import { JOINT_NAMES } from "../../shared/ml/pose";
import { compileMap } from "../../shared/ml/map-expr";
import { PoseTrackerCore } from "./pose-state";
import { fakePose } from "./test-bodies";

const core = (o: Partial<ConstructorParameters<typeof PoseTrackerCore>[0]> = {}) =>
  new PoseTrackerCore({ smooth: 0, holdMs: 150, mirror: true, ...o });

describe("PoseTrackerCore", () => {
  it("sans corps : present 0, 33 joints neutres", () => {
    const out = core().update([], 0);
    expect(out.present).toBe(0);
    expect(Object.keys(out.joints)).toHaveLength(33);
    expect(out.joints.leftWrist.v).toBe(0);
  });

  it("un corps : joints nommés, raise, centre des hanches", () => {
    const out = core({ mirror: false }).update([fakePose(0, 0)], 0);
    expect(out.present).toBe(1);
    // image non miroir : côtés échangés → le poignet gauche du sujet devient rightWrist côté écran
    expect(out.joints.rightWrist.y).toBeCloseTo(0);
    expect(out.raiseRight).toBeCloseTo(1);
    expect(out.y).toBeCloseTo(0.6);
    expect(out.joints.nose.v).toBeCloseTo(0.9);
  });

  it("miroir : x inversé, noms du sujet conservés", () => {
    const out = core({ mirror: true }).update([fakePose(0.3, 0)], 0);
    expect(out.joints.leftWrist.x).toBeCloseTo(0.8); // 1 - 0.2
    expect(out.raiseLeft).toBeCloseTo(0.5);
  });

  it("plusieurs corps : le premier alimente les clés plates, tous sont dans poses", () => {
    const out = core().update([fakePose(0.3, 0), fakePose(0.3, 0.1)], 0);
    expect(out.count).toBe(2);
    expect(out.poses).toHaveLength(2);
    expect(out.poses[0].landmarks).toHaveLength(33);
  });

  it("hold-ms puis present 0, dernières valeurs gardées", () => {
    const c = core({ holdMs: 100 });
    c.update([fakePose(0, 0)], 0);
    expect(c.update([], 50).present).toBe(1);
    const gone = c.update([], 300);
    expect(gone.present).toBe(0);
    expect(gone.raiseLeft).toBeGreaterThan(0.9);
  });

  it("lissage et map", () => {
    const s = core({ smooth: 0.9 });
    const a = s.update([fakePose(0.3, 0)], 0).x;
    const b = s.update([fakePose(0.3, 0.2)], 33).x;
    expect(b).not.toBe(a);
    const out = core({ map: compileMap("pitch=raiseLeft*3600; vol=present*raiseRight") }).update([fakePose(0, 0)], 0);
    expect(out.pitch).toBeCloseTo(out.raiseLeft * 3600);
    expect(out.vol).toBeCloseTo(out.raiseRight);
  });

  it("angles : calculés sur les points en mètres (world) quand ils existent, côtés écran", () => {
    const raw = fakePose();
    const world = JOINT_NAMES.map(() => ({ x: 0, y: 0, z: 0 }));
    const w = (n: (typeof JOINT_NAMES)[number], x: number, y: number) => (world[JOINT_NAMES.indexOf(n)] = { x, y, z: 0 });
    // genou « gauche du sujet » plié à angle droit (hanche, genou, cheville)
    w("leftHip", 0, 0);
    w("leftKnee", 0, 0.4);
    w("leftAnkle", 0.4, 0.4);
    // jambe droite du sujet tendue
    w("rightHip", 0.2, 0);
    w("rightKnee", 0.2, 0.4);
    w("rightAnkle", 0.2, 0.8);
    raw.world = world;
    const flipped = new PoseTrackerCore({ smooth: 0, holdMs: 100, mirror: true }).update([raw], 0);
    expect(flipped.kneeLeft).toBeCloseTo((90 - 45) / 135, 2);
    expect(flipped.kneeRight).toBeCloseTo(1, 2);
    const plain = new PoseTrackerCore({ smooth: 0, holdMs: 100, mirror: false }).update([raw], 0);
    expect(plain.kneeRight).toBeCloseTo((90 - 45) / 135, 2); // côtés échangés sans miroir
  });
});
