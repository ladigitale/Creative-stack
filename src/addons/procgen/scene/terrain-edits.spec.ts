import { describe, expect, it } from "vitest";
import { Terrain, readTerrainEdits } from "./terrain";

const spec = { size: [10, 8] as [number, number], relief: 0.2, scale: 12, mountains: 0, water: null, surface: "grass" as const, seed: 3 };

describe("retouches du relief", () => {
  it("creuse, monte, aplanit ; rejoue la liste depuis le sol d'origine", () => {
    const t = new Terrain(spec, []);
    const h0 = t.height(1, 1), hm = t.height(-2, 0), hr = t.height(1 + 0.6 * 1.3, 1);
    t.applyEdits(readTerrainEdits([{ op: "dig", x: 1, z: 1, r: 0.6, depth: 0.5 }, { op: "raise", x: -2, z: 0, r: 1, depth: 0.4 }]));
    expect(t.height(1, 1)).toBeLessThan(h0 - 0.4);
    expect(t.height(-2, 0)).toBeGreaterThan(hm + 0.3);
    // la terre sortie du trou fait un bourrelet autour
    expect(t.height(1 + 0.6 * 1.3, 1)).toBeGreaterThan(hr + 0.02);
    // même liste : même sol (pas de cumul) ; liste vide : sol d'origine
    t.applyEdits(readTerrainEdits([{ op: "dig", x: 1, z: 1, r: 0.6, depth: 0.5 }, { op: "raise", x: -2, z: 0, r: 1, depth: 0.4 }]));
    expect(t.height(1, 1)).toBeLessThan(h0 - 0.4);
    expect(t.height(1, 1)).toBeGreaterThan(h0 - 0.6);
    t.applyEdits([]);
    expect(t.height(1, 1)).toBeCloseTo(h0, 5);
    t.applyEdits(readTerrainEdits([{ op: "flatten", x: 0, z: 0, r: 2, height: 1 }]));
    expect(t.height(0, 0)).toBeCloseTo(1, 2);
  });

  it("une retouche en cours (k) avance progressivement ; entrées invalides ignorées", () => {
    const t = new Terrain(spec, []);
    const h0 = t.height(0, 0);
    t.applyEdits(readTerrainEdits([{ op: "dig", x: 0, z: 0, r: 1, depth: 1, k: 0.5 }]));
    expect(t.height(0, 0)).toBeCloseTo(h0 - 0.5, 1);
    expect(readTerrainEdits([{ op: "explode", x: 0, z: 0 }, { op: "dig", x: "a", z: 0 }, null, 3])).toEqual([]);
  });
});
