import { describe, expect, it } from "vitest";
import { Doc, BLEND_MODES, compactStroke, sanitizeBlend, clampZoom, contentBBox, fitView, panBy, sanitizeView, strokeBBox, strokeHit, toScreen, toWorld, zoomAt, MAX_ZOOM, MIN_ZOOM, type Stroke } from "./model";
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

describe("modes de fusion", () => {
  it("n'acceptent que les modes connus", () => {
    expect(sanitizeBlend("Multiply")).toBe("multiply");
    expect(sanitizeBlend(" screen ")).toBe("screen");
    expect(sanitizeBlend("source-over")).toBe("normal");
    expect(sanitizeBlend("x;y", "overlay")).toBe("overlay");
    expect(sanitizeBlend(42)).toBe("normal");
    expect(BLEND_MODES).toContain("luminosity");
  });
  it("le pinceau ne mémorise le mode que s'il n'est pas normal", () => {
    expect(makeBrush({ ...BRUSH_DEFAULTS }, 4).blend).toBeUndefined();
    expect(makeBrush({ ...BRUSH_DEFAULTS }, 4, "multiply").blend).toBe("multiply");
  });
  it("export SVG : chaque trait fusionné est un groupe mix-blend-mode", () => {
    const a = stroke([[0, 0], [100, 0]], brush(10, { blend: "multiply" }));
    const b = stroke([[0, 20], [100, 20]], brush(10, { hardness: 0.4, blend: "screen" }));
    const c = stroke([[0, 40], [100, 40]]);
    const svg = exportSvg([a, b, c]);
    expect(svg).toContain('<g style="mix-blend-mode:multiply"><path ');
    expect(svg).toContain('<g style="mix-blend-mode:screen"><g fill="url(#g1)">');
    expect((svg.match(/mix-blend-mode/g) ?? []).length).toBe(2);
  });
});

describe("compaction des traits", () => {
  const line = (n: number, f: (i: number) => [number, number, number]) => Array.from({ length: n }, (_, i) => f(i)).flat();
  it("une droite dense se réduit à ses extrémités", () => {
    const out = compactStroke(line(200, (i) => [i * 0.5, 0, 1]), 0.1);
    expect(out).toEqual([0, 0, 1, 99.5, 0, 1]);
  });
  it("garde la forme à la tolérance près", () => {
    const pts = line(400, (i) => [i, Math.sin(i / 20) * 30, 1]);
    const out = compactStroke(pts, 0.5);
    expect(out.length / 3).toBeLessThan(80);
    expect(out.length / 3).toBeGreaterThan(10);
    // Chaque point d'origine reste à moins de la tolérance de la polyligne simplifiée.
    for (let i = 0; i < pts.length; i += 3) {
      let best = Infinity;
      for (let k = 0; k + 5 < out.length; k += 3) {
        const [ax, ay, bx, by] = [out[k], out[k + 1], out[k + 3], out[k + 4]];
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const t = Math.max(0, Math.min(1, ((pts[i] - ax) * dx + (pts[i + 1] - ay) * dy) / l2));
        best = Math.min(best, Math.hypot(pts[i] - (ax + t * dx), pts[i + 1] - (ay + t * dy)));
      }
      expect(best).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });
  it("garde les variations de pression", () => {
    const out = compactStroke(line(100, (i) => [i, 0, i < 50 ? 0.2 : 1]), 0.5, 0.04);
    expect(out.length / 3).toBeGreaterThan(2);
    expect(compactStroke(line(100, (i) => [i, 0, i < 50 ? 0.2 : 1]), 0.5, Infinity)).toHaveLength(6);
  });
  it("joint les points confondus et garde le dernier", () => {
    expect(compactStroke([0, 0, 1, 0.01, 0, 1, 0.02, 0, 1, 5, 0, 1, 5.01, 0, 1], 1)).toEqual([0, 0, 1, 5.01, 0, 1]);
    expect(compactStroke([3, 3, 1, 3, 3, 1], 1)).toEqual([3, 3, 1, 3, 3, 1]);
    expect(compactStroke([1, 2, 0.5], 1)).toEqual([1, 2, 0.5]);
  });
  it("s'adapte à toute échelle du monde", () => {
    for (const k of [1e-6, 1e6]) {
      const out = compactStroke(line(300, (i) => [i * k, Math.sin(i / 15) * 20 * k, 1]), 0.3 * k);
      expect(out.length / 3).toBeGreaterThan(10);
      expect(out.length / 3).toBeLessThan(100);
    }
  });
});

describe("export SVG : jointure et culling", () => {
  it("fusionne les traits nets consécutifs de même style", () => {
    const a = stroke([[0, 0], [50, 10], [100, 0]]), b = stroke([[0, 30], [50, 40], [100, 30]]);
    const c = stroke([[0, 60], [100, 60]], brush(4));
    const svg = exportSvg([a, b, c]);
    expect((svg.match(/<path /g) ?? []).length).toBe(2);
    expect((svg.match(/M/g) ?? []).length).toBe(3);
  });
  it("ne joint pas à travers un trait d'un autre style (ordre de superposition gardé)", () => {
    const a = stroke([[0, 0], [100, 0]]), soft = stroke([[0, 5], [100, 5]], brush(10, { hardness: 0.3 })), b = stroke([[0, 9], [100, 9]]);
    expect((exportSvg([a, soft, b]).match(/<path /g) ?? []).length).toBe(2);
  });
  it("écarte les traits hors de la zone", () => {
    const svg = exportSvg([stroke([[0, 0], [10, 0]]), stroke([[1000, 1000], [1010, 1000]])], { area: { x: -20, y: -20, w: 60, h: 40 } });
    expect((svg.match(/<path /g) ?? []).length).toBe(1);
  });
});

describe("fusion vectorielle (découpage polygonal)", () => {
  it("un trait plein devient son contour : aire ≈ capsule", async () => {
    const { strokeOutline } = await import("./merge");
    const { multiArea } = await import("../vector");
    const m = strokeOutline([0, 0, 1, 100, 0, 1], 5, 0.05);
    expect(m).toHaveLength(1);
    expect(multiArea(m)).toBeCloseTo(100 * 10 + Math.PI * 25, -1);
  });
  it("fonctionne à toute échelle du monde", async () => {
    const { strokeOutline } = await import("./merge");
    const { multiArea } = await import("../vector");
    for (const k of [1e-7, 1e7]) {
      const m = strokeOutline([0, 0, 1, 100 * k, 0, 1], 5 * k, 0.05 * k);
      expect(multiArea(m) / (k * k)).toBeCloseTo(1000 + Math.PI * 25, -1);
    }
  });
  it("deux traits qui se croisent : une seule forme, sans double comptage", async () => {
    const { strokeOutline, mergeShapes, shapeHit } = await import("./merge");
    const { multiArea } = await import("../vector");
    const a = strokeOutline([0, 0, 1, 100, 0, 1], 5, 0.05);
    const b = strokeOutline([50, -50, 1, 50, 50, 1], 5, 0.05);
    const m = mergeShapes(a, b, 0.05);
    expect(m).toHaveLength(1);
    expect(multiArea(m)).toBeLessThan(multiArea(a) + multiArea(b) - 90);
    expect(shapeHit(m, 50, 30, 0)).toBe(true);
    expect(shapeHit(m, 20, 30, 0)).toBe(false);
    expect(shapeHit(m, 20, 7, 2.5)).toBe(true);
  });
  it("cible : même style au contact, bloquée par un trait d'un autre style posé dessus", async () => {
    const { mergeTarget, isSolid } = await import("./merge");
    const red = brush(10, { color: "#ff0000" }), blue = brush(10, { color: "#0000ff" });
    const r1 = stroke([[0, 0], [100, 0]], red);
    const fresh = stroke([[50, -20], [50, 20]], red);
    expect(isSolid(red, fresh.pts)).toBe(true);
    expect(mergeTarget([r1], fresh)).toBe(0);
    expect(mergeTarget([r1, stroke([[0, 200], [100, 200]], blue)], fresh)).toBe(0);
    expect(mergeTarget([r1, stroke([[40, -30], [60, 30]], blue)], fresh)).toBe(-1);
    expect(mergeTarget([stroke([[0, 0], [100, 0]], brush(10, { color: "#ff0000", hardness: 0.3 }))], fresh)).toBe(-1);
    expect(mergeTarget([stroke([[0, 0], [100, 0]], brush(10, { color: "#ff0000", blend: "multiply" }))], fresh)).toBe(-1);
  });
  it("swap : une étape d'annulation", () => {
    const d = new Doc();
    const a = stroke([[0, 0]]), b = stroke([[5, 5]]), c = stroke([[9, 9]]);
    d.add(a); d.add(b); d.add(c);
    const merged = { ...stroke([[1, 1]]), pts: [], shape: [[[[0, 0], [1, 0], [1, 1]] as [number, number][]]] };
    d.swap(new Set([a.id]), merged, 0);
    expect(d.strokes).toEqual([merged, b, c]);
    expect(d.totalPoints).toBe(3 + 2);
    d.undo();
    expect(d.strokes).toEqual([a, b, c]);
    d.redo();
    expect(d.strokes).toEqual([merged, b, c]);
  });
  it("export : une forme = un chemin rempli", () => {
    const shape = { ...stroke([[0, 0]]), pts: [], shape: [[[[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][]]], bbox: { x: 0, y: 0, w: 10, h: 10 } };
    const svg = exportSvg([shape]);
    expect(svg).toContain('fill-rule="evenodd"');
    expect((svg.match(/<path /g) ?? []).length).toBe(1);
  });
});
