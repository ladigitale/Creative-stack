import { describe, expect, it } from "vitest";
import { parseNodesMap, toNodes } from "./nodes";

const world = { width: 800, height: 450 };
const body = (x: number, y: number, angle = 0) => ({ x, y, angle, vx: 0, vy: 0, awake: true });

describe("nodes : monde 2D → format sonic-3d", () => {
  it("désactivé sans nodes-plane ni nodes-scale", () => {
    expect(parseNodesMap("", 0, "", "", world)).toBeNull();
  });

  it("plan xz par défaut : centre de la scène à l'origine, y vers le bas → z, hauteur fixe optionnelle", () => {
    const m = parseNodesMap("xz", 0.01, "", "0.11", world)!;
    expect(m).toMatchObject({ plane: "xz", scale: 0.01, origin: [400, 225], height: 0.11 });
    expect(toNodes({ cue: body(200, 225), b1: body(560, 125, 90) }, m)).toEqual({
      cue: { x: -2, z: 0, ry: -0, y: 0.11 },
      b1: { x: 1.6, z: -1, ry: -1.5708, y: 0.11 },
    });
  });

  it("sans hauteur, y n'est pas publié (le nœud garde la sienne) ; échelle par défaut 0,01", () => {
    const m = parseNodesMap("xz", 0, "0 0", "", world)!;
    expect(m.scale).toBe(0.01);
    expect(toNodes({ a: body(100, 200) }, m).a).not.toHaveProperty("y");
    expect(toNodes({ a: body(100, 200) }, m).a).toMatchObject({ x: 1, z: 2 });
  });

  it("plan screen : repère de l'écran (y vers le bas), origine 0 0 et échelle 1 par défaut, rotation horaire", () => {
    const m = parseNodesMap("screen", 0, "", "", world)!;
    expect(m).toMatchObject({ plane: "screen", scale: 1, origin: [0, 0] });
    expect(toNodes({ a: body(120, 80, 90) }, m).a).toEqual({ x: 120, y: 80, rz: 1.5708 });
  });

  it("ease : ajouté à chaque nœud quand demandé", () => {
    const m = { ...parseNodesMap("screen", 0, "", "", world)!, ease: 33 };
    expect(toNodes({ a: body(1, 2) }, m).a.ease).toEqual({ ms: 33 });
  });

  it("plan xy (mur) : y vers le haut", () => {
    const m = parseNodesMap("xy", 1, "0 0", "", world)!;
    expect(toNodes({ a: body(3, 4) }, m).a).toEqual({ x: 3, y: -4, rz: -0 });
  });
});
