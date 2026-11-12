import { describe, expect, it } from "vitest";
import "./index";
import type { SonicSketch } from "./sketch";

type Inner = { mode: string; erasing: boolean; stroke: { brush: { angle: number } } | null };
const ptr = (type: string, x: number, y: number, o: Record<string, unknown>) => {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
  const all = { pointerId: 1, pointerType: "pen", pressure: 0.5, tiltX: 0, tiltY: 0, twist: 0, buttons: 1, ...o };
  for (const [k, v] of Object.entries(all)) Object.defineProperty(e, k, { value: v });
  return e;
};
const mount = async (attrs: Record<string, string> = {}) => {
  const el = document.createElement("sonic-sketch") as SonicSketch;
  for (const [k, v] of Object.entries({ width: "400", height: "300", ...attrs })) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  const c = el.shadowRoot!.querySelector("canvas")!;
  c.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return { el, c, inner: el as unknown as Inner };
};

describe("sonic-sketch : stylets", () => {
  it("bout gomme : le trait devient une gomme ; pen-eraser=none : il dessine", async () => {
    const { el, c, inner } = await mount();
    c.dispatchEvent(ptr("pointerdown", 50, 50, { buttons: 32 }));
    expect([inner.mode, inner.erasing]).toEqual(["draw", true]);
    c.dispatchEvent(ptr("pointerup", 50, 50, { buttons: 0 }));
    el.setAttribute("pen-eraser", "none");
    await el.updateComplete;
    c.dispatchEvent(ptr("pointerdown", 60, 50, { pointerId: 2, buttons: 32 }));
    expect(inner.erasing).toBe(false);
    el.remove();
  });

  it("bouton latéral : pipette par défaut, déplacement de la vue avec pen-barrel=pan", async () => {
    const { el, c, inner } = await mount();
    c.dispatchEvent(ptr("pointerdown", 50, 50, { buttons: 3, button: 2 }));
    expect(inner.mode).toBe("pick");
    c.dispatchEvent(ptr("pointerup", 50, 50, { buttons: 0 }));
    el.setAttribute("pen-barrel", "pan");
    await el.updateComplete;
    c.dispatchEvent(ptr("pointerdown", 50, 50, { pointerId: 3, buttons: 3, button: 2 }));
    expect(inner.mode).toBe("pan");
    el.remove();
  });

  it("paume : après le stylet, un doigt seul déplace la vue ; touch=draw garde le dessin au doigt", async () => {
    const { el, c, inner } = await mount();
    c.dispatchEvent(ptr("pointerdown", 50, 50, { pointerType: "touch", pointerId: 10 }));
    expect(inner.mode).toBe("draw");
    c.dispatchEvent(ptr("pointerup", 50, 50, { pointerType: "touch", pointerId: 10, buttons: 0 }));
    c.dispatchEvent(ptr("pointerdown", 80, 50, { pointerId: 11 }));
    c.dispatchEvent(ptr("pointerup", 80, 50, { pointerId: 11, buttons: 0 }));
    c.dispatchEvent(ptr("pointerdown", 50, 50, { pointerType: "touch", pointerId: 12 }));
    expect(inner.mode).toBe("pan");
    c.dispatchEvent(ptr("pointerup", 50, 50, { pointerType: "touch", pointerId: 12, buttons: 0 }));
    el.setAttribute("touch", "draw");
    await el.updateComplete;
    c.dispatchEvent(ptr("pointerdown", 50, 50, { pointerType: "touch", pointerId: 13 }));
    expect(inner.mode).toBe("draw");
    el.remove();
  });

  it("rotation / inclinaison du stylet : orientent la pointe ; pen-tilt=none l'ignore", async () => {
    const { el, c, inner } = await mount({ angle: "10" });
    c.dispatchEvent(ptr("pointerdown", 50, 50, { twist: 30 }));
    expect(inner.stroke!.brush.angle).toBeCloseTo(40);
    c.dispatchEvent(ptr("pointerup", 50, 50, { buttons: 0 }));
    c.dispatchEvent(ptr("pointerdown", 60, 50, { pointerId: 5, tiltY: 45 }));
    expect(inner.stroke!.brush.angle).toBeCloseTo(100);
    c.dispatchEvent(ptr("pointerup", 60, 50, { pointerId: 5, buttons: 0 }));
    el.setAttribute("pen-tilt", "none");
    await el.updateComplete;
    c.dispatchEvent(ptr("pointerdown", 70, 50, { pointerId: 6, twist: 30 }));
    expect(inner.stroke!.brush.angle).toBeCloseTo(10);
    el.remove();
  });
});

describe("sonic-paint : stylets", () => {
  it("bout gomme et rotation pendant le trait, remis à la fin ; bouton latéral en pipette", async () => {
    await import("../paint/index");
    const el = document.createElement("sonic-paint") as HTMLElement & { brush(): { tool: string; angle: number }; updateComplete: Promise<unknown> };
    el.setAttribute("width", "200"); el.setAttribute("height", "100");
    document.body.appendChild(el);
    await el.updateComplete;
    const c = el.shadowRoot!.querySelector("canvas")!;
    c.dispatchEvent(ptr("pointerdown", 10, 10, { buttons: 32, twist: 45 }));
    expect(el.brush()).toMatchObject({ tool: "erase", angle: 45 });
    c.dispatchEvent(ptr("pointerup", 10, 10, { buttons: 0 }));
    expect(el.brush()).toMatchObject({ tool: "paint", angle: 0 });
    c.dispatchEvent(ptr("pointerdown", 10, 10, { pointerId: 2, buttons: 3, button: 2 }));
    expect((el as unknown as { picking: boolean }).picking).toBe(true);
    el.remove();
  });
});

describe("sonic-sketch : pression en direct", () => {
  it("pressureCurve / pressureMin / simulatePressure du DP du pinceau", async () => {
    const { set } = await import("@supersoniks/concorde/core/utils/PublisherProxy");
    set("penLive", { size: 10 });
    const { el } = await mount({ "brush-from": "penLive" });
    const pr = (o: Record<string, unknown>) => (el as unknown as { pressureOf(e: PointerEvent): number }).pressureOf(ptr("pointermove", 0, 0, o) as unknown as PointerEvent);
    expect(pr({ pressure: 0.5 })).toBeCloseTo(0.5);
    set("penLive", { size: 10, pressureCurve: 2, pressureMin: 0.2 });
    expect(pr({ pressure: 0.5 })).toBeCloseTo(0.2 + 0.8 * 0.25);
    expect(pr({ pointerType: "mouse" })).toBe(1);
    set("penLive", { size: 10, simulatePressure: true });
    expect(pr({ pointerType: "mouse" })).toBe(1);
    el.remove();
  });
});
