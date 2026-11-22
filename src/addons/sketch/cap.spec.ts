import { describe, expect, it } from "vitest";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import type { SonicSketch } from "./sketch";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Inner = { mode: string; backdropUrl: string };
const ptr = (type: string, x: number, y: number, o: Record<string, unknown> = {}) => {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
  const all = { pointerId: 1, pointerType: "mouse", pressure: 0.5, tiltX: 0, tiltY: 0, twist: 0, buttons: 1, button: 0, ...o };
  for (const [k, v] of Object.entries(all)) Object.defineProperty(e, k, { value: v });
  return e;
};
const mount = async (attrs: Record<string, string> = {}) => {
  const el = document.createElement("sonic-sketch") as SonicSketch;
  for (const [k, v] of Object.entries({ width: "400", height: "300", background: "transparent", ...attrs })) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  const c = el.shadowRoot!.querySelector("canvas")!;
  c.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return { el, c, inner: el as unknown as Inner };
};

describe("sonic-sketch : plafond de traits, photo de fond, export du cadre", () => {
  it("max-strokes : au-delà, un nouveau trait est refusé et l'état dit full", async () => {
    const { el, c, inner } = await mount({ "max-strokes": "1" });
    let full = 0;
    el.addEventListener("sketch-full", () => full++);
    c.dispatchEvent(ptr("pointerdown", 50, 50));
    c.dispatchEvent(ptr("pointermove", 120, 80));
    c.dispatchEvent(ptr("pointerup", 120, 80, { buttons: 0 }));
    await wait(20);
    expect(el.getState().strokes).toBe(1);
    expect(el.getState()).toMatchObject({ maxStrokes: 1, full: true });
    c.dispatchEvent(ptr("pointerdown", 60, 60, { pointerId: 2 }));
    expect(inner.mode).not.toBe("draw");
    expect(full).toBe(1);
    el.remove();
  });

  it("backdrop-from : URL ou {url} d'image acceptée, le reste ignoré", async () => {
    set("skBack", null);
    const { el, inner } = await mount({ "backdrop-from": "skBack" });
    set("skBack", { url: "data:image/png;base64,iVBORw0KGgo=" });
    await wait(5);
    expect(inner.backdropUrl).toBe("data:image/png;base64,iVBORw0KGgo=");
    set("skBack", "javascript:alert(1)");
    await wait(5);
    expect(inner.backdropUrl).toBe("javascript:alert(1)");
    expect((el as unknown as { backdrop: unknown }).backdrop).toBeNull();
    el.remove();
  });

  it("toSvg({area: 'page'}) garde le cadre de la toile, même zoomée", async () => {
    const { el } = await mount();
    (el as unknown as { setView: (v: unknown, b: boolean) => void }).setView({ x: 50, y: 20, zoom: 3, rotation: 0 }, true);
    const vb = (svg: string | null) => (/viewBox="([^"]+)"/.exec(svg ?? "")?.[1] ?? "").split(/\s+/).map(Number);
    expect(vb(el.toSvg({ area: "page" }))).toEqual([-200, -150, 400, 300]);
    expect(vb(el.toSvg({ area: "view" }))[2]).toBeCloseTo(400 / 3, 0);
    el.remove();
  });
});
