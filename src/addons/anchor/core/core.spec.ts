import { describe, expect, it } from "vitest";
import { boxBlur, type Gray } from "./image";
import { extractFeatures } from "./features";
import { apply, fitHomography, invert, ransacHomography, squareToQuad, toCssMatrix3d, type Mat3 } from "./homography";
import { buildReference, decodeReference, locate, orderQuad, signedAngle } from "./reference";
import { upInImage } from "./gravity";

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** « Mur » texturé : rectangles et disques de gris aléatoires, légèrement flouté. */
function wall(w: number, h: number, seed = 7): Gray {
  const rnd = seeded(seed);
  const d = new Uint8Array(w * h).fill(128);
  for (let k = 0; k < 260; k++) {
    const x0 = rnd() * w, y0 = rnd() * h, rw = 4 + rnd() * 40, rh = 4 + rnd() * 40, v = (rnd() * 255) | 0;
    const disk = rnd() < 0.4;
    for (let y = Math.max(0, y0 | 0); y < Math.min(h, (y0 + rh) | 0); y++) {
      for (let x = Math.max(0, x0 | 0); x < Math.min(w, (x0 + rw) | 0); x++) {
        if (disk && Math.hypot(x - x0 - rw / 2, y - y0 - rh / 2) > Math.min(rw, rh) / 2) continue;
        d[y * w + x] = v;
      }
    }
  }
  return boxBlur({ data: d, width: w, height: h }, 1);
}

/** Image vue à travers l'homographie `h` (source → destination), bilinéaire, fond uniforme. */
function warp(src: Gray, h: Mat3, w: number, hh: number, noise = 0, seed = 3): Gray {
  const inv = invert(h)!;
  const rnd = seeded(seed);
  const out = new Uint8Array(w * hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
    const p = apply(inv, x, y);
    let v = 90;
    if (p && p.x >= 0 && p.y >= 0 && p.x < src.width - 1 && p.y < src.height - 1) {
      const x0 = p.x | 0, y0 = p.y | 0, tx = p.x - x0, ty = p.y - y0, i = y0 * src.width + x0;
      const a = src.data[i] + (src.data[i + 1] - src.data[i]) * tx;
      const b = src.data[i + src.width] + (src.data[i + src.width + 1] - src.data[i + src.width]) * tx;
      v = a + (b - a) * ty;
    }
    out[y * w + x] = Math.max(0, Math.min(255, Math.round(v + (rnd() - 0.5) * noise)));
  }
  return { data: out, width: w, height: hh };
}

/** Homographie d'une prise de vue : rotation, échelle, perspective, translation. */
function view(rotDeg: number, scale: number, px: number, py: number, tx: number, ty: number, cx: number, cy: number): Mat3 {
  const a = (rotDeg * Math.PI) / 180, c = Math.cos(a) * scale, s = Math.sin(a) * scale;
  const T1 = new Float64Array([1, 0, -cx, 0, 1, -cy, 0, 0, 1]);
  const R = new Float64Array([c, -s, 0, s, c, 0, px, py, 1]);
  const T2 = new Float64Array([1, 0, cx + tx, 0, 1, cy + ty, 0, 0, 1]);
  const m = (A: Mat3, B: Mat3) => {
    const o = new Float64Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
    return o;
  };
  const H = m(T2, m(R, T1));
  for (let k = 0; k < 9; k++) H[k] /= H[8];
  return H;
}

const ZONE = [{ x: 0.25, y: 0.2 }, { x: 0.75, y: 0.2 }, { x: 0.75, y: 0.8 }, { x: 0.25, y: 0.8 }];

describe("homographie", () => {
  it("retrouve une homographie exacte à partir de 4 et de N points", () => {
    const H = view(20, 0.9, 0.0004, -0.0003, 15, -10, 160, 120);
    const sx = [10, 300, 290, 20, 150, 80], sy = [15, 10, 230, 220, 120, 60];
    const dx = sx.map((x, i) => apply(H, x, sy[i])!.x), dy = sx.map((x, i) => apply(H, x, sy[i])!.y);
    for (const idx of [[0, 1, 2, 3], [0, 1, 2, 3, 4, 5]]) {
      const G = fitHomography(sx, sy, dx, dy, idx)!;
      for (let k = 0; k < 9; k++) expect(G[k]).toBeCloseTo(H[k], 6);
    }
  });

  it("RANSAC ignore 40 % d'appariements faux", () => {
    const H = view(-15, 1.1, 0.0002, 0.0002, -8, 12, 160, 120);
    const rnd = seeded(11);
    const n = 120;
    const sx: number[] = [], sy: number[] = [], dx: number[] = [], dy: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = rnd() * 320, y = rnd() * 240;
      sx.push(x); sy.push(y);
      if (i % 5 < 2) { dx.push(rnd() * 320); dy.push(rnd() * 240); }
      else { const p = apply(H, x, y)!; dx.push(p.x + (rnd() - 0.5)); dy.push(p.y + (rnd() - 0.5)); }
    }
    const r = ransacHomography(sx, sy, dx, dy, n, { random: seeded(5), threshold: 3 })!;
    expect(r.count).toBeGreaterThanOrEqual(70);
    const p = apply(r.h, 100, 100)!, q = apply(H, 100, 100)!;
    expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(1);
  });

  it("matrix3d du carré unité vers un quadrilatère", () => {
    const H = squareToQuad([{ x: 10, y: 20 }, { x: 110, y: 25 }, { x: 105, y: 140 }, { x: 5, y: 120 }])!;
    const p = apply(H, 1, 1)!;
    expect(p.x).toBeCloseTo(105, 6);
    expect(p.y).toBeCloseTo(140, 6);
    expect(toCssMatrix3d(H)).toMatch(/^matrix3d\(/);
  });
});

describe("points caractéristiques", () => {
  it("trouve des points répartis et respecte le masque", () => {
    const img = wall(320, 240);
    const f = extractFeatures(img, { maxPoints: 400 });
    expect(f.n).toBeGreaterThan(200);
    const g = extractFeatures(img, { maxPoints: 400, mask: (x) => x < 160 });
    for (let i = 0; i < g.n; i++) expect(g.x[i]).toBeLessThan(161);
  });
});

describe("ancrage", () => {
  const ref = wall(320, 240);
  const built = buildReference(ref, ZONE, { id: "mur" });
  const decoded = decodeReference(JSON.parse(JSON.stringify(built)))!;

  it("sérialise et relit une référence", () => {
    expect(built.n).toBeGreaterThan(100);
    expect(decoded.features.n).toBe(built.n);
    expect(decoded.zone[2]).toEqual({ x: 0.75, y: 0.8 });
  });

  const cases: Array<[string, Mat3]> = [
    ["de face, décalé", view(0, 1, 0, 0, 20, -12, 160, 120)],
    ["tourné de 25°", view(25, 0.95, 0, 0, 0, 0, 160, 120)],
    ["en perspective", view(-8, 0.9, 0.0012, 0.0004, 10, 5, 160, 120)],
    ["plus loin (×0.6)", view(5, 0.6, 0, 0, 0, 0, 160, 120)],
    ["plus près (×1.5)", view(0, 1.5, 0, 0, 0, 0, 160, 120)],
  ];
  for (const [name, H] of cases) {
    it(`retrouve la zone : ${name}`, () => {
      const q = warp(ref, H, 320, 240, 8);
      const r = locate(decoded, extractFeatures(q, { maxPoints: 700 }), { random: seeded(9) });
      expect(r.found).toBe(true);
      const want = ZONE.map((p) => apply(H, p.x * 320, p.y * 240)!);
      r.corners!.forEach((c, i) => expect(Math.hypot(c.x - want[i].x, c.y - want[i].y)).toBeLessThan(4));
    });
  }

  it("ne trouve rien sur une autre image", () => {
    const r = locate(decoded, extractFeatures(wall(320, 240, 99), { maxPoints: 700 }), { random: seeded(9) });
    expect(r.found).toBe(false);
  });

  it("le filtre de gravité rejette une rotation incompatible", () => {
    const H = view(60, 1, 0, 0, 0, 0, 160, 120);
    const q = extractFeatures(warp(ref, H, 320, 240, 4), { maxPoints: 700 });
    const withUp = decodeReference(buildReference(ref, ZONE, { up: { x: 0, y: -1 } }))!;
    const ok = locate(withUp, q, { up: { x: Math.sin(Math.PI / 3), y: -Math.cos(Math.PI / 3) }, random: seeded(9) });
    expect(ok.found).toBe(true);
    expect(ok.rotation!).toBeCloseTo(60, -1);
    const ko = locate(withUp, q, { up: { x: 0, y: -1 }, gravityTolerance: 30, random: seeded(9) });
    expect(ko.found).toBe(false);
  });
});

describe("outils", () => {
  it("ordonne les coins en partant du haut-gauche, sens horaire", () => {
    const o = orderQuad([{ x: 0.8, y: 0.9 }, { x: 0.1, y: 0.1 }, { x: 0.2, y: 0.8 }, { x: 0.9, y: 0.2 }]);
    expect(o.map((p) => p.x)).toEqual([0.1, 0.9, 0.8, 0.2]);
  });

  it("angle signé positif dans le sens horaire (y vers le bas)", () => {
    expect(signedAngle({ x: 0, y: -1 }, { x: 1, y: 0 })).toBeCloseTo(90);
  });

  it("haut dans l'image depuis l'accéléromètre", () => {
    expect(upInImage(0, 9.8)).toEqual({ x: 0, y: -1 });
    expect(upInImage(0, -9.8, 0, true)).toEqual({ x: 0, y: -1 });
    expect(upInImage(0.5, 0.5)).toBeNull();
    const l = upInImage(9.8, 0, 90)!;
    expect(l.x).toBeCloseTo(0);
    expect(l.y).toBeCloseTo(-1);
  });
});
