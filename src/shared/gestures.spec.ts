import { describe, expect, it } from "vitest";
import { applyGestures, gestureMode, wheelToPage } from "./gestures";

describe("gestes et défilement de page", () => {
  it("mode lu avec repli sur auto", () => {
    expect(gestureMode("capture")).toBe("capture");
    expect(gestureMode("cooperative")).toBe("cooperative");
    expect(gestureMode("n'importe")).toBe("auto");
    expect(gestureMode(undefined)).toBe("auto");
  });
  it("capture : touch-action none ; coopératif : pan-y et molette rendue à la page sans Ctrl", () => {
    const host = document.createElement("div");
    const c = document.createElement("canvas");
    host.appendChild(c);
    document.body.appendChild(host);
    expect(applyGestures(host, [c], "capture")).toBe(false);
    expect(c.style.touchAction).toBe("none");
    expect(applyGestures(host, [c], "cooperative")).toBe(true);
    expect(host.style.touchAction).toBe("pan-y");
    expect(wheelToPage(true, new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
    expect(wheelToPage(true, new WheelEvent("wheel", { deltaY: 10, ctrlKey: true }))).toBe(false);
    expect(wheelToPage(false, new WheelEvent("wheel", { deltaY: 10 }))).toBe(false);
    host.remove();
  });
});
