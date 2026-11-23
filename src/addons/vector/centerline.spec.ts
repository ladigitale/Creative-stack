import { describe, expect, it } from "vitest";
import { centerline } from "./centerline";
import type { Multi, Pt } from "./geometry";

const rect = (x: number, y: number, w: number, h: number): Pt[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const len = (l: Pt[]) => l.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - l[i][0], p[1] - l[i][1]), 0);

describe("centerline (ligne du milieu)", () => {
  it("une barre épaisse devient un seul trait en son milieu, avec son épaisseur", () => {
    const r = centerline([[rect(0, 0, 200, 12)]], { cell: 0.5 });
    expect(r.lines).toHaveLength(1);
    const l = r.lines[0];
    for (const [, y] of l) expect(Math.abs(y - 6)).toBeLessThan(0.8);
    expect(len(l)).toBeGreaterThan(180);
    expect(r.width).toBeGreaterThan(10);
    expect(r.width).toBeLessThan(14);
    // Peu de points : un segment presque droit.
    expect(l.length).toBeLessThan(8);
  });

  it("un anneau devient une boucle fermée au milieu de la couronne", () => {
    const outer: Pt[] = [], inner: Pt[] = [];
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      outer.push([100 + 50 * Math.cos(a), 100 + 50 * Math.sin(a)]);
      inner.unshift([100 + 40 * Math.cos(a), 100 + 40 * Math.sin(a)]);
    }
    const r = centerline([[outer, inner]], { cell: 0.5 });
    expect(r.lines).toHaveLength(1);
    const l = r.lines[0];
    expect(l[0][0]).toBeCloseTo(l[l.length - 1][0], 5);
    for (const [x, y] of l) expect(Math.abs(Math.hypot(x - 100, y - 100) - 45)).toBeLessThan(1.2);
  });

  it("un T garde ses trois branches, sans barbes aux coins", () => {
    const T: Multi = [[[[0, 0], [120, 0], [120, 14], [67, 14], [67, 110], [53, 110], [53, 14], [0, 14]]]];
    const r = centerline(T, { cell: 0.5 });
    expect(r.lines.length).toBeGreaterThanOrEqual(2);
    expect(r.lines.length).toBeLessThanOrEqual(3);
    const total = r.lines.reduce((s, l) => s + len(l), 0);
    // Barre ~120 + jambe ~100 (moins les demi-épaisseurs aux bouts).
    expect(total).toBeGreaterThan(190);
    expect(total).toBeLessThan(235);
  });

  it("ébarbage : une bosse sur le côté ne crée pas de branche, `prune` retire les branches courtes", () => {
    const bump: Multi = [[[[0, 0], [200, 0], [200, 12], [104, 12], [104, 20], [96, 20], [96, 12], [0, 12]]]];
    expect(centerline(bump, { cell: 0.5 }).lines).toHaveLength(1);
    const twig: Multi = [[[[0, 0], [200, 0], [200, 12], [104, 12], [104, 40], [96, 40], [96, 12], [0, 12]]]];
    expect(centerline(twig, { cell: 0.5 }).lines.length).toBeGreaterThan(1);
    expect(centerline(twig, { cell: 0.5, prune: 40 }).lines).toHaveLength(1);
  });

  it("forme vide ou plate : rien", () => {
    expect(centerline([]).lines).toEqual([]);
    expect(centerline([[[[0, 0], [10, 0], [20, 0]]]]).lines).toEqual([]);
  });
});
