import { describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { registerStore, unregisterStore } from "../interactive/registry";
import { parseHex, rgbToOklch, suggestPalette } from "./core";
import type { SonicPaletteEditor } from "./editor";

const hue = (hex: string) => rgbToOklch(parseHex(hex)!).h;
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe("suggestPalette", () => {
  it("garde les couleurs verrouillées et remplit les autres selon la règle", () => {
    const out = suggestPalette({ colors: ["#d1495b", "#000000", "#000000"], locked: [true, false, false], rule: "triadic" });
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("#d1495b");
    const h0 = hue(out[0]);
    expect(hueGap(hue(out[1]), h0)).toBeGreaterThan(100);
    expect(hueGap(hue(out[2]), h0)).toBeGreaterThan(100);
    expect(hueGap(hue(out[1]), hue(out[2]))).toBeGreaterThan(100);
  });

  it("une 2e couleur verrouillée retire la teinte qu'elle occupe déjà", () => {
    const base = "#2f6fdb";
    const comp = suggestPalette({ colors: [base, "#000000"], locked: [true, false], rule: "complementary" })[1];
    const out = suggestPalette({ colors: [base, comp, "#000000"], locked: [true, true, false], rule: "complementary" });
    expect(out.slice(0, 2)).toEqual([base, comp]);
    expect(out[2]).not.toBe(comp);
  });

  it("sans verrou, la couleur d'ancrage reste ; les variantes changent la proposition ; tout verrouillé : inchangé", () => {
    const cols = ["#111111", "#3d9970", "#222222", "#333333"];
    const a = suggestPalette({ colors: cols, rule: "analogous", anchor: 1 });
    expect(a[1]).toBe("#3d9970");
    const b = suggestPalette({ colors: cols, rule: "analogous", anchor: 1, variant: 3 });
    expect(b[1]).toBe("#3d9970");
    expect(b).not.toEqual(a);
    expect(suggestPalette({ colors: cols, locked: [true, true, true, true], rule: "square" })).toEqual(cols);
  });

  it("assez de couleurs même quand la règle a peu de teintes", () => {
    const out = suggestPalette({ colors: Array(8).fill("#808080").map((c, i) => (i ? c : "#e0a526")), locked: [true], rule: "mono" });
    expect(out).toHaveLength(8);
    expect(new Set(out).size).toBeGreaterThan(4);
  });
});

describe("sonic-palette-editor", () => {
  const mount = async (attrs: Record<string, string>) => {
    const el = document.createElement("sonic-palette-editor") as SonicPaletteEditor;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.appendChild(el);
    await el.updateComplete;
    return el;
  };

  it("charge depuis params (dp.clé), propose, enregistre vers save-to", async () => {
    set("edH", { edit: { id: "p3", name: "Mer", colors: ["#1d4ed8", "#ffffff", "#000000"], locked: [true] } });
    set("edC", { suggest: 0, save: 0 });
    const got: { type: string; payload: unknown }[] = [];
    registerStore({ id: "edStore", dispatch: (a) => void got.push({ type: a.type, payload: a.payload }), getState: () => ({}), reset: () => {} });
    const el = await mount({ params: "edH.edit", control: "edC", "save-to": "edStore", "out-data-provider": "edState" });
    expect(get("edState")).toMatchObject({ id: "p3", name: "Mer", colors: ["#1d4ed8", "#ffffff", "#000000"], locked: [true, false, false], lockedCount: 1 });
    set("edC", { suggest: 1, save: 0 });
    await el.updateComplete;
    const cols = el.getState().colors;
    expect(cols[0]).toBe("#1d4ed8");
    expect(cols.slice(1)).not.toEqual(["#ffffff", "#000000"]);
    set("edC", { suggest: 1, save: 1 });
    expect(got).toEqual([{ type: "savePalette", payload: { id: "p3", name: "Mer", colors: cols } }]);
    // Nouvelle palette chargée : remplacée.
    set("edH", { edit: { id: "", name: "", colors: ["#ff0000"] } });
    await el.updateComplete;
    expect(el.getState()).toMatchObject({ id: "", colors: ["#ff0000"], count: 1 });
    unregisterStore("edStore");
    el.remove();
  });

  it("nombre, verrous, couleur choisie", async () => {
    const el = await mount({ colors: "#2f6fdb, #e0a526", rule: "complementary" });
    el.setCount(5);
    expect(el.getState().count).toBe(5);
    expect(el.getState().colors.slice(0, 2)).toEqual(["#2f6fdb", "#e0a526"]);
    el.toggleLock(1);
    el.select(3);
    el.setColor({ l: 0.5, c: 0, h: 120 });
    expect(el.getState().colors[3]).toBe(el.getState().colors[3].toLowerCase());
    expect(rgbToOklch(parseHex(el.getState().colors[3])!).c).toBeLessThan(0.01);
    el.suggest();
    expect(el.getState().colors[1]).toBe("#e0a526");
    el.removeColor(0);
    expect(el.getState()).toMatchObject({ count: 4, locked: [true, false, false, false] });
    el.setCount(1);
    expect(el.getState().count).toBe(1);
    el.removeColor(0);
    expect(el.getState().count).toBe(1);
    await el.updateComplete;
    expect(el.shadowRoot!.querySelectorAll(".slot").length).toBe(1);
    el.remove();
  });
});
