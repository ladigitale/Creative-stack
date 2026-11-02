import { describe, expect, it } from "vitest";
import { compileMap } from "../../shared/ml/map-expr";
import { HandTrackerCore } from "./hand-state";
import { fakeHand } from "./test-hands";

const core = (o: Partial<ConstructorParameters<typeof HandTrackerCore>[0]> = {}) =>
  new HandTrackerCore({ smooth: 0, holdMs: 150, mirror: false, ...o });

describe("HandTrackerCore", () => {
  it("sans main : tout à zéro", () => {
    const out = core().update([], 0);
    expect(out.count).toBe(0);
    expect(out.left.present).toBe(0);
    expect(out.right.present).toBe(0);
    expect(out.hands).toEqual([]);
  });

  it("deux mains : gauche / droite selon x, valeurs 0..1", () => {
    const out = core().update([fakeHand(0.75, 0.4), fakeHand(0.25, 0.6)], 0);
    expect(out.count).toBe(2);
    expect(out.left.present).toBe(1);
    expect(out.right.present).toBe(1);
    expect(out.left.x).toBeLessThan(out.right.x);
    expect(out.left.y).toBeGreaterThan(out.right.y);
    expect(out.hands.map((h) => h.role)).toEqual(["right", "left"]);
    expect(out.hands[0].landmarks).toHaveLength(21);
  });

  it("miroir : x inversé, landmarks et world compris", () => {
    const h = fakeHand(0.2, 0.5, 0.3, { world: [{ x: 0.1, y: 0, z: 0 }] });
    const plain = core().update([h], 0);
    const mirrored = core({ mirror: true }).update([h], 0);
    const role = plain.right.present ? "right" : "left";
    const mrole = mirrored.right.present ? "right" : "left";
    expect(mirrored[mrole as "left"].x).toBeCloseTo(1 - plain[role as "left"].x, 5);
    expect(mirrored.hands[0].landmarks[0].x).toBeCloseTo(1 - plain.hands[0].landmarks[0].x, 5);
    expect(mirrored.hands[0].world?.[0].x).toBeCloseTo(-0.1, 5);
  });

  it("main seule : garde son rôle en traversant le centre", () => {
    const c = core();
    c.update([fakeHand(0.8, 0.5), fakeHand(0.2, 0.5)], 0);
    c.update([fakeHand(0.7, 0.5)], 33); // la gauche disparaît, la droite bouge
    const out = c.update([fakeHand(0.45, 0.5)], 66);
    expect(out.right.present).toBe(1);
    expect(out.right.x).toBeCloseTo(0.45, 1);
  });

  it("hold-ms : valeur gardée puis present 0 sans effacer la dernière valeur", () => {
    const c = core({ holdMs: 100 });
    c.update([fakeHand(0.8, 0.3)], 0);
    expect(c.update([], 50).right.present).toBe(1);
    const gone = c.update([], 200);
    expect(gone.right.present).toBe(0);
    expect(gone.right.x).toBeCloseTo(0.8, 1);
  });

  it("lissage : un saut est amorti, la première valeur est exacte", () => {
    const c = core({ smooth: 0.9 });
    const first = c.update([fakeHand(0.8, 0.5)], 0);
    const x0 = first.right.x;
    const next = c.update([fakeHand(0.9, 0.5)], 33);
    expect(next.right.x).toBeGreaterThan(x0);
    expect(next.right.x).toBeLessThan(x0 + 0.1 - 0.01);
  });

  it("geste et score recopiés", () => {
    const out = core().update([fakeHand(0.8, 0.5, 0.3, { gesture: "Open_Palm", gestureScore: 0.8 })], 0);
    expect(out.right.gesture).toBe("Open_Palm");
    expect(out.right.gestureScore).toBeCloseTo(0.8);
  });

  it("map : clés dérivées, présence conditionnelle", () => {
    const map = compileMap("cents=right.x*3600; gain=left.present ? 1-left.y : 0; play.vol=left.present");
    const c = core({ map });
    const both = c.update([fakeHand(0.25, 0.2), fakeHand(0.75, 0.5)], 0);
    expect(both.cents).toBeCloseTo(both.right.x * 3600, 3);
    expect(both.gain).toBeCloseTo(1 - both.left.y, 5);
    expect((both.play as { vol: number }).vol).toBe(1);
    const c2 = core({ map });
    const right = c2.update([fakeHand(0.75, 0.5)], 0);
    expect(right.gain).toBe(0);
  });
});
