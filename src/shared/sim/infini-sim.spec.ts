import { describe, expect, it } from "vitest";
import { readMonde } from "../monde/format";
import { MondeDriver } from "../monde/driver";
import { heightAt, TileManager } from "../monde/infini";
import { loadRapier, RigidWorld } from "./rigid";
import { nearShapes, groundOf } from "./infini-shapes";
import { GameProbe } from "./queries";
import { EmitterSet } from "./set";

const balle = { parts: [{ name: "b", sphere: 0.2, at: [0, 0.2, 0] }] };
const pilier = { parts: [{ name: "p", box: [1, 3, 1], at: [0, 1.5, 0] }] };

function monde(relief: string, layers: unknown[] = [], extra: Record<string, unknown> = {}) {
  return readMonde({
    physique: true,
    models: { balle, pilier },
    infini: { seed: "s", tile: 16, radius: 1, center: [8, 8], ground: { relief }, layers },
    ...extra,
  });
}

describe("monde infini dans les simulations", () => {
  it("relief : une balle lâchée se pose sur le champ de hauteurs de la tuile", async () => {
    const R = await loadRapier();
    const m = monde("= 2 + 0.15 * x + 0.05 * z", [], { place: [{ model: "balle", name: "b", at: [6, 12, 9], corps: { type: "dynamique", rebond: 0 } }] });
    const d = new MondeDriver();
    d.setMonde(m, 0);
    const mgr = new TileManager();
    mgr.set(m.infini);
    mgr.update(8, 8, 1000);
    const w = new RigidWorld(R, m, d);
    for (let i = 0; i < 240; i++) {
      w.syncInfini(mgr);
      w.step(1 / 60);
    }
    const t = d.instances.get("b")!.t;
    // la balle roule sur la pente : elle reste posée sur le relief, où qu'elle soit
    expect(Math.abs(t.y - heightAt(m.infini!, t.x, t.z))).toBeLessThan(0.25);
    w.dispose();
  });

  it("peuplement : obstacle physique, forme des requêtes, boîte des émetteurs, sol des nuées", async () => {
    const R = await loadRapier();
    const layers = [{ model: "pilier", cell: 16, density: 1, jitter: 0 }];
    const m = monde("", layers, { place: [{ model: "balle", name: "b", at: [2, 0, 8], corps: { type: "dynamique", vitesse: [8, 0, 0] } }] });
    const d = new MondeDriver();
    d.setMonde(m, 0);
    const mgr = new TileManager();
    mgr.set(m.infini);
    mgr.update(8, 8, 1000);
    // un pilier au centre de chaque tuile (8, 8)
    const { shapes, sig } = nearShapes(m, mgr);
    expect(shapes.length).toBe(9);
    expect(sig.split(";").length).toBe(9);
    expect(shapes[0].tags).toContain("infini");
    const w = new RigidWorld(R, m, d);
    for (let i = 0; i < 120; i++) {
      w.syncInfini(mgr);
      w.step(1 / 60);
    }
    // la balle heurte le pilier de sa tuile (choc nommé par l'identifiant de la copie) et le contourne
    expect(w.contacts.some((c) => c.a.startsWith("t.0.0") || c.b.startsWith("t.0.0"))).toBe(true);
    expect(Math.abs(d.instances.get("b")!.t.z - 8)).toBeGreaterThan(0.5);
    w.dispose();

    const probe = new GameProbe();
    probe.set(m);
    probe.setExtra(sig, shapes);
    const r = probe.apply({ q: { n: 1, ray: { from: [0, 1, 8], dir: [1, 0, 0], max: 16 } } }, d);
    expect(r?.q.hit).toBe(true);
    expect(r?.q.instance?.startsWith("t.0.0")).toBe(true);
    expect(r?.q.tags).toContain("infini");

    const set = new EmitterSet();
    set.setFixed(sig, shapes);
    const hits: string[] = [];
    // grille large : candidats, à trier par l'emprise exacte comme le font les émetteurs
    set.world(d).boxes.query(7, 7, 9, 9, (b) => {
      if (b.hi[0] >= 7 && b.lo[0] <= 9 && b.hi[2] >= 7 && b.lo[2] <= 9) hits.push(b.name);
    });
    expect(hits).toEqual(["t.0.0.0.0"]);
    set.ground = groundOf(monde("= 3"));
    expect(set.world(d).ground(1, 1)).toBe(3);
  });
});
