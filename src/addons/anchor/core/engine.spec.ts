import { describe, expect, it } from "vitest";
import { boxBlur, type Gray } from "./image";
import { apply, invert, type Mat3 } from "./homography";
import { buildReference } from "./reference";
import { AnchorEngine } from "./engine";
import { buildPyramid, trackChecked } from "./flow";

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function wall(w: number, h: number, seed = 7): Gray {
  const rnd = seeded(seed);
  const d = new Uint8Array(w * h).fill(128);
  for (let k = 0; k < 260; k++) {
    const x0 = rnd() * w, y0 = rnd() * h, rw = 4 + rnd() * 40, rh = 4 + rnd() * 40, v = (rnd() * 255) | 0;
    for (let y = Math.max(0, y0 | 0); y < Math.min(h, (y0 + rh) | 0); y++) for (let x = Math.max(0, x0 | 0); x < Math.min(w, (x0 + rw) | 0); x++) d[y * w + x] = v;
  }
  return boxBlur({ data: d, width: w, height: h }, 1);
}
function warp(src: Gray, h: Mat3): Gray {
  const inv = invert(h)!, w = src.width, hh = src.height, out = new Uint8Array(w * hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
    const p = apply(inv, x, y); let v = 90;
    if (p && p.x >= 0 && p.y >= 0 && p.x < w - 1 && p.y < hh - 1) {
      const x0 = p.x | 0, y0 = p.y | 0, tx = p.x - x0, ty = p.y - y0, i = y0 * w + x0;
      const a = src.data[i] + (src.data[i + 1] - src.data[i]) * tx, b = src.data[i + w] + (src.data[i + w + 1] - src.data[i + w]) * tx;
      v = a + (b - a) * ty;
    }
    out[y * w + x] = Math.round(v);
  }
  return { data: out, width: w, height: hh };
}
const shift = (dx: number, dy: number, rot = 0): Mat3 => {
  const a = (rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), cx = 160, cy = 120;
  return new Float64Array([c, -s, cx - c * cx + s * cy + dx, s, c, cy - s * cx - c * cy + dy, 0, 0, 1]);
};
const ZONE = [{ x: 0.25, y: 0.2 }, { x: 0.75, y: 0.2 }, { x: 0.75, y: 0.8 }, { x: 0.25, y: 0.8 }];

describe("flot optique", () => {
  it("suit un déplacement de quelques pixels", () => {
    const a = wall(320, 240), b = warp(a, shift(4.5, -3));
    const xs = [100, 150, 200, 220], ys = [80, 120, 150, 100];
    const r = trackChecked(buildPyramid(a), buildPyramid(b), xs, ys);
    let n = 0;
    for (let i = 0; i < 4; i++) if (r.ok[i]) { n++; expect(r.x[i] - xs[i]).toBeCloseTo(4.5, 0); expect(r.y[i] - ys[i]).toBeCloseTo(-3, 0); }
    expect(n).toBeGreaterThanOrEqual(3);
  });
});

describe("moteur", () => {
  it("détecte, puis suit image par image, coins justes", () => {
    const ref = wall(320, 240);
    const e = new AnchorEngine();
    expect(e.setReferences([buildReference(ref, ZONE), { nope: 1 }])).toBe(1);
    const first = e.process(warp(ref, shift(10, 5)), { order: [0, 1] });
    expect(first.found).toBe(true);
    expect(first.mode).toBe("detect");
    let H = shift(10, 5);
    for (let k = 1; k <= 6; k++) {
      H = shift(10 + k * 3, 5 - k * 2, k * 1.5);
      const r = e.process(warp(ref, H), { order: [0] });
      expect(r.found).toBe(true);
      expect(r.mode).toBe("track");
      const want = ZONE.map((p) => apply(H, p.x * 320, p.y * 240)!);
      r.corners!.forEach((c, i) => expect(Math.hypot(c.x - want[i].x, c.y - want[i].y)).toBeLessThan(3));
    }
  });

  it("retourne à la détection quand la zone disparaît", () => {
    const ref = wall(320, 240);
    const e = new AnchorEngine();
    e.setReferences([buildReference(ref, ZONE)]);
    expect(e.process(warp(ref, shift(0, 0)), { order: [0] }).found).toBe(true);
    const lost = e.process(wall(320, 240, 99), { order: [0] });
    expect(lost.found).toBe(false);
    expect(e.tracking).toBe(-1);
  });
});
