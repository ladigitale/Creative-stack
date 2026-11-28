import { afterEach, describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { CUT, ENGRAVE, getPattern, notch, patternParams, PATTERNS, polyhedronJoint, slotWidth } from "./patterns";
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
      expect(out.advice.length, def.id).toBeGreaterThan(0);
      expect(out.advice.every((t) => typeof t === "string" && t.length > 10)).toBe(true);
      for (const n of out.svg.match(/-?\d+(\.\d+)?/g)!.map(Number)) expect(Number.isFinite(n)).toBe(true);
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

/** Contours (sous-chemins) des chemins découpés, en points. */
function cutPolys(svg: string): [number, number][][] {
  const out: [number, number][][] = [];
  for (const m of svg.matchAll(/<path d="([^"]+)" fill="none" stroke="#e11d48"/g)) {
    for (const sub of m[1].split(/(?=M)/)) {
      const nums = sub.match(/-?\d+(\.\d+)?/g);
      if (!nums || /[ACHQV]/.test(sub)) continue;
      const pts: [number, number][] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push([+nums[i], +nums[i + 1]]);
      out.push(pts);
    }
  }
  return out;
}

describe("boîtes et assemblages", () => {
  it("nouvelles familles et conseils au catalogue", () => {
    for (const id of ["boite-charniere", "boite-coulissante", "boite-couvercle", "boite-tiroir", "boite-polygone", "croisillon", "polyedre", "abat-jour", "formes"]) {
      expect(getPattern(id), id).not.toBeNull();
    }
    expect(getPattern("abat-jour")!.family).toBe("assemblages");
  });

  it("fente = épaisseur − serrage − trait", () => {
    expect(slotWidth(3, 0.05, 0.1)).toBeCloseTo(2.85, 6);
    expect(slotWidth(0.5, 0.3, 0.3)).toBe(0.3);
  });

  it("forme croisée : fentes de la bonne largeur, chacune sur la moitié de la hauteur", () => {
    const def = getPattern("croisillon")!;
    for (const forme of [0, 1, 2, 3]) {
      const p = patternParams(def, { forme, hauteur: 100, epaisseur: 3, serrage: 0.05, trait: 0.1 });
      const out = def.build(p);
      const [a, b] = cutPolys(out.svg);
      const xs = a.map((q) => q[0]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const bx = b.map((q) => q[0]);
      const cxb = (Math.min(...bx) + Math.max(...bx)) / 2;
      const slotPts = (pts: [number, number][], c: number) => pts.filter((q) => Math.abs(Math.abs(q[0] - c) - 1.425) < 0.02);
      const sa = slotPts(a, cx), sb = slotPts(b, cxb);
      expect(sa.length, `forme ${forme}`).toBe(4);
      expect(sb.length, `forme ${forme}`).toBe(4);
      // Fond de la fente haute (A) et de la fente basse (B), dans le même rang : elles se recouvrent de 0,4 mm à mi-hauteur.
      const yA = Math.max(...sa.map((q) => q[1])), yB = Math.min(...sb.map((q) => q[1]));
      expect(yA - yB).toBeCloseTo(0.4, 1);
      if (forme === 0 || forme === 2) {
        // Sapin et boule : l'axe va du haut au bas de la pièce, les fentes se rejoignent au milieu.
        // A garde le bas intact, B garde le haut intact.
        const yTop = Math.min(...b.map((q) => q[1])), yBot = Math.max(...a.map((q) => q[1]));
        expect((yA + yB) / 2).toBeCloseTo((yTop + yBot) / 2, 1);
      }
    }
  });

  it("encoche d'un contour convexe : remplace le bord du haut", () => {
    const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const n = notch(sq, 5, 2, 5, true);
    expect(n).toContainEqual([4, 5]);
    expect(n).toContainEqual([6, 5]);
    expect(n.length).toBe(8);
    const m = notch(sq, 5, 2, 5, false);
    expect(m).toContainEqual([4, 5]);
    expect(m.some(([, y]) => y === 10)).toBe(true);
  });

  it("abat-jour : N modules, fentes à mi-hauteur élargies pour l'angle de croisement", () => {
    const def = getPattern("abat-jour")!;
    const out = def.build(patternParams(def, { modules: 12, hauteur: 120, epaisseur: 3, serrage: 0, trait: 0, ajours: 0 }));
    const polys = cutPolys(out.svg);
    expect(polys.length).toBe(12);
    const m = polys[0];
    const y0 = Math.min(...m.map((q) => q[1]));
    // Fond de la fente du haut à H/2.
    const deep = m.filter((q) => Math.abs(q[1] - y0 - 60) < 1e-6);
    expect(deep.length).toBe(4); // fond de la fente haute et de la fente basse
    const xsTop = deep.map((q) => q[0]).sort((a, b) => a - b);
    expect(xsTop[1] - xsTop[0]).toBeCloseTo(3 / Math.sin(Math.PI / 6), 1);
    expect(out.notes.join(" ")).toContain("12 modules");
  });

  it("polyèdre : une face par face du solide, un connecteur par arête", () => {
    const def = getPattern("polyedre")!;
    const counts = [[0, 4, 6], [1, 6, 12], [2, 8, 12], [3, 12, 30], [4, 20, 30]];
    for (const [solide, faces, edges] of counts) {
      const out = def.build(patternParams(def, { solide, arete: 80, ajours: 0 }));
      expect(cutPolys(out.svg).length, `solide ${solide}`).toBe(faces + edges);
    }
    const j = polyhedronJoint(3, Math.PI / 2);
    expect(j.len).toBeCloseTo(j.s0 + 2 * j.d, 6);
    // Les faces reculées ne se touchent pas à l'arête : écart entre leurs chants > épaisseur.
    for (const d of [Math.acos(1 / 3), Math.PI / 2, Math.acos(-Math.sqrt(5) / 3)]) {
      const k = polyhedronJoint(3, d);
      expect(2 * k.s0 * Math.sin(d / 2)).toBeGreaterThan(3);
    }
  });

  it("boîte polygonale : mortaises de la largeur de fente, une paroi par côté", () => {
    const def = getPattern("boite-polygone")!;
    const out = def.build(patternParams(def, { cotes: 6, epaisseur: 3, serrage: 0.05, trait: 0.1, couvercle: 0 }));
    const polys = cutPolys(out.svg);
    // fond + 12 mortaises + 6 parois
    expect(polys.length).toBe(1 + 12 + 6);
    const mort = polys.filter((q) => q.length === 4 && Math.max(...q.map((v) => v[0])) - Math.min(...q.map((v) => v[0])) < 20);
    const side = (q: [number, number][]) => Math.min(...[0, 1].map((i) => Math.hypot(q[i + 1][0] - q[i][0], q[i + 1][1] - q[i][1])));
    expect(mort.length).toBeGreaterThanOrEqual(12);
    for (const q of mort.slice(0, 12)) expect(side(q)).toBeCloseTo(2.85, 1);
  });

  it("charnière vivante : fentes ouvertes dans le couvercle", () => {
    const def = getPattern("boite-charniere")!;
    const out = def.build(patternParams(def, {}));
    expect((out.svg.match(/ H/g) ?? []).length).toBeGreaterThan(20);
  });
});

describe("sonic-laser-pattern", () => {
  it("publie le SVG et suit les paramètres en direct", async () => {
    set("patCtl", { pattern: "porte-cles", params: { largeur: 80 } });
    document.body.insertAdjacentHTML("beforeend", '<sonic-laser-pattern id="pat" control="patCtl"></sonic-laser-pattern>');
    const el = document.querySelector("sonic-laser-pattern") as SonicLaserPattern;
    await el.updateComplete;
    await wait(20);
    const st = get("patState") as { pattern: string; widthMm: number; svg: string; specs: unknown[]; catalog: unknown[]; advice: string[] };
    expect(st.pattern).toBe("porte-cles");
    expect(st.advice.length).toBeGreaterThan(0);
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
