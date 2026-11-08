import { describe, expect, it } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { parsePath, flatten, multiArea, multiBBox, pathToMulti, boolean, offset, simplifyLine, simplifyMulti, visvalingam, roundedPath, fitCurve, cull, TileIndex, levelOfDetail, clipToView, viewFromCamera, ShapeLibrary, runVectorOp, ringArea } from "./index";

const SQ = "M0 0 H10 V10 H0 Z";
const SQ2 = "M5 5 H15 V15 H5 Z";
const area = (d: string) => multiArea(pathToMulti(d) ?? []);

describe("chemins SVG", () => {
  it("lit absolu, relatif et arcs", () => {
    expect(parsePath("M0 0 l10 0 l0 10 z")).not.toBeNull();
    expect(parsePath("M0 0 A5 5 0 0 1 10 0")).not.toBeNull();
    expect(area("m0 0 h10 v10 h-10 z")).toBeCloseTo(100);
  });
  it("refuse l'illisible et le trop gros", () => {
    expect(parsePath("not a path")).toBeNull();
    expect(parsePath("M0 0 L" + "1 1 ".repeat(150000))).toBeNull();
  });
  it("aplatit une courbe fermée", () => {
    const f = flatten(parsePath("M0 0 C0 10 10 10 10 0 Z")!, 0.1);
    expect(f[0].closed).toBe(true);
    expect(f[0].ring.length).toBeGreaterThan(4);
  });
});

describe("booléens", () => {
  it("union, intersection, différence, xor", () => {
    expect(area(runVectorOp("union", SQ, SQ2).d)).toBeCloseTo(175);
    expect(area(runVectorOp("intersect", SQ, SQ2).d)).toBeCloseTo(25);
    expect(area(runVectorOp("difference", SQ, SQ2).d)).toBeCloseTo(75);
    expect(area(runVectorOp("xor", SQ, SQ2).d)).toBeCloseTo(150);
  });
  it("crée un trou", () => {
    const r = runVectorOp("difference", "M0 0 H30 V30 H0 Z", "M10 10 H20 V20 H10 Z");
    expect(area(r.d)).toBeCloseTo(800);
    expect(r.polygons).toBe(1);
  });
  it("erreurs propres", () => {
    expect(runVectorOp("nope", SQ, "").error).toMatch(/inconnue/);
    expect(runVectorOp("union", "not a path", "").error).toMatch(/illisible/);
    expect(runVectorOp("union", SQ, "not a path").error).toMatch(/illisible/);
  });
});

describe("décalage, simplification, arrondi", () => {
  it("agrandit et réduit", () => {
    const m = pathToMulti(SQ)!;
    expect(multiArea(offset(m, 2, 12))).toBeGreaterThan(multiArea(m) + 40);
    expect(multiArea(offset(m, -2, 12))).toBeCloseTo(36, 0);
    expect(offset(m, -6, 8)).toEqual([]);
  });
  it("RDP retire les points alignés", () => {
    const line = Array.from({ length: 50 }, (_, i) => [i, 0] as [number, number]);
    expect(simplifyLine(line, 0.1).length).toBe(2);
    expect(visvalingam(line, 0.5).length).toBeLessThan(line.length);
  });
  it("conserve les coins", () => {
    const m = simplifyMulti(pathToMulti("M0 0 L5 0 L10 0 L10 5 L10 10 L0 10 Z")!, 0.1);
    expect(multiArea(m)).toBeCloseTo(100);
  });
  it("arrondit et ajuste des courbes", () => {
    expect(roundedPath([[0, 0], [10, 0], [10, 10], [0, 10]], 2)).toContain("Q");
    const circle = Array.from({ length: 40 }, (_, i) => [Math.cos((i / 40) * 6.283) * 10, Math.sin((i / 40) * 6.283) * 10] as [number, number]);
    const d = fitCurve(circle, 0.2, true);
    expect(d).toContain("C");
    expect(Math.abs(area(d)) / (Math.PI * 100)).toBeGreaterThan(0.95);
  });
  it("opérations round / fit / simplify / offset via runVectorOp", () => {
    expect(runVectorOp("round", SQ, "", { radius: 2 }).d).toContain("Q");
    expect(runVectorOp("offset", SQ, "", { delta: 1 }).area).toBeGreaterThan(100);
    expect(runVectorOp("simplify", SQ, "", { tolerance: 1 }).area).toBeCloseTo(100);
    expect(runVectorOp("fit", SQ, "", { tolerance: 0.5 }).error).toBeNull();
  });
});

describe("ajustement de courbes (fitCurve)", () => {
  type P2 = [number, number];
  const nums = (d: string) => (d.match(/-?\d+(\.\d+)?(e-?\d+)?/g) ?? []).map(Number);
  const pointsOf = (d: string): P2[] => { const n = nums(d); return Array.from({ length: n.length / 2 }, (_, i) => [n[2 * i], n[2 * i + 1]]); };
  const flat = (d: string): P2[] => flatten(parsePath(d)!, 0.01).flatMap((s) => s.ring) as P2[];
  const circle = (n: number, r = 50): P2[] => Array.from({ length: n }, (_, i) => [Math.cos((i / n) * 2 * Math.PI) * r, Math.sin((i / n) * 2 * Math.PI) * r]);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const hand: P2[] = Array.from({ length: 80 }, (_, i) => [i * 2 + rnd() * 1.5, (i < 40 ? i * 1.5 : 120 - i * 1.5) + rnd() * 1.5]);
  const star: P2[] = Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 20 : 50, a = (i / 10) * 2 * Math.PI; return [Math.cos(a) * r, Math.sin(a) * r]; });
  const roundedSparse: P2[] = [[10, 0], [90, 0], [97, 3], [100, 10], [100, 40], [97, 47], [90, 50], [10, 50], [3, 47], [0, 40], [0, 10], [3, 3]];

  it("un rectangle reste à coins vifs", () => {
    const d = fitCurve([[0, 0], [100, 0], [100, 50], [0, 50]], 1, true);
    expect(d).not.toContain("C");
    expect(Math.abs(area(d))).toBeCloseTo(5000);
    expect(multiBBox(pathToMulti(d)!)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    // Côtés densément échantillonnés : mêmes coins vifs.
    const dense: P2[] = [];
    for (let i = 0; i < 100; i += 5) dense.push([i, 0]);
    for (let i = 0; i < 50; i += 5) dense.push([100, i]);
    for (let i = 100; i > 0; i -= 5) dense.push([i, 50]);
    for (let i = 50; i > 0; i -= 5) dense.push([0, i]);
    const d2 = fitCurve(dense, 0.5, true);
    expect(d2).not.toContain("C");
    expect(Math.abs(area(d2))).toBeCloseTo(5000);
    expect(runVectorOp("fit", "M0 0 H40 V20 H0 Z", "", { tolerance: 0.5 }).d).not.toContain("C");
  });

  it("aucun point de contrôle hors de la boîte englobante élargie", () => {
    const cases: [P2[], number, boolean][] = [[circle(6), 0.5, true], [circle(8), 0.5, true], [circle(12), 0.5, true], [star, 0.5, true], [roundedSparse, 0.5, true], [hand, 0.8, false], [[[0, 0], [10, 10], [20, 0], [30, 10], [40, 0]], 0.4, false], [[[0, 0], [50, 10], [100, 0]], 0.4, false]];
    for (const [pts, tol, closed] of cases) {
      const d = fitCurve(pts, tol, closed);
      expect(d).not.toMatch(/NaN|Infinity/);
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const m = 0.1 * Math.max(x1 - x0, y1 - y0) + tol;
      for (const [x, y] of pointsOf(d)) {
        expect(x).toBeGreaterThanOrEqual(x0 - m);
        expect(x).toBeLessThanOrEqual(x1 + m);
        expect(y).toBeGreaterThanOrEqual(y0 - m);
        expect(y).toBeLessThanOrEqual(y1 + m);
      }
      // La courbe suit la polyligne d'entrée (aucune boucle ni pointe qui s'en écarte).
      const line = closed ? [...pts, pts[0]] : pts;
      const toLine = (p: P2) => Math.min(...line.slice(1).map((b, i) => { const a = line[i], dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0; return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); }));
      expect(Math.max(...flat(d).map(toLine))).toBeLessThanOrEqual(tol * 1.05);
    }
  });

  it("un cercle échantillonné reste proche du cercle, en peu de courbes", () => {
    for (const n of [40, 200]) {
      const d = fitCurve(circle(n), 0.5, true);
      expect((d.match(/C/g) ?? []).length).toBeLessThanOrEqual(8);
      expect(d).not.toContain("L");
      const radii = flat(d).map(([x, y]) => Math.hypot(x, y));
      expect(Math.max(...radii.map((r) => Math.abs(r - 50)))).toBeLessThan(0.5 + 50 * (1 - Math.cos(Math.PI / n)));
    }
  });

  it("coins détectés sur un contour mixte, extrémités et cas dégénérés", () => {
    // L : six coins vifs, aucun arrondi.
    expect(fitCurve([[0, 0], [60, 0], [60, 20], [20, 20], [20, 60], [0, 60]], 0.5, true)).not.toContain("C");
    // Rectangle arrondi clairsemé : courbes aux angles, droites sur les côtés.
    const rr = fitCurve(roundedSparse, 0.5, true);
    expect(rr).toContain("C");
    expect(Math.abs(area(rr))).toBeGreaterThan(4800);
    // Courbe ouverte : commence et finit exactement aux extrémités.
    const open = fitCurve(hand, 0.8);
    expect(open.startsWith(`M${+hand[0][0].toFixed(3)},${+hand[0][1].toFixed(3)}`)).toBe(true);
    const last = pointsOf(open).at(-1)!;
    expect(last[0]).toBeCloseTo(hand.at(-1)![0], 2);
    expect(last[1]).toBeCloseTo(hand.at(-1)![1], 2);
    // Dégénérés : un point, deux points, aller-retour, doublons.
    expect(fitCurve([[1, 1]], 1)).toBe("");
    expect(fitCurve([[0, 0], [10, 0]], 1)).toBe("M0,0L10,0");
    expect(fitCurve([[0, 0], [0, 0], [50, 0], [10, 0.1], [60, 0]], 0.3)).not.toMatch(/NaN/);
    // cornerDeg ≥ 180 : aucun coin, contour entièrement lissé.
    expect(fitCurve(circle(6), 0.5, true, { cornerDeg: 180 })).toContain("C");
  });
});

describe("culling", () => {
  const items = [
    { id: "a", bbox: { x: 0, y: 0, w: 10, h: 10 } },
    { id: "b", bbox: { x: 1000, y: 1000, w: 10, h: 10 } },
    { id: "c", bbox: { x: -5, y: -5, w: 10, h: 10 } },
  ];
  it("garde les formes visibles", () => {
    const v = { x: 0, y: 0, w: 100, h: 100 };
    expect(cull(items, v).map((i) => i.id)).toEqual(["a", "c"]);
    expect(cull(items, v, 2000).length).toBe(3);
  });
  it("grille spatiale", () => {
    const t = new TileIndex(64);
    for (const i of items) t.insert(i.id, i.bbox);
    expect(t.query({ x: 0, y: 0, w: 100, h: 100 })).toEqual(["a", "c"]);
    t.remove("a");
    expect(t.query({ x: 0, y: 0, w: 100, h: 100 })).toEqual(["c"]);
    t.insert("huge", { x: -1e9, y: -1e9, w: 2e9, h: 2e9 });
    expect(t.query({ x: 0, y: 0, w: 1, h: 1 })).toContain("huge");
    expect(() => new TileIndex(0)).toThrow();
  });
  it("niveau de détail et découpe", () => {
    const m = pathToMulti(SQ)!;
    expect(levelOfDetail(m, 0.01)).toBeNull();
    expect(levelOfDetail(m, 10)).not.toBeNull();
    const clipped = clipToView(m, { x: 5, y: 0, w: 100, h: 100 });
    expect(multiArea(clipped)).toBeCloseTo(50);
    expect(clipToView(m, { x: 500, y: 500, w: 1, h: 1 })).toEqual([]);
    expect(viewFromCamera(0, 0, 2, 200, 100)).toEqual({ x: -50, y: -25, w: 100, h: 50 });
  });
});

describe("bibliothèque", () => {
  it("ajoute, filtre, supprime, recharge", () => {
    const lib = new ShapeLibrary();
    expect(lib.add({ name: "Carré", d: SQ, tags: ["Base"] }).id).toBe("carre");
    expect(lib.add({ name: "Carré", d: SQ2 }).id).toBe("carre-2");
    expect(lib.add({ d: "xx" }).error).toBeTruthy();
    expect(lib.add({ id: "bad id!", d: SQ }).error).toBeTruthy();
    expect(lib.list({ tag: "base" }).length).toBe(1);
    expect(lib.get("carre")!.area).toBeCloseTo(100);
    const json = lib.toJSON();
    expect(lib.remove("carre")).toBe(true);
    const r = new ShapeLibrary().load([...json, { d: "?" }]);
    expect(r).toEqual({ loaded: 2, rejected: 1 });
  });
});

describe("composants", () => {
  it("sonic-vector-op publie son résultat", async () => {
    set("vt.a", { d: SQ });
    set("vt.b", SQ2);
    const el = document.createElement("sonic-vector-op") as HTMLElement;
    el.setAttribute("op", "intersect");
    el.setAttribute("a", "vt.a");
    el.setAttribute("b", "vt.b");
    el.setAttribute("out-data-provider", "vt.out");
    document.body.append(el);
    await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
    const out = dp("vt.out").get() as { area: number; error: string | null };
    expect(out.error).toBeNull();
    expect((out as unknown as { status: string }).status).toBe("ready");
    expect(out.area).toBeCloseTo(25);
    set("vt.b", "M100 100 H110 V110 H100 Z");
    expect((dp("vt.out").get() as { area: number }).area).toBe(0);
    el.remove();
  });
  it("sonic-vector-op : réglages en direct par params et control, status publié", async () => {
    set("vt2.a", { d: SQ });
    set("vt2.ctl", { n: 0 });
    set("vt2.prm", {});
    const el = document.createElement("sonic-vector-op") as HTMLElement & { settings(): Record<string, unknown> };
    el.setAttribute("op", "simplify");
    el.setAttribute("a", "vt2.a");
    el.setAttribute("control", "vt2.ctl");
    el.setAttribute("params", "vt2.prm");
    el.setAttribute("out-data-provider", "vt2.out");
    document.body.append(el);
    await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
    const out = () => dp("vt2.out").get() as { status: string; area: number; d: string; error: string | null };
    expect(out()).toMatchObject({ status: "ready", error: null });
    expect(out().area).toBeCloseTo(100);
    set("vt2.ctl", { n: 0, op: "offset", delta: 2 });
    expect(out().area).toBeGreaterThan(140);
    // params l'emporte sur control.
    set("vt2.prm", { delta: -2 });
    expect(out().area).toBeCloseTo(36, 0);
    expect(el.settings()).toMatchObject({ op: "offset", delta: -2 });
    set("vt2.prm", { op: "round", radius: 3 });
    expect(out().d).toContain("Q");
    set("vt2.prm", { op: "fit", tolerance: 0.5 });
    expect(out().d).not.toContain("C");
    set("vt2.prm", { op: "nope" });
    expect(out()).toMatchObject({ status: "error" });
    expect(out().error).toMatch(/inconnue/);
    // Valeurs hors bornes ignorées ou bornées, jamais NaN.
    set("vt2.prm", { op: "offset", delta: "abc", segments: 1e9 });
    expect(el.settings()).toMatchObject({ delta: 2, segments: 64 });
    set("vt2.a", "");
    expect(out().status).toBe("idle");
    el.remove();
  });

  it("sonic-vector-library obéit au compteur", async () => {
    const el = document.createElement("sonic-vector-library") as HTMLElement;
    el.setAttribute("control", "vt.ctl");
    el.setAttribute("out-data-provider", "vt.lib");
    document.body.append(el);
    await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
    set("vt.ctl", { n: 0 });
    set("vt.ctl", { n: 1, add: { name: "a", d: SQ } });
    expect((dp("vt.lib").get() as { count: number }).count).toBe(1);
    set("vt.ctl", { n: 1, add: { name: "b", d: SQ } });
    expect((dp("vt.lib").get() as { count: number }).count).toBe(1);
    set("vt.ctl", { n: 2, add: { name: "bad", d: "??" } });
    expect((dp("vt.lib").get() as { error: string }).error).toBeTruthy();
    expect((dp("vt.lib").get() as { status: string }).status).toBe("error");
    set("vt.ctl", { n: 3, clear: true });
    expect(dp("vt.lib").get()).toMatchObject({ count: 0, status: "ready", error: null });
    el.remove();
  });
  it("utilitaires exportés", () => {
    expect(ringArea([[0, 0], [2, 0], [2, 2], [0, 2]])).toBeCloseTo(4);
    expect(multiBBox(boolean("union", pathToMulti(SQ)!, pathToMulti(SQ2)!))).toEqual({ x: 0, y: 0, w: 15, h: 15 });
  });
});
