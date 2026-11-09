import { describe, expect, it } from "vitest";
import {
  ViewGestures, fitBox, invert, multiply, normAngle, panView, sanitizeView2D, screenToWorld, transformAt, viewMatrix,
  visibleBounds, wheelFactor, worldToScreen, type View2D,
} from "./view2d";

const W = 400, H = 300;

describe("vue 2D", () => {
  it("écran ↔ monde est une bijection, rotation comprise", () => {
    const v: View2D = { x: 120, y: -40, zoom: 3.5, rotation: 1.1 };
    const [wx, wy] = screenToWorld(v, 37, 211, W, H);
    const [sx, sy] = worldToScreen(v, wx, wy, W, H);
    expect(sx).toBeCloseTo(37, 9);
    expect(sy).toBeCloseTo(211, 9);
  });

  it("la matrice de vue place le monde comme worldToScreen", () => {
    const v: View2D = { x: 10, y: 20, zoom: 2, rotation: -0.6 };
    const m = viewMatrix(v, W, H);
    const [sx, sy] = worldToScreen(v, 55, -7, W, H);
    expect(m[0] * 55 + m[2] * -7 + m[4]).toBeCloseTo(sx, 9);
    expect(m[1] * 55 + m[3] * -7 + m[5]).toBeCloseTo(sy, 9);
    const id = multiply(m, invert(m));
    expect(id.map((x) => Math.round(x * 1e9) / 1e9 + 0)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("zoom et rotation gardent fixe le point sous les doigts", () => {
    const v: View2D = { x: 0, y: 0, zoom: 1, rotation: 0.2 };
    const before = screenToWorld(v, 300, 50, W, H);
    const t = transformAt(v, 2.5, 0.7, 300, 50, W, H, 0.01, 64);
    const [sx, sy] = worldToScreen(t, before[0], before[1], W, H);
    expect(sx).toBeCloseTo(300, 9);
    expect(sy).toBeCloseTo(50, 9);
    expect(t.zoom).toBe(2.5);
    expect(t.rotation).toBeCloseTo(0.9);
  });

  it("le contenu suit le doigt, même tourné", () => {
    const v: View2D = { x: 5, y: 5, zoom: 2, rotation: Math.PI / 2 };
    const w0 = screenToWorld(v, 100, 100, W, H);
    const p = panView(v, 30, -12);
    const [sx, sy] = worldToScreen(p, w0[0], w0[1], W, H);
    expect(sx).toBeCloseTo(130, 9);
    expect(sy).toBeCloseTo(88, 9);
  });

  it("bornes, angles et valeurs invalides", () => {
    expect(normAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(normAngle(-3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(normAngle(NaN)).toBe(0);
    expect(sanitizeView2D({ x: "4", zoom: 1e9, rotation: "x" }, { x: 0, y: 1, zoom: 2, rotation: 0.5 }, 0.01, 64)).toEqual({ x: 4, y: 1, zoom: 64, rotation: 0.5 });
    expect(wheelFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false })).toBeGreaterThan(1);
    expect(wheelFactor({ deltaY: 100, deltaMode: 0, ctrlKey: true })).toBeLessThan(wheelFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false }));
  });

  it("cadre une boîte tournée et couvre l'écran", () => {
    const v = fitBox({ x: 0, y: 0, w: 4000, h: 2000 }, W, H, Math.PI / 2, 0.01, 64, 0)!;
    expect(v.zoom).toBeCloseTo(Math.min(W / 2000, H / 4000));
    const b = visibleBounds(v, W, H);
    expect(b.w).toBeCloseTo(H / v.zoom);
    expect(b.h).toBeCloseTo(W / v.zoom);
    expect(fitBox(null, W, H, 0, 0.01, 64)).toBeNull();
  });
});

describe("gestes de vue", () => {
  function host(v: View2D) {
    const h = {
      v,
      settled: 0,
      view: () => h.v,
      setView: (nv: View2D, settled: boolean) => { h.v = nv; if (settled) h.settled++; },
      size: () => ({ w: W, h: H }),
      zoomRange: () => [0.01, 64] as [number, number],
      fit: () => { h.v = { x: 0, y: 0, zoom: 1, rotation: 0 }; },
    };
    return h;
  }

  it("deux doigts : déplacer, zoomer et tourner ; le doigt seul n'est pas un geste", () => {
    const h = host({ x: 0, y: 0, zoom: 1, rotation: 0 });
    const g = new ViewGestures(h);
    expect(g.down(1, { x: 100, y: 150 }, false)).toBe("none");
    expect(g.move(1, { x: 110, y: 150 })).toBe(false);
    expect(g.down(2, { x: 300, y: 150 }, false)).toBe("pinch");
    const under = screenToWorld(h.v, 205, 150, W, H);
    // Les doigts s'écartent et tournent d'un quart de tour autour de leur milieu.
    g.move(1, { x: 200, y: 50 });
    expect(g.move(2, { x: 200, y: 350 })).toBe(true);
    expect(h.v.rotation).toBeCloseTo(Math.PI / 2);
    expect(h.v.zoom).toBeCloseTo(300 / 190, 5);
    const [sx, sy] = worldToScreen(h.v, under[0], under[1], W, H);
    expect(sx).toBeCloseTo(200, 5);
    expect(sy).toBeCloseTo(200, 5);
    g.up(2);
    expect(h.settled).toBe(1);
    expect(g.active).toBe(false);
    expect(g.move(1, { x: 0, y: 0 })).toBe(false);
  });

  it("glisser avec la main déplace la vue ; clavier", () => {
    const h = host({ x: 0, y: 0, zoom: 2, rotation: 0 });
    const g = new ViewGestures(h);
    expect(g.down(1, { x: 10, y: 10 }, true)).toBe("pan");
    g.move(1, { x: 50, y: 10 });
    expect(h.v.x).toBeCloseTo(-20);
    g.up(1);
    const key = (k: string, shiftKey = false) => g.key({ key: k, shiftKey, ctrlKey: false, metaKey: false, altKey: false } as KeyboardEvent);
    expect(key("r")).toBe(true);
    expect(h.v.rotation).toBeCloseTo(Math.PI / 12);
    expect(key("R", true)).toBe(true);
    expect(h.v.rotation).toBeCloseTo(0);
    expect(key("+")).toBe(true);
    expect(h.v.zoom).toBeCloseTo(3.2);
    expect(key("0")).toBe(true);
    expect(h.v.zoom).toBe(1);
    expect(key("a")).toBe(false);
  });
});
