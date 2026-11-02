import type { Point, RawHand } from "../../shared/ml/hands";

/** Main synthétique : poignet en (cx, cy+0,25), bases des doigts à cy, bouts à cy - reach. Pour les tests uniquement. */
export function fakeHand(cx: number, cy: number, reach = 0.3, extra: Partial<RawHand> = {}): RawHand {
  const lm: Point[] = Array.from({ length: 21 }, () => ({ x: cx, y: cy, z: 0 }));
  lm[0] = { x: cx, y: cy + 0.25, z: 0 };
  [5, 9, 13, 17].forEach((b, i) => {
    const x = cx + (i - 1) * 0.04;
    lm[b] = { x, y: cy, z: 0 };
    lm[[8, 12, 16, 20][i]] = { x, y: cy - reach, z: 0 };
  });
  lm[4] = { x: cx - 0.18, y: cy, z: 0 };
  return { landmarks: lm, score: 0.9, ...extra };
}
