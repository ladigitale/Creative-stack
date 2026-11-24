import { describe, expect, it } from "vitest";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import type { SonicSketch } from "./sketch";
import { decodeSource, encodeSource, svgText } from "./source";
import { exportSvg } from "./export";
import { readStrokes } from "./store";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const ptr = (type: string, x: number, y: number, o: Record<string, unknown> = {}) => {
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
  return { el, c };
};
const line = (c: HTMLCanvasElement, x0: number, y0: number, x1: number, y1: number, id = 1) => {
  c.dispatchEvent(ptr("pointerdown", x0, y0, { pointerId: id }));
  for (let i = 1; i <= 6; i++) c.dispatchEvent(ptr("pointermove", x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * i) / 6, { pointerId: id }));
  c.dispatchEvent(ptr("pointerup", x1, y1, { pointerId: id, buttons: 0 }));
};

describe("sonic-sketch : SVG avec traits d'origine", () => {
  it("exportSvg donne width/height (taille nominale) et embarque la source", () => {
    const svg = exportSvg([], { area: { x: -600, y: -450, w: 1200, h: 900 }, margin: 0, source: { format: "json", data: '{"a":"<&>"}' } });
    expect(svg).toMatch(/<svg [^>]*width="1200" height="900" viewBox="-600 -450 1200 900"/);
    expect(svg).toContain('<metadata id="sonic-sketch-source" data-format="json">{&quot;a&quot;:&quot;&lt;&amp;>&quot;}</metadata>');
  });

  it("aller-retour : un SVG exporté se rouvre trait par trait", async () => {
    const strokes = readStrokes([
      { brush: { size: 6, color: "#ff3d7f", blend: "multiply" }, seed: 3, pts: [0, 0, 0.5, 40.12345, 20, 0.5, 80, 10, 0.6] },
      { brush: { size: 20, color: "#00aaff", opacity: 0.4 }, seed: 1, pts: [-50, -20, 0.5, 10, 30, 0.5] },
    ])!;
    const source = await encodeSource(strokes);
    expect(source.format).toBe("gz64");
    const svg = exportSvg(strokes, { area: { x: -200, y: -150, w: 400, h: 300 }, margin: 0, source });
    const back = await decodeSource(svg);
    expect(back?.map((s) => [s.brush.blend, s.brush.color, s.pts[3]])).toEqual([["multiply", "#ff3d7f", 40.123], [undefined, "#00aaff", 10]]);

    set("ouvrir", null);
    const { el: b } = await mount({ "open-from": "ouvrir", "max-strokes": "500" });
    set("ouvrir", "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg))));
    // Décompression asynchrone : sous charge (suite complète en parallèle), 30 ms ne suffisent pas toujours.
    for (let t = 0; t < 100 && b.getState().strokes !== 2; t++) await wait(20);
    expect(b.getState().strokes).toBe(2);
    expect(b.getState().opened).toEqual({ strokes: 2 });
    expect(b.getState().canUndo).toBe(false);
    expect(b.toSvg({ area: "page" })).toContain("mix-blend-mode:multiply");
    set("ouvrir", { url: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>') });
    await wait(10);
    expect(b.getState().opened).toEqual({ error: "dessin sans traits d'origine" });
    expect(b.getState().strokes).toBe(2);
    b.remove();
  });

  it("source corrompue ou d'une autre version : rien n'est ouvert", async () => {
    const bad = (d: string, fmt = "gz64") => `<svg xmlns="http://www.w3.org/2000/svg"><metadata id="sonic-sketch-source" data-format="${fmt}">${d}</metadata></svg>`;
    expect(await decodeSource(bad("!!!"))).toBeNull();
    expect(await decodeSource(bad('{"v":2,"strokes":[]}', "json"))).toBeNull();
    expect(await decodeSource(bad('{"v":1,"strokes":[{"brush":{"size":4},"pts":[0,0,1,5,5,1]}]}', "json"))).toHaveLength(1);
    expect(await svgText("javascript:alert(1)")).toBeNull();
    expect(readStrokes("x")).toBeNull();
  });
});
