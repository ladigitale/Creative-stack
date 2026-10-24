import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { getStore } from "../interactive";
import { StageNodes, writeElement } from "./stage-core";
import "./index";
import type { SonicStage } from "./stage";
import manifestJson from "./manifest.json";
import billes from "./examples/billes-dom.sdui.json";

const tick = () => new Promise((r) => setTimeout(r, 0));
let n = 0;
const id = (p: string) => `${p}-${++n}`;

function el(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("writeElement", () => {
  it("absolute : (x, y) = centre de l'élément, rotation en radians ; offset : simple décalage", () => {
    const a = document.createElement("div");
    writeElement(a, { x: 100, y: 50, rz: Math.PI / 2, sx: 2, sy: 2, opacity: 0.5, z: 3, visible: false }, "absolute");
    expect(a.style.position).toBe("absolute");
    expect(a.style.transform).toBe("translate(100px, 50px) translate(-50%, -50%) rotate(1.571rad) scale(2, 2)");
    expect([a.style.opacity, a.style.zIndex, a.style.visibility]).toEqual(["0.5", "3", "hidden"]);
    const b = document.createElement("div");
    writeElement(b, { y: 10 }, "offset");
    expect(b.style.position).toBe("");
    expect(b.style.transform).toBe("translate(0px, 10px)");
  });

  it("SVG : attributs transform (degrés), opacity, visibility, fill", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.appendChild(g);
    writeElement(g, { x: 5, y: 6, rz: Math.PI, color: "#f00", visible: true }, "absolute");
    expect(g.getAttribute("transform")).toBe("translate(5 6) rotate(180)");
    expect(g.getAttribute("fill")).toBe("#f00");
    expect(g.getAttribute("visibility")).toBe("visible");
  });
});

describe("StageNodes", () => {
  const setup = () => {
    const els = new Map<string, Element[]>();
    const nodes = new StageNodes({ resolve: (name) => els.get(name) ?? [] });
    return { els, nodes };
  };

  it("patch, ease interpolé par step, même valeur sans effet, $reset retire les styles", () => {
    const { els, nodes } = setup();
    const a = document.createElement("div");
    els.set("a", [a]);
    nodes.apply({ a: { x: 0, y: 0 } }, 0);
    nodes.apply({ a: { x: 100, ease: { ms: 100 } } }, 0);
    expect(nodes.active).toBe(true);
    nodes.step(50);
    expect(nodes.state("a")!.x).toBeCloseTo(50);
    expect(nodes.step(100)).toBe(false);
    expect(nodes.state("a")).toMatchObject({ x: 100, y: 0 });
    a.style.transform = "none";
    nodes.apply({ a: { x: 100, ease: { ms: 100 } } }, 200);
    expect(a.style.transform).toBe("none"); // republication identique : rien n'est réécrit
    nodes.apply({ $reset: true }, 300);
    expect(a.style.transform).toBe("");
    expect(a.style.position).toBe("");
  });

  it("sans animation (mouvement réduit), ease est ignoré ; un nœud sans élément est compté et gardé", () => {
    const { els, nodes } = setup();
    nodes.apply({ b: { x: 10, ease: { ms: 500 } } }, 0, false);
    expect(nodes.active).toBe(false);
    expect(nodes.missing).toBe(1);
    const b = document.createElement("div");
    els.set("b", [b]);
    nodes.renderAll();
    expect(b.style.transform).toContain("translate(10px, 0px)");
  });
});

describe("sonic-stage", () => {
  it("lit nodes dans son DataProvider (assignation complète ou chemin), place un élément apparu plus tard", async () => {
    const dp = id("scene");
    set(dp, { nodes: { a: { x: 40, y: 20 } } });
    const host = el(`<sonic-stage dataProvider="${dp}" width="400" height="200"><div id="a"></div></sonic-stage>`);
    await tick();
    const stage = host.querySelector("sonic-stage") as SonicStage;
    const a = host.querySelector("#a") as HTMLElement;
    expect(a.style.transform).toContain("translate(40px, 20px)");
    set(`${dp}.nodes.a.y`, 80);
    await tick();
    expect(stage.nodeState("a")!.y).toBe(80);
    set(dp, { nodes: { a: { x: 40, y: 80 }, b: { x: 7, y: 9 } } });
    const b = document.createElement("div");
    b.id = "b";
    stage.appendChild(b);
    await tick();
    expect(b.style.transform).toContain("translate(7px, 9px)");
  });

  it("tap : objectId (pick-names) et coordonnées de scène envoyés au store", async () => {
    const storeId = id("jeu");
    const host = el(`<sonic-store id="${storeId}" initial='{"got":[]}' reducer='{"got": $append($state.got, [$action.payload])}'></sonic-store><sonic-stage target="${storeId}" pick-names="^b" pick-empty><div id="b1"><span>x</span></div><div id="deco"></div></sonic-stage>`);
    await tick();
    const stage = host.querySelector("sonic-stage") as SonicStage;
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20, width: 100, height: 100 } as DOMRect);
    const tap = (target: Element, x: number, y: number) => {
      target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true, clientX: x, clientY: y, button: 0 }));
      target.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, composed: true, clientX: x, clientY: y, button: 0 }));
    };
    tap(host.querySelector("#b1 span")!, 30, 50);
    tap(host.querySelector("#deco")!, 15, 25);
    await tick();
    expect((getStore(storeId)!.getState() as { got: unknown[] }).got).toEqual([
      { objectId: "b1", x: 20, y: 30 },
      { objectId: null, x: 5, y: 5 },
    ]);
  });
});

describe("manifeste et exemple", () => {
  it("l'exemple relie physique (nodes-plane screen) et scène sur le même DataProvider, mêmes noms", () => {
    const m = manifestJson as unknown as { examples: string[] };
    expect(m.examples).toEqual(["examples/billes-dom.sdui.json"]);
    const all: Array<{ tagName: string; attributes?: Record<string, string>; nodes?: unknown[] }> = [];
    const walk = (x: { nodes?: unknown[] }) => {
      for (const c of (x.nodes ?? []) as typeof all) {
        all.push(c);
        walk(c);
      }
    };
    walk(billes as { nodes: unknown[] });
    const world = all.find((x) => x.tagName === "sonic-physics")!.attributes!;
    const stage = all.find((x) => x.tagName === "sonic-stage")!.attributes!;
    expect(world["nodes-plane"]).toBe("screen");
    expect(stage.dataProvider).toBe(`${world.id}State`);
    expect([stage.width, stage.height]).toEqual([world.width, world.height]);
    const bodies = all.filter((x) => x.tagName === "sonic-body").map((x) => x.attributes!.name);
    const ids = new Set(all.map((x) => x.attributes?.id));
    for (const b of bodies) expect(ids.has(b)).toBe(true);
  });
});
