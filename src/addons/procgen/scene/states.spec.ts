import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { GENERATORS } from "../gen/index";
import { containerModel, containerParts } from "../gen/container";
import { jointLocal, posedAll } from "../gen/joints";
import { partsBounds } from "../gen/parts";
import { m4Compose, m4Point, qAxis } from "../core/math";
import { StateLayer } from "../render/states";
import { composeScene, type ObjectInfo, type Recipe } from "./compose";
import { planFx } from "./fx";
import { FREE_STATES, resolveStates, statesInputOf, stripStates } from "./states";
import { stripFx } from "./fx";

const build = (gen: string, params: Record<string, unknown>, seed = "s") => {
  const g = GENERATORS[gen];
  const issues = new Issues();
  const p = resolveParams(g.schema, params, { rng: new Rng(1), vars: {} }, issues, "");
  return g.build(p as never, { rng: new Rng(seed), issues, path: "" });
};
const names = (a: { joints?: { name: string }[] }) => (a.joints ?? []).map((j) => j.name);

function scene(extra: Partial<Recipe> = {}) {
  const recipe: Recipe = {
    size: [30, 24],
    ground: { relief: 0 },
    layers: [
      { id: "malles", gen: "container.chest", place: { at: [[-4, 0], [-2, 0]] }, params: { open: false } },
      { id: "marmites", gen: "container.pot", place: { at: [[0, 3]] }, params: { open: false } },
      { id: "autos", gen: "vehicle", place: { at: [[5, 0]] }, params: { kind: "moderncar", variant: 0 } },
      { id: "maisons", gen: "building", place: { at: [[0, -7]] }, params: { style: "bourg", floors: 2, shutters: 1, decay: 0 } },
      { id: "lanternes", gen: "prop.lantern", place: { at: [[3, 4]] } },
    ],
    ...extra,
  };
  return { recipe, model: composeScene({ recipe, seed: 3 }) };
}

describe("parties mobiles déclarées par les générateurs", () => {
  it("contenants : couvercle `lid` (rabats `lid.*` du carton), ancre lid.top, `open` = valeur de départ", () => {
    for (const kind of ["chest", "crate", "toolbox", "wheeliebin", "cooler", "pot", "milkcan", "suitcase"]) {
      const a = build("container", { kind, open: false });
      expect(names(a), kind).toEqual(["lid"]);
      expect(a.joints![0].initial).toBe(0);
      expect(a.anchors["lid.top"], kind).toBeTruthy();
      expect(a.body!.vertexCount + a.joints![0].mesh.vertexCount).toBe(a.mesh.vertexCount);
    }
    expect(names(build("container", { kind: "cardboard" }))).toEqual(["lid.f", "lid.b", "lid.l", "lid.r"]);
    expect(build("container", { kind: "chest", open: true }).joints![0].initial).toBe(1);
    expect(names(build("container", { kind: "basket" }))).toEqual([]);
    // vectoriel : le couvercle posé à sa valeur (fermé plus bas qu'ouvert)
    const m = containerModel({ kind: "chest", open: false });
    expect(partsBounds(containerParts(m, { lid: 1 })).max[1]).toBeGreaterThan(partsBounds(containerParts(m, { lid: 0 })).max[1] + 0.2);
  });

  it("véhicules : portières (door.fl côté conducteur, x > 0), coffre, capot, essieux, places", () => {
    const car = build("vehicle", { kind: "moderncar", variant: 0 });
    expect(names(car)).toEqual(["door.fl", "door.rl", "door.fr", "door.rr", "trunk", "hood", "wheel.0", "wheel.1"]);
    const fl = car.joints!.find((j) => j.name === "door.fl")!;
    expect(fl.pivot[0]).toBeGreaterThan(0);
    expect(car.anchors["seat.driver"].pos[0]).toBeGreaterThan(0);
    expect(car.anchors["approach.door.fl"].pos[0]).toBeGreaterThan(0.9);
    expect(car.anchors["door.fl.handle"]).toBeTruthy();
    // la portière ouverte s'écarte de la caisse (vers +x)
    const h = car.anchors["door.fl.handle"].pos;
    expect(m4Point(jointLocal(fl, 1), h)[0]).toBeGreaterThan(h[0] + 0.5);
    expect(car.joints!.find((j) => j.name === "wheel.0")!.openable).toBe(false);
    expect(names(build("vehicle", { kind: "van", variant: 1 }))).toEqual(expect.arrayContaining(["door.fl", "door.fr", "door.side", "door.back.l", "door.back.r"]));
    expect(build("vehicle", { kind: "van", variant: 1 }).joints!.find((j) => j.name === "door.side")!.kind).toBe("translation");
    expect(names(build("vehicle", { kind: "bus" }))).toEqual(expect.arrayContaining(["door.0", "door.1"]));
    expect(names(build("vehicle", { kind: "truck", variant: 0 }))).toEqual(expect.arrayContaining(["door.fl", "door.back.l"]));
    expect(names(build("vehicle", { kind: "truck", variant: 1 }))).toEqual(expect.arrayContaining(["tailgate"]));
  });

  it("bâtiment, portail, niche, boîte aux lettres, assemblage", () => {
    const b = build("building", { style: "bourg", shutters: 1, decay: 0, floors: 2 });
    expect(names(b)).toContain("door");
    expect(names(b).some((n) => n.startsWith("shutter."))).toBe(true);
    expect(b.anchors["door.handle"]).toBeTruthy();
    const gate = build("structure", { kind: "gate", open: 0.5 });
    expect(names(gate)).toEqual(["gate.l", "gate.r"]);
    expect(gate.joints![0].initial).toBe(0.5);
    expect(names(build("pet", { kind: "kennel" }))).toEqual(["door"]);
    expect(names(build("prop", { kind: "mailbox" }))).toEqual(["lid"]);
    const asm = build("assembly", {
      parts: [
        { t: "box", c: [0, 0.4, 0], h: [0.4, 0.4, 0.3], role: "wood" },
        { t: "box", c: [0, 0.4, 0.31], h: [0.38, 0.38, 0.01], role: "red", part: { name: "door", pivot: [-0.4, 0, 0.31], axis: [0, 1, 0], range: [0, -100], label: "porte" } },
        { t: "box", c: [0.3, 0.4, 0.33], h: [0.02, 0.04, 0.02], role: "metal", part: { name: "door" } },
        { t: "box", c: [0, 0.1, 0], h: [0.1, 0.1, 0.1], role: "wood", part: { name: "x", kind: "spin" } },
      ],
    });
    expect(names(asm)).toEqual(["door"]);
    expect(asm.joints![0].label).toBe("porte");
  });
});

describe("composition : parties séparées, états hors de la clé de composition", () => {
  it("instances à part pour les parties, sommets notés pour un bâtiment fusionné ; affords open", () => {
    const { model } = scene();
    const chest = model.objects.find((o) => o.id === "malles.0")!;
    expect(chest.joints!.map((j) => j.name)).toEqual(["lid"]);
    expect(chest.affords).toContain("open");
    const lidGroup = model.instances.find((g) => g.joint === "lid" && g.key.startsWith("container"))!;
    expect(lidGroup.objs.length).toBe(2);
    const house = model.objects.find((o) => o.generator === "building")!;
    expect(house.jointTile!.tile).toBeGreaterThanOrEqual(0);
    expect(house.jointTile!.ranges.door[1]).toBeGreaterThan(house.jointTile!.ranges.door[0]);
    const car = model.objects.find((o) => o.generator === "vehicle")!;
    expect(car.affords).toContain("open");
  });

  it("changer un état ne change pas la clé de composition", () => {
    const { recipe } = scene();
    const withStates = { ...recipe, stateSpeed: 1, layers: recipe.layers!.map((l, i) => (i === 0 ? { ...l, states: { "0": { lid: 1 } }, stateFx: { "lid>0.3": "steam" } } : l)), actors: { a: { at: [0, 0] as [number, number], states: { burning: 1 } } } };
    expect(JSON.stringify(stripStates(stripFx(withStates)))).toBe(JSON.stringify(stripStates(stripFx({ ...recipe, actors: { a: { at: [0, 0] as [number, number] } } }))));
  });
});

describe("lecture des états", () => {
  it("alias open, préfixe, états libres, entrées invalides signalées avec didYouMean", () => {
    const { recipe, model } = scene();
    const issues = new Issues();
    const r = resolveStates(
      statesInputOf({ ...recipe, layers: recipe.layers!.map((l, i) => (i === 0 ? { ...l, states: { "1": { open: true } } } : l)) } as never, {
        "malles.0": { lid: 0.5 },
        "autos.0": { door: 1, trunk: 2, hood: "x" },
        "maisons.0": { door: 1, burning: true },
        "lanternes.0": { lit: 1 },
        "marmites.0": { lidd: 1 },
        "malle.9": { lid: 1 },
      }),
      model.objects,
      issues,
    );
    expect(r.values["malles.1"]).toEqual({ lid: 1 });
    expect(r.values["malles.0"].lid).toBe(0.5);
    expect(r.values["autos.0"]).toMatchObject({ "door.fl": 1, "door.fr": 1, "door.rl": 1, "door.rr": 1, trunk: 1 });
    expect(r.values["autos.0"]["wheel.0"]).toBeUndefined();
    expect(r.values["maisons.0"]).toMatchObject({ door: 1, burning: 1 });
    const byPath = Object.fromEntries(issues.list.map((i) => [i.path, i]));
    expect(byPath["states.autos.0.trunk"].code).toBe("clamped");
    expect(byPath["states.autos.0.hood"].code).toBe("type");
    expect(byPath["states.marmites.0.lidd"]).toMatchObject({ code: "unknown", didYouMean: "lid" });
    expect(byPath["states.malle.9"]).toMatchObject({ code: "unknown", didYouMean: "malles.0" });
    // feu sur la maison : flammes, fumée, braises ; lanterne allumée : flamme et lumière
    expect(r.fx.some((f) => f.raw.preset === "feu" && f.list.some((a) => a.id === "maisons.0"))).toBe(true);
    expect(r.fx.some((f) => f.raw.preset === "fumee")).toBe(true);
    expect(r.lights.length).toBe(2);
    expect(Object.keys(FREE_STATES)).toEqual(["burning", "lit", "boiling", "smoking"]);
  });

  it("stateFx : la vapeur sort de la marmite seulement quand le couvercle est levé", () => {
    const { recipe, model } = scene();
    const withFx = (st: unknown) => ({ ...recipe, layers: recipe.layers!.map((l) => (l.id === "marmites" ? { ...l, stateFx: { "lid>0.3": "steam" }, states: st } : l)) });
    const closed = resolveStates(statesInputOf(withFx(undefined) as never), model.objects, new Issues());
    expect(closed.fx).toEqual([]);
    const open = resolveStates(statesInputOf(withFx({ "0": { lid: 1 } }) as never), model.objects, new Issues());
    expect(open.fx.length).toBe(1);
    expect(open.fx[0].list[0].id).toBe("marmites.0");
    // un système de particules de scene/fx.ts, préréglage traduit (steam → vapeur)
    const plans = planFx({ states: open.fx }, model, new Issues());
    expect(plans.find((p) => p.id === open.fx[0].id)!.raw.preset).toBe("vapeur");
    // règle par objet dans `states`, et état libre `boiling` (vapeur et bulles)
    const iss = new Issues();
    const r = resolveStates(statesInputOf(recipe as never, { "marmites.0": { boiling: 1, fx: { "lid>0.3": "smoke", "nope>1": "fire" } } }), model.objects, iss);
    expect(r.fx.map((f) => f.raw.preset).sort()).toEqual(["bulles", "vapeur"]);
    expect(iss.list.some((i) => i.path === "states.marmites.0.fx.nope>1" && i.code === "unknown")).toBe(true);
  });
});

describe("application sans recomposition (rendu 3D)", () => {
  it("le couvercle tourne par sa seule matrice d'instance, animé, puis l'événement state", () => {
    const { model } = scene();
    const g = model.instances.find((x) => x.joint === "lid" && x.key.startsWith("container|") && x.objs.length === 2)!;
    const im = new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), g.matrices.length);
    const byObj = new Map(model.objects.map((o) => [o.obj, o] as [number, ObjectInfo]));
    const L = new StateLayer();
    L.objMatrix = (o) => m4Compose(o.pos, qAxis([0, 1, 0], o.yaw), o.scale);
    const events: unknown[] = [];
    L.onState = (e) => events.push(e);
    L.add(im, "lid", g.objs, byObj);
    L.mounted();
    const before = new THREE.Matrix4();
    im.getMatrixAt(0, before);
    const chest = model.objects.find((o) => o.id === "malles.0")!;
    const top0 = chest.anchors["lid.top"][1];
    expect(L.set({ "malles.0": { lid: 1 } }, 0.6, [])).toBe(true);
    expect(L.moving).toBe(true);
    L.step(0.3);
    expect(chest.states!.lid).toBeCloseTo(0.5, 5);
    expect(events).toEqual([]);
    L.step(0.4);
    expect(L.moving).toBe(false);
    expect(events).toEqual([{ objectId: "malles.0", part: "lid", value: 1 }]);
    const after = new THREE.Matrix4();
    im.getMatrixAt(0, after);
    expect(after.equals(before)).toBe(false);
    // l'ancre du couvercle a suivi (couvercle levé à l'arrière)
    const t = chest.anchors["lid.top"];
    expect(Math.hypot(t[0] - chest.pos[0], t[2] - chest.pos[2])).toBeGreaterThan(0.2);
    expect(chest.anchors["lid.top"][1]).not.toBeCloseTo(top0, 2);
    expect(L.partOf.get(im)).toBe("lid");
  });

  it("partie d'un bâtiment : sommets de la tuile réécrits, partie retrouvée sous le doigt", () => {
    const { model } = scene();
    const house = model.objects.find((o) => o.generator === "building")!;
    const tile = model.tiles[house.jointTile!.tile];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(tile.pos), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(Float32Array.from(tile.nrm), 3));
    const mesh = new THREE.Mesh(geo);
    const L = new StateLayer();
    L.objMatrix = (o) => m4Compose(o.pos, qAxis([0, 1, 0], o.yaw), o.scale);
    L.addTile(house, mesh, house.jointTile!.ranges);
    const [a] = house.jointTile!.ranges.door;
    const p0 = Array.from((geo.getAttribute("position").array as Float32Array).slice(a * 3, a * 3 + 30));
    L.set({ "maisons.0": { door: 1 } }, 0, []);
    L.step(0.016);
    const p1 = Array.from((geo.getAttribute("position").array as Float32Array).slice(a * 3, a * 3 + 30));
    expect(p1).not.toEqual(p0);
    expect(L.partAt(house, mesh, a)).toBe("door");
    expect(L.partAt(house, mesh, 0)).toBe(null);
    // retour fermé : sommets d'origine
    L.set({ "maisons.0": { door: 0 } }, 0, []);
    L.step(0.016);
    const p2 = Array.from((geo.getAttribute("position").array as Float32Array).slice(a * 3, a * 3 + 30));
    p2.forEach((v, i) => expect(v).toBeCloseTo(p0[i], 3));
  });

  it("vectoriel : les parties posées à leur état (portière ouverte plus large)", async () => {
    const { vehiclePartsModel } = await import("../gen/vehicle-parts");
    const vm = vehiclePartsModel({ kind: "moderncar", variant: 0 });
    const w = (st: Record<string, number>) => partsBounds([...vm.parts, ...posedAll(vm.joints, st)]).max[0];
    expect(w({ "door.fl": 1 })).toBeGreaterThan(w({}) + 0.5);
  });
});
