import { describe, expect, it } from "vitest";
import { get } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { GestureTracker, coalesce, type GestureOptions } from "./gesture-core";
import { readGestureParams, withNormalized } from "./gesture";

const opts = (o: Partial<GestureOptions> = {}): GestureOptions => ({
  swipeThreshold: 40, longPressMs: 450, doubleTapMs: 280, drag: false, pan: false, pinch: false, width: 400, height: 200, ...o,
});
const types = (a: { type: string }[]) => a.map((x) => x.type);

describe("coordonnées des gestes", () => {
  it("swipe : point de départ, start / end et déplacement", () => {
    const g = new GestureTracker();
    g.down({ id: 1, x: 100, y: 100, t: 0 }, opts());
    g.move({ id: 1, x: 160, y: 110, t: 50 }, opts());
    const [a] = g.up({ id: 1, x: 160, y: 110, t: 100 }, opts());
    expect(a).toEqual({
      type: "swipe-right",
      payload: { x: 100, y: 100, nx: 0.25, ny: 0.5, dx: 60, dy: 10, start: { x: 100, y: 100, nx: 0.25, ny: 0.5 }, end: { x: 160, y: 110, nx: 0.4, ny: 0.55 } },
    });
  });

  it("tap : nx, ny bornées ajoutées sans toucher x, y, u, v", () => {
    expect(withNormalized({ type: "tap", payload: { x: 10, y: 250, u: 0.025, v: 1.25 } }).payload).toEqual({ x: 10, y: 250, u: 0.025, v: 1.25, nx: 0.025, ny: 1 });
    expect(withNormalized({ type: "swipe-up" })).toEqual({ type: "swipe-up" });
  });
});

describe("drag continu (dragEvents)", () => {
  it("drag:start après 10 px, drag:move cadencé, drag:end avec vitesse ; pas de swipe", () => {
    const g = new GestureTracker();
    const o = opts({ dragEvents: true, rate: 10 });
    expect(g.down({ id: 1, x: 100, y: 100, t: 0 }, o)).toEqual([]);
    expect(g.move({ id: 1, x: 105, y: 100, t: 10 }, o)).toEqual([]); // sous la tolérance : rien
    const a = g.move({ id: 1, x: 120, y: 100, t: 20 }, o);
    expect(types(a)).toEqual(["drag:start", "drag:move"]);
    expect(a[0].payload).toEqual({ x: 100, y: 100, nx: 0.25, ny: 0.5 });
    expect(a[1].payload).toMatchObject({ x: 120, y: 100, nx: 0.3, dx: 20, dy: 0 });
    expect(g.move({ id: 1, x: 140, y: 100, t: 60 }, o)).toEqual([]); // 40 ms < 100 ms : retenu
    expect(types(g.move({ id: 1, x: 160, y: 100, t: 130 }, o))).toEqual(["drag:move"]);
    expect(g.state().drag).toMatchObject({ active: true, x: 160, dx: 60 });
    g.move({ id: 1, x: 170, y: 100, t: 150 }, o); // retenu, rendu au lever
    const end = g.up({ id: 1, x: 180, y: 100, t: 160 }, o);
    expect(types(end)).toEqual(["drag:move", "drag:end"]);
    const p = end[1].payload!;
    expect(p).toMatchObject({ x: 180, y: 100, dx: 80, dy: 0, start: { x: 100, y: 100 } });
    expect(Number(p.vx)).toBeGreaterThan(0);
    expect(p.cancelled).toBeUndefined();
    expect(g.state().drag).toMatchObject({ active: false });
  });

  it("un tap reste un tap ; un deuxième doigt interrompt le glisser (cancelled)", () => {
    const g = new GestureTracker();
    const o = opts({ dragEvents: true });
    g.down({ id: 1, x: 10, y: 10, t: 0 }, o);
    expect(types(g.up({ id: 1, x: 12, y: 10, t: 50 }, o))).toEqual(["tap"]);
    g.down({ id: 1, x: 10, y: 10, t: 1000 }, o);
    g.move({ id: 1, x: 40, y: 10, t: 1020 }, o);
    const b = g.down({ id: 2, x: 200, y: 10, t: 1030 }, o);
    expect(types(b)).toEqual(["drag:end"]);
    expect(b[0].payload).toMatchObject({ cancelled: true });
    expect(g.move({ id: 1, x: 80, y: 10, t: 1100 }, o)).toEqual([]);
  });

  it("cancel termine le glisser ; coalesce garde le dernier drag:move", () => {
    const g = new GestureTracker();
    const o = opts({ dragEvents: true });
    g.down({ id: 1, x: 0, y: 0, t: 0 }, o);
    g.move({ id: 1, x: 50, y: 0, t: 20 }, o);
    expect(g.cancel()).toEqual([expect.objectContaining({ type: "drag:end", payload: expect.objectContaining({ cancelled: true }) })]);
    expect(coalesce([{ type: "drag:move", payload: { x: 1 } }, { type: "drag:move", payload: { x: 2 } }])).toEqual([{ type: "drag:move", payload: { x: 2 } }]);
  });

  it("params : dragEvents et rate", () => {
    expect(readGestureParams({ dragEvents: true, rate: 500 }).settings).toEqual({ dragEvents: true, rate: 120 });
    expect(readGestureParams({ rate: "vite" }).invalid).toEqual(["rate"]);
  });
});

function pointer(type: string, id: number, x: number, y: number): Event {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
  Object.defineProperty(e, "pointerId", { value: id });
  return e;
}

describe("sonic-gesture drag-events", () => {
  it("actions et état publié ; attribut scroll reflété", async () => {
    document.body.innerHTML = `<sonic-gesture drag-events dispatch-event state-provider="gdState" scroll="y"></sonic-gesture>`;
    const el = document.querySelector("sonic-gesture") as HTMLElement & { updateComplete: Promise<unknown>; scrollAxis: string };
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} });
    (el as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    await el.updateComplete;
    expect(el.scrollAxis).toBe("y");
    const got: { type: string; payload: Record<string, unknown> }[] = [];
    el.addEventListener("sonic-action", (e) => got.push((e as CustomEvent).detail));
    el.dispatchEvent(pointer("pointerdown", 1, 20, 50));
    el.dispatchEvent(pointer("pointermove", 1, 60, 50));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect((get("gdState") as { drag: { active: boolean; nx: number } }).drag).toMatchObject({ active: true, nx: 0.3 });
    el.dispatchEvent(pointer("pointerup", 1, 100, 50));
    expect(got.map((a) => a.type)).toEqual(["drag:start", "drag:move", "drag:move", "drag:end"]);
    expect(got[3].payload).toMatchObject({ x: 100, nx: 0.5, dx: 80 });
    el.dispatchEvent(pointer("pointerdown", 2, 20, 20));
    el.dispatchEvent(pointer("pointerup", 2, 20, 20));
    expect(got[4]).toMatchObject({ type: "tap", payload: { x: 20, y: 20, nx: 0.1, ny: 0.2 } });
    el.remove();
  });
});
