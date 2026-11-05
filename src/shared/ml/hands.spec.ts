import { describe, expect, it } from "vitest";
import { jointedHand } from "../../addons/vision/test-hands";
import { FINGER_NAMES, assignRoles, countFingers, fineMetrics, fingerExtension, metricsOf, mirrorPoints, openness, palmCenter, pinch, roll, type Point } from "./hands";

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


describe("doigts", () => {
  const all = (v: number) => ({ thumb: v, index: v, middle: v, ring: v, pinky: v });

  it("main ouverte : tous les doigts ≈ 1 ; poing : tous ≈ 0", () => {
    const open = fineMetrics(jointedHand(all(0)));
    const fist = fineMetrics(jointedHand(all(1)));
    for (const f of FINGER_NAMES) {
      expect(open[f]).toBeGreaterThan(0.9);
      expect(fist[f]).toBeLessThan(0.15);
    }
  });

  it("un doigt replié ne change que lui", () => {
    const m = fineMetrics(jointedHand({ middle: 1 }));
    expect(m.middle).toBeLessThan(0.15);
    for (const f of ["thumb", "index", "ring", "pinky"] as const) expect(m[f]).toBeGreaterThan(0.9);
  });

  it("l'extension croît avec le dépliement", () => {
    const vals = [1, 0.7, 0.4, 0].map((c) => fingerExtension(jointedHand({ index: c }), "index"));
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1]);
  });

  it("indépendante de la position et de l'échelle de la main", () => {
    const base = jointedHand({ ring: 0.8 });
    const moved = base.map((p) => ({ x: p.x * 0.5 + 0.2, y: p.y * 0.5 + 0.1, z: p.z }));
    expect(fingerExtension(moved, "ring")).toBeCloseTo(fingerExtension(base, "ring"), 3);
  });

  it("countFingers : chiffres montrés", () => {
    expect(countFingers(fineMetrics(jointedHand(all(0))))).toBe(5);
    expect(countFingers(fineMetrics(jointedHand(all(1))))).toBe(0);
    // 2 : index et majeur tendus
    expect(countFingers(fineMetrics(jointedHand({ thumb: 1, ring: 1, pinky: 1 })))).toBe(2);
    // 3 : index, majeur, annulaire
    expect(countFingers(fineMetrics(jointedHand({ thumb: 1, pinky: 1 })))).toBe(3);
  });

  it("écartement : doigts serrés < doigts écartés", () => {
    expect(fineMetrics(jointedHand(all(0), 0.04)).spread).toBeLessThan(fineMetrics(jointedHand(all(0), 0.12)).spread);
  });

  it("pince pouce–majeur : bouts qui se touchent ≈ 1, sinon 0", () => {
    const h = jointedHand(all(0));
    h[4] = { x: h[12].x + 0.003, y: h[12].y + 0.003, z: 0 };
    const m = fineMetrics(h);
    expect(m.pinchMiddle).toBeGreaterThan(0.9);
    expect(m.pinchPinky).toBeLessThan(m.pinchMiddle);
  });

  it("utilise les points en mètres quand ils existent", () => {
    const lm = jointedHand({ index: 1 });
    // image écrasée à l'horizontale : les angles image sont faussés, ceux du monde non
    const squashed = lm.map((p) => ({ x: 0.5 + (p.x - 0.5) * 0.2, y: p.y, z: p.z }));
    const viaWorld = fineMetrics(squashed, lm);
    expect(viaWorld.index).toBeLessThan(0.15);
  });
});
