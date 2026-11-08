import { describe, expect, it } from "vitest";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SonicGesture, readGestureParams } from "./gesture";

void SonicGesture;

function pointer(type: string, id: number, x: number, y: number): Event {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
  Object.defineProperty(e, "pointerId", { value: id });
  return e;
}

describe("sonic-gesture params", () => {
  it("readGestureParams : bornes, booléens, valeurs refusées", () => {
    expect(readGestureParams({ swipeThreshold: 0, longPressMs: 1e6, doubleTapMs: "", press: true })).toEqual({
      settings: { swipeThreshold: 1, longPressMs: 10000, press: true },
      invalid: [],
    });
    expect(readGestureParams({ swipeThreshold: "loin", pan: "oui" }).invalid).toEqual(["swipeThreshold", "pan"]);
  });

  it("swipeThreshold et press en direct ; clé retirée = retour à l'attribut", async () => {
    const el = document.createElement("sonic-gesture") as SonicGesture;
    el.dispatchEventFlag = true;
    el.setAttribute("params", "gs1p");
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 100, right: 400, bottom: 100, x: 0, y: 0, toJSON() {} });
    (el as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    document.body.appendChild(el);
    await el.updateComplete;
    const got: string[] = [];
    el.addEventListener("sonic-action", (e) => got.push((e as CustomEvent).detail.type));
    const swipe = (id: number, dx: number) => {
      el.dispatchEvent(pointer("pointerdown", id, 10, 50));
      el.dispatchEvent(pointer("pointermove", id, 10 + dx, 50));
      el.dispatchEvent(pointer("pointerup", id, 10 + dx, 50));
    };
    swipe(1, 60); // 60 > 40 (attribut) : swipe
    expect(got.filter((t) => t.startsWith("swipe"))).toEqual(["swipe-right"]);
    set("gs1p", { swipeThreshold: 100, press: true });
    expect(el.settings().swipeThreshold).toBe(100);
    swipe(2, 60); // 60 < 100 : pas de swipe, mais press / release
    expect(got.filter((t) => t.startsWith("swipe"))).toEqual(["swipe-right"]);
    expect(got).toContain("press");
    expect(got).toContain("release");
    set("gs1p", {});
    expect(el.settings()).toMatchObject({ swipeThreshold: 40, press: false });
    el.remove();
  });
});
