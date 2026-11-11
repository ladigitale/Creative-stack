import { describe, expect, it } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { denoise, label, quantize, readSettings, ringToCurve, smoothRing, toSvg, trace, traceMask, type RGBA } from "./index";
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
  it("palette imposée : les couleurs sont exactement celles données, les absentes ne font pas de couche", () => {
    const r = trace(square, { palette: ["#ff0000", "#fff", "#00ff00", "pas une couleur"], tolerance: 0.5 });
    expect(r.layers.map((l) => l.color).sort()).toEqual(["#ff0000", "#ffffff"]);
    expect(r.layers.find((l) => l.color === "#ff0000")!.area).toBeCloseTo(400, -1);
  });
  it("palette lue en tableau, en chaîne ou depuis l'état de sonic-palette", () => {
    expect(readSettings({ palette: ["#ff0000", "#00ff00"] }).palette).toEqual(["#ff0000", "#00ff00"]);
    expect(readSettings({ palette: "#ff0000, #00ff00" }).palette).toEqual(["#ff0000", "#00ff00"]);
    expect(readSettings({ palette: { colors: ["#123456"] } }).palette).toEqual(["#123456"]);
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
    expect(r.layers.some((l) => l.d.includes("Q"))).toBe(true);
    const blue = r.layers.find((l) => l.color.endsWith("dc") || l.color.startsWith("#1"))!;
    // couche empilée : bleu + rouge (le rouge est dessiné par-dessus)
    expect(Math.abs(blue.area / (Math.PI * 400 + 600) - 1)).toBeLessThan(0.1);
  });
  it("écarte les taches minuscules", () => {
    const img = image(40, 40, (x, y) => (x === 5 && y === 5 ? RED : WHITE));
    expect(trace(img, { colors: 2, denoise: 0, minArea: 4 }).layers.length).toBe(1);
  });
  it("courbes : aucun point de contrôle hors de l'image (pas de débordement)", () => {
    const img = image(80, 60, (x, y) => ((x - 25) ** 2 + (y - 30) ** 2 < 400 ? RED : x >= 45 && x < 70 && y >= 10 && y < 50 ? BLUE : WHITE));
    const r = trace(img, { colors: 3, curves: true });
    for (const l of r.layers) {
      const nums = l.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
      for (let i = 0; i < nums.length; i += 2) {
        expect(nums[i]).toBeGreaterThanOrEqual(-1);
        expect(nums[i]).toBeLessThanOrEqual(81);
        expect(nums[i + 1]).toBeGreaterThanOrEqual(-1);
        expect(nums[i + 1]).toBeLessThanOrEqual(61);
      }
    }
  });
  it("courbes : un rectangle garde ses coins vifs", () => {
    expect(ringToCurve([[0, 0], [40, 0], [40, 30], [0, 30]], 1)).toBe("M0 0L40 0L40 30L0 30Z");
  });
  it("lisse l'escalier d'une diagonale et garde les vrais coins", () => {
    const stairs: [number, number][] = [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2], [3, 2], [3, 3], [0, 3]];
    const s = smoothRing(stairs);
    // les marches d'un pixel ne sont plus des sommets, seulement des milieux d'arêtes
    expect(s.some((p) => p[0] === 1 && p[1] === 1)).toBe(false);
    const rect = smoothRing([[0, 0], [10, 0], [10, 8], [0, 8]]);
    expect(rect).toContainEqual([10, 8]);
  });
  it("palette : retrouve 4 aplats malgré l'anticrénelage", () => {
    const COLS: [number, number, number, number][] = [[244, 227, 178, 255], [217, 79, 48, 255], [42, 111, 151, 255], [56, 102, 65, 255]];
    const img = image(120, 90, (x, y) => {
      // bords adoucis : un pixel de transition entre chaque zone
      const zone = x < 40 ? 0 : x < 80 ? 1 : y < 45 ? 2 : 3;
      const edge = x === 40 || x === 80 || (x > 80 && y === 45);
      if (!edge) return COLS[zone];
      const prev = x === 40 ? 0 : x === 80 ? 1 : 2;
      return COLS[prev].map((v, i) => (i < 3 ? (v + COLS[zone][i]) / 2 : 255)) as [number, number, number, number];
    });
    const pal = quantize(img, 4);
    for (const c of COLS) expect(pal.some((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) < 20)).toBe(true);
  });
  it("le filtre efface un liseré d'un pixel", () => {
    const lab = new Int16Array(49);
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) lab[y * 7 + x] = x < 3 ? 0 : x === 3 ? 2 : 1;
    const out = denoise(lab, 7, 7, 1, 3);
    for (let y = 1; y < 6; y++) expect(out[y * 7 + 3]).not.toBe(2);
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
    expect(toSvg(trace(square, { colors: 2 }), { width: 400, height: 400 })).toContain('width="400" height="400"');
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
  it("lit les réglages dans control et params (bornés)", () => {
    expect(readSettings({ n: 3, colors: 99, tolerance: "1.5", curves: 1, flat: false, "max-size": 800 }))
      .toEqual({ colors: 32, tolerance: 1.5, curves: true, flat: false, maxSize: 800 });
    expect(readSettings(null)).toEqual({});
  });
  it("réglages pilotés par DataProvider et sortie complète", async () => {
    const still = document.createElement("canvas") as HTMLCanvasElement & { frameSeq: number; getFrameCanvas: () => HTMLCanvasElement };
    still.id = "vz-src";
    still.width = 40; still.height = 40;
    still.frameSeq = 1;
    still.getFrameCanvas = () => still;
    document.body.append(still);
    const el = document.createElement("sonic-vectorize") as HTMLElement & { run: () => boolean; settings: () => { colors: number; curves: boolean } };
    el.setAttribute("source", "#vz-src");
    el.setAttribute("control", "vz.ctl3");
    el.setAttribute("params", "vz.par3");
    el.setAttribute("out-data-provider", "vz.out3");
    set("vz.ctl3", { n: 0, colors: 4, curves: true });
    document.body.append(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(el.settings().colors).toBe(4);
    expect(el.settings().curves).toBe(true);
    set("vz.par3", { colors: 6 });
    expect(el.settings().colors).toBe(6);
    const out = dp("vz.out3").get() as { settings: { colors: number }; status: string };
    expect(out.settings.colors).toBe(4);
    el.remove();
    still.remove();
  });
});

describe("sonic-vectorize svg-from", () => {
  it("un SVG ouvert est lu tel quel (source svg, opacités, keep-colors), une seule fois par fichier", async () => {
    const { vi } = await import("vitest");
    const { svgRefOf } = await import("./vectorize");
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      fetched.push(u);
      return { text: async () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 40"><rect width="10" height="10" fill="#ff0000" fill-opacity=".5"/><circle cx="30" cy="20" r="5" fill="navy"/></svg>' };
    }));
    expect(svgRefOf({ url: "blob:a", mime: "image/svg+xml" })).toEqual({ url: "blob:a" });
    expect(svgRefOf({ url: "blob:a", mime: "image/png" })).toBeNull();
    expect(svgRefOf({ url: "https://x/a.svg", mime: "image/svg+xml" })).toBeNull();
    set("svgFichier", null);
    const el = document.createElement("sonic-vectorize");
    el.setAttribute("svg-from", "svgFichier");
    el.setAttribute("auto", "");
    el.setAttribute("keep-colors", "");
    el.setAttribute("out-data-provider", "svgVec");
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    set("svgFichier", { url: "blob:fichier1", mime: "image/svg+xml" });
    await new Promise((r) => setTimeout(r, 20));
    const s = dp("svgVec").get() as { status: string; source: string; width: number; height: number; keepColors: boolean; paths: { color: string; opacity?: number }[] };
    expect(s).toMatchObject({ status: "ready", source: "svg", width: 50, height: 40, keepColors: true });
    expect(s.paths.map((p) => [p.color, p.opacity])).toEqual([["#ff0000", 0.5], ["#000080", 1]]);
    // Le même fichier relu par une source d'images : pas de nouvelle lecture.
    (el as unknown as { run(q: boolean): boolean }).run(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetched).toEqual(["blob:fichier1"]);
    el.remove();
    vi.unstubAllGlobals();
  });
});

describe("sonic-vectorize : palette imposée et fond retiré sur un SVG lu", () => {
  it("couleurs ramenées à la palette, couche du dessous retirée, sans relire le fichier", async () => {
    const { vi } = await import("vitest");
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      reads++;
      return { text: async () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#fafafa"/><rect width="4" height="4" fill="#e01010"/><rect x="5" width="4" height="4" fill="#1010d0"/></svg>' };
    }));
    set("svgOpt", null);
    set("svgOptParams", {});
    const el = document.createElement("sonic-vectorize");
    for (const [k, v] of Object.entries({ "svg-from": "svgOpt", auto: "", params: "svgOptParams", "out-data-provider": "svgOptVec" })) el.setAttribute(k, v);
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    set("svgOpt", { url: "blob:opt", mime: "image/svg+xml" });
    await new Promise((r) => setTimeout(r, 20));
    const cols = () => (dp("svgOptVec").get() as { paths: { color: string }[] }).paths.map((p) => p.color);
    expect(cols()).toEqual(["#fafafa", "#e01010", "#1010d0"]);
    set("svgOptParams", { palette: ["#ff0000", "#0000ff", "#ffffff"], dropBase: true });
    await new Promise((r) => setTimeout(r, 80));
    expect(cols()).toEqual(["#ff0000", "#0000ff"]);
    set("svgOptParams", { palette: [], dropBase: false });
    await new Promise((r) => setTimeout(r, 80));
    expect(cols()).toEqual(["#fafafa", "#e01010", "#1010d0"]);
    expect(reads).toBe(1);
    el.remove();
    vi.unstubAllGlobals();
  });
});
