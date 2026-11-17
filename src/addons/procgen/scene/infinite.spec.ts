import { describe, expect, it } from "vitest";
import { Issues } from "../core/schema";
import type { Recipe } from "./compose";
import { MainThreadRunner, TileWorld, composeTile, readInfinite, recordMove, worldRoads, type InfiniteSpec } from "./infinite";
import { boundEdits, editCount } from "../../../shared/monde/tiles";

const RECIPE: Recipe & { infinite: unknown } = {
  infinite: { tile: 24, radius: 1, follow: "heros", seed: "campagne", roads: { spacing: 60, width: 4, kind: "road" }, persist: 6 },
  ground: { relief: 1.5, scale: 30 },
  layers: [
    { id: "arbres", gen: "tree", place: { scatter: { cell: 7, density: 0.5 } }, params: { species: "oak", height: "= rand(5, 8)" } },
    { id: "rochers", gen: "rock", place: { scatter: { cell: 11, density: "= h > 0 ? 0.6 : 0.2" } } },
    { id: "bornes", gen: "prop.milestone", place: { along: "routes", side: "left", spacing: 30 } },
    { id: "puits", gen: "prop.well", place: { at: [[3, 4], [200, 200]] } },
  ],
  actors: { heros: { at: [0, 0] } },
};

const spec = (): InfiniteSpec => readInfinite(RECIPE.infinite, new Issues(), "1")!;
const job = (cx: number, cz: number, extra: Partial<Parameters<typeof composeTile>[0]> = {}) => ({ recipe: RECIPE, seed: "1", params: {}, spec: spec(), cx, cz, objBase: 1000, step: 1.5, ...extra });

describe("procgen : monde infini", { timeout: 120000 }, () => {
  it("lecture : bornes, réseau de routes, persistance", () => {
    const iss = new Issues();
    const s = readInfinite({ tile: 2, radius: 9, roads: [{ kind: "path" }], persist: { total: 50 } }, iss, "x")!;
    expect(s.tile).toBe(8);
    expect(s.radius).toBe(4);
    expect(s.roads[0]).toMatchObject({ id: "routes", kind: "path" });
    expect(s.persist).toBe(50);
    expect(iss.list.some((i) => i.path === "infinite.radius")).toBe(true);
    expect(readInfinite(undefined, iss, "x")).toBeNull();
  });

  it("tuile déterministe : mêmes ids, mêmes positions, objets dans la tuile, repère du monde", () => {
    const a = composeTile(job(2, -1)), b = composeTile(job(2, -1));
    expect(a.objects.map((o) => o.id)).toEqual(b.objects.map((o) => o.id));
    expect(a.objects.map((o) => o.pos)).toEqual(b.objects.map((o) => o.pos));
    expect(a.objects.length).toBeGreaterThan(0);
    for (const o of a.objects) {
      expect(o.pos[0]).toBeGreaterThanOrEqual(48);
      expect(o.pos[0]).toBeLessThan(72);
      expect(o.pos[2]).toBeGreaterThanOrEqual(-24);
      expect(o.pos[2]).toBeLessThan(0);
    }
    expect(a.objects.every((o) => /^(arbres|rochers|bornes)\.2_-1_\d+$/.test(o.id))).toBe(true);
  });

  it("raccord : le sol de deux tuiles voisines a la même hauteur sur la frontière", () => {
    const a = composeTile(job(0, 0)), b = composeTile(job(1, 0));
    for (let z = -11; z < 12; z += 2.3) {
      const ha = a.terrain!.height(12, z), hb = b.terrain!.height(-12, z);
      expect(Math.abs(ha - hb)).toBeLessThan(1e-3);
    }
  });

  it("points at : seul celui de la tuile, avec son rang", () => {
    const t = composeTile(job(0, 0));
    expect(t.objects.find((o) => o.layer === "puits")?.id).toBe("puits.0");
    const far = composeTile(job(8, 8));
    expect(far.objects.find((o) => o.layer === "puits")?.id).toBe("puits.1");
  });

  it("routes du monde : mêmes tronçons vus de deux tuiles", () => {
    const s = spec();
    const A = worldRoads(s, 0, 0, 24, 24), B = worldRoads(s, 24, 0, 48, 24);
    const shared = A.filter((p) => B.some((q) => q.id === p.id));
    for (const p of shared) expect(B.find((q) => q.id === p.id)!.points).toEqual(p.points);
    expect(worldRoads(s, -300, -300, 300, 300).length).toBeGreaterThan(5);
  });

  it("retouches : retiré, déplacé, ajouté ; les autres ids ne bougent pas", () => {
    const base = composeTile(job(0, 0));
    const [r, m] = base.objects.filter((o) => o.layer === "arbres");
    const e = composeTile(job(0, 0, { edits: { remove: [r.id], move: { [m.id]: { x: 1, z: 2, yaw: 90 } }, add: [{ id: "n1", gen: "prop.barrel", x: 5, z: -5 }] } }));
    expect(e.objects.some((o) => o.id === r.id)).toBe(false);
    const mm = e.objects.find((o) => o.id === m.id)!;
    expect([mm.pos[0], mm.pos[2]]).toEqual([1, 2]);
    expect(e.objects.find((o) => o.id === "n1")?.generator).toBe("prop");
    const keep = base.objects.filter((o) => o.id !== r.id && o.id !== m.id).map((o) => o.id);
    expect(keep.every((id) => e.objects.some((o) => o.id === id))).toBe(true);
  });

  it("chargement autour du point suivi, relâche derrière, budget par image", () => {
    const w = new TileWorld(spec(), RECIPE, "1", {}, new MainThreadRunner());
    let frames = 0;
    while ((w.busy || w.tiles.size < 9) && frames++ < 20000) w.update(0, 0, 4);
    expect(w.tiles.size).toBe(9);
    expect(w.added.length).toBe(9);
    w.added = [];
    for (let k = 0; k < 20000 && (w.busy || !w.tiles.has("10,0")); k++) w.update(10 * 24 + 12, 12, 4);
    expect(w.tiles.has("0,0")).toBe(false);
    expect(w.removed.some((t) => t.key === "0,0")).toBe(true);
    expect(w.tiles.has("10,0")).toBe(true);
    expect(w.objects().length).toBeGreaterThan(0);
    expect(w.state().avgTileMs).toBeGreaterThan(0);
  });

  it("façade : sol, cellules libres, chemin entre tuiles", () => {
    const w = new TileWorld(spec(), RECIPE, "1", {}, new MainThreadRunner());
    for (let k = 0; k < 3000 && (w.busy || w.tiles.size < 9); k++) w.update(0, 0, 50);
    const p = w.path([-20, 0], [20, 3]);
    expect(p).not.toBeNull();
    for (const [x, z] of p!.slice(1, -1)) expect(w.free(x, z)).toBe(true);
    expect(Number.isFinite(w.height(30, 0))).toBe(true);
  });

  it("persistance bornée par un total : les tuiles lointaines oubliées d'abord", () => {
    const s = spec();
    let tiles = {};
    const obj = { id: "", layer: "arbres", generator: "tree", params: {}, scale: 1 };
    for (let k = 0; k < 10; k++) {
      const x = k * 24 + 3;
      tiles = recordMove(tiles, s, { ...obj, id: `arbres.${k}_0_0` }, [x, 3], { x: x + 1, z: 3, yaw: 0 }, [x, 3], k).tiles;
    }
    const n = Object.values(tiles).reduce((a: number, e) => a + editCount(e as never), 0);
    expect(n).toBeLessThanOrEqual(6);
    expect(Object.keys(tiles)).toContain("9,0");
    expect(Object.keys(tiles)).not.toContain("0,0");
    // changement de tuile : retiré de l'une, ajouté dans l'autre
    const t2 = recordMove({}, s, { ...obj, id: "arbres.0_0_1" }, [3, 3], { x: 30, z: 3, yaw: 45 }, [3, 3]).tiles;
    expect(t2["0,0"].remove).toEqual(["arbres.0_0_1"]);
    expect(t2["1,0"].add?.[0]).toMatchObject({ id: "arbres.0_0_1", gen: "tree", x: 30 });
    // la tuile gardée est tronquée plutôt qu'oubliée
    const b = boundEdits({ "0,0": { remove: ["a", "b", "c"] } }, 2, 0, 0, "0,0");
    expect(b.count).toBe(2);
  });
});

describe("procgen : tuiles composées dans un worker", { timeout: 120000 }, () => {
  it("aller-retour : même modèle, maillages d'assets envoyés une fois", async () => {
    const { serveTileWorker, WorkerTileRunner } = await import("./tile-worker");
    // paire worker ↔ page en mémoire (clonage structuré, comme postMessage)
    const scope: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void } = { onmessage: null, postMessage: () => {} };
    const fake = { onmessage: null as ((e: { data: unknown }) => void) | null, onerror: null, terminate() {}, postMessage(m: unknown) { queueMicrotask(() => scope.onmessage!({ data: structuredClone(m) })); } };
    scope.postMessage = (m) => queueMicrotask(() => fake.onmessage!({ data: structuredClone(m) }));
    serveTileWorker(scope);
    const runner = new WorkerTileRunner(fake);
    const got = await new Promise<import("./compose").SceneModel>((res) => runner.start(job(0, 0), (m) => res(m!)));
    const ref = composeTile(job(0, 0));
    expect(got.objects.map((o) => o.id)).toEqual(ref.objects.map((o) => o.id));
    expect(got.terrain!.height(3, 4)).toBeCloseTo(ref.terrain!.height(3, 4), 5);
    expect(got.nav!.free(5, 5)).toBe(ref.nav!.free(5, 5));
    expect(got.instances.map((g) => g.mesh.vertexCount)).toEqual(ref.instances.map((g) => g.mesh.vertexCount));
    const again = await new Promise<import("./compose").SceneModel>((res) => runner.start(job(0, 1), (m) => res(m!)));
    expect(again.instances.every((g) => g.mesh.vertexCount > 0)).toBe(true);
    expect(runner.usingWorker).toBe(true);
  });

  it("worker en échec : la tâche repasse sur le fil principal", async () => {
    const { WorkerTileRunner } = await import("./tile-worker");
    const fake = { onmessage: null, onerror: null as null | ((e: object) => void), terminate() {}, postMessage() { queueMicrotask(() => fake.onerror!({})); } };
    const runner = new WorkerTileRunner(fake);
    const p = new Promise<unknown>((res) => runner.start(job(1, 1), (m) => res(m)));
    await new Promise((r) => setTimeout(r, 0));
    for (let k = 0; k < 2000 && runner.busy; k++) runner.pump(50);
    expect(await p).not.toBeNull();
    expect(runner.usingWorker).toBe(false);
  });
});
