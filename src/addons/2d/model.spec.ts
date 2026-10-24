import { describe, expect, it } from "vitest";
import { hitShape, layerTransform, parseLayers, parseSprite, safeImageSrc, screenToLayer, visualKey } from "./model";
import manifestJson from "./manifest.json";
import parallaxe from "./examples/parallaxe.sdui.json";

describe("parseSprite", () => {
  it("attributs SDUI et JSON donnent la même description ; vocabulaire de sonic-body", () => {
    const a = parseSprite({ name: "p", shape: "box", w: "120", h: "16", "font-size": "30", angle: "-8", layer: "monde", hidden: "" }, "x").spec;
    const b = parseSprite({ name: "p", shape: "box", w: 120, h: 16, fontSize: 30, angle: -8, layer: "monde", hidden: true }, "x").spec;
    expect(a).toEqual(b);
    expect(parseSprite({ r: 10 }, "auto").spec).toMatchObject({ name: "auto", shape: "circle" });
    expect(parseSprite({ text: "Score" }, "t").spec).toMatchObject({ shape: "text", fill: "#ffffff" });
    expect(parseSprite({ shape: "blob" }, "q").errors[0]).toContain("inconnue");
    expect(parseSprite({ shape: "polygon", points: "0,0 10,0" }, "p").errors[0]).toContain("3 points");
  });

  it("images : data:image/… ou https:// seulement", () => {
    expect(safeImageSrc("https://exemple.org/a.png")).toBe("https://exemple.org/a.png");
    expect(safeImageSrc("data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(safeImageSrc("javascript:alert(1)")).toBe("");
    expect(safeImageSrc("http://exemple.org/a.png")).toBe("");
    expect(safeImageSrc("data:text/html;base64,PHNjcmlwdD4=")).toBe("");
    expect(parseSprite({ shape: "image", src: "javascript:x" }, "i").errors[0]).toContain("src");
  });

  it("la position n'entre pas dans la clé d'apparence (un sprite déplacé n'est pas redessiné)", () => {
    const a = parseSprite({ name: "a", r: 5, x: 1, y: 2, angle: 10 }, "a").spec;
    const b = parseSprite({ name: "a", r: 5, x: 99, y: 7, angle: 0 }, "a").spec;
    expect(visualKey(a)).toBe(visualKey(b));
    expect(visualKey(a)).not.toBe(visualKey({ ...a, fill: "#f00" }));
  });
});

describe("calques et caméra", () => {
  it("parseLayers : nom:parallaxe[:y], défaut un calque monde", () => {
    expect(parseLayers("").layers).toEqual([{ name: "monde", parallax: 1, sortY: false }]);
    const { layers, errors } = parseLayers("ciel:0 decor:0.4 monde:1:y hud:0 monde:2");
    expect(layers.map((l) => [l.name, l.parallax, l.sortY])).toEqual([
      ["ciel", 0, false],
      ["decor", 0.4, false],
      ["monde", 1, true],
      ["hud", 0, false],
    ]);
    expect(errors[0]).toContain("double");
  });

  it("parallaxe 1 : la caméra est au centre de l'écran, zoom compris ; parallaxe 0 : fixe à l'écran", () => {
    const cam = { x: 1000, y: 300, zoom: 2 };
    const t = layerTransform(1, cam, 800, 450);
    expect(t.scale).toBe(2);
    expect(t.x + t.scale * 1000).toBe(400);
    expect(t.y + t.scale * 300).toBe(225);
    expect(layerTransform(0, cam, 800, 450)).toEqual({ x: 0, y: 0, scale: 1 });
    const half = layerTransform(0.5, cam, 800, 450);
    expect(half.scale).toBe(1.5);
    const [lx, ly] = screenToLayer(400, 225, 1, cam, 800, 450);
    expect([lx, ly]).toEqual([1000, 300]);
  });

  it("toucher : cercle, boîte, polygone dans le repère du sprite", () => {
    const c = parseSprite({ r: 10 }, "c").spec;
    expect(hitShape(c, 6, 6)).toBe(true);
    expect(hitShape(c, 8, 8)).toBe(false);
    const b = parseSprite({ w: 40, h: 10 }, "b").spec;
    expect(hitShape(b, 19, 4)).toBe(true);
    expect(hitShape(b, 21, 0)).toBe(false);
    const p = parseSprite({ shape: "polygon", points: "-10,0 0,-20 10,0" }, "p").spec;
    expect(hitShape(p, 0, -5)).toBe(true);
    expect(hitShape(p, 8, -15)).toBe(false);
  });
});

describe("manifeste et exemple", () => {
  it("l'exemple : sprites nommés comme les corps, dataProvider = état du monde, caméra du store", () => {
    const m = manifestJson as unknown as { examples: string[] };
    expect(m.examples).toEqual(["examples/parallaxe.sdui.json"]);
    type N = { tagName: string; attributes?: Record<string, string>; nodes?: N[] };
    const all: N[] = [];
    const walk = (x: { nodes?: N[] }) => (x.nodes ?? []).forEach((c) => (all.push(c), walk(c)));
    walk(parallaxe as unknown as { nodes: N[] });
    const world = all.find((x) => x.tagName === "sonic-physics")!.attributes!;
    const scene = all.find((x) => x.tagName === "sonic-2d")!.attributes!;
    expect(world["nodes-plane"]).toBe("screen");
    expect(scene.dataProvider).toBe(`${world.id}State`);
    const sprites = new Set(all.filter((x) => x.tagName === "sonic-sprite").map((x) => x.attributes!.name));
    for (const b of all.filter((x) => x.tagName === "sonic-body")) expect(sprites.has(b.attributes!.name)).toBe(true);
    const layers = new Set(parseLayers(scene.layers).layers.map((l) => l.name));
    for (const s of all.filter((x) => x.tagName === "sonic-sprite")) expect(layers.has(s.attributes!.layer)).toBe(true);
  });
});
