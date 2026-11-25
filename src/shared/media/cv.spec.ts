import { describe, expect, it } from "vitest";
import { colorBlobs, lumaOf, motion, oklab, parseHex, readZones, sampleColor, updateZone, zoneLevel } from "./cv";

/** Image RGBA unie avec des rectangles colorés. */
function img(w: number, h: number, bg: number[], rects: [number, number, number, number, number[]][] = []): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let c = bg;
      for (const [rx, ry, rw, rh, col] of rects) if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) c = col;
      d.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    }
  return d;
}

describe("mouvement", () => {
  it("niveau, centre et boîte de ce qui a bougé", () => {
    const a = lumaOf(img(40, 30, [20, 20, 20]), 40, 30);
    const b = lumaOf(img(40, 30, [20, 20, 20], [[10, 5, 10, 10, [250, 250, 250]]]), 40, 30);
    const m = motion(a, b, 40, 30, 0.08);
    expect(m.level).toBeCloseTo(100 / 1200, 5);
    expect(m.x).toBeCloseTo(15 / 40, 5);
    expect(m.y).toBeCloseTo(10 / 30, 5);
    expect(m.box).toEqual([0.25, 5 / 30, 0.5, 0.5]);
    expect(motion(a, a, 40, 30, 0.08).level).toBe(0);
  });

  it("zones (miroir compris) et hystérésis", () => {
    const zones = readZones('{"g": [0, 0, 0.5, 1], "d": [0.5, 0, 0.5, 1]}');
    expect(zones.map((z) => z.name)).toEqual(["g", "d"]);
    const mask = new Uint8Array(4 * 2);
    mask[0] = mask[4] = 1; // colonne de gauche
    expect(zoneLevel(mask, 4, 2, zones[0])).toBe(0.5);
    expect(zoneLevel(mask, 4, 2, zones[1])).toBe(0);
    expect(zoneLevel(mask, 4, 2, zones[1], true)).toBe(0.5);
    const s = { level: 0, active: false, count: 0, since: 0 };
    expect(updateZone(s, 0.1, 0, 0.06, 300)).toBe(true);
    expect(updateZone(s, 0.2, 50, 0.06, 300)).toBe(false);
    updateZone(s, 0, 200, 0.06, 300);
    expect(s.active).toBe(true);
    updateZone(s, 0, 400, 0.06, 300);
    expect(s.active).toBe(false);
    expect(updateZone(s, 0.1, 500, 0.06, 300)).toBe(true);
    expect(s.count).toBe(2);
  });
});

describe("couleur", () => {
  it("OKLab et hexadécimal", () => {
    expect(oklab(255, 255, 255)[0]).toBeCloseTo(1, 3);
    expect(parseHex("#f00")).toEqual([255, 0, 0]);
    expect(parseHex("nope")).toBeNull();
  });

  it("trouve la balle rouge, tolère l'ombre, ignore le reste", () => {
    const d = img(60, 40, [200, 200, 190], [
      [40, 10, 8, 8, [220, 30, 40]],
      [44, 14, 4, 4, [150, 20, 28]], // partie ombrée de la balle
      [5, 5, 6, 6, [30, 160, 60]], // objet vert
      [5, 30, 2, 2, [215, 35, 45]], // petite tache rouge (bruit)
    ]);
    const blobs = colorBlobs(d, 60, 40, [225, 29, 72], 0.15, 0.002);
    expect(blobs.length).toBe(1);
    expect(blobs[0].x).toBeCloseTo(44 / 60, 2);
    expect(blobs[0].y).toBeCloseTo(14 / 40, 2);
    expect(blobs[0].area).toBeCloseTo(64 / 2400, 3);
    const strict = colorBlobs(d, 60, 40, [225, 29, 72], 0.15, 0.0001);
    expect(strict.length).toBe(2);
    expect(sampleColor(d, 60, 40, 9 / 60, 9 / 40, 1)).toEqual([30, 160, 60]);
  });
});
