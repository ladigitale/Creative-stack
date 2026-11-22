import { describe, expect, it } from "vitest";
import { inkField, marchingSquares, otsu, smoothPath, traceLineArt } from "./lineart";
import { trace } from "./trace";
import { signedArea } from "../vector/geometry";

/** Image en niveaux de gris → RGBA. */
function img(w: number, h: number, f: (x: number, y: number) => number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = f(x, y), i = (y * w + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

describe("tracé au trait", () => {
  it("Otsu sépare deux populations", () => {
    const hist = new Array(256).fill(0);
    hist[30] = 500; hist[220] = 1500;
    const t = otsu(hist);
    expect(t).toBeGreaterThanOrEqual(30);
    expect(t).toBeLessThan(220);
  });

  it("un carré d'encre : un contour extérieur (aire signée négative), au bord réel à moins d'un demi-pixel", () => {
    const im = img(40, 40, (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 30 ? 0 : 255));
    const lum = new Float32Array(40 * 40).map((_, i) => im.data[i * 4]);
    const rings = marchingSquares(inkField(lum, 40, 40, { threshold: 128, adaptive: 0, sensitivity: 0 }).field, 40, 40);
    expect(rings).toHaveLength(1);
    expect(signedArea(rings[0])).toBeLessThan(0);
    expect(Math.abs(Math.abs(signedArea(rings[0])) - 400)).toBeLessThan(25);
  });

  it("un anneau : contour et trou de sens opposés, trous minuscules bouchés, taches retirées", () => {
    const im = img(60, 60, (x, y) => {
      const r = Math.hypot(x - 30, y - 30);
      if (r < 20 && r > 10) return 0;
      if (x === 3 && y === 3) return 0; // tache d'un pixel
      return 255;
    });
    const res = traceLineArt(im, { minArea: 6, minHole: 4, blur: 0.6, threshold: 128 });
    expect(res.rings).toBe(2);
    expect(res.d.match(/M/g)).toHaveLength(2);
    expect(res.area).toBeGreaterThan(Math.PI * (19 ** 2 - 11 ** 2));
    expect(res.area).toBeLessThan(Math.PI * (21 ** 2 - 9 ** 2));
  });

  it("seuil local : un trait sur un papier dégradé (ombre) sort seul, là où le seuil global prend l'ombre", () => {
    // Papier de 240 (gauche) à 90 (droite), trait vertical à 50 % plus sombre que le papier local.
    const im = img(120, 60, (x) => {
      const paper = 240 - (150 * x) / 119;
      return x >= 58 && x < 62 ? paper * 0.4 : paper;
    });
    const global = traceLineArt(im, { blur: 0.8 });
    const local = traceLineArt(im, { blur: 0.8, adaptive: 12, sensitivity: 20 });
    expect(local.rings).toBe(1);
    expect(local.area).toBeLessThan(60 * 6);
    expect(global.area).toBeGreaterThan(local.area * 3);
  });

  it("courbes : cercle lissé en cubiques, coins vifs d'un carré gardés en droites", () => {
    const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(smoothPath(sq, 55)).toBe("M0 0L10 0L10 10L0 10L0 0Z");
    const circle = Array.from({ length: 24 }, (_, i) => [Math.cos((i / 24) * Math.PI * 2) * 10, Math.sin((i / 24) * Math.PI * 2) * 10] as [number, number]);
    expect(smoothPath(circle, 55)).toMatch(/^M[^L]*Z$/);
  });

  it("trace() en mode lineart : une couche d'encre à la couleur demandée", () => {
    const im = img(50, 50, (x, y) => (Math.hypot(x - 25, y - 25) < 12 ? 20 : 250));
    const r = trace(im, { mode: "lineart", curves: true, lineart: { ink: "#e11d48" } });
    expect(r.layers).toHaveLength(1);
    expect(r.layers[0].color).toBe("#e11d48");
    expect(r.layers[0].d).toContain("C");
    expect(r.palette).toEqual(["#e11d48", "#ffffff"]);
  });

  it("ignore ce qui touche le bord de l'image (table, ombre autour de la feuille)", () => {
    const im = img(60, 60, (x, y) => (x < 6 || Math.hypot(x - 35, y - 30) < 10 ? 10 : 245));
    expect(traceLineArt(im, { threshold: 128 }).rings).toBe(2);
    expect(traceLineArt(im, { threshold: 128, clearBorder: true }).rings).toBe(1);
  });
});
