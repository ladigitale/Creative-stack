import { describe, expect, it } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { denoise, label, quantize, toSvg, trace, traceMask, type RGBA } from "./index";
import { parsePath } from "../vector/svgpath";

function image(w: number, h: number, paint: (x: number, y: number) => [number, number, number, number]): RGBA {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(paint(x, y), (y * w + x) * 4);
  return { data, width: w, height: h };
}
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const RED: [number, number, number, number] = [220, 20, 20, 255];
const BLUE: [number, number, number, number] = [20, 20, 220, 255];
const square = image(40, 40, (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 30 ? RED : WHITE));

describe("contours", () => {
  it("suit un carré", () => {
    const m = new Uint8Array(25);
    for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) m[y * 5 + x] = 1;
    const rings = traceMask(m, 5, 5);
    expect(rings.length).toBe(1);
    expect(rings[0].length).toBe(4);
  });
  it("suit un anneau : deux contours", () => {
    const m = new Uint8Array(49);
    for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) m[y * 7 + x] = 1;
    m[3 * 7 + 3] = 0;
    expect(traceMask(m, 7, 7).length).toBe(2);
  });
  it("sépare deux pixels en diagonale sans boucler", () => {
    const m = new Uint8Array(9);
    m[0] = 1; m[4] = 1;
    const rings = traceMask(m, 3, 3);
    expect(rings.length).toBeGreaterThanOrEqual(2);
  });
});

describe("palette", () => {
  it("retrouve les couleurs dominantes", () => {
    const pal = quantize(square, 2);
    expect(pal.length).toBe(2);
    expect(pal.some((c) => c[0] > 200 && c[1] < 60)).toBe(true);
    expect(pal.some((c) => c[1] > 240)).toBe(true);
  });
  it("ignore le transparent", () => {
    const img = image(4, 4, () => [0, 0, 0, 0]);
    expect(quantize(img, 4)).toEqual([]);
    expect(trace(img).layers).toEqual([]);
    expect(Array.from(label(img, [[0, 0, 0]])).every((v) => v === -1)).toBe(true);
  });
  it("le filtre retire un pixel isolé", () => {
    const lab = new Int16Array(25);
    lab[12] = 1;
    expect(denoise(lab, 5, 5, 1, 2)[12]).toBe(0);
  });
});

describe("vectorisation", () => {
  it("produit un fond et une forme rouge", () => {
    const r = trace(square, { colors: 2, tolerance: 0.5 });
    expect(r.layers.length).toBe(2);
    const red = r.layers.find((l) => l.color.startsWith("#d") || l.color.startsWith("#c"))!;
    expect(red).toBeTruthy();
    expect(red.area).toBeCloseTo(400, -1);
    expect(parsePath(red.d)).not.toBeNull();
  });
  it("les couches s'empilent du plus grand au plus petit", () => {
    const r = trace(square, { colors: 2 });
    expect(r.layers[0].area).toBeGreaterThanOrEqual(r.layers[1].area);
    expect(r.layers[0].area).toBeCloseTo(1600, -1);
  });
  it("mode à plat : le fond a un trou", () => {
    const r = trace(square, { colors: 2, stack: false });
    expect(r.layers[0].area).toBeCloseTo(1200, -1);
  });
  it("trois couleurs, courbes", () => {
    const img = image(60, 60, (x, y) => ((x - 30) ** 2 + (y - 30) ** 2 < 400 ? BLUE : x < 10 ? RED : WHITE));
    const r = trace(img, { colors: 3, curves: true, tolerance: 0.6 });
    expect(r.layers.length).toBe(3);
    expect(r.layers.some((l) => l.d.includes("C"))).toBe(true);
    const blue = r.layers.find((l) => l.color.endsWith("dc") || l.color.startsWith("#1"))!;
    // couche empilée : bleu + rouge (le rouge est dessiné par-dessus)
    expect(Math.abs(blue.area / (Math.PI * 400 + 600) - 1)).toBeLessThan(0.1);
  });
  it("écarte les taches minuscules", () => {
    const img = image(40, 40, (x, y) => (x === 5 && y === 5 ? RED : WHITE));
    expect(trace(img, { colors: 2, denoise: 0, minArea: 4 }).layers.length).toBe(1);
  });
  it("plafonne la taille du résultat", () => {
    expect(trace(square, { colors: 2, maxChars: 10 }).truncated).toBe(true);
  });
  it("refuse les images énormes ou vides", () => {
    expect(() => trace({ data: [], width: 0, height: 0 })).toThrow();
    expect(() => trace({ data: [], width: 3000, height: 3000 })).toThrow();
  });
  it("document SVG autonome", () => {
    const s = toSvg(trace(square, { colors: 2 }));
    expect(s.startsWith("<svg")).toBe(true);
    expect(s).toContain("viewBox=\"0 0 40 40\"");
    expect(s).not.toMatch(/<script|on\w+=/);
  });
  it("grande image en temps raisonnable", () => {
    const big = image(256, 256, (x, y) => ((x >> 5) + (y >> 5)) % 2 ? RED : (x + y) % 97 === 0 ? BLUE : WHITE);
    const t0 = performance.now();
    const r = trace(big, { colors: 6 });
    expect(r.layers.length).toBeGreaterThan(1);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});

describe("composant", () => {
  it("signale une source absente", async () => {
    const el = document.createElement("sonic-vectorize") as HTMLElement & { run: () => boolean };
    el.setAttribute("source", "#nope");
    el.setAttribute("out-data-provider", "vz.out");
    document.body.append(el);
    el.run();
    expect((dp("vz.out").get() as { status: string }).status).toBe("error");
    el.remove();
  });
  it("lance sur hausse du compteur", async () => {
    const el = document.createElement("sonic-vectorize") as HTMLElement & { run: () => boolean };
    el.setAttribute("source", "#nope");
    el.setAttribute("control", "vz.ctl");
    el.setAttribute("out-data-provider", "vz.out2");
    document.body.append(el);
    set("vz.ctl", { n: 0 });
    expect((dp("vz.out2").get() as { status: string }).status).toBe("idle");
    set("vz.ctl", { n: 1 });
    expect((dp("vz.out2").get() as { status: string }).status).toBe("error");
    el.remove();
  });
});
