import { describe, expect, it } from "vitest";
import { Issues } from "../core/schema";
import { composeScene, type Recipe } from "./compose";
import { SceneFx, fxInputOf, planFx, stripFx, ventOf } from "./fx";
import { GENERATORS } from "../gen/index";
import { Rng } from "../core/rng";

const ctx = { target: [0, 0, 0] as [number, number, number], extent: 12 };

function scene(extra: Partial<Recipe> = {}) {
  const recipe: Recipe = {
    size: [30, 24],
    ground: { relief: 0 },
    layers: [
      { id: "maisons", gen: "building", count: 2, place: { at: [[-6, 0], [6, 0]] }, params: { style: "bourg", chimneys: 2, floors: 2, roof: "gable" } },
      { id: "feu", gen: "prop.campfire", place: { at: [[0, 6]] } },
      { id: "chute", gen: "water.cascade", place: { at: [[0, -7]] } },
    ],
    ...extra,
  };
  return { recipe, model: composeScene({ recipe, seed: 3 }) };
}

describe("ancres des générateurs", () => {
  it("bâtiment : une ancre chimney.N au-dessus du toit par cheminée", () => {
    const a = GENERATORS.building.build({ ...defaults("building"), chimneys: 2, roof: "gable" } as never, { rng: new Rng("b"), path: "b" } as never);
    const keys = Object.keys(a.anchors).filter((k) => k.startsWith("chimney."));
    expect(keys).toEqual(["chimney.0", "chimney.1"]);
    for (const k of keys) expect(a.anchors[k].pos[1]).toBeGreaterThan(a.anchors.door.pos[1] + 3);
  });
  it("cascade : ancres fall et fall.top", () => {
    const a = GENERATORS.water.build({ ...defaults("water"), kind: "cascade" } as never, { rng: new Rng("w"), path: "w" } as never);
    expect(a.anchors.fall).toBeDefined();
    expect(a.anchors["fall.top"].pos[1]).toBeGreaterThan(a.anchors.fall.pos[1]);
  });
});

function defaults(id: string): Record<string, unknown> {
  const sch = (GENERATORS as Record<string, { schema: Record<string, { default: unknown }> }>)[id].schema;
  return Object.fromEntries(Object.entries(sch).map(([k, v]) => [k, v.default]));
}

describe("planFx", () => {
  it("rien quand les clés sont absentes", () => {
    const { recipe, model } = scene();
    const fx = new SceneFx();
    fx.configure(fxInputOf(recipe as never), model, {}, new Issues());
    expect(fx.systems).toHaveLength(0);
    expect(fx.active).toBe(false);
  });
  it("cheminées, feux de camp, cascades, météo", () => {
    const { recipe, model } = scene({ weather: { kind: "rain", intensity: 0.5 }, fx: { chimneys: true, campfires: true, cascades: true } });
    const iss = new Issues();
    const plans = planFx(fxInputOf(recipe as never), model, iss);
    const ids = plans.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["weather", "chimneys", "campfires-fire", "campfires-embers", "campfires-smoke", "campfires-sparks", "cascades", "cascades-drops"]));
    const ch = plans.find((p) => p.id === "chimneys")!;
    expect(ch.nSrc).toBe(4);
    expect(iss.list.filter((i) => i.code !== "info")).toEqual([]);
  });
  it("noms français et anglais, météo inconnue signalée", () => {
    const { model } = scene();
    const iss = new Issues();
    const plans = planFx({ weather: "neige" }, model, iss);
    expect(plans[0].raw.preset).toBe("neige");
    planFx({ weather: "grele" }, model, iss);
    expect(iss.list.some((i) => i.path === "weather.kind" && i.code === "unknown")).toBe(true);
    planFx({ fx: { fumee: true } }, model, iss);
    expect(iss.list.some((i) => i.path === "fx.fumee")).toBe(true);
  });
  it("effets par calque : ancre nommée, sinon haut de l'objet", () => {
    const { model } = scene();
    const plans = planFx({ layers: [{ id: "maisons", fx: "smoke" }, { id: "feu", fx: { preset: "sparks", anchor: "light" } }] }, model, new Issues());
    expect(plans.map((p) => [p.id, p.nSrc])).toEqual([["maisons-fx", 4], ["feu-fx", 1]]);
  });
  it("système libre attaché à un objet par objet@ancre", () => {
    const { model } = scene();
    const plans = planFx({ particles: { vapeur: { preset: "steam", at: "maisons.1@chimney.0" } } }, model, new Issues());
    expect(plans[0].raw.preset).toBe("vapeur");
    expect(plans[0].src).toMatchObject({ kind: "point", obj: { id: "maisons.1", anchor: "chimney.0" } });
  });
});

describe("SceneFx", () => {
  it("les grains naissent aux ancres et suivent un objet déplacé", () => {
    const { recipe, model } = scene({ fx: { chimneys: true } });
    const fx = new SceneFx();
    fx.configure(fxInputOf(recipe as never), model, {}, new Issues());
    const s = fx.systems[0];
    for (let i = 0; i < 30; i++) fx.step(1 / 30, ctx);
    expect(s.sys.spawned).toBeGreaterThan(5);
    const o = model.objects.find((x) => x.id === "maisons.0")!;
    const ch = o.anchors["chimney.0"];
    // déplacement (glisser) : l'ancre bouge, la source aussi
    o.anchors["chimney.0"] = [ch[0] + 50, ch[1], ch[2]];
    const pts = fx.sources(s, ctx);
    expect(pts.some((p) => p[0] > ch[0] + 40)).toBe(true);
    // objet caché : plus de source
    expect(fx.sources(s, { ...ctx, hidden: new Set(["maisons.0", "maisons.1"]) })).toHaveLength(0);
  });
  it("relecture identique : même tampon (la fumée continue)", () => {
    const { recipe, model } = scene({ fx: { chimneys: true } });
    const fx = new SceneFx();
    const inp = fxInputOf(recipe as never);
    expect(fx.configure(inp, model, {}, new Issues())).toBe(true);
    const sys = fx.systems[0].sys;
    expect(fx.configure(inp, model, {}, new Issues())).toBe(false);
    expect(fx.systems[0].sys).toBe(sys);
  });
  it("budget : réduit sur mobile et en vectoriel, signalé", () => {
    const { recipe, model } = scene({ weather: { kind: "snow", intensity: 1 }, fx: { mist: 1, chimneys: true } });
    const a = new SceneFx(), b = new SceneFx(), c = new SceneFx();
    a.configure(fxInputOf(recipe as never), model, {}, new Issues());
    const iss = new Issues();
    b.configure(fxInputOf(recipe as never), model, { mobile: true }, iss);
    c.configure(fxInputOf(recipe as never), model, { vector: true }, new Issues());
    expect(a.grains).toBeLessThanOrEqual(8000);
    expect(b.grains).toBeLessThanOrEqual(4000);
    expect(c.grains).toBeLessThanOrEqual(1500);
    expect(c.grains).toBeLessThan(a.grains);
  });
  it("météo : naît au-dessus de la vue, dans la scène", () => {
    const { recipe, model } = scene({ weather: "rain" });
    const fx = new SceneFx();
    fx.configure(fxInputOf(recipe as never), model, {}, new Issues());
    for (let i = 0; i < 10; i++) fx.step(1 / 30, { target: [100, 0, 100], extent: 10 });
    const s = fx.systems[0].sys;
    expect(s.spawned).toBeGreaterThan(20);
    for (let i = 0; i < s.spawned; i++) {
      expect(Math.abs(s.p0[i * 3])).toBeLessThanOrEqual(15 + 4);
      expect(s.p0[i * 3 + 1]).toBeGreaterThan(5);
    }
  });
  it("ordres fx.<id> : une salve à chaque hausse de n", () => {
    const { recipe, model } = scene({ fx: { campfires: true } });
    const fx = new SceneFx();
    fx.configure(fxInputOf(recipe as never), model, {}, new Issues());
    const sp = fx.systems.find((s) => s.id === "campfires-sparks")!.sys;
    fx.applyOrders({ "campfires-sparks": { n: 1 } }, ctx);
    expect(sp.spawned).toBe(0);
    fx.applyOrders({ "campfires-sparks": { n: 2 } }, ctx);
    expect(sp.spawned).toBe(24);
  });
});

describe("clés de recette", () => {
  it("stripFx retire météo et effets (pas de recomposition)", () => {
    const r = { size: [10, 10], weather: "rain", fx: { chimneys: true }, particles: {}, windDir: 30, wind: 2, layers: [{ id: "a", gen: "tree", fx: "leaves" }] };
    expect(stripFx(r)).toEqual({ size: [10, 10], windDir: 30, wind: 2, layers: [{ id: "a", gen: "tree" }] });
    expect(r.layers[0].fx).toBe("leaves");
  });
  it("vent : force × direction", () => {
    const v = ventOf(1, 90);
    expect(v[0]).toBeCloseTo(1.4);
    expect(Math.abs(v[2])).toBeLessThan(1e-6);
    expect(ventOf(0, 0)).toEqual([0, 0, 0]);
  });
});
