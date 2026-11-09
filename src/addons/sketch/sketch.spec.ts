import { describe, expect, it } from "vitest";
import { Doc, clampZoom, contentBBox, fitView, panBy, sanitizeView, strokeBBox, strokeHit, toScreen, toWorld, zoomAt, MAX_ZOOM, MIN_ZOOM, type Stroke } from "./model";
import { stampsOf } from "./stamps";
import { exportSvg } from "./export";
import { BRUSH_DEFAULTS } from "../paint/brush";
import { makeBrush } from "./model";
import { transformAt } from "../../shared/view2d";

const brush = (size = 10, extra: Record<string, unknown> = {}) => ({ ...makeBrush({ ...BRUSH_DEFAULTS, hardness: 1, pressure: false }, size), ...extra }) as ReturnType<typeof makeBrush>;
let id = 0;
const stroke = (pts: number[][], b = brush()): Stroke => {
  const flat = pts.flatMap(([x, y, p = 1]) => [x, y, p]);
  return { id: ++id, brush: b, pts: flat, seed: 7, bbox: strokeBBox(flat, b.size / 2) };
};

describe("vue", () => {
  it("écran ↔ monde est une bijection", () => {
    const v = { x: 12, y: -3, zoom: 7.5, rotation: 0.7 };
    const [wx, wy] = toWorld(v, 120, 80, 400, 300);
    const [sx, sy] = toScreen(v, wx, wy, 400, 300);
    expect(sx).toBeCloseTo(120);
    expect(sy).toBeCloseTo(80);
  });
  it("le zoom garde fixe le point sous le curseur, même très profond", () => {
    let v = { x: 0, y: 0, zoom: 1, rotation: -0.4 };
    const before = toWorld(v, 100, 60, 400, 300);
    for (let i = 0; i < 20; i++) v = zoomAt(v, 4, 100, 60, 400, 300);
    expect(v.zoom).toBe(MAX_ZOOM);
    const [wx, wy] = toWorld(v, 100, 60, 400, 300);
    expect(wx).toBeCloseTo(before[0], 6);
    expect(wy).toBeCloseTo(before[1], 6);
  });
  it("borne le zoom et ignore les valeurs invalides", () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(1e99)).toBe(MAX_ZOOM);
    expect(clampZoom(NaN)).toBe(1);
    expect(sanitizeView({ x: "3", y: null, zoom: "abc", rotation: 7 }, { x: 1, y: 2, zoom: 5, rotation: 0 })).toEqual({ x: 3, y: 2, zoom: 5, rotation: expect.closeTo(7 - 2 * Math.PI, 9) });
  });
  it("le déplacement suit les pixels", () => {
    const v = panBy({ x: 0, y: 0, zoom: 4, rotation: 0 }, 40, -8);
    expect(v.x).toBe(-10);
    expect(v.y).toBe(2);
  });
  it("cadre le contenu", () => {
    const v = fitView({ x: 0, y: 0, w: 100, h: 50 }, 400, 300, 0);
    expect(v).toEqual({ x: 50, y: 25, zoom: 4, rotation: 0 });
    expect(fitView(null, 400, 300)).toEqual({ x: 0, y: 0, zoom: 1, rotation: 0 });
    // Tournée d'un quart de tour, la boîte 100 × 50 devient 50 × 100 à l'écran.
    expect(fitView({ x: 0, y: 0, w: 100, h: 50 }, 400, 300, 0, Math.PI / 2).zoom).toBeCloseTo(3);
  });
  it("tourner et zoomer à deux doigts garde le point sous les doigts", () => {
    const v = { x: 30, y: 40, zoom: 2, rotation: 0.3 };
    const before = toWorld(v, 250, 90, 400, 300);
    const t = transformAt(v, 1.7, 0.9, 250, 90, 400, 300, MIN_ZOOM, MAX_ZOOM);
    const [sx, sy] = toScreen(t, before[0], before[1], 400, 300);
    expect(sx).toBeCloseTo(250, 6);
    expect(sy).toBeCloseTo(90, 6);
    expect(t.rotation).toBeCloseTo(1.2);
  });
});

describe("Doc", () => {
  it("annule et rétablit ajouts, suppressions et effacement", () => {
    const d = new Doc();
    const a = stroke([[0, 0], [10, 0]]), b = stroke([[0, 5], [10, 5]]), c = stroke([[0, 9], [10, 9]]);
    d.add(a); d.add(b); d.add(c);
    expect(d.remove(new Set([a.id, c.id]))).toBe(2);
    expect(d.strokes).toEqual([b]);
    d.undo();
    expect(d.strokes).toEqual([a, b, c]);
    d.redo();
    expect(d.strokes).toEqual([b]);
    d.clear();
    expect(d.strokes).toEqual([]);
    d.undo();
    expect(d.strokes).toEqual([b]);
    d.undo(); d.undo(); d.undo(); d.undo();
    expect(d.strokes).toEqual([]);
    expect(d.canUndo).toBe(false);
    expect(d.canRedo).toBe(true);
  });
  it("une nouvelle action efface l'avenir et l'historique est borné", () => {
    const d = new Doc(3);
    for (let i = 0; i < 5; i++) d.add(stroke([[i, 0]]));
    d.undo(); d.undo();
    d.add(stroke([[9, 9]]));
    expect(d.canRedo).toBe(false);
    let n = 0;
    while (d.undo()) n++;
    expect(n).toBe(2);
  });
  it("refuse au-delà des limites", () => {
    const d = new Doc();
    expect(d.add({ ...stroke([[0, 0]]), pts: new Array(3 * 2_000_001).fill(0) })).toBe(false);
  });
});

describe("hit-test et boîtes", () => {
  it("touche un trait selon son épaisseur", () => {
    const s = stroke([[0, 0], [100, 0]], brush(10));
    expect(strokeHit(s, 50, 4, 0)).toBe(true);
    expect(strokeHit(s, 50, 8, 0)).toBe(false);
    expect(strokeHit(s, 50, 8, 4)).toBe(true);
    expect(strokeHit(stroke([[5, 5]], brush(10)), 8, 5, 0)).toBe(true);
  });
  it("boîte du contenu", () => {
    expect(contentBBox([])).toBeNull();
    const b = contentBBox([stroke([[0, 0], [10, 0]]), stroke([[0, 20]])])!;
    expect(b.x).toBe(-5);
    expect(b.h).toBe(30);
  });
});

describe("empreintes", () => {
  it("sont déterministes", () => {
    const b = brush(10, { sizeJitter: 0.5, scatter: 0.5, angleJitter: 30 });
    const pts = [0, 0, 1, 50, 20, 1, 90, 5, 1];
    expect(stampsOf(b, 3, pts)).toEqual(stampsOf(b, 3, pts));
    expect(stampsOf(b, 3, pts)).not.toEqual(stampsOf(b, 4, pts));
  });
  it("fonctionnent à toute échelle du monde (sans plancher en pixels)", () => {
    for (const k of [1e-6, 1, 1e6]) {
      const b = brush(10 * k);
      const st = stampsOf(b, 1, [0, 0, 1, 100 * k, 0, 1]);
      expect(st.length).toBeGreaterThan(40);
      expect(st.length).toBeLessThan(200);
      expect(st[0].size).toBeCloseTo(10 * k, 6 - Math.log10(Math.max(1, 1 / k)) + 6);
    }
  });
});

describe("export SVG", () => {
  it("trait net opaque : un tracé", () => {
    const svg = exportSvg([stroke([[0, 0], [50, 10], [100, 0]])]);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="/);
    expect((svg.match(/<path /g) ?? []).length).toBe(1);
    expect(svg).toContain('stroke-linecap="round"');
  });
  it("pointe personnalisée : un seul chemin partagé et des <use>", () => {
    const tip = "M0 0L10 0L5 9Z";
    const svg = exportSvg([stroke([[0, 0], [100, 0]], brush(10, { tip, spacing: 0.5 })), stroke([[0, 20], [100, 20]], brush(10, { tip, spacing: 0.5 }))]);
    expect((svg.match(/<path id=/g) ?? []).length).toBe(1);
    expect((svg.match(/<use /g) ?? []).length).toBeGreaterThan(20);
    expect(svg).toContain("transform=");
  });
  it("disque doux : dégradé partagé", () => {
    const svg = exportSvg([stroke([[0, 0], [60, 0]], brush(10, { hardness: 0.3 }))]);
    expect((svg.match(/<radialGradient/g) ?? []).length).toBe(1);
    expect(svg).toContain("url(#g1)");
  });
  it("fond, vide et plafond d'empreintes", () => {
    expect(exportSvg([], { background: "#fff" })).toContain("<rect");
    expect(exportSvg([])).toContain("<svg");
    const soft = stroke([[0, 0], [1000, 0]], brush(10, { hardness: 0.5 }));
    expect(() => exportSvg([soft], { maxStamps: 10 })).toThrow(/trop d'empreintes/);
  });
});
