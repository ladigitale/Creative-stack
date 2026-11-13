import { describe, expect, it } from "vitest";
import { TILE, TileCache, tileLevel, tileRect, tilesFor } from "./tiles";
import { makeBrush, strokeBBox, type Stroke } from "./model";
import { BRUSH_DEFAULTS } from "../paint/brush";

/** Canvas factice : compte les empreintes posées (drawImage). */
function fakeCanvas(w: number, h: number) {
  const ctx = {
    n: 0,
    save() {}, restore() {}, translate() {}, rotate() {}, fill() {}, fillRect() {}, clearRect() {}, beginPath() {}, rect() {}, clip() {}, setTransform() {},
    getTransform() { return { a: 1, d: 1, e: 0, f: 0 }; },
    drawImage() { this.n++; },
    globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "#000", imageSmoothingEnabled: true, imageSmoothingQuality: "low",
    canvas: null as unknown,
  };
  const c = { width: w, height: h, getContext: () => ctx } as unknown as HTMLCanvasElement & { getContext: () => typeof ctx };
  ctx.canvas = c;
  return c;
}
const made: ReturnType<typeof fakeCanvas>[] = [];
const cache = () => new TileCache((w, h) => { const c = fakeCanvas(w, h); made.push(c); return c; });
const b = makeBrush({ ...BRUSH_DEFAULTS, hardness: 1, pressure: false }, 10);
let id = 0;
const line = (x0: number, y0: number, x1: number, y1: number): Stroke => {
  const pts = [x0, y0, 1, x1, y1, 1];
  return { id: ++id, brush: b, pts, seed: 1, bbox: strokeBBox(pts, 5) };
};
const drawn = (c: HTMLCanvasElement) => (c.getContext("2d") as unknown as { n: number }).n;

describe("pyramide de tuiles", () => {
  it("niveau le plus fin qui reste au moins au zoom ; tuiles d'un rectangle", () => {
    expect(tileLevel(1)).toBe(0);
    expect(tileLevel(1.5)).toBe(1);
    expect(tileLevel(0.3)).toBe(-1);
    expect(tileRect(1, 2, -1)).toEqual({ x: 256, y: -128, w: 128, h: 128 });
    expect(tilesFor(0, { x: -10, y: 0, w: 300, h: 10 })).toEqual([[-1, 0], [0, 0], [1, 0]]);
    expect(TILE).toBe(256);
  });

  it("un trait ajouté au-dessus est peint sur les tuiles en cache qu'il touche, sans les refaire", () => {
    const tc = cache();
    const a = line(10, 10, 100, 10);
    tc.sync([a], "#fff");
    const t0 = tc.render(0, 0, 0)!, t1 = tc.render(0, 3, 0)!;
    const n0 = drawn(t0.canvas), n1 = drawn(t1.canvas);
    expect(n0).toBeGreaterThan(0);
    expect(n1).toBe(0);
    const c = line(20, 50, 120, 50);
    tc.sync([a, c], "#fff");
    expect(tc.get(0, 0, 0)).toBe(t0);
    expect(drawn(t0.canvas)).toBeGreaterThan(n0);
    expect(drawn(t1.canvas)).toBe(0);
  });

  it("annulation ou retouche : seules les tuiles sous les traits changés sont oubliées", () => {
    const tc = cache();
    const a = line(10, 10, 100, 10), far = line(900, 10, 950, 10);
    tc.sync([a, far], null);
    tc.render(0, 0, 0);
    tc.render(0, 3, 0);
    tc.sync([far], null);
    expect(tc.get(0, 0, 0)).toBeUndefined();
    expect(tc.get(0, 3, 0)).toBeDefined();
    // changement de fond : tout est refait
    tc.sync([far], "#000");
    expect(tc.size).toBe(0);
  });

  it("composition : tuiles manquantes comptées, rendues sous budget, remplacées par un niveau voisin", () => {
    const tc = cache();
    tc.sync([line(0, 0, 200, 0)], null);
    const out = fakeCanvas(10, 10).getContext() as unknown as CanvasRenderingContext2D;
    const view = { x: 128, y: 128, zoom: 1, rotation: 0 };
    expect(tc.draw(out, view, 256, 256, 1, false)).toBeGreaterThan(0);
    expect(tc.draw(out, view, 256, 256, 1, true, () => false)).toBeGreaterThan(0);
    expect(tc.draw(out, view, 256, 256, 1, true)).toBe(0);
    // au niveau au-dessus, rien en cache, mais la tuile parente (niveau 0) sert de remplaçante
    const before = (out as unknown as { n: number }).n;
    const miss = tc.draw(out, { ...view, zoom: 1.6 }, 256, 256, 1, false);
    expect(miss).toBeGreaterThan(0);
    expect((out as unknown as { n: number }).n).toBeGreaterThan(before);
  });
});
