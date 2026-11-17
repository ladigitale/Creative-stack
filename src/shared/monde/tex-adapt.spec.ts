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
