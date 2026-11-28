import { describe, expect, it } from "vitest";
import { HOME_KINDS, home, homeModel } from "./home";
import { partsBounds, partsToMesh } from "./parts";
import { composeScene } from "../scene/compose";

describe("objets du quotidien (intérieur)", () => {
  it("chaque sorte : un maillage fini, posé au sol, à taille réelle", () => {
    for (const kind of HOME_KINDS)
      for (const variant of [0, 1]) {
        const m = homeModel({ kind, variant });
        const mesh = partsToMesh(m.parts);
        expect(mesh.vertexCount, kind).toBeGreaterThan(20);
        expect(mesh.pos.every(Number.isFinite), kind).toBe(true);
        const bb = partsBounds(m.parts);
        expect(bb.min[1], kind).toBeGreaterThan(-0.02);
        // toile de cinéma et écran publicitaire : grands formats
        const big = kind === "cinema" || kind === "adscreen";
        expect(bb.max[1], kind).toBeLessThan(big ? 4.6 : 2.2);
        expect(Math.max(bb.max[0] - bb.min[0], bb.max[2] - bb.min[2]), kind).toBeLessThan(big ? 8 : 2.4);
      }
  });
  it("les objets à écran publient l'ancre screen et sa taille", () => {
    for (const kind of ["tv", "crt", "laptop", "computer", "phone", "tablet", "microwave", "cinema", "adscreen"]) {
      const a = home.build({ kind } as never, {} as never);
      expect(a.anchors.screen, kind).toBeDefined();
      const s = (a.extra as { screen?: { w: number; h: number } }).screen!;
      expect(s.w * s.h, kind).toBeGreaterThan(0);
    }
    expect(home.build({ kind: "fridge" } as never, {} as never).anchors.screen).toBeUndefined();
  });
  it("posés sur un meuble avec onTop", () => {
    const m = composeScene({
      recipe: {
        size: [6, 6],
        layers: [
          { id: "bureau", gen: "home", place: { at: [{ x: 0, z: 0 }] }, params: { kind: "desk" } },
          { id: "pc", gen: "home", onTop: true, place: { at: [{ x: -0.2, z: 0 }] }, params: { kind: "laptop" } },
        ],
      },
      seed: 1,
    });
    const d = m.objects.find((o) => o.id === "bureau.0")!;
    expect(m.objects.find((o) => o.id === "pc.0")!.pos[1]).toBeGreaterThan(d.pos[1] + 0.6);
  });
});
