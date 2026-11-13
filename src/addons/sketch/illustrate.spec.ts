import { describe, expect, it } from "vitest";
import { STROKES_DEFAULT, illustrateImage } from "./illustrate";
import { readGestures } from "./gestures";
import { readPainterlyOptions } from "./painterly-element";

/** Image de test : fond sombre dégradé, une sphère claire éclairée de côté, une arête nette. */
function scene(w = 160, h = 120) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let c = [40 + (x / w) * 40, 30 + (y / h) * 20, 60];
    const dx = (x - 70) / 32, dy = (y - 60) / 32, d = dx * dx + dy * dy;
    if (d < 1) {
      const z = Math.sqrt(1 - d), l = Math.max(0, -0.6 * dx - 0.5 * dy + 0.62 * z);
      c = [60 + 190 * l, 50 + 150 * l, 30 + 90 * l];
    }
    if (x > 130) c = [230, 210, 120];
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

describe("illustrateImage (peinture en passes avec les outils)", () => {
  const r = illustrateImage(scene(), { maxSide: 160, seed: 5, detail: 0.7, preview: true });
  const g = readGestures({ width: r.width, height: r.height, strokes: r.strokes })!;

  it("construit l'image en passes nommées, avec glacis en Produit et en Écran", () => {
    const names = r.layers.map((l) => (l as { name?: string }).name);
    for (const n of ["fond", "masses", "ombres", "lumières", "détails", "contours"]) expect(names).toContain(n);
    const blends = new Set(g.strokes.map((s) => s.brush.blend));
    expect(blends.has("multiply")).toBe(true);
    expect(blends.has("screen")).toBe(true);
    // pinceau plat pour les masses (pointe ovale qui suit le geste)
    expect(g.strokes.some((s) => s.brush.angleFollow === true && Number(s.brush.roundness) < 1)).toBe(true);
    expect(r.error).toBeLessThan(0.08);
  });

  it("peu de traits, tous dans le cadre, jeu de gestes lisible", () => {
    expect(r.strokes.length).toBeLessThan(4000);
    expect(g.strokes.length).toBe(r.strokes.length);
    expect(r.strokes[0]).toMatchObject({ reset: true, tool: "paint", pressure: true });
    for (const s of g.strokes) for (let k = 0; k < s.pts.length; k += 3) {
      expect(s.pts[k]).toBeGreaterThanOrEqual(0);
      expect(s.pts[k]).toBeLessThanOrEqual(r.width);
      expect(s.pts[k + 1]).toBeGreaterThanOrEqual(0);
      expect(s.pts[k + 1]).toBeLessThanOrEqual(r.height);
    }
  });

  it("déterministe ; style lu dans les réglages", () => {
    const b = illustrateImage(scene(), { maxSide: 160, seed: 5, detail: 0.7 });
    expect(JSON.stringify(b.strokes)).toBe(JSON.stringify(r.strokes));
    expect(readPainterlyOptions({ style: "huile" }).style).toBe("huile");
    expect(readPainterlyOptions({ style: "aquarelle" }).style).toBeUndefined();
  });
});

describe("illustrateImage, style réaliste (touches posées fondues)", () => {
  const r = illustrateImage(scene(), { maxSide: 160, seed: 5, detail: 0.7, style: "realiste" });
  const g = readGestures({ width: r.width, height: r.height, strokes: r.strokes })!;

  it("surtout des touches posées, ni contours ni pointe texturée, image reconstruite", () => {
    const fond = r.layers[0].strokes;
    // touches posées, sauf quelques touches filées sur la matière fine orientée
    const rest = g.strokes.slice(fond);
    expect(rest.filter((s) => s.pts.length === 3).length / rest.length).toBeGreaterThan(0.8);
    expect(rest.some((s) => s.brush.tip)).toBe(false);
    const names = r.layers.map((l) => (l as { name?: string }).name);
    expect(names).not.toContain("contours");
    expect(names).toContain("ombres");
    expect(r.error).toBeLessThan(0.06);
  });

  it("dureté selon la netteté : des touches douces et des touches nettes ; ovales orientées sur les arêtes", () => {
    const hard = g.strokes.map((s) => Number(s.brush.hardness));
    expect(Math.min(...hard)).toBeLessThan(0.2);
    expect(Math.max(...hard)).toBeGreaterThan(0.5);
    expect(g.strokes.some((s) => Number(s.brush.roundness) < 1 && Number(s.brush.angle) !== 0)).toBe(true);
    expect(readPainterlyOptions({ style: "realiste" }).style).toBe("realiste");
  });

  it("budget de traits toujours tenu, défaut de chaque manière", () => {
    for (const n of [300, 1200]) {
      const b = illustrateImage(scene(), { maxSide: 160, seed: 5, style: "realiste", maxStrokes: n });
      expect(b.strokes.length).toBeLessThanOrEqual(n);
      expect(b.error).toBeLessThan(0.12);
    }
    expect(illustrateImage(scene(), { maxSide: 160, style: "illustration", maxStrokes: 200 }).strokes.length).toBeLessThanOrEqual(200);
    expect(STROKES_DEFAULT.realiste).toBeLessThan(STROKES_DEFAULT.huile);
  });

  it("point focal et ajustement : plus fidèle à budget égal, détails resserrés autour du point donné", () => {
    const base = { maxSide: 160, seed: 5, style: "realiste" as const, maxStrokes: 900 };
    const raw = illustrateImage(scene(), { ...base, optimizeMs: 0 });
    const tuned = illustrateImage(scene(), { ...base, optimizeMs: 400 });
    expect(tuned.error).toBeLessThan(raw.error);
    expect(tuned.layers.some((l) => (l as { name?: string }).name === "ajustement")).toBe(true);
    // détails fins (petites touches) : plus nombreux près du point focal donné (la sphère, à gauche)
    const near = (r: typeof raw) => {
      const g = readGestures({ width: r.width, height: r.height, strokes: r.strokes })!;
      const small = g.strokes.filter((s) => s.pts.length === 3 && Number(s.brush.size) < r.width / 20);
      return small.filter((s) => Math.hypot(s.pts[0] / r.width - 0.44, s.pts[1] / r.height - 0.5) < 0.25).length / Math.max(1, small.length);
    };
    const focused = illustrateImage(scene(), { ...base, optimizeMs: 0, focus: { x: 0.44, y: 0.5, r: 0.2 } });
    expect(near(focused)).toBeGreaterThan(near(raw));
    expect(readPainterlyOptions({ focus: { x: 0.3, y: 2, r: 0.1 } }).focus).toEqual({ x: 0.3, y: 1, r: 0.1 });
    expect(readPainterlyOptions({ focus: "centre" }).focus).toBeUndefined();
  });
});
