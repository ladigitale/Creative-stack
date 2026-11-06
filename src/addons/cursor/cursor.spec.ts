import { afterEach, describe, expect, it } from "vitest";
import { dp } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { hoverTarget, magneticOffset } from "./core";
import { SonicCursor } from "./cursor";

void SonicCursor;

if (typeof PointerEvent === "undefined") {
  class PE extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) { super(type, init); this.pointerType = init.pointerType ?? "mouse"; }
  }
  (globalThis as any).PointerEvent = PE;
}

describe("effet magnétique", () => {
  const box = { left: 100, top: 100, width: 100, height: 40 };
  it("hors zone : rien", () => {
    expect(magneticOffset(box, 10, 10, 60, 0.35, 14)).toEqual({ dx: 0, dy: 0, active: false });
  });
  it("attire vers le pointeur", () => {
    const r = magneticOffset(box, 180, 120, 60, 0.35, 14);
    expect(r.active).toBe(true);
    expect(r.dx).toBeCloseTo(10.5, 5);
    expect(r.dy).toBeCloseTo(0, 5);
  });
  it("plafonné", () => {
    const r = magneticOffset(box, 240, 120, 60, 1, 14);
    expect(Math.hypot(r.dx, r.dy)).toBeCloseTo(14, 5);
  });
  it("zone élargie du rayon", () => {
    expect(magneticOffset(box, 150, 80, 30, 0.5, 20).active).toBe(true);
    expect(magneticOffset(box, 150, 60, 30, 0.5, 20).active).toBe(false);
  });
});

describe("élément survolé", () => {
  it("premier data-cursor du chemin", () => {
    const a = document.createElement("div");
    const b = document.createElement("a");
    b.setAttribute("data-cursor", "voir");
    b.id = "lien";
    expect(hoverTarget([a, b, document.body])).toEqual({ name: "voir", id: "lien" });
    expect(hoverTarget([a, document.body])).toBeNull();
    expect(hoverTarget([window, null, 3])).toBeNull();
  });
});

describe("sonic-cursor", () => {
  afterEach(() => { document.body.innerHTML = ""; document.head.innerHTML = ""; });
  const flush = () => new Promise((r) => setTimeout(r, 60));
  const mk = async (attrs: Record<string, string>) => {
    const el = document.createElement("sonic-cursor") as SonicCursor;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.appendChild(el);
    await el.updateComplete;
    return el;
  };
  it("publie position et élément survolé", async () => {
    const target = document.createElement("button");
    target.setAttribute("data-cursor", "ouvrir");
    document.body.appendChild(target);
    const el = await mk({ "out-data-provider": "ptr-test", smooth: "1" });
    target.dispatchEvent(new PointerEvent("pointermove", { clientX: 40, clientY: 25, pointerType: "mouse", bubbles: true, composed: true }));
    await flush();
    const s = dp("ptr-test").get() as any;
    expect(s.x).toBe(40);
    expect(s.y).toBe(25);
    expect(s.inside).toBe(true);
    expect(s.hover).toEqual({ name: "ouvrir", id: "" });
    expect(s.smoothX).toBe(40);
    el.remove();
  });
  it("appui et sortie", async () => {
    const el = await mk({ "out-data-provider": "ptr-down", smooth: "1" });
    window.dispatchEvent(new PointerEvent("pointerdown", { clientX: 5, clientY: 6, pointerType: "mouse" }));
    await flush();
    expect((dp("ptr-down").get() as any).down).toBe(true);
    window.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse" }));
    await flush();
    expect((dp("ptr-down").get() as any).down).toBe(false);
    el.remove();
  });
  it("suiveur créé puis retiré, curseur natif masqué à la demande", async () => {
    const el = await mk({ follower: "ring", "hide-native": "", size: "30" });
    expect(document.body.querySelectorAll("div[aria-hidden]").length).toBe(1);
    expect(document.head.querySelector("style")?.textContent).toContain("cursor:none");
    el.removeAttribute("hide-native");
    el.hideNative = false;
    el.follower = "none";
    await el.updateComplete;
    expect(document.body.querySelectorAll("div[aria-hidden]").length).toBe(0);
    expect(document.head.querySelector("style")).toBeNull();
    el.remove();
  });
  it("éléments magnétiques : décalage appliqué puis relâché", async () => {
    const m = document.createElement("div");
    m.setAttribute("data-magnetic", "");
    m.getBoundingClientRect = () => ({ left: 100, top: 100, width: 100, height: 40, right: 200, bottom: 140, x: 100, y: 100, toJSON() {} }) as DOMRect;
    document.body.appendChild(m);
    const el = await mk({ magnetic: "[data-magnetic]", smooth: "1", "magnetic-max": "20", "magnetic-strength": "0.5" });
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 190, clientY: 120, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 400));
    expect(m.style.translate).not.toBe("");
    expect(m.style.getPropertyValue("--mx")).not.toBe("");
    document.documentElement.dispatchEvent(new Event("pointerleave"));
    await new Promise((r) => setTimeout(r, 800));
    expect(m.style.translate).toBe("");
    el.remove();
  });
  it("tactile : pas d'attraction", async () => {
    const m = document.createElement("div");
    m.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40, right: 100, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
    m.setAttribute("data-magnetic", "");
    document.body.appendChild(m);
    const el = await mk({ magnetic: "[data-magnetic]", smooth: "1" });
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 90, clientY: 20, pointerType: "touch" }));
    await flush();
    expect(m.style.translate).toBe("");
    el.remove();
  });
});
