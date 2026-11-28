import { describe, expect, it } from "vitest";
import { accelOf, opacityAt, ParticleSystem, positionAt, readParticles, type V3 } from "./particles";
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

describe("usages : salve, flux, nappe", () => {
  it("mode déduit : préréglage, débit, ou donné (alias anglais)", () => {
    expect(one({ preset: "etincelles" }).s.mode).toBe("salve");
    expect(one({ preset: "fumee" }).s.mode).toBe("flux");
    expect(one({ preset: "brume" }).s.mode).toBe("nappe");
    expect(one({ rate: 5 }).s.mode).toBe("flux");
    expect(one({ preset: "fumee", mode: "burst" }).s).toMatchObject({ mode: "salve", rate: 0 });
    const n = one({ mode: "ambient", max: 80, life: [4, 6] }).s;
    expect(n.mode).toBe("nappe");
    expect(n.rate).toBeGreaterThan(0);
    expect(one({ mode: "pschitt" }).issues.some((i) => i.path === "particles.p.mode")).toBe(true);
  });
  it("fondus : une fumée monte en opacité, une brume entre et sort en douceur, une salve part pleine", () => {
    const fumee = one({ preset: "fumee" }).s;
    expect(opacityAt(fumee, 0)).toBe(0);
    expect(opacityAt(fumee, 0.2)).toBeGreaterThan(0.35);
    const brume = one({ preset: "brume" }).s;
    expect(opacityAt(brume, 0)).toBe(0);
    expect(opacityAt(brume, 1)).toBe(0);
    expect(opacityAt(brume, 0.5)).toBeCloseTo(0.2, 5);
    const salve = one({ preset: "eclats" }).s;
    expect(opacityAt(salve, 0)).toBe(1);
  });
  it("nappe préremplie : population établie dès le premier pas, âges répartis, système qui s'installe en fondu", () => {
    const set = new ParticleSet();
    set.set(readMonde({ particles: { b: { preset: "brume", rate: 6 } } }));
    set.step(1 / 60);
    const sys = set.systems[0];
    const now = set.now;
    const ages = [...sys.born].filter((b) => b > -1e8).map((b) => now - b);
    expect(ages.length).toBeGreaterThan(30);
    // pas de vague : les âges couvrent la vie (6 à 10 s), pas tous nés à l'instant
    expect(Math.max(...ages)).toBeGreaterThan(4);
    expect(ages.filter((a) => a < 0.5).length).toBeLessThan(ages.length / 4);
    expect(sys.presence(now)).toBeLessThan(0.05);
    expect(sys.presence(now + 3)).toBeCloseTo(1, 5);
  });
  it("flux : une image très longue ne lâche pas une rafale", () => {
    const { s } = one({ preset: "fumee", max: 200 });
    const sys = new ParticleSystem(s);
    sys.continuous(5, 5, [0, 0, 0]);
    expect(sys.spawned).toBeLessThanOrEqual(Math.ceil(s.rate * 0.25));
  });
});
