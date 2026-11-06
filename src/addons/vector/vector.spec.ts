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
    expect(out.area).toBeCloseTo(25);
    set("vt.b", "M100 100 H110 V110 H100 Z");
    expect((dp("vt.out").get() as { area: number }).area).toBe(0);
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
    set("vt.ctl", { n: 3, clear: true });
    expect((dp("vt.lib").get() as { count: number }).count).toBe(0);
    el.remove();
  });
  it("utilitaires exportés", () => {
    expect(ringArea([[0, 0], [2, 0], [2, 2], [0, 2]])).toBeCloseTo(4);
    expect(multiBBox(boolean("union", pathToMulti(SQ)!, pathToMulti(SQ2)!))).toEqual({ x: 0, y: 0, w: 15, h: 15 });
  });
});
