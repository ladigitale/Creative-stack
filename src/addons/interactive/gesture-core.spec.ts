import { describe, expect, it } from "vitest";
import { GestureTracker, coalesce, type GestureOptions } from "./gesture-core";

const base: GestureOptions = { swipeThreshold: 40, longPressMs: 450, doubleTapMs: 280, drag: false, pan: false, pinch: false, width: 400, height: 200 };
const opts = (o: Partial<GestureOptions> = {}): GestureOptions => ({ ...base, ...o });
const types = (a: { type: string }[]) => a.map((x) => x.type);

describe("compatibilité (1 doigt)", () => {
  it("tap avec position, puis double-tap", () => {
    const g = new GestureTracker();
    g.down({ id: 1, x: 100, y: 50, t: 0 }, opts());
    const a = g.up({ id: 1, x: 101, y: 50, t: 80 }, opts());
    expect(a).toEqual([{ type: "tap", payload: { x: 100, y: 50, u: 0.25, v: 0.25 } }]);
    g.down({ id: 2, x: 100, y: 50, t: 200 }, opts());
    expect(types(g.up({ id: 2, x: 100, y: 50, t: 250 }, opts()))).toEqual(["double-tap"]);
  });

  it("swipe selon la direction dominante", () => {
    const g = new GestureTracker();
    g.down({ id: 1, x: 100, y: 100, t: 0 }, opts());
    g.move({ id: 1, x: 160, y: 110, t: 50 }, opts());
    expect(types(g.up({ id: 1, x: 160, y: 110, t: 100 }, opts()))).toEqual(["swipe-right"]);
  });

  it("drag : fraction cumulée depuis le début (sens historique) puis drag-end", () => {
    const g = new GestureTracker();
    const o = opts({ drag: true });
    g.down({ id: 1, x: 0, y: 0, t: 0 }, o);
    expect(g.move({ id: 1, x: 40, y: 20, t: 10 }, o)).toEqual([{ type: "drag", payload: { dx: 0.1, dy: 0.1 } }]);
    expect(g.move({ id: 1, x: 80, y: 20, t: 20 }, o)[0].payload).toEqual({ dx: 0.2, dy: 0.1 });
    const end = g.up({ id: 1, x: 80, y: 20, t: 30 }, o);
    expect(types(end)).toEqual(["drag-end", "swipe-right"]);
  });

  it("appui long : une fois, et ni tap ni swipe ensuite", () => {
    const g = new GestureTracker();
    g.down({ id: 1, x: 10, y: 10, t: 0 }, opts());
    expect(g.canLongPress()).toBe(true);
    expect(types(g.longPress(opts()))).toEqual(["long-press"]);
    expect(g.longPress(opts())).toEqual([]);
    expect(g.up({ id: 1, x: 90, y: 10, t: 600 }, opts())).toEqual([]);
  });

  it("un mouvement > 10 px annule l'appui long", () => {
    const g = new GestureTracker();
    g.down({ id: 1, x: 0, y: 0, t: 0 }, opts());
    g.move({ id: 1, x: 15, y: 0, t: 10 }, opts());
    expect(g.canLongPress()).toBe(false);
  });
});

describe("pan (px)", () => {
  it("delta en px depuis l'action précédente, pan-end avec vitesse, sans swipe", () => {
    const g = new GestureTracker();
    const o = opts({ pan: true });
    g.down({ id: 1, x: 100, y: 100, t: 0 }, o);
    expect(g.move({ id: 1, x: 130, y: 90, t: 100 }, o)).toEqual([{ type: "pan", payload: { dx: 30, dy: -10, x: 130, y: 90 } }]);
    expect(g.move({ id: 1, x: 150, y: 90, t: 200 }, o)[0].payload).toMatchObject({ dx: 20, dy: 0 });
    const end = g.up({ id: 1, x: 150, y: 90, t: 250 }, o);
    expect(end).toEqual([{ type: "pan-end", payload: { dx: 50, dy: -10, vx: 200, vy: -40 } }]);
  });
});

describe("pinch (2 doigts)", () => {
  it("échelle, rotation, centre ; pinch-end ; pas de tap ni swipe", () => {
    const g = new GestureTracker();
    const o = opts({ pinch: true });
    g.down({ id: 1, x: 100, y: 100, t: 0 }, o);
    const start = g.down({ id: 2, x: 200, y: 100, t: 10 }, o);
    expect(start).toEqual([{ type: "pinch-start", payload: { cx: 150, cy: 100 } }]);
    const p = g.move({ id: 2, x: 300, y: 100, t: 20 }, o);
    expect(p[0]).toEqual({ type: "pinch", payload: { scale: 2, dScale: 2, rotation: 0, dRotation: 0, cx: 200, cy: 100 } });
    const r = g.move({ id: 2, x: 100, y: 300, t: 30 }, o);
    expect(r[0].payload).toMatchObject({ scale: 2, rotation: 1.5708 });
    expect(types(g.up({ id: 2, x: 100, y: 300, t: 40 }, o))).toEqual(["pinch-end"]);
    // pan non activé : rien d'autre à la fin
    expect(g.up({ id: 1, x: 100, y: 100, t: 50 }, o)).toEqual([]);
  });

  it("pas de saut de pan quand un doigt se lève", () => {
    const g = new GestureTracker();
    const o = opts({ pinch: true, pan: true });
    g.down({ id: 1, x: 0, y: 0, t: 0 }, o);
    g.down({ id: 2, x: 100, y: 0, t: 0 }, o);
    g.up({ id: 2, x: 100, y: 0, t: 10 }, o);
    expect(g.move({ id: 1, x: 5, y: 0, t: 20 }, o)).toEqual([{ type: "pan", payload: { dx: 5, dy: 0, x: 5, y: 0 } }]);
  });

  it("sans l'option pinch, deux doigts n'émettent ni pinch ni tap", () => {
    const g = new GestureTracker();
    g.down({ id: 1, x: 0, y: 0, t: 0 }, opts());
    g.down({ id: 2, x: 50, y: 0, t: 0 }, opts());
    expect(g.move({ id: 2, x: 90, y: 0, t: 10 }, opts())).toEqual([]);
    g.up({ id: 2, x: 90, y: 0, t: 20 }, opts());
    expect(g.up({ id: 1, x: 0, y: 0, t: 30 }, opts())).toEqual([]);
  });
});

describe("pan-end", () => {
  it("pas de pan-end sans aucun pan émis", () => {
    const g = new GestureTracker();
    const o = opts({ pinch: true, pan: true });
    g.down({ id: 1, x: 100, y: 100, t: 0 }, o);
    g.down({ id: 2, x: 200, y: 100, t: 0 }, o);
    g.up({ id: 2, x: 200, y: 100, t: 20 }, o);
    expect(types(g.up({ id: 1, x: 100, y: 100, t: 30 }, o))).toEqual([]);
  });
});

describe("molette et regroupement", () => {
  it("la molette donne un pinch source wheel", () => {
    const g = new GestureTracker();
    const a = g.wheel(-100, 10, 20);
    expect(a.type).toBe("pinch");
    expect(a.payload).toMatchObject({ source: "wheel", cx: 10, cy: 20 });
    expect(Number(a.payload!.dScale)).toBeGreaterThan(1);
  });

  it("coalesce : pan additionné, pinch multiplié, ordre conservé", () => {
    const out = coalesce([
      { type: "pan", payload: { dx: 1, dy: 2, x: 1, y: 2 } },
      { type: "pan", payload: { dx: 3, dy: 4, x: 4, y: 6 } },
      { type: "pinch", payload: { scale: 1.1, dScale: 1.1, rotation: 0, dRotation: 0.1, cx: 0, cy: 0 } },
      { type: "pinch", payload: { scale: 1.21, dScale: 1.1, rotation: 0.2, dRotation: 0.1, cx: 1, cy: 1 } },
    ]);
    expect(out).toEqual([
      { type: "pan", payload: { dx: 4, dy: 6, x: 4, y: 6 } },
      { type: "pinch", payload: { scale: 1.21, dScale: 1.21, rotation: 0.2, dRotation: 0.2, cx: 1, cy: 1 } },
    ]);
  });

  it("état publié", () => {
    const g = new GestureTracker();
    g.down({ id: 1, x: 10, y: 10, t: 0 }, opts());
    expect(g.state()).toMatchObject({ active: true, pointers: 1, scale: 1 });
    g.cancel();
    expect(g.state()).toMatchObject({ active: false, pointers: 0 });
  });
});
