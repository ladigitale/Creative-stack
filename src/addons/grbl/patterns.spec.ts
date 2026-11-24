import { afterEach, describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { CUT, ENGRAVE, getPattern, patternParams, PATTERNS } from "./patterns";
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

describe("motifs génératifs", () => {
  const ids = ["subdivision", "arbre", "corail", "spirographe", "guilloche", "rosace", "truchet", "labyrinthe", "flux", "harmonographe", "ondes", "repetition"];
  for (const id of ids) {
    it(`${id} : SVG gravé au trait, cadré, en moins d'une seconde`, () => {
      const def = getPattern(id)!;
      expect(def.family).toBe("motifs");
      const t = performance.now();
      const out = def.build(patternParams(def, {}));
      expect(performance.now() - t).toBeLessThan(1500);
      expect(out.svg).toContain(`stroke="${ENGRAVE}"`);
      expect(out.widthMm).toBe(100);
      // Tout tient dans le format.
      const nums = [...out.svg.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      expect(nums.length).toBeGreaterThan(10);
      for (const [x, y] of nums) { expect(x).toBeGreaterThanOrEqual(-0.01); expect(y).toBeGreaterThanOrEqual(-0.01); expect(x).toBeLessThanOrEqual(100.01); expect(y).toBeLessThanOrEqual(100.01); }
    });
  }

  it("cadre disque : tout dans le cercle, contour découpé ; la graine change le motif", () => {
    const def = getPattern("arbre")!;
    const a = def.build(patternParams(def, { cadre: 2, largeur: 80, hauteur: 120 }));
    expect(a.widthMm).toBe(80);
    expect(a.svg).toContain(`stroke="${CUT}"`);
    const b = def.build(patternParams(def, { cadre: 2, largeur: 80, hauteur: 120, graine: 2 }));
    expect(b.svg).not.toBe(a.svg);
  });

  it("paramètres à choix : options exposées, valeur = index", () => {
    const def = getPattern("repetition")!;
    const rep = def.params.find((s) => s.key === "repetition")!;
    expect(rep.options?.length).toBe(rep.max + 1);
    for (let i = 0; i <= rep.max; i++) expect(def.build(patternParams(def, { repetition: i })).svg).toContain("<path");
  });
});

describe("subdivision", () => {
  it("chaque découpage, avec retrait et remplissages, reste dans le format", () => {
    const def = getPattern("subdivision")!;
    for (let mode = 0; mode < 5; mode++) for (const extra of [{}, { retrait: 1, remplissage: 5 }]) {
      const out = def.build(patternParams(def, { mode, ...extra }));
      const nums = [...out.svg.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      expect(nums.length, `mode ${mode}`).toBeGreaterThan(8);
      for (const [x, y] of nums) { expect(x).toBeGreaterThanOrEqual(-0.01); expect(x).toBeLessThanOrEqual(100.01); expect(y).toBeGreaterThanOrEqual(-0.01); expect(y).toBeLessThanOrEqual(100.01); }
    }
  });

  it("profondeur forcée : un quadtree complet a 4^n feuilles et ses bords communs ne sont tracés qu'une fois", () => {
    const def = getPattern("subdivision")!;
    const out = def.build(patternParams(def, { mode: 1, profondeur: 3, minimum: 3, irregularite: 0, ecart: 0 }));
    // Grille 8 × 8 sur 100 mm : 9 lignes et 9 colonnes de 100 mm = 1 800 mm de trait.
    const len = [...out.svg.matchAll(/d="([^"]+)"/g)].flatMap((m) => m[1].split("M").filter(Boolean)).reduce((s, sub) => {
      const pts = sub.split("L").map((p) => p.trim().split(" ").map(Number));
      let l = 0;
      for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      return s + l;
    }, 0);
    expect(len).toBeCloseTo(1800, 0);
  });
});
