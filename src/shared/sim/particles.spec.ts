import { describe, expect, it } from "vitest";
import { accelOf, ParticleSystem, positionAt, readParticles, type V3 } from "./particles";
import { ParticleSet } from "./particle-set";
import { readMonde } from "../monde/format";

const one = (raw: Record<string, unknown>) => {
  const issues: { path: string; message: string }[] = [];
  const [s] = readParticles({ p: raw }, 1, issues);
  return { s, issues };
};

describe("lecture des particules", () => {
  it("un préréglage donne les valeurs par défaut, une clé écrite les remplace", () => {
    const { s } = one({ preset: "feu", rate: 10, color: ["#00ff00"] });
    expect(s.blend).toBe("add");
    expect(s.rate).toBe(10);
    expect(s.color).toEqual(["#00ff00"]);
    expect(s.rise).toBeGreaterThan(0);
  });
  it("préréglage inconnu et réglage invalide signalés, plafond total tenu", () => {
    const issues: { path: string; message: string }[] = [];
    const list = readParticles({ a: { preset: "lave" }, "2b": {}, c: { max: 4000 }, d: { max: 4000 }, e: { max: 4000 }, f: { max: 4000 }, g: { max: 4000 } }, 1, issues);
    expect(issues.some((i) => i.path === "particles.a.preset")).toBe(true);
    expect(issues.some((i) => i.path === "particles.2b")).toBe(true);
    expect(list.reduce((n, s) => n + s.max, 0)).toBeLessThanOrEqual(16000);
  });
  it("lu dans le monde avec le vent, en mètres", () => {
    const m = readMonde({ unite: "cm", vent: [100, 0, 0], particles: { pluie: { preset: "pluie", extent: [500, 0, 500] } } });
    expect(m.vent).toEqual([1, 0, 0]);
    expect(m.particles[0].extent).toEqual([5, 0, 5]);
  });
});

describe("mouvement en forme close", () => {
  it("chute libre et sol", () => {
    const { s } = one({ gravity: 9.8, speed: 0, spread: 0, life: 5, floor: true, burst: 1 });
    const sys = new ParticleSystem(s);
    sys.burstAt(0, [0, 10, 0]);
    const out: V3 = [0, 0, 0];
    const acc = accelOf(s, [0, 0, 0]);
    positionAt(sys, 0, 1, acc, out);
    expect(out[1]).toBeCloseTo(10 - 4.9, 3);
    positionAt(sys, 0, 3, acc, out);
    expect(out[1]).toBe(0);
  });
  it("le frottement borne la distance parcourue (v / drag)", () => {
    const { s } = one({ speed: 4, spread: 0, dir: [1, 0, 0], drag: 2, life: 10, burst: 1 });
    const sys = new ParticleSystem(s);
    sys.burstAt(0, [0, 0, 0]);
    const out: V3 = [0, 0, 0];
    positionAt(sys, 0, 10, accelOf(s, [0, 0, 0]), out);
    expect(out[0]).toBeCloseTo(2, 2);
  });
  it("tampon circulaire : les plus anciens grains sont réécrits, plages à envoyer suivies", () => {
    const { s } = one({ max: 8, burst: 5 });
    const sys = new ParticleSystem(s);
    sys.burstAt(0, [0, 0, 0]);
    expect(sys.dirty).toEqual([0, 5]);
    sys.dirty = null;
    sys.burstAt(1, [0, 0, 0]);
    expect(sys.head).toBe(2);
    expect(sys.dirty).toEqual([0, 8]);
    expect(sys.born[0]).toBe(1);
  });
});

describe("systèmes d'un monde", () => {
  it("salve sur ordre, puis système enchaîné", () => {
    const m = readMonde({ particles: { boom: { preset: "etincelles", burst: 10, life: 0.5, then: "fumee" }, fumee: { preset: "fumee", rate: 0, burst: 6 } } });
    const set = new ParticleSet();
    set.set(m);
    set.applyOrders({ boom: { n: 0 } });
    expect(set.applyOrders({ boom: { n: 1, at: [1, 0, 2] } })).toBe(true);
    expect(set.get("boom")!.spawned).toBe(10);
    for (let k = 0; k < 40; k++) set.step(1 / 60);
    expect(set.get("fumee")!.spawned).toBe(6);
    expect(set.get("fumee")!.lastBurstAt).toEqual([1, 0, 2]);
  });
  it("naissances continues à la source (instance suivie)", () => {
    const m = readMonde({ particles: { feu: { preset: "feu", from: "torche", offset: [0, 1, 0] } } });
    const set = new ParticleSet();
    set.set(m);
    set.poseOf = (n) => (n === "torche" ? { x: 3, y: 0, z: 0, ry: 0 } : null);
    for (let k = 0; k < 60; k++) set.step(1 / 60);
    const sys = set.get("feu")!;
    expect(sys.spawned).toBeGreaterThan(30);
    expect(Math.abs(sys.p0[0] - 3)).toBeLessThan(0.5);
    expect(set.active).toBe(true);
  });
});
