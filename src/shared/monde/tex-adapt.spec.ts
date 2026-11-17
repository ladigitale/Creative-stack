import { describe, expect, it } from "vitest";
import { readTex, TexJob, texPixels, texSizeFor, TEX_SIZE } from "./textures";

describe("texture adaptative", () => {
  it("choisit la taille selon la densité à l'écran", () => {
    expect(texSizeFor(10, 1)).toBe(TEX_SIZE);
    expect(texSizeFor(200, 1)).toBe(256);
    expect(texSizeFor(400, 1)).toBe(512);
    expect(texSizeFor(4000, 1)).toBe(512);
    expect(texSizeFor(4000, 1, 1024)).toBe(1024);
    // un motif fin (répété 8 fois par mètre) demande moins de texels par tuile
    expect(texSizeFor(400, 8)).toBe(TEX_SIZE);
    expect(texSizeFor(4000, 1, 64)).toBe(TEX_SIZE);
  });
  it("calcule le même motif plus finement", () => {
    const t = readTex("bois")!;
    const a = texPixels(t, "#a07040", 128);
    const b = texPixels(t, "#a07040", 512);
    expect(a.length).toBe(128 * 128 * 4);
    expect(b.length).toBe(512 * 512 * 4);
    // même motif : le pixel (x, y) de la petite = le pixel (4x, 4y) de la grande
    for (const [x, y] of [[0, 0], [17, 33], [100, 5]]) {
      const i = (y * 128 + x) * 4, j = (y * 4 * 512 + x * 4) * 4;
      expect(Math.abs(a[i] - b[j])).toBeLessThan(2);
    }
  });
  it("se calcule par tranches sans changer le résultat", () => {
    const t = readTex({ kind: "carrelage", seed: 3 })!;
    const job = new TexJob(t, "#336699", 256);
    let px: Uint8ClampedArray | null = null;
    let n = 0;
    while (!(px = job.step(0)) && n < 1000) n++;
    expect(n).toBeGreaterThan(10);
    expect(job.done).toBe(true);
    expect(Array.from(px!.slice(0, 4000))).toEqual(Array.from(texPixels(t, "#336699", 256).slice(0, 4000)));
  });
});

import { normalPixels, ormPixels, texHeights } from "./textures";
describe("cartes dérivées", () => {
  it("hauteurs, normales et ORM cohérentes avec le motif", () => {
    const t = readTex("brique")!;
    const h = texHeights(t, 64);
    expect(h.length).toBe(64 * 64);
    const n = normalPixels(h, 64, 1);
    // une surface plate pointe vers +z (bleu fort) ; sur un joint, la pente incline la normale
    let flat = 0, tilted = 0;
    for (let i = 0; i < 64 * 64; i++) n[i * 4 + 2] > 250 ? flat++ : tilted++;
    expect(flat).toBeGreaterThan(0);
    expect(tilted).toBeGreaterThan(0);
    const o = ormPixels(h, 64, 0.5);
    // creux (hauteur 0) : occlusion sombre, rugosité pleine ; bosse : claire et plus lisse
    const lo = h.indexOf(Math.min(...h)), hi = h.indexOf(Math.max(...h));
    expect(o[lo * 4]).toBeLessThan(o[hi * 4]);
    expect(o[lo * 4 + 1]).toBeGreaterThan(o[hi * 4 + 1]);
    expect(o[hi * 4 + 2]).toBe(h[hi]);
  });
});
