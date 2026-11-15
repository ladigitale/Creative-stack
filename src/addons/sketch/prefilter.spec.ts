import { describe, expect, it } from "vitest";
import { autoContrast, bilateral, kuwahara, kuwaharaAniso, median, prepareImage, quantize } from "./prefilter";
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
  it("Kuwahara anisotrope : plages lisses, bord franc, sans marches le long d'un bord oblique", () => {
    const im = edge(), k = kuwaharaAniso(im, 3);
    expect(noise(k, 2, 15)).toBeLessThan(noise(im, 2, 15) * 0.7);
    expect(step(k)).toBeGreaterThan(0.6);
    // Bord oblique : le classique fait des marches (forte variation le long du bord), l'anisotrope moins.
    const diag = make(48, 48, (x, y) => (x + 0.5 * y < 34 ? 0.15 : 0.85));
    const rough = (m: Img) => {
      let s = 0;
      for (let y = 8; y < 40; y++) for (let x = 1; x < 47; x++) { const i = y * 48 + x; s += Math.abs(m.r[i] - m.r[i - 48]) * Math.abs(m.r[i] - m.r[i - 1]); }
      return s;
    };
    expect(rough(kuwaharaAniso(diag, 4))).toBeLessThanOrEqual(rough(kuwahara(diag, 4)) + 1e-6);
  });
  it("tramage : moyenne locale proche du dégradé d'origine, là où les aplats font des marches", () => {
    const grad = make(64, 16, (x) => x / 63);
    const flat = quantize(grad, 3), dith = quantize(grad, 3, true);
    const errMean = (q: Img) => {
      let e = 0;
      for (let x = 4; x < 60; x += 4) { let a = 0, b = 0; for (let y = 0; y < 16; y++) for (let dx = 0; dx < 4; dx++) { a += q.r[y * 64 + x + dx]; b += grad.r[y * 64 + x + dx]; } e += Math.abs(a - b) / 64; }
      return e;
    };
    expect(errMean(dith)).toBeLessThan(errMean(flat) * 0.6);
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
    expect(prepareImage(im, { prepare: "kuwahara-aniso" })).not.toBe(im);
    expect(prepareImage(im, { style: "realiste", prepare: "bilateral" })).not.toBe(im);
  });
  it("trame-aniso : la trame est fondue (pas de pixels isolés), le bord reste franc", () => {
    const grad = make(60, 40, (x) => (x < 30 ? 0.2 + 0.3 * (x / 29) : 0.85));
    const t = prepareImage(grad, { prepare: "trame-aniso", prepareForce: 0.5 });
    let iso = 0;
    for (let y = 5; y < 35; y++) for (let x = 3; x < 26; x++) {
      const i = y * 60 + x, v = t.r[i];
      if (Math.abs(v - t.r[i - 1]) > 0.08 && Math.abs(v - t.r[i + 1]) > 0.08) iso++;
    }
    expect(iso).toBeLessThan(10);
    expect(t.r[20 * 60 + 34] - t.r[20 * 60 + 25]).toBeGreaterThan(0.25);
  });
});
