import { describe, expect, it } from "vitest";
import { arrowHead, badgeRadius, box, dragLength, isShapeTool, needsDrag, pixelBlock, textSize } from "./shapes";

describe("sonic-paint : outils de forme", () => {
  it("reconnaît les outils de forme, pas ceux du pinceau", () => {
    for (const t of ["line", "arrow", "rect", "ellipse", "text", "badge", "pixelate"]) expect(isShapeTool(t)).toBe(true);
    for (const t of ["paint", "erase", "pick", "hand", "", null, 3]) expect(isShapeTool(t)).toBe(false);
  });

  it("le texte et la pastille se posent d'un clic, les autres se tirent", () => {
    expect(needsDrag("text")).toBe(false);
    expect(needsDrag("badge")).toBe(false);
    expect(needsDrag("arrow")).toBe(true);
    expect(needsDrag("pixelate")).toBe(true);
    expect(dragLength({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("normalise le rectangle quel que soit le sens du geste", () => {
    expect(box({ x: 50, y: 40 }, { x: 10, y: 100 })).toEqual({ x: 10, y: 40, w: 40, h: 60 });
  });

  it("pointe de flèche : au bout du trait, symétrique, jamais plus longue que lui", () => {
    const h = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 6);
    expect(h.base).toEqual({ x: 76, y: 0 });
    expect(h.left.x).toBeCloseTo(76);
    expect(h.left.y).toBeCloseTo(-h.right.y);
    expect(Math.abs(h.left.y)).toBeCloseTo(24 * 0.42);
    const short = arrowHead({ x: 0, y: 0 }, { x: 0, y: 8 }, 6);
    expect(short.base.x).toBeCloseTo(0);
    expect(short.base.y).toBeCloseTo(0);
  });

  it("tailles déduites de l'épaisseur, avec un minimum lisible", () => {
    expect(textSize(1)).toBe(12);
    expect(textSize(8)).toBe(32);
    expect(badgeRadius(1)).toBe(10);
    expect(badgeRadius(10)).toBe(26);
    expect(pixelBlock(1)).toBe(4);
    expect(pixelBlock(8)).toBe(16);
  });
});
