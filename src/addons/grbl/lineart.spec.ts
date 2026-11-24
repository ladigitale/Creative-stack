import { describe, expect, it } from "vitest";
import { optimizeStrokes, strokeLength, type Polyline } from "./lineart";

const near = (a: number, b: number, e = 1e-3) => Math.abs(a - b) < e;

describe("optimizeStrokes", () => {
  it("croisement : le premier trait passe, le second est interrompu de part et d'autre", () => {
    const out = optimizeStrokes([[[0, 5], [10, 5]], [[5, 0], [5, 10]]], { gap: 0.2 });
    expect(out.length).toBe(3);
    expect(out.some((l) => near(l[0][1], 5) && near(l[l.length - 1][1], 5) && near(Math.abs(l[0][0] - l[l.length - 1][0]), 10))).toBe(true);
    expect(near(strokeLength(out), 20 - 0.4)).toBe(true);
  });

  it("jonction d'arbre : le tronc continue dans la branche la plus droite, l'autre recule", () => {
    const trunk: Polyline = [[0, 0], [0, 10]];
    const straight: Polyline = [[0, 10], [1, 20]];
    const side: Polyline = [[0, 10], [-8, 16]];
    const out = optimizeStrokes([trunk, straight, side], { gap: 0.25 });
    expect(out.length).toBe(2);
    const long = out.find((l) => l.length >= 3)!;
    expect(near(strokeLength([long]), 10 + Math.hypot(1, 10))).toBe(true);
    const branch = out.find((l) => l !== long)!;
    // La branche ne touche plus le point de jonction.
    const d = Math.min(...branch.map((p) => Math.hypot(p[0], p[1] - 10)));
    expect(d).toBeGreaterThan(0.24);
  });

  it("traits superposés et bords communs de tuiles : un seul passage", () => {
    const sq = (x: number): Polyline => [[x, 0], [x + 10, 0], [x + 10, 10], [x, 10], [x, 0]];
    // Deux carrés côte à côte (bord commun) + un carré repassé.
    const out = optimizeStrokes([sq(0), sq(10), sq(0)], { gap: 0 });
    expect(near(strokeLength(out), 70)).toBe(true);
  });

  it("recouvrement partiel colinéaire : coupé aux nœuds puis dédoublonné", () => {
    const out = optimizeStrokes([[[0, 0], [10, 0]], [[4, 0], [6, 0]]], { gap: 0 });
    expect(near(strokeLength(out), 10)).toBe(true);
  });

  it("recoud des segments donnés dans le désordre en un seul tracé", () => {
    const pts: [number, number][] = Array.from({ length: 30 }, (_, i) => [i, Math.sin(i / 3) * 4]);
    const segs: Polyline[] = [];
    for (let i = 1; i < pts.length; i++) segs.push(i % 2 ? [pts[i - 1], pts[i]] : [pts[i], pts[i - 1]]);
    segs.reverse();
    const out = optimizeStrokes(segs, { gap: 0.2 });
    expect(out.length).toBe(1);
    expect(out[0].length).toBe(30);
  });

  it("gap 0 : croisements gardés, rien de coupé", () => {
    const out = optimizeStrokes([[[0, 5], [10, 5]], [[5, 0], [5, 10]]], { gap: 0 });
    expect(near(strokeLength(out), 20)).toBe(true);
  });

  it("200 traits au hasard : plus aucun croisement après optimisation", () => {
    let seed = 7;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const lines: Polyline[] = Array.from({ length: 200 }, () => [[r() * 100, r() * 100], [r() * 100, r() * 100]]);
    const out = optimizeStrokes(lines, { gap: 0.15 });
    const segs = out.flatMap((l) => l.slice(1).map((p, i) => [l[i], p] as const));
    let cross = 0;
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const [[ax, ay], [bx, by]] = segs[i], [[cx, cy], [dx, dy]] = segs[j];
      const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy, den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((cx - ax) * sy - (cy - ay) * sx) / den, u = ((cx - ax) * ry - (cy - ay) * rx) / den;
      if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6) cross++;
    }
    expect(cross).toBe(0);
    expect(strokeLength(out)).toBeGreaterThan(strokeLength(lines) * 0.8);
  });
});
