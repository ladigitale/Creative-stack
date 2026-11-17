import { describe, expect, it } from "vitest";
import { composeScene, type Recipe } from "./compose";
import { SCENES } from "./library";
import { meadowBudget, meadowKeep, readMeadows } from "./meadows";
import { Issues } from "../core/schema";
import { composeVector } from "../vector/compose";
import { HERBE_BUDGET, herbeBendGLSL } from "../../../shared/monde/herbes";
import { FRAGMENT, VERTEX } from "../render/shaders";

const base: Recipe = {
  size: [20, 16],
  ground: { relief: 0.6, scale: 8 },
  paths: [{ id: "chemin", points: [[-10, 0], [10, 0]], width: 2, kind: "path" }],
  zones: [{ id: "carre", box: [2, 2, 8, 7] }, { id: "rond", at: [-5, -5], r: 2 }],
  layers: [{ id: "caisse", gen: "prop.crate", place: { at: [[-6, 5]] } }],
};

describe("prairies (meadows)", () => {
  it("sans prairie : rien de semé, aucun coût", () => {
    const m = composeScene({ recipe: base, seed: 1 });
    expect(m.meadows).toEqual([]);
  });

  it("zone par défaut, zone nommée, sortes et erreurs signalées sous meadows.N", () => {
    const issues = new Issues();
    const zones = [{ id: "carre", x: 5, z: 4.5, r: 0, box: [2, 2, 8, 7] as [number, number, number, number] }];
    const r = readMeadows([{ kind: "wheat" }, { kind: "cactus" }, { kind: "reeds", zone: "carre", tip: "#ffeeaa" }, { kind: "herbe", zone: "nulle-part" }, { kind: "fleurs", zone: [1, 2] }], [20, 16], zones, issues);
    expect(r.fields.map((f) => f.kind)).toEqual(["ble", "roseau"]);
    expect(r.fields[0].rect).toEqual([-10, -8, 10, 8]);
    expect(r.fields[1].rect).toEqual([2, 2, 8, 7]);
    expect(r.custom).toEqual([false, true]);
    expect(issues.list.map((i) => i.path).sort()).toEqual(["meadows.1", "meadows.3.zone", "meadows.4.zone"]);
  });

  it("brins posés sur le relief, hors du chemin et sous la caisse, dans leur zone ; reproductible", () => {
    const recipe: Recipe = { ...base, meadows: [{ kind: "herbe", density: 60 }, { kind: "fleurs", zone: "rond", density: "= 50 + 50" }] };
    const m = composeScene({ recipe, seed: 3 });
    expect(m.meadows).toHaveLength(2);
    const [herbe, fleurs] = m.meadows;
    const n = herbe.blades.length / 6;
    expect(n).toBeGreaterThan(5000);
    expect(n).toBeLessThan(20 * 16 * 60);
    const crate = m.objects.find((o) => o.id === "caisse.0")!;
    for (let k = 0; k < herbe.blades.length; k += 6) {
      const x = herbe.blades[k], y = herbe.blades[k + 1], z = herbe.blades[k + 2];
      expect(Math.abs(y - m.terrain!.height(x, z))).toBeLessThan(1e-4);
      // chemin de 2 m centré sur z = 0
      expect(Math.abs(z)).toBeGreaterThan(0.85);
      expect(Math.hypot(x - crate.pos[0], z - crate.pos[2])).toBeGreaterThan(Math.min(crate.footprint.hx, crate.footprint.hz) * 0.8);
    }
    expect(fleurs.blades.length / 6).toBeGreaterThan(600);
    for (let k = 0; k < fleurs.blades.length; k += 6) expect(Math.hypot(fleurs.blades[k] + 5, fleurs.blades[k + 2] + 5)).toBeLessThan(2.05);
    const again = composeScene({ recipe, seed: 3 });
    expect(Array.from(again.meadows[0].blades.slice(0, 30))).toEqual(Array.from(herbe.blades.slice(0, 30)));
  });

  it("budget : moins dense sur mobile en auto, borne de la scène", () => {
    expect(meadowBudget("auto", true)).toBe(HERBE_BUDGET[0]);
    expect(meadowBudget(undefined, false)).toBe(HERBE_BUDGET[1]);
    expect(meadowBudget(2, true)).toBe(HERBE_BUDGET[2]);
    const recipe: Recipe = { size: [100, 100], ground: false, meadows: [{ kind: "gazon" }] };
    const mob = composeScene({ recipe, seed: 1, mobile: true });
    const desk = composeScene({ recipe, seed: 1 });
    expect(mob.meadows[0].blades.length / 6).toBeLessThanOrEqual(HERBE_BUDGET[0]);
    expect(desk.meadows[0].blades.length / 6).toBeGreaterThan(mob.meadows[0].blades.length / 6);
  });

  it("masque : routes et eau exclues, obstacles tournés", () => {
    const keep = meadowKeep([10, 10], null, [{ x: 0, z: 0, hx: 2, hz: 0.5, yaw: Math.PI / 2 }]);
    expect(keep.ground(0, 0)).toBe(true);
    expect(keep.all(0, 1.5)).toBe(false);
    expect(keep.all(1.5, 0)).toBe(true);
    expect(keep.all(20, 0)).toBe(false);
  });

  it("rendu vectoriel : ignorées proprement, signalées en info", () => {
    const m = composeVector({ recipe: { ...base, meadows: [{ kind: "herbe" }] }, seed: 1 });
    expect(m.meadows).toEqual([]);
    expect(m.issues.some((i) => i.path === "meadows" && i.code === "info")).toBe(true);
  });

  it("scène prairie de la bibliothèque : cinq champs, vent orienté", () => {
    const m = composeScene({ recipe: SCENES.prairie, seed: 1 });
    expect(m.meadows.map((f) => f.field.kind)).toEqual(["ble", "fleurs", "herbe", "roseau", "gazon"]);
    expect(m.meadows.every((f) => f.blades.length > 0)).toBe(true);
    expect(m.windDir).toBeCloseTo((70 * Math.PI) / 180);
    expect(m.issues.filter((i) => i.code !== "info")).toEqual([]);
  });

  it("shaders : ploiement commun avec le format monde, sous #ifdef BLADE", () => {
    expect(VERTEX).toContain(herbeBendGLSL({ time: "uTime", wind: "uBladeWind", sway: "uSway", push: "uPush" }));
    expect(VERTEX).toMatch(/#ifdef BLADE[\s\S]*herbeBend\(root\)/);
    expect(FRAGMENT).toContain("uBladeBase");
  });
});
