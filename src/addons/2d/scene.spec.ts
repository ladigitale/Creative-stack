import { describe, expect, it } from "vitest";
import { Scene2D } from "./scene";
import { parseLayers, parseSprite } from "./model";

/** Scène sans rendu (pas d'init WebGL) : suffit pour la construction et la déformation des maillages. */
function scene() {
  const s = new Scene2D({ canvas: document.createElement("canvas"), width: 400, height: 400, background: "", resolution: 1, invalidate: () => {} });
  s.setLayers(parseLayers("").layers);
  return s;
}
const mesh = (o: Record<string, unknown> = {}) => parseSprite({ name: "chair", shape: "mesh", src: "https://exemple.org/a.png", x: 200, y: 200, w: 100, h: 200, grid: "2,4", ...o }, "m").spec;
const bone = (x: number, y: number, len: number, angle = 0) => {
  const r = (angle * Math.PI) / 180;
  return { x, y, x2: x - Math.sin(r) * len, y2: y + Math.cos(r) * len, angle };
};
const REST = { haut: bone(200, 100, 100), bas: bone(200, 200, 100) };
type Inside = { entries: Map<string, { mesh?: { geom: { positions: Float32Array }; skin: unknown } }> };
const positions = (s: Scene2D) => Array.from((s as unknown as Inside).entries.get("chair")!.mesh!.geom.positions);

describe("sprite mesh", () => {
  it("sans squelette : un quad à la taille du sprite, centré sur sa position", () => {
    const s = scene();
    s.syncSet(new Set(), [mesh()]);
    expect(positions(s)).toEqual([-50, -100, 50, -100, -50, 100, 50, 100]);
  });

  it("au repos : les sommets de la grille restent en place (repère du porteur)", () => {
    const s = scene();
    s.syncSet(new Set(), [mesh()]);
    s.setSkeleton(REST, REST);
    const p = positions(s);
    expect(p).toHaveLength(3 * 5 * 2);
    expect(p[0]).toBeCloseTo(-50, 2);
    expect(p[1]).toBeCloseTo(-100, 2);
    expect(p[p.length - 2]).toBeCloseTo(50, 2);
    expect(p[p.length - 1]).toBeCloseTo(100, 2);
  });

  it("os plié : le bas du maillage suit l'os, le haut reste ; rest changé : la grille est refaite", () => {
    const s = scene();
    s.syncSet(new Set(), [mesh({ influences: 2, falloff: 6 })]);
    s.setSkeleton(REST, REST);
    s.setSkeleton(REST, { haut: REST.haut, bas: bone(200, 200, 100, 90) });
    const p = positions(s);
    expect(Math.abs(p[0] + 50)).toBeLessThan(3);
    expect(Math.abs(p[1] + 100)).toBeLessThan(3);
    // coin bas-gauche (relatif) : à l'écran il passe à gauche de l'articulation
    const last = p.length - 2;
    expect(p[last]).toBeLessThan(-80);
    for (const v of p) expect(Number.isFinite(v)).toBe(true);
    // un nouveau repos (autre référence) reconstruit : maillage de nouveau rigide au repos
    const moved = { haut: bone(200, 100, 100), bas: bone(200, 200, 100) };
    s.setSkeleton(moved, moved);
    expect(positions(s)[last]).toBeCloseTo(50, 2);
  });

  it("skin-bones : seuls les os listés comptent ; aucun os valide : retour au quad", () => {
    const s = scene();
    s.syncSet(new Set(), [mesh({ "skin-bones": "haut" })]);
    s.setSkeleton(REST, { haut: REST.haut, bas: bone(200, 200, 100, 90) });
    const p = positions(s);
    for (let i = 0; i < p.length; i += 2) {
      expect(p[i] + 50).toBeGreaterThan(-1e-3); // un seul os, resté au repos : rien ne bouge
    }
    s.setSkeleton({ autre: "x" }, null);
    expect(positions(s)).toEqual([-50, -100, 50, -100, -50, 100, 50, 100]);
  });

  it("un maillage apparu après le squelette est déformé tout de suite", () => {
    const s = scene();
    s.setSkeleton(REST, REST);
    s.syncSet(new Set(), [mesh()]);
    expect(positions(s)).toHaveLength(3 * 5 * 2);
  });
});
