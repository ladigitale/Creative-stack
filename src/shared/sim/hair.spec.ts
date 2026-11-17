import { describe, expect, it } from "vitest";
import { HairSim, readHair } from "./hair";

const at = (x = 0, y = 1.5, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

describe("chevelures", () => {
  it("lecture, coupes et erreurs", () => {
    const issues: string[] = [];
    expect(readHair("queue", (m) => issues.push(m))?.cut).toBe("queue");
    expect(readHair({ coupe: "longs", nombre: 20 }, () => {})?.count).toBe(20);
    readHair({ coupe: "afro-cyber" }, (m) => issues.push(m));
    expect(issues[0]).toMatch(/afro-cyber/);
  });
  it("les cheveux longs tombent, restent hors du crâne et suivent la tête", () => {
    const spec = readHair({ coupe: "longs", nombre: 40, longueur: 0.4 }, () => {})!;
    const sim = new HairSim(spec, [0, 0, 0], 0.2);
    expect(sim.strands).toBeGreaterThan(15);
    for (let i = 0; i < 120; i++) sim.step(1 / 60, at(), [0, -9.81, 0], [0, 0, 0]);
    let low = Infinity;
    for (let i = 0; i < sim.pos.length; i += 3) {
      const d = Math.hypot(sim.pos[i], sim.pos[i + 1] - 1.5, sim.pos[i + 2]);
      expect(d).toBeGreaterThan(0.19);
      low = Math.min(low, sim.pos[i + 1]);
    }
    expect(low).toBeLessThan(1.3);
    for (let i = 0; i < 60; i++) sim.step(1 / 60, at(2), [0, -9.81, 0], [0, 0, 0]);
    let mx = 0;
    for (let i = 0; i < sim.pos.length; i += 3) mx += sim.pos[i];
    expect(mx / (sim.pos.length / 3)).toBeGreaterThan(1.7);
  });
  it("une coupe hérissée reste dressée", () => {
    const sim = new HairSim(readHair("herisses", () => {})!, [0, 0, 0], 0.2);
    for (let i = 0; i < 120; i++) sim.step(1 / 60, at(), [0, -9.81, 0], [0, 0, 0]);
    // bout des mèches du sommet au-dessus du crâne
    let high = -Infinity;
    for (let i = 1; i < sim.pos.length; i += 3) high = Math.max(high, sim.pos[i]);
    expect(high).toBeGreaterThan(1.75);
  });
});
