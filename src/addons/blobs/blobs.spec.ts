import { describe, expect, it } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { detectBlobs, toOverlaySvg } from "./index";

type Paint = (x: number, y: number) => [number, number, number];

function image(w: number, h: number, paint: Paint): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = paint(x, y);
    d.set([r, g, b, 255], (y * w + x) * 4);
  }
  return d;
}

/** Disques de couleur `fg` sur un fond `bg(x, y)` (anticrénelage simple). */
function disks(w: number, h: number, centers: Array<[number, number]>, r: number, fg: [number, number, number], bg: Paint): Uint8ClampedArray {
  return image(w, h, (x, y) => {
    let cover = 0;
    for (const [cx, cy] of centers) cover = Math.max(cover, Math.min(1, Math.max(0, r + 0.5 - Math.hypot(x - cx, y - cy))));
    const b = bg(x, y);
    return [0, 1, 2].map((i) => Math.round(fg[i] * cover + b[i] * (1 - cover))) as [number, number, number];
  });
}

const PAPER: Paint = () => [232, 228, 220];
const DARK: [number, number, number] = [50, 55, 70];

function grid(nx: number, ny: number, step: number, off: number): Array<[number, number]> {
  const c: Array<[number, number]> = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) c.push([off + i * step + ((i * 7 + j * 3) % 5) - 2, off + j * step + ((i * 3 + j * 5) % 5) - 2]);
  return c;
}

describe("détection", () => {
  it("compte des objets isolés", () => {
    const c = grid(6, 4, 50, 30);
    const r = detectBlobs(disks(320, 230, c, 12, DARK, PAPER), 320, 230);
    expect(r.count).toBe(24);
    expect(r.polarity).toBe("dark");
    expect(r.blobs.every((b) => !b.split && b.k === 1)).toBe(true);
  });

  it("objets clairs sur fond sombre", () => {
    const c = grid(5, 3, 60, 40);
    const r = detectBlobs(disks(320, 200, c, 14, [240, 230, 200], () => [30, 30, 35]), 320, 200);
    expect(r.count).toBe(15);
    expect(r.polarity).toBe("light");
  });

  it("résiste à un éclairage très inégal", () => {
    const c = grid(6, 4, 50, 30);
    const ramp: Paint = (x, y) => { const v = 250 - 150 * (x / 320) ** 1.5 - 30 * (y / 230); return [v, v, v - 8]; };
    const r = detectBlobs(disks(320, 230, c, 11, [70, 50, 40], ramp), 320, 230);
    expect(r.count).toBe(24);
  });

  it("sépare des objets qui se touchent (ligne, paire, triangle)", () => {
    const c: Array<[number, number]> = [
      [40, 40], [61, 40], [82, 40], // ligne de 3
      [200, 60], [219, 70], // paire
      [150, 160], [171, 160], [160.5, 142], // triangle
      [270, 170], [40, 170], // isolés
    ];
    const r = detectBlobs(disks(320, 220, c, 12, [40, 60, 140], PAPER), 320, 220);
    expect(r.count).toBe(10);
    expect(r.blobs.filter((b) => b.split).length).toBe(8);
    const merged = detectBlobs(disks(320, 220, c, 12, [40, 60, 140], PAPER), 320, 220, { split: false });
    expect(merged.count).toBe(5);
    expect(merged.estimate).toBe(10);
  });

  it("ignore les poussières", () => {
    const px = image(200, 200, (x, y) => (Math.hypot(x - 60, y - 60) < 15 || Math.hypot(x - 140, y - 140) < 15 ? DARK : (x * 31 + y * 17) % 211 === 0 ? DARK : [232, 228, 220]));
    expect(detectBlobs(px, 200, 200).count).toBe(2);
  });

  it("référence imposée par un point", () => {
    const small = grid(4, 2, 50, 30);
    const data = disks(260, 200, [...small, [100, 160], [130, 160]], 10, DARK, PAPER);
    const r = detectBlobs(data, 260, 200, { refPoint: { x: small[0][0], y: small[0][1] } });
    expect(r.reference).toBe("point");
    expect(Math.abs(r.median - Math.PI * 100)).toBeLessThan(80);
  });

  it("image vide : zéro objet, sans erreur", () => {
    const r = detectBlobs(image(80, 60, PAPER), 80, 60);
    expect(r.count).toBe(0);
  });

  it("refuse les tailles invalides", () => {
    expect(() => detectBlobs(new Uint8ClampedArray(0), 0, 0)).toThrow();
    expect(() => detectBlobs(new Uint8ClampedArray(16), 4000, 4000)).toThrow();
  });

  it("marqueurs SVG sûrs", () => {
    const r = detectBlobs(disks(120, 80, [[30, 40], [90, 40]], 12, DARK, PAPER), 120, 80);
    const s = toOverlaySvg(r, { single: "javascript:alert(1)", split: "#f00" });
    expect(s.startsWith("<svg")).toBe(true);
    expect(s).not.toMatch(/<script|on\w+=|javascript:/);
    expect((s.match(/<circle/g) ?? []).length).toBe(2);
  });

  it("temps raisonnable sur 640×480", () => {
    const c = grid(14, 10, 42, 30);
    const data = disks(640, 480, c, 9, [180, 30, 60], PAPER);
    const t0 = performance.now();
    const r = detectBlobs(data, 640, 480);
    expect(r.count).toBe(140);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe("composant", () => {
  it("signale une source absente", () => {
    const el = document.createElement("sonic-blobs") as HTMLElement & { run: () => boolean };
    el.setAttribute("source", "#nope");
    el.setAttribute("out-data-provider", "bl.out");
    document.body.append(el);
    el.run();
    expect((dp("bl.out").get() as { status: string }).status).toBe("error");
    el.remove();
  });

  it("lance sur hausse du compteur", () => {
    const el = document.createElement("sonic-blobs") as HTMLElement & { run: () => boolean };
    el.setAttribute("source", "#nope");
    el.setAttribute("control", "bl.ctl");
    el.setAttribute("out-data-provider", "bl.out2");
    document.body.append(el);
    set("bl.ctl", { n: 0 });
    expect((dp("bl.out2").get() as { status: string }).status).toBe("idle");
    set("bl.ctl", { n: 1 });
    expect((dp("bl.out2").get() as { status: string }).status).toBe("error");
    el.remove();
  });
});
