import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clearAssetCache, composeScene, type Recipe, type SceneModel } from "./compose";
import type { Mesh } from "../geom/mesh";

const recipe: Recipe = {
  size: [40, 24],
  ground: { relief: 0.4 },
  paths: [{ id: "rue", points: [[-20, 0], [20, 0]], width: 4, kind: "street", sidewalk: 1.5 }],
  layers: [
    { id: "maisons", gen: "building", count: 3, place: { along: "rue", side: "right", spacing: 9 }, params: { floors: 2, bays: 2, depth: 6 } },
    { id: "arbres", gen: "tree", count: 10, place: { poisson: true, minDist: 3 }, params: { species: "= pick('oak', 'pine')", height: "= rand(4, 8)" } },
    { id: "rochers", gen: "rock", count: 4, place: { poisson: true, minDist: 3 } },
    { id: "lampes", gen: "prop.lamp", count: 3, place: { along: "rue", side: "left", spacing: 12, offset: -1 } },
  ],
};

/** Empreinte de tout ce que la vue consomme : objets, tuiles fusionnées, instances, navigation, messages. */
function fingerprint(m: SceneModel): string {
  const h = createHash("sha1");
  const mesh = (x: Mesh | null) => {
    if (!x) return h.update("-");
    for (const k of ["pos", "nrm", "role", "ao", "flex", "obj", "skin", "weight", "morph", "blend", "idx"] as const) {
      const a = x[k];
      h.update(k);
      if (a) h.update(new Float64Array(a));
    }
  };
  h.update(JSON.stringify(m.objects.map((o) => [o.id, o.generator, o.pos, o.yaw, o.scale, o.params, o.anchors])));
  m.tiles.forEach(mesh);
  for (const g of m.instances) {
    h.update(g.key);
    mesh(g.mesh);
    for (const t of g.matrices) h.update(new Float64Array(Array.from(t)));
  }
  h.update(JSON.stringify(m.issues));
  if (m.nav) h.update(new Uint8Array(m.nav.blocked));
  return h.digest("hex");
}

describe("cache d'assets entre compositions", () => {
  it("recomposer donne le même modèle bit à bit qu'une composition neuve, bien plus vite", { timeout: 60000 }, () => {
    clearAssetCache();
    let t = performance.now();
    const cold = composeScene({ recipe, seed: 7 });
    const coldMs = performance.now() - t;
    t = performance.now();
    const warm = composeScene({ recipe, seed: 7 });
    const warmMs = performance.now() - t;
    expect(fingerprint(warm)).toBe(fingerprint(cold));
    expect(warmMs * 5).toBeLessThan(coldMs);
    // une autre graine ne réutilise pas les assets d'une autre (clé = état de l'aléa du constructeur)
    clearAssetCache();
    const other = fingerprint(composeScene({ recipe, seed: 8 }));
    composeScene({ recipe, seed: 7 });
    expect(fingerprint(composeScene({ recipe, seed: 8 }))).toBe(other);
  });

  it("une modification ne touche que l'objet modifié : le reste sort du cache, identique", { timeout: 60000 }, () => {
    clearAssetCache();
    const edits = { "maisons.1": { floors: 3 } };
    const fresh = fingerprint(composeScene({ recipe, seed: 7, edits }));
    clearAssetCache();
    composeScene({ recipe, seed: 7 });
    expect(fingerprint(composeScene({ recipe, seed: 7, edits }))).toBe(fresh);
  });
});
