import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { tracingBudget } from "./photo";

const screen = (w: number, h: number) => ({ getDrawingBufferSize: (v: THREE.Vector2) => v.set(w, h) });

describe("tracingBudget", () => {
  it("garde l'échelle demandée sur un écran d'ordinateur modeste", () => {
    const b = tracingBudget(screen(1000, 700), 1, false);
    expect(b.scale).toBe(1);
    expect(b.tiles).toBe(2);
  });

  it("réduit fortement les pixels tracés et découpe en tuiles sur un téléphone dense", () => {
    const b = tracingBudget(screen(1170, 2532), 1, true);
    expect(1170 * 2532 * b.scale * b.scale).toBeLessThanOrEqual(350_001);
    expect(b.tiles).toBeGreaterThanOrEqual(2);
  });

  it("ne dépasse jamais l'échelle demandée", () => {
    expect(tracingBudget(screen(400, 300), 0.5, true).scale).toBe(0.5);
  });
});
