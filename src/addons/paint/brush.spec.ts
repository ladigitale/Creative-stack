import { describe, expect, it } from "vitest";
import { BRUSH_DEFAULTS, History, Stabilizer, StampWalker, blendOp, dabSize, sanitizeBrush, type Pt } from "./brush";

const pt = (x: number, y: number, p = 1): Pt => ({ x, y, p });
const B = { ...BRUSH_DEFAULTS, size: 20, spacing: 0.5, pressure: false };

describe("réglages", () => {
  it("mode de fusion : liste fermée, normal par défaut", () => {
    expect(BRUSH_DEFAULTS.blend).toBe("normal");
    expect(sanitizeBrush(BRUSH_DEFAULTS, { blend: "multiply" }).blend).toBe("multiply");
    expect(sanitizeBrush(BRUSH_DEFAULTS, { blend: "copy" }).blend).toBe("normal");
    expect(sanitizeBrush(BRUSH_DEFAULTS, { blend: 3 }).blend).toBe("normal");
    expect(blendOp("normal")).toBe("source-over");
    expect(blendOp("screen")).toBe("screen");
  });

  it("borne et ignore l'invalide", () => {
    const o = sanitizeBrush(BRUSH_DEFAULTS, { size: 9999, hardness: -3, opacity: 0, smoothing: 5, spacing: "x", color: "red", tool: "erase", pressure: false });
    expect(o).toMatchObject({ size: 512, hardness: 0, opacity: 0.01, smoothing: 0.95, spacing: BRUSH_DEFAULTS.spacing, color: "red", tool: "erase", pressure: false });
  });
  it("refuse les couleurs suspectes", () => {
    for (const c of ["url(javascript:1)", "red; x", "#zzz!", "", "a"]) expect(sanitizeBrush(BRUSH_DEFAULTS, { color: c }).color).toBe(BRUSH_DEFAULTS.color);
    for (const c of ["#fff", "#aabbccdd", "rgb(10, 20, 30)", "hsla(120, 50%, 50%, 0.5)", "tomato"]) expect(sanitizeBrush(BRUSH_DEFAULTS, { color: c }).color).toBe(c);
  });
  it("outil inconnu ignoré, entrée nulle tolérée", () => {
    expect(sanitizeBrush(BRUSH_DEFAULTS, { tool: "laser" }).tool).toBe("paint");
    expect(sanitizeBrush(BRUSH_DEFAULTS, null)).toEqual(BRUSH_DEFAULTS);
  });
  it("la pression module le diamètre sans le faire disparaître", () => {
    const b = { ...BRUSH_DEFAULTS, size: 100, pressure: true };
    expect(dabSize(b, 1)).toBe(100);
    expect(dabSize(b, 0)).toBeCloseTo(20);
    expect(dabSize({ ...b, pressure: false }, 0)).toBe(100);
  });
});

describe("lissage", () => {
  it("sans lissage la pointe suit le pointeur", () => {
    const s = new Stabilizer();
    s.feed(pt(0, 0), 0);
    expect(s.feed(pt(10, 10), 0)).toMatchObject({ x: 10, y: 10 });
  });
  it("avec lissage la pointe rattrape en retard et converge", () => {
    const s = new Stabilizer();
    s.feed(pt(0, 0), 0.8);
    const a = s.feed(pt(100, 0), 0.8);
    expect(a.x).toBeGreaterThan(0);
    expect(a.x).toBeLessThan(50);
    let last = a;
    for (let i = 0; i < 80; i++) last = s.feed(pt(100, 0), 0.8);
    expect(last.x).toBeGreaterThan(99.9);
    s.reset();
    expect(s.position).toBeNull();
  });
});

describe("empreintes", () => {
  it("la première position pose une empreinte", () => {
    const w = new StampWalker();
    expect(w.walk(pt(5, 5), B)).toHaveLength(1);
  });
  it("espacement régulier le long d'un segment", () => {
    const w = new StampWalker();
    w.walk(pt(0, 0), B);
    const s = w.walk(pt(100, 0), B);
    expect(s).toHaveLength(10);
    for (let i = 1; i < s.length; i++) expect(s[i].x - s[i - 1].x).toBeCloseTo(10);
  });
  it("le reste d'espacement se reporte d'un segment à l'autre", () => {
    const one = new StampWalker();
    one.walk(pt(0, 0), B);
    const a = one.walk(pt(100, 0), B);
    const two = new StampWalker();
    two.walk(pt(0, 0), B);
    const b = [...two.walk(pt(33, 0), B), ...two.walk(pt(71, 0), B), ...two.walk(pt(100, 0), B)];
    expect(b.length).toBe(a.length);
    b.forEach((p, i) => expect(p.x).toBeCloseTo(a[i].x, 5));
  });
  it("même place : rien de plus", () => {
    const w = new StampWalker();
    w.walk(pt(3, 3), B);
    expect(w.walk(pt(3, 3), B)).toEqual([]);
  });
  it("le travail d'un appel est borné", () => {
    const w = new StampWalker();
    w.walk(pt(0, 0), { ...B, size: 1, spacing: 0.02 });
    expect(w.walk(pt(1e6, 0), { ...B, size: 1, spacing: 0.02 }, 500).length).toBeLessThanOrEqual(500);
  });
  it("la pression interpolée change l'espacement", () => {
    const b = { ...B, pressure: true, size: 100, spacing: 0.5 };
    const w = new StampWalker();
    w.walk(pt(0, 0, 1), b);
    const s = w.walk(pt(400, 0, 0), b);
    const first = s[1].x - s[0].x, lastGap = s[s.length - 1].x - s[s.length - 2].x;
    expect(lastGap).toBeLessThan(first);
  });
});

describe("historique", () => {
  it("annule et rétablit", () => {
    const h = new History<string>();
    h.push("a", 1);
    h.push("b", 1);
    expect(h.undo("c", 1)).toBe("b");
    expect(h.undo("b", 1)).toBe("a");
    expect(h.undo("a", 1)).toBeNull();
    expect(h.redo("a", 1)).toBe("b");
    expect(h.canRedo).toBe(true);
    h.push("x", 1);
    expect(h.canRedo).toBe(false);
  });
  it("borne le nombre d'étapes et le coût", () => {
    const h = new History<number>(3, 100);
    for (let i = 0; i < 10; i++) h.push(i, 1);
    expect(h.undoDepth).toBe(3);
    const g = new History<number>(50, 100);
    for (let i = 0; i < 10; i++) g.push(i, 40);
    expect(g.undoDepth).toBeLessThanOrEqual(2);
    expect(g.undoDepth).toBeGreaterThanOrEqual(1);
    g.clear();
    expect(g.canUndo).toBe(false);
  });
});

import { place, rng, MAX_TIP_CHARS } from "./brush";
import { tipFromValue, tipGeometry, tipTransform } from "./tip";

describe("pointes personnalisées", () => {
  it("valide la pointe et borne les variations", () => {
    expect(sanitizeBrush(BRUSH_DEFAULTS, { tip: "M0 0L10 0L5 9Z" }).tip).toBe("M0 0L10 0L5 9Z");
    expect(sanitizeBrush(BRUSH_DEFAULTS, { tip: "not a path" }).tip).toBe("");
    expect(sanitizeBrush({ ...BRUSH_DEFAULTS, tip: "M0 0L1 1" }, { tip: "not a path" }).tip).toBe("M0 0L1 1");
    expect(sanitizeBrush(BRUSH_DEFAULTS, { tip: "M0 0" + "L1 1".repeat(MAX_TIP_CHARS) }).tip).toBe("");
    const b = sanitizeBrush(BRUSH_DEFAULTS, { angle: 999, sizeJitter: 5, scatter: -1, roundness: 0, angleJitter: 500, angleFollow: true });
    expect([b.angle, b.sizeJitter, b.scatter, b.roundness, b.angleJitter, b.angleFollow]).toEqual([360, 1, 0, 0.05, 180, true]);
  });
  it("place les empreintes de façon reproductible", () => {
    const b = sanitizeBrush(BRUSH_DEFAULTS, { sizeJitter: 0.5, scatter: 1, angleJitter: 40 });
    const run = (seed: number) => { const r = rng(seed); return [1, 2, 3].map((i) => place({ x: i * 10, y: 0, p: 1, a: 0 }, b, r)); };
    expect(run(5)).toEqual(run(5));
    expect(run(5)).not.toEqual(run(6));
  });
  it("sans variation, l'empreinte est exactement au point", () => {
    const pl = place({ x: 7, y: 9, p: 1, a: 1 }, { ...BRUSH_DEFAULTS, pressure: false, size: 20 }, rng(1));
    expect(pl).toEqual({ x: 7, y: 9, size: 20, rot: 0, squash: 1 });
  });
  it("angle-follow ajoute la direction du tracé", () => {
    const pl = place({ x: 0, y: 0, p: 1, a: Math.PI / 2 }, { ...BRUSH_DEFAULTS, angleFollow: true, angle: 90 }, rng(1));
    expect(pl.rot).toBeCloseTo(Math.PI);
  });
  it("le marcheur donne la direction", () => {
    const w = new StampWalker();
    const b = { ...BRUSH_DEFAULTS, pressure: false, size: 10 };
    w.walk({ x: 0, y: 0, p: 1 }, b);
    const out = w.walk({ x: 0, y: 100, p: 1 }, b);
    expect(out.length).toBeGreaterThan(10);
    expect(out[0].a).toBeCloseTo(Math.PI / 2);
  });
  it("géométrie de pointe : boîte unité centrée", () => {
    const g = tipGeometry("M10 10L30 10L30 20L10 20Z")!;
    expect(g.cx).toBe(20);
    expect(g.cy).toBe(15);
    expect(g.k).toBeCloseTo(1 / 20);
    expect(tipGeometry("M5 5L5 5Z")).toBeNull();
    expect(tipGeometry("rien")).toBeNull();
    expect(tipTransform(g, 100, 50, 40, 0)).toBe("translate(100 50) scale(2 2) translate(-20 -15)");
  });
  it("lit une forme depuis un DataProvider", () => {
    expect(tipFromValue("M0 0L1 1")).toBe("M0 0L1 1");
    expect(tipFromValue({ d: "M0 0L2 2" })).toBe("M0 0L2 2");
    expect(tipFromValue({ shape: { d: "M0 0L3 3" } })).toBe("M0 0L3 3");
    expect(tipFromValue(42)).toBe("");
  });
});
