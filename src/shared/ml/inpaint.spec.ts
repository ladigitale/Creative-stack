import { describe, expect, it } from "vitest";
import { dilateHoles, fillHoles, holesFromMask } from "./inpaint";

const img = (w: number, h: number, f: (x: number, y: number) => [number, number, number]) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      d.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return d;
};

describe("fillHoles", () => {
  it("un trou dans une couleur unie prend cette couleur", () => {
    const w = 16;
    const h = 12;
    const d = img(w, h, () => [200, 100, 50]);
    const hole = new Uint8Array(w * h);
    for (let y = 4; y < 9; y++) for (let x = 5; x < 11; x++) hole[y * w + x] = 1;
    for (const i of hole.keys()) if (hole[i]) d.set([0, 0, 0, 0], i * 4); // contenu du trou : ignoré
    const filled = fillHoles(d, hole, w, h);
    expect(filled).toBe(30);
    for (const i of hole.keys()) if (hole[i]) expect([d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]]).toEqual([200, 100, 50, 255]);
  });

  it("les pixels connus ne changent pas ; un dégradé est prolongé entre ses bords", () => {
    const w = 20;
    const h = 4;
    const d = img(w, h, (x) => [x * 10, 0, 0]); // 0 → 190
    const hole = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 8; x < 12; x++) hole[y * w + x] = 1;
    const before = Uint8ClampedArray.from(d);
    fillHoles(d, hole, w, h);
    for (let i = 0; i < w * h; i++) if (!hole[i]) expect(d[i * 4]).toBe(before[i * 4]);
    // les valeurs remplies restent entre les voisins connus (70 à gauche, 120 à droite) et se rangent dans l'ordre
    const row = [8, 9, 10, 11].map((x) => d[x * 4]);
    for (const v of row) {
      expect(v).toBeGreaterThanOrEqual(60);
      expect(v).toBeLessThanOrEqual(130);
    }
    expect(row[0]).toBeLessThanOrEqual(row[3]);
  });

  it("rien de connu ou rien à remplir : 0 et image inchangée", () => {
    const d = img(4, 4, () => [1, 2, 3]);
    const all = new Uint8Array(16).fill(1);
    expect(fillHoles(d, all, 4, 4)).toBe(0);
    expect(fillHoles(d, new Uint8Array(16), 4, 4)).toBe(0);
    expect([d[0], d[1], d[2]]).toEqual([1, 2, 3]);
  });

  it("dimensions incohérentes : ignoré", () => {
    expect(fillHoles(new Uint8ClampedArray(4), new Uint8Array(1), 4, 4)).toBe(0);
  });
});

describe("holesFromMask", () => {
  it("alpha du masque → trous, avec inversion", () => {
    const m = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 200]);
    expect(Array.from(holesFromMask(m, 4, 1))).toEqual([1, 0, 0, 1]);
    expect(Array.from(holesFromMask(m, 4, 1, true))).toEqual([0, 1, 1, 0]);
  });
});

describe("dilateHoles", () => {
  it("agrandit d'un pixel dans toutes les directions, sans déborder de l'image", () => {
    const hole = new Uint8Array(25);
    hole[2 * 5 + 2] = 1;
    const d = dilateHoles(hole, 5, 5);
    expect(d.reduce((a, b) => a + b, 0)).toBe(9);
    const edge = new Uint8Array(25);
    edge[0] = 1;
    expect(dilateHoles(edge, 5, 5).reduce((a, b) => a + b, 0)).toBe(4);
  });
});
