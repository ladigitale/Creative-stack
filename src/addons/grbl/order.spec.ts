import { describe, expect, it } from "vitest";
import { islands, orderBlocks, orderPaths, travelOf, type OrderPath } from "./order";
import { analyzeGcode, svgToGcode, TOOLPATH_DEFAULTS } from "./index";

type P = [number, number];
const square = (x: number, y: number, s: number): OrderPath => ({ pts: [[x, y], [x + s, y], [x + s, y + s], [x, y + s]] as P[], closed: true });
// Générateur déterministe : mêmes formes à chaque exécution.
const rand = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

describe("ordre des parcours", () => {
  it("contours dispersés : bien moins de trajet à vide que dans l'ordre du dessin", () => {
    const r = rand(7);
    const paths: OrderPath[] = [];
    for (let i = 0; i < 400; i++) paths.push(square(r() * 300, r() * 300, 2 + r() * 4));
    const before = travelOf(paths);
    const after = travelOf(orderPaths(paths));
    expect(after).toBeLessThan(before * 0.12);
    expect(orderPaths(paths)).toHaveLength(400);
  });

  it("entre dans un contour fermé par le sommet le plus proche, prend un trait par le bon bout", () => {
    const [first] = orderPaths([square(10, 10, 10), square(100, 100, 5)], [25, 25]);
    expect(first.pts[0]).toEqual([20, 20]);
    expect(first.pts).toHaveLength(4);
    const line: OrderPath = { pts: [[50, 0], [5, 0]], closed: false };
    expect(orderPaths([square(80, 80, 5), line], [0, 0])[0].pts[0]).toEqual([5, 0]);
  });

  it("garde les intérieurs avant les contours qui les entourent", () => {
    const outer = square(0, 0, 100), inner = square(40, 40, 10), inner2 = square(70, 10, 10);
    const out = orderPaths([outer, inner, inner2]);
    expect(out[2].pts).toContainEqual([0, 0]);
  });

  it("regroupe les contours en îles (forme, trous, forme dans un trou)", () => {
    const g = islands([square(0, 0, 100).pts, square(10, 10, 80).pts, square(40, 40, 10).pts, square(200, 0, 10).pts]);
    expect(g.map((i) => i.length).sort()).toEqual([1, 1, 2]);
  });

  it("enchaîne les blocs au plus proche, à l'envers s'il le faut", () => {
    const seg = (a: P, b: P): OrderPath => ({ pts: [a, b], closed: false });
    const far = [seg([100, 0], [110, 0]), seg([110, 1], [100, 1])];
    const near = [seg([20, 0], [10, 0]), seg([10, 1], [0, 1])];
    const out = orderBlocks([far, near], [0, 0]);
    expect(out[0].pts[0]).toEqual([0, 1]);
    expect(out[2].pts[0]).toEqual([100, 0]);
  });

  it("hachures : une île après l'autre au lieu de traverser tout le dessin à chaque ligne", () => {
    // Deux carrés pleins éloignés, dans un seul chemin (comme une couche vectorisée).
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="20mm" viewBox="0 0 100 20"><path fill="#000000" d="M0 0H10V10H0Z M90 0H100V10H90Z"/></svg>`;
    const res = svgToGcode(svg, { ...TOOLPATH_DEFAULTS, widthMm: 100, interval: 0.5, mode: "fill" });
    expect(res.error).toBeNull();
    const st = analyzeGcode(res.lines);
    // Ligne à ligne sur les deux carrés : 20 traversées de 80 mm (plus de 1 600 mm). Par îles : une traversée, plus le
    // retour à l'origine en fin de programme (~100 mm).
    expect(st.travelMm).toBeLessThan(300);
  });

  it("découpe en plusieurs passes : chaque contour repassé sur place avant le suivant", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="20mm" viewBox="0 0 100 20"><path fill="none" stroke="#e11d48" d="M0 0H10V10H0Z"/><path fill="none" stroke="#e11d48" d="M90 0H100V10H90Z"/></svg>`;
    const res = svgToGcode(svg, { ...TOOLPATH_DEFAULTS, widthMm: 100, mode: "line", passes: 3, returnHome: false });
    const g0 = res.lines.filter((l) => l.startsWith("G0"));
    expect(g0).toHaveLength(6);
    expect(new Set(g0.slice(0, 3)).size).toBe(1);
    expect(new Set(g0.slice(3)).size).toBe(1);
    expect(analyzeGcode(res.lines).travelMm).toBeLessThan(100);
  });
});
