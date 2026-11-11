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

describe("conversion des couleurs vers la palette", async () => {
  const { colorMap, fromOklab } = await import("./colormap");
  const { oklab } = await import("./select");
  const pal = ["#000000", "#ffffff", "#c2410c"].map((c) => parseColor(c)!);
  const grey = parseColor("#777777")!, light = parseColor("#dddddd")!, orange = parseColor("#d9480f")!;

  it("OKLab aller-retour", () => {
    const c = parseColor("#3366aa")!;
    const back = fromOklab(oklab(c) as [number, number, number]);
    for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(c[i], 3);
  });
  it("au plus proche : vraies couleurs de la palette", () => {
    const m = colorMap([light, orange], pal, "nearest");
    expect(m.get(light.join(","))).toEqual([1, 1, 1, 1]);
    expect(m.get(orange.join(","))).toEqual(pal[2]);
  });
  it("paliers : l'ordre des clartés est gardé ; dégradé : couleurs intermédiaires ; force partielle", () => {
    const lv = colorMap([grey, light], [pal[0], pal[1]], "levels");
    expect(lv.get(grey.join(","))).toEqual([0, 0, 0, 1]);
    expect(lv.get(light.join(","))).toEqual([1, 1, 1, 1]);
    const mid = parseColor("#999999")!;
    const gr = colorMap([grey, mid, light], [pal[0], pal[1]], "gradient");
    const g = gr.get(mid.join(","))!;
    expect(g[0]).toBeGreaterThan(0.1);
    expect(g[0]).toBeLessThan(0.9);
    const half = colorMap([light], [pal[0]], "nearest", 0.5).get(light.join(","))!;
    expect(half[0]).toBeGreaterThan(0.2);
    expect(half[0]).toBeLessThan(0.8);
  });
  it("palette vide : rien", () => {
    expect(colorMap([grey], [], "nearest").size).toBe(0);
  });
});

describe("passes d'un trait (le trait revient sur lui-même)", async () => {
  const { passCuts, splitPasses } = await import("./turns");
  const line = (xs: [number, number][]) => xs.flatMap(([x, y]) => [x, y, 1]);
  const seg = (a: [number, number], b: [number, number], n = 20): [number, number][] =>
    Array.from({ length: n }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n] as [number, number]);

  it("hachure serrée en aller-retour : une passe par recouvrement", () => {
    const zig = line([...seg([0, 0], [100, 4]), ...seg([100, 4], [0, 8]), ...seg([0, 8], [100, 12]), [100, 12]]);
    const cuts = passCuts(zig, 8);
    expect(cuts).toHaveLength(2);
    const passes = splitPasses(zig, cuts);
    expect(passes).toHaveLength(3);
    expect(passes.reduce((n, p) => n + p.length / 3, 0)).toBe(zig.length / 3 + 2);
  });

  it("boucle qui se croise : coupée au croisement, même sans angle vif", () => {
    const loop = line(Array.from({ length: 90 }, (_, i) => {
      const a = (i / 60) * Math.PI * 2;
      return [Math.cos(a) * 40 + i * 0.3, Math.sin(a) * 40] as [number, number];
    }));
    expect(passCuts(loop, 6)).toHaveLength(1);
  });

  it("geste rapide (points espacés) qui traverse une partie posée : vu", () => {
    const cross = line([[0, 0], [100, 0], [100, 60], [50, 60], [50, -60], [20, -60]]);
    expect(passCuts(cross, 6)).toHaveLength(1);
  });

  it("virages francs sans recouvrement, courbe douce, tremblement : aucune coupe", () => {
    const square = line([...seg([0, 0], [100, 0]), ...seg([100, 0], [100, 30]), ...seg([100, 30], [0, 30]), ...seg([0, 30], [0, 60]), [0, 60]]);
    expect(passCuts(square, 6)).toEqual([]);
    const arc = line(Array.from({ length: 60 }, (_, i) => [Math.cos(i / 20) * 80, Math.sin(i / 20) * 80] as [number, number]));
    expect(passCuts(arc, 6)).toEqual([]);
    const wobbly = line(Array.from({ length: 80 }, (_, i) => [i * 2, Math.sin(i * 1.7) * 0.8] as [number, number]));
    expect(passCuts(wobbly, 6)).toEqual([]);
  });
});

describe("aplatissement progressif", async () => {
  const { StrokeFlattener, capDisc } = await import("./flatten-inc");
  const { strokeOutline } = await import("./merge");
  const { paintFlat, safeBoolean } = await import("./flat");
  const { passCuts, splitPasses } = await import("./turns");
  const { multiArea } = await import("../vector");
  const back = { known: true as const, color: [244 / 255, 241 / 255, 234 / 255, 1] as [number, number, number, number] };
  const src: [number, number, number, number] = [47 / 255, 111 / 255, 216 / 255, 1];
  const areas = (regions: { rgba: number[]; shape: never }[]) => {
    const m = new Map<string, number>();
    for (const r of regions) m.set(r.rgba.join(","), (m.get(r.rgba.join(",")) ?? 0) + multiArea(r.shape));
    return m;
  };
  // Tourner en rond autour d'un point : beaucoup de passes, beaucoup de recouvrements.
  const pts: number[] = [];
  for (let i = 0; i < 300; i++) { const a = i * 0.12, rr = 30 + 8 * Math.sin(i * 0.013); pts.push(400 + Math.cos(a) * rr + i * 0.02, 300 + Math.sin(a) * rr, 1); }

  for (const [mode, alpha] of [["multiply", 0.5], ["normal", 1], ["normal", 0.6]] as const) {
    it(`même résultat que d'un bloc (${mode}, ${alpha})`, () => {
      const r = 9, otol = 0.25, multi = mode !== "normal" || alpha < 1;
      const cuts = multi ? passCuts(pts, 18) : [];
      // D'un bloc.
      let block: never[] = [];
      splitPasses(pts, cuts).forEach((p, k) => {
        const m = strokeOutline(p, r, otol);
        const s = k > 0 ? safeBoolean("difference", m, [[capDisc(p[0], p[1], r)]]) : m;
        block = paintFlat(block, s, src, alpha, mode, back) as never[];
      });
      // Par morceaux : passes, et tronçons de 40 points dans chaque passe.
      const f = new StrokeFlattener({ radius: () => r, tolerance: () => otol, pressure: false, ztol: 0, ptol: Infinity, src, alpha, mode, multi }, () => ({ index: 0, regions: [], back }));
      splitPasses(pts, cuts).forEach((p, k) => {
        const n = p.length / 3;
        for (let s = 0; s < n - 1; s += 40) {
          const e = Math.min(n - 1, s + 40);
          f.push({ pts: p.slice(s * 3, (e + 1) * 3), joint: s > 0 ? "chunk" : k > 0 ? "pass" : "start" });
        }
      });
      const inc = f.finish();
      expect(inc).not.toBeNull();
      const a = areas(block as never), b = areas(inc!.regions as never);
      const total = (m: Map<string, number>) => [...m.values()].reduce((x, y) => x + y, 0);
      expect(Math.abs(total(a) - total(b)) / total(a)).toBeLessThan(0.01);
      for (const [c, v] of a) if (v > total(a) * 0.02) expect(Math.abs((b.get(c) ?? 0) - v) / v).toBeLessThan(0.05);
    });
  }

  it("budget dépassé sur une carte complexe : arrêt (heavy), sans recalcul d'un bloc", () => {
    const spec = { radius: () => 9, tolerance: () => 0.25, pressure: false, ztol: 0, ptol: Infinity, src, alpha: 0.5, mode: "multiply" as const, multi: true };
    const cuts = passCuts(pts, 18);
    const run = (budgetMs: number, heavyVertices: number) => {
      const f = new StrokeFlattener({ ...spec, budgetMs, heavyVertices }, () => ({ index: 0, regions: [], back }));
      splitPasses(pts, cuts).forEach((p, k) => f.push({ pts: p, joint: k ? "pass" : "start" }));
      return f;
    };
    const tight = run(0, 0);
    expect(tight.finish()).toBeNull();
    expect(tight.heavy).toBe(true);
    // Carte encore simple : le budget ne s'applique pas (la compilation à chaud du premier morceau ne compte pas).
    const simple = run(0, 1e9);
    expect(simple.finish()).not.toBeNull();
    expect(simple.heavy).toBe(false);
  });

  it("pression variable (stylet) : échec, le trait n'est pas plein", () => {
    const f = new StrokeFlattener({ radius: () => 5, tolerance: () => 0.25, pressure: true, ztol: 0, ptol: 0.04, src, alpha: 1, mode: "normal", multi: false }, () => ({ index: 0, regions: [], back }));
    f.push({ pts: [0, 0, 0.5, 50, 0, 0.5], joint: "start" });
    f.push({ pts: [50, 0, 0.5, 100, 0, 0.9], joint: "chunk" });
    expect(f.finish()).toBeNull();
    expect(f.heavy).toBe(false);
  });

  it("carte cible remise en cause en cours de trait : échec, recalcul d'un bloc", () => {
    let n = 0;
    const f = new StrokeFlattener({ radius: () => 5, tolerance: () => 0.25, pressure: false, ztol: 0, ptol: Infinity, src, alpha: 1, mode: "normal", multi: false }, () => ({ index: n++ ? 1 : 0, regions: [], back }));
    f.push({ pts: [0, 0, 1, 50, 0, 1], joint: "start" });
    f.push({ pts: [50, 0, 1, 100, 0, 1], joint: "chunk" });
    expect(f.finish()).toBeNull();
    expect(f.failed).toBe(true);
  });
});

describe("gomme comme un pinceau", async () => {
  const { strokeOutline } = await import("./merge");
  const { paintFlat, fadeFlat, eraseFlat } = await import("./flat");
  const { parseColor } = await import("./flat-color");
  const { multiArea } = await import("../vector");
  const { exportSvg } = await import("./export");
  const { makeBrush } = await import("./model");
  const { BRUSH_DEFAULTS } = await import("../paint/brush");
  const red = parseColor("#ff0000")!;
  const white = { known: true as const, color: parseColor("#ffffff") };
  const h = strokeOutline([0, 0, 1, 100, 0, 1], 5, 0.02);
  const v = strokeOutline([50, -50, 1, 50, 50, 1], 5, 0.02);

  it("gomme partielle : la partie gommée garde sa couleur à opacité réduite, le reste est intact", () => {
    const m = fadeFlat(paintFlat([], h, red, 1, "normal", white), v, 0.4);
    const faded = m.filter((r) => r.rgba[3] < 0.999);
    const full = m.filter((r) => r.rgba[3] >= 0.999);
    expect(faded.length).toBeGreaterThan(0);
    for (const r of faded) {
      expect(r.rgba[3]).toBeCloseTo(0.6, 2);
      expect(r.rgba.slice(0, 3)).toEqual(red.slice(0, 3));
    }
    expect(faded.reduce((n, r) => n + multiArea(r.shape), 0)).toBeCloseTo(100, -1);
    expect(full.reduce((n, r) => n + multiArea(r.shape), 0) + faded.reduce((n, r) => n + multiArea(r.shape), 0)).toBeCloseTo(multiArea(h), -1);
  });

  it("repasser efface davantage, jusqu'à faire disparaître la région ; opacité 1 = trou net", () => {
    let m = paintFlat([], h, red, 1, "normal", white);
    for (let i = 0; i < 12; i++) m = fadeFlat(m, v, 0.5);
    expect(m.every((r) => r.rgba[3] >= 0.999)).toBe(true);
    const net = eraseFlat(paintFlat([], h, red, 1, "normal", white), v);
    expect(fadeFlat(paintFlat([], h, red, 1, "normal", white), v, 1).reduce((n, r) => n + multiArea(r.shape), 0)).toBeCloseTo(net.reduce((n, r) => n + multiArea(r.shape), 0), 3);
  });

  it("gomme en empreintes et masque partiel : enregistrés, relus, exportés en masques SVG", () => {
    const soft = makeBrush({ ...BRUSH_DEFAULTS, hardness: 0.3, opacity: 0.7, color: "#000000" }, 12, "normal");
    const half = makeBrush({ ...BRUSH_DEFAULTS, opacity: 0.5, color: "#000000" }, 10, "normal");
    const paint = makeBrush({ ...BRUSH_DEFAULTS, color: "#2f6fd8" }, 10, "normal");
    const strokes = [
      { id: 1, brush: paint, pts: [0, 0, 1, 100, 0, 1], seed: 1, bbox: { x: -5, y: -5, w: 110, h: 10 } },
      { id: 2, brush: soft, pts: [50, -20, 1, 50, 20, 1], seed: 2, erase: true, bbox: { x: 44, y: -26, w: 12, h: 52 } },
      { id: 3, brush: half, pts: [], seed: 3, mask: v, bbox: { x: 45, y: -55, w: 10, h: 110 } },
    ];
    const back = readStrokes(JSON.parse(JSON.stringify(writeStrokes(strokes))))!;
    expect(back[1].erase).toBe(true);
    expect(back[1].brush.opacity).toBeCloseTo(0.7);
    expect(back[0].erase).toBeUndefined();
    expect(back[2].mask).toBeTruthy();
    expect(back[2].brush.opacity).toBeCloseTo(0.5);
    const svg = exportSvg(back);
    expect(svg.match(/<mask /g)).toHaveLength(2);
    expect(svg).toContain('fill-opacity="0.5"');
  });
});
