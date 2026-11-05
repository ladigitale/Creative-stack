import { describe, expect, it } from "vitest";
import {
  COLOR_POINTS,
  FACE_OVAL,
  FACE_VERTEX_COUNT,
  blendGain,
  colorGain,
  featherWeights,
  fillPositions,
  fillUvCanonical,
  fillUvFromLandmarks,
  sampleMean,
  swapPartner,
  validLandmarks,
} from "./face-mesh";
import { FACE_TRIANGLES, FACE_UV } from "./face-mesh-data";

const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ x: (i % 20) / 20, y: Math.floor(i / 20) / 25, z: 0 }));

describe("données du maillage canonique", () => {
  it("468 points UV dans 0..1 et 880 triangles bien indexés", () => {
    expect(FACE_UV.length).toBe(FACE_VERTEX_COUNT * 2);
    expect(FACE_TRIANGLES.length).toBe(880 * 3);
    expect(Math.max(...FACE_TRIANGLES)).toBe(FACE_VERTEX_COUNT - 1);
    expect(Math.min(...FACE_UV)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...FACE_UV)).toBeLessThanOrEqual(1);
  });

  it("chaque point du maillage est utilisé par au moins un triangle", () => {
    const used = new Set(FACE_TRIANGLES);
    expect(used.size).toBe(FACE_VERTEX_COUNT);
  });

  it("points de référence cohérents : nez au centre, menton en bas, front en haut", () => {
    const uv = (i: number) => ({ x: FACE_UV[i * 2], y: FACE_UV[i * 2 + 1] });
    expect(uv(1).x).toBeCloseTo(0.5, 1);
    expect(uv(152).y).toBeGreaterThan(uv(1).y);
    expect(uv(10).y).toBeLessThan(uv(1).y);
    expect(uv(234).x).toBeLessThan(uv(454).x);
  });
});

describe("featherWeights", () => {
  it("0 sur le contour, 1 au cœur, entre 0 et 1 partout", () => {
    const w = featherWeights(6);
    for (const v of FACE_OVAL) expect(w[v]).toBe(0);
    expect(w[1]).toBe(1);
    for (const x of w) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
  });

  it("plus d'anneaux = fondu plus large (somme des poids plus faible)", () => {
    const sum = (a: Float32Array) => a.reduce((s, v) => s + v, 0);
    expect(sum(featherWeights(12))).toBeLessThan(sum(featherWeights(3)));
  });

  it("résultat mis en cache", () => {
    expect(featherWeights(5)).toBe(featherWeights(5));
  });
});

describe("tampons de sommets", () => {
  it("positions en espace de découpe, y vers le haut", () => {
    const lm = pts(FACE_VERTEX_COUNT);
    lm[1] = { x: 0.25, y: 0.75, z: 0 };
    const out = new Float32Array(FACE_VERTEX_COUNT * 2);
    fillPositions(out, lm);
    expect(out[2]).toBeCloseTo(-0.5);
    expect(out[3]).toBeCloseTo(-0.5);
  });

  it("UV d'un autre visage, avec ou sans retournement horizontal", () => {
    const lm = pts(FACE_VERTEX_COUNT);
    lm[5] = { x: 0.3, y: 0.6, z: 0 };
    const a = new Float32Array(FACE_VERTEX_COUNT * 2);
    fillUvFromLandmarks(a, lm, false);
    expect([a[10], a[11]]).toEqual([expect.closeTo(0.3), expect.closeTo(0.6)]);
    fillUvFromLandmarks(a, lm, true);
    expect(a[10]).toBeCloseTo(0.7);
    expect(a[11]).toBeCloseTo(0.6);
  });

  it("UV canoniques copiés tels quels", () => {
    const a = new Float32Array(FACE_VERTEX_COUNT * 2);
    fillUvCanonical(a);
    expect(a[2]).toBe(FACE_UV[2]);
    expect(a[FACE_VERTEX_COUNT * 2 - 1]).toBe(FACE_UV[FACE_VERTEX_COUNT * 2 - 1]);
  });

  it("validLandmarks exige 468 points finis", () => {
    expect(validLandmarks(pts(468))).toBe(true);
    expect(validLandmarks(pts(478))).toBe(true);
    expect(validLandmarks(pts(21))).toBe(false);
    expect(validLandmarks(null)).toBe(false);
    expect(validLandmarks([{ x: NaN, y: 0 }, ...pts(500)])).toBe(false);
  });
});

describe("couleurs", () => {
  const img = (w: number, h: number, rgb: [number, number, number]) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) d.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
    return d;
  };

  it("moyenne autour des points, bords gérés", () => {
    const d = img(10, 10, [255, 128, 0]);
    const m = sampleMean(d, 10, 10, [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 0.5 }]);
    expect(m![0]).toBeCloseTo(1);
    expect(m![1]).toBeCloseTo(128 / 255, 2);
    expect(m![2]).toBe(0);
  });

  it("null sans pixels valides ou tampon trop court", () => {
    expect(sampleMean(new Uint8ClampedArray(4), 10, 10, [{ x: 0.5, y: 0.5 }])).toBeNull();
    expect(sampleMean(img(2, 2, [1, 2, 3]), 2, 2, [{ x: NaN, y: 0 }])).toBeNull();
  });

  it("gain : neutre sans mesure, borné, proportionnel à la force", () => {
    expect(colorGain(null, [0.5, 0.5, 0.5], 1)).toEqual([1, 1, 1]);
    const full = colorGain([0.2, 0.4, 0.4], [0.4, 0.4, 0.2], 1);
    expect(full[0]).toBeGreaterThan(1);
    expect(full[1]).toBeCloseTo(1);
    expect(full[2]).toBeLessThan(1);
    const half = colorGain([0.2, 0.4, 0.4], [0.4, 0.4, 0.2], 0.5);
    expect(half[0] - 1).toBeCloseTo((full[0] - 1) / 2);
    expect(colorGain([0, 0, 0], [1, 1, 1], 1)[0]).toBe(2);
    expect(colorGain([1, 1, 1], [0, 0, 0], 1)[0]).toBe(0.5);
    expect(colorGain([0.2, 0.2, 0.2], [0.9, 0.9, 0.9], 0)).toEqual([1, 1, 1]);
  });

  it("lissage des gains", () => {
    expect(blendGain([1, 1, 1], [2, 0, 1], 0.5)).toEqual([1.5, 0.5, 1]);
    expect(blendGain([1, 1, 1], [2, 2, 2], 0)).toEqual([1, 1, 1]);
    expect(blendGain([1, 1, 1], [2, 2, 2], 5)).toEqual([2, 2, 2]);
  });

  it("points de mesure valides", () => {
    for (const k of COLOR_POINTS) expect(k).toBeLessThan(FACE_VERTEX_COUNT);
  });
});

describe("swapPartner", () => {
  it("échange 0↔1, rien sans partenaire", () => {
    expect(swapPartner(0, 2)).toBe(1);
    expect(swapPartner(1, 2)).toBe(0);
    expect(swapPartner(0, 1)).toBe(-1);
    expect(swapPartner(2, 3)).toBe(-1);
    expect(swapPartner(0, 0)).toBe(-1);
  });
});
