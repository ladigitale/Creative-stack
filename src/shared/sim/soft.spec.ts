import { describe, expect, it } from "vitest";
import { readSoft, SoftSim } from "./soft";
import { readMonde } from "../monde/format";

const ident = (x = 0, y = 0, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

describe("pièces souples", () => {
  it("lecture et erreurs", () => {
    const issues: string[] = [];
    expect(readSoft("cape", (m) => issues.push(m))?.kind).toBe("tissu");
    expect(readSoft({ type: "queue", attache: "bas" }, (m) => issues.push(m))?.pin).toBe("bas");
    expect(readSoft({ type: "gelée" }, (m) => issues.push(m))).toBeNull();
    expect(issues[0]).toMatch(/gelée/);
    const m = readMonde({ models: { p: { parts: [{ name: "cape", box: [0.6, 0.9, 0.02], souple: { rigidite: 0.3 } }] } } });
    expect(m.models.get("p")!.parts[0].soft?.stiffness).toBe(0.3);
  });

  it("un tissu tenu à plat par un bord retombe ; un drapeau flotte au vent", () => {
    const nappe = new SoftSim(readSoft({ type: "tissu", attache: "arriere" }, () => {})!, { c: [0, 2, 0], h: [0.4, 0.01, 0.4] });
    for (let i = 0; i < 180; i++) nappe.step(1 / 60, ident(), [0, -9.81, 0], [0, 0, 0], null);
    let lowest = Infinity;
    for (let i = 1; i < nappe.pos.length; i += 3) lowest = Math.min(lowest, nappe.pos[i]);
    expect(lowest).toBeLessThan(1.4);
    expect(nappe.pos[2]).toBeCloseTo(nappe.rest[2], 5);
    const spec = readSoft({ type: "tissu", attache: "gauche" }, () => {})!;
    const sim = new SoftSim(spec, { c: [0.5, 2, 0], h: [0.5, 0.3, 0.01] });
    const m = ident();
    // vent fort de côté : le tissu part dans le sens du vent
    for (let i = 0; i < 240; i++) sim.step(1 / 60, m, [0, -9.81, 0], [0, 0, 12], null);
    let zs = 0;
    for (let i = 2; i < sim.pos.length; i += 3) zs += sim.pos[i];
    expect(zs / sim.n).toBeGreaterThan(0.1);
  });

  it("une queue suit son attache et ne traverse pas une sphère ni le sol", () => {
    const spec = readSoft({ type: "chaine", attache: "haut", segments: 8 }, () => {})!;
    const sim = new SoftSim(spec, { c: [0, 0.5, 0], h: [0.03, 0.5, 0.03] });
    const sph = new Float32Array([0, 0.4, 0.02, 0.15]);
    for (let i = 0; i < 120; i++) sim.step(1 / 60, ident(0, 0.3, 0), [0, -9.81, 0], [0, 0, 0], sph);
    for (let i = 0; i < sim.n; i++) {
      const x = sim.pos[i * 3], y = sim.pos[i * 3 + 1], z = sim.pos[i * 3 + 2];
      expect(y).toBeGreaterThanOrEqual(0.004);
      if (i > 0) expect(Math.hypot(x, y - 0.4, z - 0.02)).toBeGreaterThan(0.14);
    }
    // l'attache se déplace : le premier point suit
    sim.step(1 / 60, ident(1, 0.3, 0), [0, -9.81, 0], [0, 0, 0], null);
    expect(sim.pos[0]).toBeCloseTo(1, 5);
  });
  it("une jupe reste un tube ouvert accroché à sa ceinture, sans s'effondrer", () => {
    const spec = readSoft("jupe", () => {})!;
    expect(spec.kind).toBe("jupe");
    const sim = new SoftSim(spec, { c: [0, 0.6, 0], h: [0.3, 0.25, 0.3] });
    for (let i = 0; i < 240; i++) sim.step(1 / 60, ident(), [0, -9.81, 0], [0.5, 0, 0], new Float32Array([0, 0.6, 0, 0.22]));
    const { cols, rows } = sim;
    // dernier anneau : encore large (la jupe ne se replie pas sur elle-même), sous la ceinture
    let minR = Infinity, maxY = -Infinity;
    for (let c = 0; c < cols; c++) {
      const k = ((rows - 1) * cols + c) * 3;
      minR = Math.min(minR, Math.hypot(sim.pos[k], sim.pos[k + 2]));
      maxY = Math.max(maxY, sim.pos[k + 1]);
    }
    expect(minR).toBeGreaterThan(0.15);
    expect(maxY).toBeLessThan(0.6);
    // ceinture tenue
    expect(sim.pos[1]).toBeCloseTo(0.85, 2);
  });
});
