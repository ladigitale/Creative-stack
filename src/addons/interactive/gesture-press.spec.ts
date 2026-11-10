import { describe, expect, it } from "vitest";
import "./gesture";

/** jsdom n'a pas PointerEvent : un MouseEvent porteur de pointerId suffit aux écouteurs. */
function pointer(type: string, id: number, x: number, y: number): Event {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
  Object.defineProperty(e, "pointerId", { value: id });
  return e;
}

describe("sonic-gesture press", () => {
  it("press au contact, release au lever, par doigt", async () => {
    const el = document.createElement("sonic-gesture") as HTMLElement & { press: boolean; dispatchEventFlag: boolean };
    el.press = true;
    el.dispatchEventFlag = true;
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} });
    (el as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    const got: { type: string; payload: Record<string, number> }[] = [];
    el.addEventListener("sonic-action", (e) => got.push((e as CustomEvent).detail));
    el.dispatchEvent(pointer("pointerdown", 1, 50, 25));
    el.dispatchEvent(pointer("pointerdown", 2, 150, 75));
    el.dispatchEvent(pointer("pointerup", 1, 60, 25));
    el.dispatchEvent(pointer("pointercancel", 2, 150, 75));
    el.dispatchEvent(pointer("pointerup", 2, 150, 75));
    const pr = got.filter((a) => a.type === "press" || a.type === "release");
    expect(pr.map((a) => `${a.type}:${a.payload.id}`)).toEqual(["press:1", "press:2", "release:1", "release:2"]);
    expect(pr[0].payload).toMatchObject({ u: 0.25, v: 0.25 });
    el.remove();
  });

  it("passthrough : rien à un doigt, pinch et pan à deux, sans capture", async () => {
    const el = document.createElement("sonic-gesture") as HTMLElement & { passthrough: boolean; pan: boolean; pinch: boolean; dispatchEventFlag: boolean };
    el.passthrough = true;
    el.pan = true;
    el.pinch = true;
    el.dispatchEventFlag = true;
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} });
    let captured = 0;
    (el as unknown as { setPointerCapture: () => void }).setPointerCapture = () => { captured++; };
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    const got: { type: string; payload: Record<string, number> }[] = [];
    el.addEventListener("sonic-action", (e) => got.push((e as CustomEvent).detail));
    el.dispatchEvent(pointer("pointerdown", 1, 50, 50));
    el.dispatchEvent(pointer("pointermove", 1, 90, 50));
    el.dispatchEvent(pointer("pointerup", 1, 90, 50));
    expect(got).toEqual([]);
    el.dispatchEvent(pointer("pointerdown", 1, 50, 50));
    el.dispatchEvent(pointer("pointerdown", 2, 150, 50));
    el.dispatchEvent(pointer("pointermove", 2, 150, 90));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    el.dispatchEvent(pointer("pointerup", 2, 150, 90));
    el.dispatchEvent(pointer("pointerup", 1, 50, 50));
    const types = got.map((a) => a.type);
    expect(types).toContain("pinch-start");
    expect(types).toContain("pinch");
    expect(types).not.toContain("tap");
    expect(types.some((t) => t.startsWith("swipe"))).toBe(false);
    expect(got.find((a) => a.type === "pinch")?.payload.dRotation).not.toBe(0);
    expect(captured).toBe(0);
    el.remove();
  });
});
