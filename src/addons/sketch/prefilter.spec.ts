import { describe, expect, it } from "vitest";
import { autoContrast, bilateral, kuwahara, median, prepareImage, quantize } from "./prefilter";
import { rng, type Img } from "./painterly";

const make = (w: number, h: number, f: (x: number, y: number) => number): Img => {
  const r = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) r[y * w + x] = f(x, y);
  return { w, h, r, g: r.slice(), b: r.slice() };
};
/** Bord vertical net (noir | blanc) avec du bruit et un point isolé. */
const edge = () => {
  const rand = rng(3);
  const im = make(40, 40, (x) => (x < 20 ? 0.1 : 0.9) + (rand() - 0.5) * 0.12);
  im.r[10 * 40 + 8] = im.g[10 * 40 + 8] = im.b[10 * 40 + 8] = 1; // point isolé dans la zone sombre
  return im;
};
const noise = (im: Img, x0: number, x1: number) => {
  let s = 0, s2 = 0, n = 0;
  for (let y = 15; y < 35; y++) for (let x = x0; x < x1; x++) { const v = im.r[y * im.w + x]; s += v; s2 += v * v; n++; }
  return Math.sqrt(s2 / n - (s / n) ** 2);
};
const step = (im: Img) => im.r[20 * im.w + 21] - im.r[20 * im.w + 18];

describe("prefilter", () => {
  it("médian : efface le point isolé, garde le bord", () => {
    const m = median(edge(), 1);
    expect(m.r[10 * 40 + 8]).toBeLessThan(0.3);
    expect(step(m)).toBeGreaterThan(0.6);
  });
  it("bilatéral : réduit le bruit sans adoucir le bord", () => {
    const im = edge(), b = bilateral(im, 3, 0.15);
    expect(noise(b, 2, 15)).toBeLessThan(noise(im, 2, 15) * 0.6);
    expect(step(b)).toBeGreaterThan(0.6);
  });
  it("Kuwahara : plages lisses, bord franc", () => {
    const im = edge(), k = kuwahara(im, 3);
    expect(noise(k, 2, 15)).toBeLessThan(noise(im, 2, 15) * 0.7);
    expect(step(k)).toBeGreaterThan(0.6);
  });
  it("aplats : palette réduite", () => {
    const q = quantize(make(30, 30, (x, y) => (x + y) / 58), 4);
    expect(new Set(Array.from(q.r, (v) => v.toFixed(4))).size).toBeLessThanOrEqual(4);
  });
  it("contraste automatique : étire une image terne, laisse une image contrastée", () => {
    const dull = make(20, 20, (x) => 0.4 + 0.2 * (x / 19));
    const c = autoContrast(dull);
    expect(Math.min(...c.r)).toBeLessThan(0.05);
    expect(Math.max(...c.r)).toBeGreaterThan(0.95);
    const full = make(20, 20, (x) => x / 19);
    expect(autoContrast(full)).toBe(full);
  });
  it("auto selon le style ; aucun = image inchangée", () => {
    const im = edge();
    expect(prepareImage(im, { prepare: "aucun" })).toBe(im);
    expect(prepareImage(im, { style: "huile" })).toBe(im);
    expect(prepareImage(im, { style: "realiste" })).toBe(im);
    expect(prepareImage(im, { style: "illustration" })).not.toBe(im);
    expect(prepareImage(im, { style: "realiste", prepare: "bilateral" })).not.toBe(im);
  });
});
