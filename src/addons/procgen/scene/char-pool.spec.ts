import { afterEach, describe, expect, it } from "vitest";
import { buildCharacterFromKey, clearCharacterCache } from "../gen/character";
import type { Look } from "../gen/character/look";
import { packBuilt, unpackBuilt } from "../gen/character/pack";
import { toGeometry } from "../render/materials";
import { type Recipe, type SceneModel, composeScene } from "./compose";
import { prefetchCharacters, recipeHasCharacters, setProcgenCharacterWorkers } from "./char-pool";
import { serveTileWorker } from "./tile-worker";

const recipe: Recipe = {
  size: [16, 12],
  layers: [{ id: "arbres", gen: "tree", count: 2, place: { poisson: true, minDist: 3 } }],
  actors: {
    a: { params: { archetype: "chibi", detail: "crowd" }, at: [-3, 0] },
    b: { params: { archetype: "realistic", detail: "crowd", mood: "happy" }, at: [0, 2] },
    c: { params: { archetype: "cartoon", detail: "crowd", soft: "cloth", bag: "cape" }, at: [3, -1] },
  },
};

/** Paire worker ↔ page en mémoire (clonage structuré, comme postMessage). */
function fakeWorker(fail = false) {
  const scope: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown, t?: unknown) => void } = { onmessage: null, postMessage: () => {} };
  const w = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    onerror: null as null | ((e: object) => void),
    terminate() {},
    postMessage(m: unknown) {
      queueMicrotask(() => (fail ? w.onerror!({}) : scope.onmessage!({ data: structuredClone(m) })));
    },
  };
  scope.postMessage = (m) => queueMicrotask(() => w.onmessage!({ data: structuredClone(m) }));
  serveTileWorker(scope);
  return w;
}

/** Ce que reçoit la carte graphique pour chaque acteur, plus squelette, taille et visage. */
function gpuView(m: SceneModel) {
  return m.actors.map((a) => {
    const g = toGeometry(a.asset.mesh);
    const attrs = Object.fromEntries(Object.entries(g.attributes).map(([k, v]) => [k, Array.from(v.array as Float32Array)]));
    return {
      id: a.id,
      pos: a.pos,
      attrs,
      index: Array.from(g.index!.array),
      bones: a.asset.skeleton!.bones,
      height: a.asset.height,
      footprint: a.asset.footprint,
      anchors: a.asset.anchors,
      soft: a.asset.soft ?? [],
      expr: a.asset.expr ? { ...a.asset.expr, data: Array.from(a.asset.expr.data) } : null,
    };
  });
}

describe("personnages construits dans des workers", { timeout: 120000 }, () => {
  afterEach(() => {
    setProcgenCharacterWorkers(null);
    clearCharacterCache();
  });

  it("même rendu qu'une construction sur place", async () => {
    clearCharacterCache();
    setProcgenCharacterWorkers(() => fakeWorker(), 2);
    const steps: number[] = [];
    const n = await prefetchCharacters({ recipe, seed: 4 }, (f) => steps.push(f));
    expect(n).toBe(3);
    expect(steps.at(-1)).toBeCloseTo(1, 9);
    const viaWorkers = gpuView(composeScene({ recipe, seed: 4 }));
    clearCharacterCache();
    setProcgenCharacterWorkers(null);
    const onPlace = gpuView(composeScene({ recipe, seed: 4 }));
    expect(viaWorkers).toEqual(onPlace);
  });

  it("une fois en cache, rien n'est relancé", async () => {
    clearCharacterCache();
    setProcgenCharacterWorkers(() => fakeWorker(), 2);
    const first = await prefetchCharacters({ recipe, seed: 5 });
    expect(first).toBe(3);
    expect(await prefetchCharacters({ recipe, seed: 5 })).toBe(0);
  });

  it("workers en échec : rien de bloquant, la composition construit sur place", async () => {
    clearCharacterCache();
    setProcgenCharacterWorkers(() => fakeWorker(true), 2);
    expect(await prefetchCharacters({ recipe, seed: 6 })).toBe(0);
    const m = composeScene({ recipe, seed: 6 });
    expect(m.actors.every((a) => a.asset.mesh.vertexCount > 0)).toBe(true);
  });

  it("sans workers : aucun repérage", async () => {
    expect(await prefetchCharacters({ recipe, seed: 7 })).toBe(0);
  });

  it("recettes avec ou sans personnages", () => {
    expect(recipeHasCharacters(recipe)).toBe(true);
    expect(recipeHasCharacters({ layers: [{ id: "f", gen: "character", count: 3 }] })).toBe(true);
    expect(recipeHasCharacters({ layers: [{ id: "a", gen: "tree", count: 3 }] })).toBe(false);
    expect(recipeHasCharacters(undefined)).toBe(false);
  });

  it("empaquetage : squelette et maillage retrouvés", () => {
    const look = (composeScene({ recipe, seed: 8 }).actors[0].asset.extra as { look: Look }).look;
    const b = buildCharacterFromKey(look, "pk/var");
    const u = unpackBuilt(structuredClone(packBuilt(b)));
    expect(u.skeleton.bones).toEqual(b.skeleton.bones);
    expect(Array.from(u.mesh.pos)).toEqual(Array.from(new Float32Array(b.mesh.pos)));
    expect(u.mesh.triangleCount).toBe(b.mesh.triangleCount);
  });
});
