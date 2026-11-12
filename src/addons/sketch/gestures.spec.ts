import { describe, expect, it } from "vitest";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import type { SonicSketch } from "./sketch";
import { densify, fitFrame, gesturesKey, readGestures } from "./gestures";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("gestes : lecture", () => {
  it("points à plat ou en couples, pression bornée, clés de pinceau filtrées, cadre par défaut", () => {
    const g = readGestures({ strokes: [
      { color: "#ff0000", size: 12, blend: "multiply", evil: "<script>", pts: [0, 0, 2, 10, 20, "x", 30, 40, 0.5] },
      { pts: [[5, 5], [50, 60, 0.2]] },
      { pts: [] },
      "rien",
    ] })!;
    expect(g.strokes).toHaveLength(2);
    expect(g.strokes[0].brush).toEqual({ color: "#ff0000", size: 12, blend: "multiply" });
    expect(g.strokes[0].pts).toEqual([0, 0, 1, 10, 20, 0.7, 30, 40, 0.5]); // pression illisible : 0.7
    expect(g.strokes[1].pts).toEqual([5, 5, 0.7, 50, 60, 0.2]);
    expect([g.width, g.height]).toEqual([50, 60]);
    expect(readGestures({ strokes: [] })).toBeNull();
    expect(readGestures([1, 2])).toBeNull();
  });

  it("réglages gardés d'un trait à l'autre (reset pour repartir) ; courbe ou segments", () => {
    const g = readGestures({ strokes: [
      { color: "#111111", size: 4, blend: "multiply", pts: [0, 0, 1, 1, 1, 1] },
      { size: 9, pts: [0, 0, 1, 1, 1, 1] },
      { reset: true, opacity: 0.5, curve: false, pts: [0, 0, 1, 1, 1, 1] },
    ] })!;
    expect(g.strokes.map((s) => s.brush)).toEqual([
      { color: "#111111", size: 4, blend: "multiply" }, { color: "#111111", size: 9, blend: "multiply" }, { opacity: 0.5 },
    ]);
    expect(g.strokes.map((s) => s.curve)).toEqual([true, true, false]);
    const line = densify([0, 0, 0, 10, 0, 1], 2, false);
    expect(line.length / 3).toBe(6);
    expect(line.slice(-3)).toEqual([10, 0, 1]);
    // La courbe passe par les points donnés.
    const c = densify([0, 0, 1, 10, 10, 1, 20, 0, 1], 1, true);
    expect(c.some((v, i) => i % 3 === 0 && Math.abs(v - 10) < 1e-9 && Math.abs(c[i + 1] - 10) < 1e-9)).toBe(true);
  });

  it("cadre ajusté à 90 % et centré ; empreinte stable", () => {
    expect(fitFrame(100, 50, 400, 300)).toEqual({ k: 3.6, ox: 20, oy: 60 });
    expect(gesturesKey({ a: 1 })).toBe(gesturesKey({ a: 1 }));
    expect(gesturesKey({ a: 1 })).not.toBe(gesturesKey({ a: 2 }));
  });
});

describe("sonic-sketch : gestes rejoués", () => {
  it("chaque nouveau jeu est dessiné avec ses réglages (couleur, fusion, gomme) ; le jeu présent au branchement non", async () => {
    set("skGest", { width: 100, height: 100, strokes: [{ color: "#00ff00", size: 10, pts: [0, 0, 1, 100, 100, 1] }] });
    const el = document.createElement("sonic-sketch") as SonicSketch;
    for (const [k, v] of Object.entries({ width: "400", height: "300", background: "#ffffff", "gestures-from": "skGest", "out-data-provider": "skGestState" })) el.setAttribute(k, v);
    document.body.appendChild(el);
    await el.updateComplete;
    await wait(10);
    expect(el.getState().strokes).toBe(0);
    set("skGest", { width: 100, height: 100, strokes: [
      { color: "#ffff00", size: 30, hardness: 1, pts: [10, 50, 1, 90, 50, 1] },
      { color: "#00ffff", size: 30, hardness: 1, blend: "multiply", pts: [50, 10, 1, 50, 90, 1] },
      { tool: "erase", size: 8, hardness: 1, pts: [10, 10, 1, 12, 12, 1] },
    ] });
    for (let i = 0; i < 100 && el.getState().gestures?.playing !== false; i++) await wait(20);
    const st = el.getState();
    expect(st.gestures).toMatchObject({ playing: false, done: 3, total: 3 });
    const svg = el.toSvg() ?? "";
    expect(svg).toMatch(/#ffff00/i);
    expect(svg).toMatch(/#00ff00/i); // jaune × cyan en produit
    // Le pinceau de l'interface n'a pas bougé.
    expect(el.brush().color).not.toBe("#00ffff");
    el.remove();
  });
});
