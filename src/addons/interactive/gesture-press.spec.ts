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
});
