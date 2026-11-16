import { describe, expect, it } from "vitest";
import { burnsToGcode, LINE_STYLES, photoBurns } from "./photo";
import { boxMean, dither, DITHER_MODES } from "../../shared/raster1bit";
import { analyzeGcode, prepareJob } from "./codec";
import { colorsOf, readSvgShapes, svgToGcode, TOOLPATH_DEFAULTS } from "./toolpath";

/** Dégradé horizontal : noir à gauche, blanc à droite. */
function ramp(w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = (x / (w - 1)) * 255;
  return g;
}

describe("tramages partagés (shared/raster1bit)", () => {
  it("chaque tramage rend un dégradé de plus en plus clair", () => {
    const w = 96, h = 24;
    const g = ramp(w, h);
    for (const mode of DITHER_MODES.filter((m) => m !== "adaptive")) {
      const bits = dither(g, w, h, mode, 128).bits;
      const part = (x0: number, x1: number) => {
        let n = 0;
        for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) n += bits[y * w + x];
        return n / ((x1 - x0) * h);
      };
      expect(part(0, 24), mode).toBeGreaterThan(part(72, 96));
    }
  });

  it("le seuil local garde un détail dans une zone sombre", () => {
    const w = 40, h = 40;
    const g = new Float32Array(w * h).fill(40);
    for (let y = 18; y < 22; y++) for (let x = 0; x < w; x++) g[y * w + x] = 10;
    expect(dither(g, w, h, "adaptive", 128).bits[20 * w + 20]).toBe(1);
    expect(dither(g, w, h, "adaptive", 128).bits[5 * w + 20]).toBe(0);
    expect(dither(g, w, h, "threshold", 128).bits[5 * w + 20]).toBe(1);
    const flat = new Float32Array(64).fill(100);
    expect(Array.from(boxMean(flat, 8, 8, 2)).every((v) => Math.abs(v - 100) < 1e-3)).toBe(true);
  });
});

describe("rendus en traits", () => {
  const W = 20, H = 10, w = 100, h = 50;
  const base = { widthMm: W, heightMm: H, spacing: 1, step: 0.2, s: 800, minS: 0, levels: 6, seed: 3 };

  for (const style of LINE_STYLES.filter((x) => x !== "isolines")) {
    it(`${style} : plus de matière à gauche (sombre) qu'à droite, dans le cadre`, () => {
      const burns = photoBurns(ramp(w, h), w, h, { ...base, style });
      expect(burns.length).toBeGreaterThan(0);
      let left = 0, right = 0;
      for (const b of burns) {
        for (let i = 1; i < b.pts.length; i++) {
          const s = Array.isArray(b.s) ? b.s[i] : b.s;
          if (!s) continue;
          const [x0, y0] = b.pts[i - 1], [x1, y1] = b.pts[i];
          const len = Math.hypot(x1 - x0, y1 - y0) || 0.05;
          if ((x0 + x1) / 2 < W / 2) left += len * s; else right += len * s;
        }
        for (const [x, y] of b.pts) {
          expect(x).toBeGreaterThanOrEqual(-0.001);
          expect(x).toBeLessThanOrEqual(W + 0.3);
          expect(y).toBeGreaterThanOrEqual(-0.001);
          expect(y).toBeLessThanOrEqual(H + 0.001);
        }
      }
      expect(left).toBeGreaterThan(right);
    });
  }

  it("isolines : une ligne de niveau par palier sur un dégradé", () => {
    const burns = photoBurns(ramp(w, h), w, h, { ...base, style: "isolines", levels: 5 });
    expect(burns.length).toBe(5);
    for (const b of burns) {
      const xs = b.pts.map((p) => p[0]);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.5);
    }
  });

  it("une image blanche ne produit rien", () => {
    const white = new Float32Array(w * h).fill(255);
    for (const style of LINE_STYLES) {
      const lines = burnsToGcode(photoBurns(white, w, h, { ...base, style }), { xMm: 0, yMm: 0, speed: 1000, returnHome: true, maxLines: 100000 });
      expect(lines, style).toEqual([]);
    }
  });

  it("le G-code des traits est décalé, en M4, accepté par la machine", () => {
    const lines = burnsToGcode(photoBurns(ramp(w, h), w, h, { ...base, style: "hatch" }), { xMm: 5, yMm: 7, speed: 1200, returnHome: true, maxLines: 100000 }) as string[];
    expect(lines.slice(0, 4)).toEqual(["G90", "G21", "M5", "M4S0"]);
    const st = analyzeGcode(lines);
    const g0 = lines.filter((l) => l.startsWith("G0X") && l !== "G0X0Y0").map((l) => Number(/X([\d.]+)/.exec(l)![1]));
    expect(Math.min(...g0)).toBeGreaterThanOrEqual(4.99);
    expect(st.maxS).toBe(800);
    expect(prepareJob(lines, { tool: "laser", maxS: 0 }).error).toBeNull();
  });
});

describe("couleurs d'un SVG quelconque", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <style>.cut{fill:none;stroke:#FF0000}.ink{fill:#333}</style>
    <rect x="0" y="0" width="100" height="100" class="cut"/>
    <circle cx="50" cy="50" r="20" class="ink"/>
    <circle cx="20" cy="20" r="5" fill="#333333"/>
    <path d="M10 90 L90 90" stroke="green" fill="none"/>
  </svg>`;

  it("liste les couleurs avec leurs surfaces et leurs traits", () => {
    expect(colorsOf(readSvgShapes(svg))).toEqual([
      { color: "#333333", fill: 2, stroke: 0 },
      { color: "#ff0000", fill: 0, stroke: 1 },
      { color: "#008000", fill: 0, stroke: 1 },
    ]);
  });

  it("une couleur non attribuée ne brûle pas, et l'erreur le dit", () => {
    const res = svgToGcode(svg, { ...TOOLPATH_DEFAULTS, mode: "skip", ops: [] });
    expect(res.error).toContain("attribuée");
    expect(res.colors.length).toBe(3);
    const ok = svgToGcode(svg, { ...TOOLPATH_DEFAULTS, mode: "skip", ops: [{ color: "#ff0000", mode: "line", power: 90, speed: 300, passes: 1, interval: 0.1, kerf: 0 }] });
    expect(ok.error).toBeNull();
    expect(ok.lines).toContain(";op #ff0000");
    expect(ok.lines.filter((l) => l.includes("S900")).length).toBe(1);
  });
});
