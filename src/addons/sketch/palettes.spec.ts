import { describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import "../color/index";
import "../interactive/index";
import { samplePalette } from "./colormap";
import type { SonicSketch } from "./sketch";
import type { SonicPalette } from "../color/palette";
import { registerStore, unregisterStore } from "../interactive/registry";

const tick = () => new Promise((r) => setTimeout(r, 0));
const sq = (x: number, y: number, s: number) => `M${x} ${y}L${x + s} ${y}L${x + s} ${y + s}L${x} ${y + s}Z`;

describe("samplePalette", () => {
  it("garde les couleurs dominantes, fusionne les voisines, trie par poids et écarte le fond", () => {
    const e = (r: number, g: number, b: number, weight: number) => ({ rgba: [r, g, b, 1] as [number, number, number, number], weight });
    const out = samplePalette([
      e(1, 1, 1, 1000), // fond
      e(1, 0, 0, 50), e(0.98, 0.02, 0, 40), // deux rouges presque identiques
      e(0, 0, 1, 80),
      e(0, 0.6, 0, 10),
    ], 3, [[1, 1, 1, 1]]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual([1, 0, 0, 1]); // rouges fusionnés (90) devant le bleu (80), le plus lourd des deux gardé
    expect(out[1]).toEqual([0, 0, 1, 1]);
    expect(out.some((c) => c[0] === 1 && c[1] === 1 && c[2] === 1)).toBe(false);
  });

  it("transparent ou sans poids : ignoré ; moins de couleurs que demandé : toutes", () => {
    const out = samplePalette([{ rgba: [1, 0, 0, 0], weight: 10 }, { rgba: [0, 1, 0, 1], weight: 0 }, { rgba: [0, 0, 1, 1], weight: 5 }], 6);
    expect(out).toEqual([[0, 0, 1, 1]]);
  });
});

describe("sonic-sketch : échantillonnage de palette", () => {
  it("commande samplePalette : couleurs des aplats par surface, sans le fond, envoyées au store", async () => {
    set("skSmpCtl", { samplePalette: 0 });
    const got: { type: string; payload: unknown }[] = [];
    registerStore({ id: "smpTarget", dispatch: (a) => void got.push({ type: a.type, payload: a.payload }), getState: () => ({}), reset: () => {} });
    const el = document.createElement("sonic-sketch") as SonicSketch;
    for (const [k, v] of Object.entries({ width: "400", height: "300", background: "#ffffff", "import-from": "smpGen", "import-auto": "", control: "skSmpCtl", "sample-to": "smpTarget", "out-data-provider": "skSmpState" })) el.setAttribute(k, v);
    document.body.appendChild(el);
    await el.updateComplete;
    el.shadowRoot!.querySelector("canvas")!.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON() {} }) as DOMRect;
    set("smpGen", { status: "ready", runs: 1, width: 100, height: 100, sourceWidth: 100, sourceHeight: 100, frame: null, keepColors: true,
      paths: [{ color: "#ff0000", d: sq(0, 0, 60), area: 0, share: 0 }, { color: "#0000ff", d: sq(70, 70, 20), area: 0, share: 0 }, { color: "#ffffff", d: sq(70, 0, 20), area: 0, share: 0 }] });
    await tick();
    expect(el.getState().strokes).toBe(1);
    set("skSmpCtl", { samplePalette: 1, sampleCount: 4 });
    const sampled = { colors: ["#ff0000", "#0000ff"], from: "drawing" };
    expect(el.getState().sampled).toEqual(sampled);
    expect((get("skSmpState") as { sampled: unknown }).sampled).toEqual(sampled);
    expect(got).toEqual([{ type: "sampled", payload: sampled }]);
    unregisterStore("smpTarget");
    el.remove();
  });
});

describe("sonic-palette : palette libre", () => {
  it("rule=custom affiche les couleurs données ; rotate tourne toutes les teintes et les écrit dans params", async () => {
    set("palCustomP", { rule: "custom", colors: ["#ff0000", "#00ff00", "bidon", "#ff0000"] });
    set("palCustomC", { rotate: 0 });
    // Store qui fusionne les réglages dans le DP du même nom, comme un sonic-store à réducteur `set`.
    registerStore({ id: "palCustomP", dispatch: (a) => set("palCustomP", { ...(get("palCustomP") as object), ...(a.payload as object) }), getState: () => ({}), reset: () => {} });
    const el = document.createElement("sonic-palette") as SonicPalette;
    for (const [k, v] of Object.entries({ params: "palCustomP", control: "palCustomC", "write-base": "", "out-data-provider": "palCustomS" })) el.setAttribute(k, v);
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.getState()).toMatchObject({ rule: "custom", colors: ["#ff0000", "#00ff00"], count: 2 });
    expect(el.getState().items.every((i) => i.role === "custom")).toBe(true);
    set("palCustomC", { rotate: 1 });
    const turned = el.getState().colors;
    expect(turned).toHaveLength(2);
    expect(turned[0]).not.toBe("#ff0000");
    expect((get("palCustomP") as { colors: string[] }).colors).toEqual(turned);
    expect(el.getState().colors).toEqual(turned); // relu depuis params : stable
    unregisterStore("palCustomP");
    el.remove();
  });

  it("attribut colors (liste) et repli sur l'harmonie sans couleurs", async () => {
    const el = document.createElement("sonic-palette") as SonicPalette;
    el.setAttribute("rule", "custom");
    el.setAttribute("colors", "#112233, #445566");
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.getState().colors).toEqual(["#112233", "#445566"]);
    el.setAttribute("colors", "");
    await el.updateComplete;
    expect(el.getState().colors.length).toBeGreaterThan(0);
    el.remove();
  });
});
