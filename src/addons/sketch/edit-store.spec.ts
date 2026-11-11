import { describe, expect, it } from "vitest";
import { BRUSH_DEFAULTS } from "../paint/brush";
import { multiArea, type Multi } from "../vector";
import { editFlat, paintFlat, type Region } from "./flat";
import { deriveColor, parseColor } from "./flat-color";
import { strokeOutline } from "./merge";
import { makeBrush, type Stroke } from "./model";
import { MemoryBackend, cleanName, isDrawingId, listDrawings, readCurrent, readStrokes, writeCurrent, writeStrokes } from "./store";

const white = { known: true as const, color: parseColor("#ffffff") };
const red = parseColor("#ff0000")!, blue = parseColor("#0000ff")!;
const square = (x: number, y: number, s: number): Multi => [[[[x, y], [x + s, y], [x + s, y + s], [x, y + s]]]];
const area = (rs: Region[]) => rs.reduce((n, r) => n + multiArea(r.shape), 0);
const ofColor = (rs: Region[], c: string) => rs.filter((r) => r.color === c);

// Deux carrés qui se touchent : rouge à gauche, bleu à droite.
let map = paintFlat([], square(0, 0, 100), red, 1, "normal", white);
map = paintFlat(map, square(100, 0, 100), blue, 1, "normal", white);
const redR = map.find((r) => r.color === "#ff0000")!;

describe("retouches de la sélection", () => {
  it("étendre : la forme grandit et découpe sa voisine ; réduire libère de la place", () => {
    const { regions, fresh } = editFlat(map, new Set([redR]), "grow", { amount: 10 });
    expect(area(ofColor(regions, "#ff0000"))).toBeGreaterThan(100 * 100 + 4 * 100 * 10 * 0.95);
    expect(area(ofColor(regions, "#0000ff"))).toBeCloseTo(100 * 90, -2);
    expect(fresh.every((r) => r.color === "#ff0000")).toBe(true);
    const shrunk = editFlat(map, new Set([redR]), "grow", { amount: -10 });
    expect(area(ofColor(shrunk.regions, "#ff0000"))).toBeCloseTo(80 * 80, -2);
    expect(area(ofColor(shrunk.regions, "#0000ff"))).toBeCloseTo(100 * 100, -1);
  });

  it("entourer : un anneau par couleur autour de la sélection, qui reste intacte", () => {
    const { regions, fresh } = editFlat(map, new Set([redR]), "outline", { amount: 5, colors: [parseColor("#000000")!, parseColor("#ffff00")!] });
    expect(regions).toContain(redR);
    expect(fresh).toContain(redR);
    const black = area(ofColor(regions, "#000000")), yellow = area(ofColor(regions, "#ffff00"));
    expect(black).toBeGreaterThan(4 * 100 * 5);
    expect(yellow).toBeGreaterThan(black);
    // L'anneau mord sur le bleu voisin.
    expect(area(ofColor(regions, "#0000ff"))).toBeLessThan(100 * 100 - 100 * 9);
  });

  it("adoucir arrondit les angles ; simplifier réduit les sommets", () => {
    const { regions } = editFlat(map, new Set([redR]), "smooth", { amount: 20 });
    const r = ofColor(regions, "#ff0000");
    // Quatre coins arrondis de rayon 20 : il manque (4 − π)·20² au carré.
    expect(area(r)).toBeLessThan(100 * 100 - 200);
    const wobbly = paintFlat([], strokeOutline([0, 0, 1, 50, 2, 1, 100, 0, 1, 150, 2, 1, 200, 0, 1], 10, 0.01), red, 1, "normal", white);
    const before = wobbly[0].shape[0][0].length;
    const simple = editFlat(wobbly, new Set(wobbly), "simplify", { amount: 4 });
    expect(simple.regions[0].shape[0][0].length).toBeLessThan(before);
  });

  it("couleurs déduites", () => {
    expect(deriveColor("darker", red)![0]).toBeLessThan(0.6);
    expect(deriveColor("complement", red)![2]).toBeGreaterThan(0.5);
    expect(deriveColor("#00ff00", red)).toEqual([0, 1, 0, 1]);
    expect(deriveColor("url(x)", red)).toBeNull();
  });

  it("sans cible ou sans ampleur : rien ne change", () => {
    expect(editFlat(map, new Set(), "grow", { amount: 5 }).regions).toBe(map);
    expect(editFlat(map, new Set([redR]), "grow", { amount: 0 }).regions).toBe(map);
  });
});

describe("carnet de dessins", () => {
  const b = makeBrush({ ...BRUSH_DEFAULTS, hardness: 1, pressure: false }, 4);
  const strokes: Stroke[] = [
    { id: 3, brush: b, pts: [0, 0, 1, 10, 0, 1], seed: 2, bbox: { x: 0, y: 0, w: 0, h: 0 } },
    { id: 9, brush: b, pts: [], flat: map, seed: 1, bbox: { x: 0, y: 0, w: 200, h: 100 } },
    { id: 12, brush: b, pts: [], mask: square(5, 5, 3), seed: 0, bbox: { x: 5, y: 5, w: 3, h: 3 } },
  ];

  it("aller-retour JSON : traits, aplats, masques, boîtes recalculées", () => {
    const back = readStrokes(JSON.parse(JSON.stringify(writeStrokes(strokes))))!;
    expect(back).toHaveLength(3);
    expect(back[0].pts).toEqual([0, 0, 1, 10, 0, 1]);
    expect(back[0].bbox.w).toBeGreaterThan(10);
    expect(back[1].flat!.map((r) => r.color).sort()).toEqual(["#0000ff", "#ff0000"]);
    expect(back[1].bbox).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    expect(back[2].mask).toEqual(square(5, 5, 3));
    expect(back.map((s) => s.id)).toEqual([1, 2, 3]);
  });

  it("relecture méfiante : structures invalides écartées", () => {
    expect(readStrokes("x")).toBeNull();
    const bad = readStrokes([
      null,
      { brush: { size: -1 }, pts: [0, 0, 1] },
      { brush: { size: 2 }, pts: [0, 0] },
      { brush: { size: 2 }, pts: [0, "x", 1] },
      { brush: { size: 2 }, flat: [{ rgba: [2, 0, 0, 1], shape: square(0, 0, 1) }] },
      { brush: { size: 2 }, mask: [[[[0, 0], [1, Infinity], [0, 1]]]] },
      { brush: { size: 2, color: "javascript:alert(1)", tip: "<svg>" }, pts: [0, 0, 1] },
    ])!;
    expect(bad).toHaveLength(1);
    expect(bad[0].brush.color).toBe(BRUSH_DEFAULTS.color);
    expect(bad[0].brush.tip).toBe(BRUSH_DEFAULTS.tip);
    expect(cleanName("  a\u0000b  ", "x")).toBe("a b");
    expect(cleanName("", "x")).toBe("x");
    expect(isDrawingId("abc-1")).toBe(true);
    expect(isDrawingId("../x")).toBe(false);
  });

  it("liste par espace de noms, la plus récente d'abord ; dessin ouvert retenu", async () => {
    const m = new MemoryBackend();
    const rec = (ns: string, id: string, updated: number) => ({ ns, id, name: id, created: 1, updated, strokes: 0, thumb: null, view: { x: 0, y: 0, zoom: 1, rotation: 0 }, nextId: 1, data: [] });
    await m.put(rec("a", "un", 5));
    await m.put(rec("a", "deux", 9));
    await m.put(rec("b", "trois", 7));
    await writeCurrent(m, "a", "un");
    expect((await listDrawings(m, "a")).map((d) => d.id)).toEqual(["deux", "un"]);
    expect(await readCurrent(m, "a")).toBe("un");
    expect(await readCurrent(m, "b")).toBeNull();
  });
});

describe("calque guide", async () => {
  const { GUIDE_DEFAULTS, GUIDE_TYPES, guidePaths, sanitizeGuide } = await import("./guide");
  const s = (o: Record<string, unknown>) => sanitizeGuide(o);

  it("assainit les réglages", () => {
    expect(s({ type: "nope", spacing: 1e9, color: "url(x)", pose: "x", subdiv: 3.6 })).toMatchObject({ type: "none", spacing: 400, color: GUIDE_DEFAULTS.color, pose: "debout", subdiv: 4 });
  });

  it("chaque type produit des repères finis", () => {
    for (const type of GUIDE_TYPES) {
      const paths = guidePaths(s({ type }), 800, 600);
      if (type === "none") { expect(paths).toEqual([]); continue; }
      expect(paths.length).toBeGreaterThan(3);
      for (const p of paths) for (const [x, y] of p.pts) expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    }
  });

  it("grille ancrée au dessin : le pas s'adapte au zoom (jamais trop dense)", () => {
    const map = (k: number) => ({ to: ([x, y]: [number, number]): [number, number] => [x * k, y * k], from: ([x, y]: [number, number]): [number, number] => [x / k, y / k], k });
    for (const k of [1e-6, 0.3, 1, 7, 1e6]) {
      const lines = guidePaths(s({ type: "grid", spacing: 40, subdiv: 4 }), 800, 600, map(k));
      const xs = lines.filter((p) => p.pts[0][0] === p.pts[1][0]).map((p) => p.pts[0][0]).sort((a, b) => a - b);
      const gap = xs[1] - xs[0];
      expect(gap).toBeGreaterThanOrEqual(40 - 1e-6);
      expect(gap).toBeLessThan(160 + 1e-6);
    }
  });

  it("perspective à deux points : horizon et deux points de fuite", () => {
    const paths = guidePaths(s({ type: "perspective2", horizon: 0.5, vp1: 0, vp2: 1 }), 800, 600);
    const dots = paths.filter((p) => p.dot).map((p) => p.pts[0]);
    expect(dots).toEqual([[0, 300], [800, 300]]);
  });

  it("mannequin : toutes les poses, miroir", () => {
    for (const pose of ["debout", "marche", "course", "assis", "bras-leves", "danse", "accroupi", "contrapposto"]) {
      const a = guidePaths(s({ type: "figure", pose }), 400, 800);
      const b = guidePaths(s({ type: "figure", pose, mirror: true }), 400, 800);
      expect(a.length).toBe(b.length);
    }
  });
});
