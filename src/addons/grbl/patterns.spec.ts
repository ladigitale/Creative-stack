import { afterEach, describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { getPattern, patternParams, PATTERNS } from "./patterns";
import { analyzeGcode, prepareJob } from "./codec";
import { readSvgShapes, svgToGcode, TOOLPATH_DEFAULTS, type LaserOp } from "./toolpath";
import type { SonicLaserPattern } from "./pattern";

const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
afterEach(() => {
  document.body.innerHTML = "";
});

const LAYER_OPS: LaserOp[] = [
  { color: "#16130f", mode: "auto", power: 25, speed: 2500, passes: 1, interval: 0.2, kerf: 0 },
  { color: "#2563eb", mode: "line", power: 12, speed: 1500, passes: 1, interval: 0.1, kerf: 0 },
  { color: "#e11d48", mode: "line", power: 100, speed: 250, passes: 2, interval: 0.1, kerf: 0 },
];

describe("modèles paramétriques", () => {
  for (const def of PATTERNS) {
    it(`${def.id} : SVG lisible, à la bonne taille, programme accepté par la machine`, () => {
      const p = patternParams(def, {});
      const out = def.build(p);
      const doc = readSvgShapes(out.svg);
      expect(doc.shapes.length).toBeGreaterThan(0);
      expect(doc.unitMm).toBeCloseTo(1, 5);
      const res = svgToGcode(out.svg, { ...TOOLPATH_DEFAULTS, mode: "skip", frame: "document", ops: out.ops ?? LAYER_OPS });
      expect(res.error, def.id).toBeNull();
      const st = analyzeGcode(res.lines);
      expect(st.bbox!.w).toBeLessThanOrEqual(out.widthMm + 0.5);
      expect(st.bbox!.h).toBeLessThanOrEqual(out.heightMm + 0.5);
      expect(prepareJob(res.lines, { tool: "laser", maxS: 0 }).error).toBeNull();
    });
  }

  it("borne et arrondit les paramètres", () => {
    const box = getPattern("boite")!;
    expect(patternParams(box, { largeur: 9999, epaisseur: "3.04", couvercle: "" })).toMatchObject({ largeur: 300, epaisseur: 3, couvercle: 1 });
  });

  it("la boîte suit ses dimensions et l'épaisseur", () => {
    const box = getPattern("boite")!;
    const a = box.build(patternParams(box, { largeur: 60, profondeur: 40 }));
    const b = box.build(patternParams(box, { largeur: 120, profondeur: 40 }));
    expect(b.widthMm).toBeGreaterThan(a.widthMm + 100);
    expect(box.build(patternParams(box, { couvercle: 0 })).svg.length).toBeLessThan(a.svg.length);
  });

  it("la grille d'essais porte une opération par case", () => {
    const g = getPattern("grille")!;
    const out = g.build(patternParams(g, { puissances: 3, vitesses: 2, decoupe: 1 }));
    expect(out.ops!.length).toBe(7);
    expect(out.ops!.map((o) => o.power).slice(0, 6)).toEqual([20, 20, 60, 60, 100, 100]);
    expect(new Set(out.ops!.map((o) => o.color)).size).toBe(7);
  });
});

describe("sonic-laser-pattern", () => {
  it("publie le SVG et suit les paramètres en direct", async () => {
    set("patCtl", { pattern: "porte-cles", params: { largeur: 80 } });
    document.body.insertAdjacentHTML("beforeend", '<sonic-laser-pattern id="pat" control="patCtl"></sonic-laser-pattern>');
    const el = document.querySelector("sonic-laser-pattern") as SonicLaserPattern;
    await el.updateComplete;
    await wait(20);
    const st = get("patState") as { pattern: string; widthMm: number; svg: string; specs: unknown[]; catalog: unknown[] };
    expect(st.pattern).toBe("porte-cles");
    expect(st.widthMm).toBe(80);
    expect(st.svg).toContain('width="80mm"');
    expect(st.catalog.length).toBe(PATTERNS.length);
    set("patCtl.params.largeur", 50);
    await wait(80);
    expect((get("patState") as { widthMm: number }).widthMm).toBe(50);
    set("patCtl", { pattern: "inconnu" });
    await wait(80);
    expect(el.getState().error).toContain("modèle inconnu");
  });
});
