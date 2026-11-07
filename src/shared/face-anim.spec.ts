import { describe, expect, it } from "vitest";
import { autoBlink, lidRects, measureFace, mouthRects } from "./face-anim";
import type { Joints } from "./puppet";

const W = 400;
const H = 300;
const j = (x: number, y: number, v = 1) => ({ x: x / W, y: y / H, v });

const FACE: Joints = {
  leftEyeOuter: j(176, 100),
  leftEye: j(184, 100),
  leftEyeInner: j(192, 100),
  rightEyeInner: j(208, 100),
  rightEye: j(216, 100),
  rightEyeOuter: j(224, 100),
  mouthLeft: j(190, 140),
  mouthRight: j(210, 140),
};

describe("measureFace", () => {
  it("yeux et bouche en pixels, largeur d'œil bornée par l'écart entre les yeux", () => {
    const f = measureFace(FACE, W, H)!;
    expect(f.eyes).toHaveLength(2);
    expect(f.eyes[0].cx).toBeCloseTo(184, 5);
    expect(f.eyes[0].cy).toBeCloseTo(100, 5);
    // coins à 16 px × 1,15 = 18,4 ; écart entre les yeux 32 : borné à [10,24 ; 19,2]
    expect(f.eyes[0].w).toBeCloseTo(18.4, 3);
    expect(f.eyes[0].angle).toBeCloseTo(0, 5);
    expect(f.mouth!.cx).toBeCloseTo(200, 5);
    expect(f.mouth!.w).toBeCloseTo(20, 5);
  });

  it("tête penchée : l'angle suit la ligne des yeux, quel que soit l'ordre gauche / droite", () => {
    const tilted: Joints = { ...FACE, leftEye: j(184, 100), rightEye: j(216, 116) };
    const f = measureFace(tilted, W, H)!;
    expect(f.eyes[0].angle).toBeCloseTo(Math.atan2(16, 32), 5);
    const swapped: Joints = { ...FACE, leftEye: j(216, 116), rightEye: j(184, 100) };
    expect(measureFace(swapped, W, H)!.eyes[0].angle).toBeCloseTo(Math.atan2(16, 32), 5);
  });

  it("points peu visibles ignorés ; rien de mesurable : null", () => {
    const f = measureFace({ ...FACE, rightEye: j(216, 100, 0.1) }, W, H)!;
    expect(f.eyes).toHaveLength(1);
    expect(measureFace({}, W, H)).toBeNull();
  });
});

describe("paupière et bouche", () => {
  it("la paupière part du haut de l'œil et descend jusqu'à le couvrir", () => {
    const open = lidRects(20, 0);
    const closed = lidRects(20, 1);
    expect(open.dst).toEqual(open.src); // ouvert : rien ne bouge
    const h = 20 * 0.55;
    expect(closed.dst[1] + closed.dst[3]).toBeCloseTo(0.5 * h, 5); // bord sous le centre de l'œil
    expect(closed.dst[3]).toBeGreaterThan(open.dst[3]);
    expect(lidRects(20, 2).dst).toEqual(closed.dst); // borné
  });

  it("bouche : ouverture proportionnelle, nulle à 0", () => {
    expect(mouthRects(20, 0).gap).toBe(0);
    expect(mouthRects(20, 1).gap).toBeCloseTo(6.4, 5);
    expect(mouthRects(20, 0.5).gap).toBeCloseTo(3.2, 5);
  });
});

describe("autoBlink", () => {
  it("ouvert la plupart du temps, des clignements courts réguliers, reproductibles", () => {
    let closedMs = 0;
    let blinks = 0;
    let prev = 0;
    for (let t = 0; t < 60000; t += 10) {
      const v = autoBlink(t, 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      if (v > 0.5) closedMs += 10;
      if (v > 0.5 && prev <= 0.5) blinks++;
      prev = v;
    }
    expect(blinks).toBeGreaterThanOrEqual(10); // 2,5 à 5,5 s : 11 à 24 en une minute
    expect(blinks).toBeLessThanOrEqual(30);
    expect(closedMs).toBeLessThan(6000);
    expect(autoBlink(12345, 3)).toBe(autoBlink(12345, 3));
  });
});
