import { describe, expect, it } from "vitest";
import { m4Compose } from "../core/math";
import { Mesh } from "../geom/mesh";
import { box } from "../geom/prims";
import type { ObjectInfo } from "./compose";
import { maxTopAt, nearestEdge, supportAt, topAt, topGridOf, wallAhead } from "./surfaces";

/** Deux gradins : une marche de 1 m (avant) et une de 2 m (arrière), posés au sol. */
function steps(): ObjectInfo {
  const m = new Mesh();
  m.append(box(1, 0.5, 0.5, 4, 0).transform(m4Compose([0, 0.5, 0.5])));
  m.append(box(1, 1, 0.5, 4, 0).transform(m4Compose([0, 1, -0.5])));
  return { id: "g.0", layer: "g", generator: "rock", params: {}, pos: [0, 0, 0], yaw: 0, scale: 1, footprint: { hx: 1, hz: 1, r: 1.42 }, height: 2, obj: 0, mode: "static", anchors: {}, top: topGridOf(m, 1, 1) };
}

describe("surfaces : sommets praticables", () => {
  it("dessus réel du modèle : marche basse devant, haute derrière", () => {
    const o = steps();
    expect(topAt(o, 0, 0.5)).toBeCloseTo(1, 1);
    expect(topAt(o, 0, -0.5)).toBeCloseTo(2, 1);
    expect(topAt(o, 3, 0)).toBeNull();
    const e = nearestEdge(o, 0, 2);
    expect(e.n[1]).toBe(1);
    expect(e.d).toBeCloseTo(1, 5);
  });

  it("appui : on monte d'un pas, pas d'un mur ; paroi trouvée droit devant", () => {
    const o = steps();
    expect(supportAt([o], 0, 0, 0.5, 0.8, 0.3).y).toBeCloseTo(1, 1);
    expect(supportAt([o], 0, 0, 0.5, 0, 0.3).y).toBe(0);
    expect(maxTopAt([o], 0, -0.5)).toBeCloseTo(2, 1);
    const w = wallAhead([o], 0, 2, 0, -1, 0, 0.3)!;
    expect(Math.abs(w.d - 1)).toBeLessThan(0.1);
    expect(w.top).toBeCloseTo(1, 0);
    // depuis la première marche, la paroi suivante est à 1 m (2 m de haut)
    const w2 = wallAhead([o], 0, 0.6, 0, -1, 1, 0.3)!;
    expect(w2.top).toBeCloseTo(2, 1);
  });
});
