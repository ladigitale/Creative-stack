import { describe, expect, it } from "vitest";
import { RACE_CARS, RaceSim, genTrack, gridOrder, parseRace, project, raceRecipe, stepCar, trackAt, trackClearance } from "./race";

const NO = { throttle: 0, steer: 0, brake: 0 };

describe("course : circuit", () => {
  it("boucle fermée à la longueur voulue, sans portions qui se frôlent, départ en ligne droite", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const t = genTrack(seed, 650, 12);
      expect(Math.abs(t.L - 650)).toBeLessThan(20);
      expect(trackClearance(t)).toBeGreaterThan(12 * 2);
      const kmax = Math.max(...t.kappa.map(Math.abs));
      expect(1 / kmax).toBeGreaterThan(9);
      // départ : courbure faible sur les 40 m qui suivent la ligne
      for (let s = 0; s < 40; s += 4) expect(Math.abs(trackAt(t, s).k)).toBeLessThan(1 / 30);
    }
  });
  it("même graine, même circuit", () => {
    expect(genTrack(9, 800, 12).pts).toEqual(genTrack(9, 800, 12).pts);
  });
  it("projection : abscisse et écart latéral", () => {
    const t = genTrack(4, 650, 12);
    const q = trackAt(t, 100);
    const p = project(t, q.p[0], q.p[1]);
    expect(Math.abs(p.s - 100)).toBeLessThan(0.5);
    expect(Math.abs(p.lat)).toBeLessThan(0.05);
    const side = project(t, q.p[0] + Math.cos(q.h) * 3, q.p[1] - Math.sin(q.h) * 3, 100);
    expect(side.lat).toBeCloseTo(3, 0);
  });
});

describe("course : réglages", () => {
  it("valeurs par défaut et bornes", () => {
    const s = parseRace({});
    expect(s).toMatchObject({ laps: 3, opponents: 5, human: true, car: "moderncar", scenery: "campagne", camera: "chase" });
    expect(s.drivers).toHaveLength(6);
    const t = parseRace({ laps: 99, opponents: 30, car: "fusée", paint: "green", human: false, camera: "top" });
    expect(t.laps).toBe(20);
    expect(t.opponents).toBe(7);
    expect(t.car).toBe("moderncar");
    expect(t.drivers).toHaveLength(7);
    expect(t.camera).toBe("top");
    expect(parseRace({ paint: "green" }).drivers[0].paint).toBe("green");
  });
  it("le joueur part 4e (ou dernier)", () => {
    expect(gridOrder(parseRace({ opponents: 5 }))[3]).toBe(0);
    expect(gridOrder(parseRace({ opponents: 1 }))).toEqual([1, 0]);
  });
  it("recette : piste fermée, une voiture par pilote, décor à l'écart", () => {
    const spec = parseRace({ seed: 5 });
    const r = raceRecipe(spec) as { paths: { points: number[][] }[]; layers: { id: string; place: { at?: unknown[] }; params?: { paint?: string } }[]; size: number[] };
    const pts = r.paths[0].points;
    expect(pts[pts.length - 2]).toEqual(pts[0]);
    const cars = r.layers.find((l) => l.id === "voitures")!;
    expect(cars.place.at).toHaveLength(6);
    expect(cars.params!.paint).toMatch(/^= i == 0/);
    const t = genTrack(spec.seed, spec.length, spec.width);
    for (const p of (r.layers.find((l) => l.id === "bois")!.place.at ?? []) as { x: number; z: number }[]) expect(Math.abs(project(t, p.x, p.z).lat)).toBeGreaterThan(spec.width / 2 + 12);
  });
});

describe("course : pilotage", () => {
  it("accélère jusqu'à la pointe, freine, ne tient pas un virage trop rapide", () => {
    const c = RACE_CARS.moderncar;
    const s = { x: 0, z: 0, yaw: 0, speed: 0, steer: 0, dist: 0, lat: 0, lon: 0 };
    for (let i = 0; i < 60 * 20; i++) stepCar(c, s, { ...NO, throttle: 1 }, 1 / 60);
    expect(s.speed).toBeGreaterThan(c.maxSpeed * 0.85);
    expect(s.speed).toBeLessThanOrEqual(c.maxSpeed + 0.01);
    let slip = 0;
    for (let i = 0; i < 60; i++) slip = Math.max(slip, stepCar(c, s, { ...NO, throttle: 1, steer: 1 }, 1 / 60));
    expect(slip).toBeGreaterThan(0);
    // l'accélération latérale reste bornée par l'adhérence
    expect(Math.abs(s.lat)).toBeLessThan(c.grip * 1.25);
    for (let i = 0; i < 60 * 6; i++) stepCar(c, s, { ...NO, brake: 1 }, 1 / 60);
    expect(s.speed).toBe(0);
  });
  it("virage à droite : le braquage positif fait décroître le cap", () => {
    const s = { x: 0, z: 0, yaw: 0, speed: 10, steer: 0, dist: 0, lat: 0, lon: 0 };
    for (let i = 0; i < 30; i++) stepCar(RACE_CARS.moderncar, s, { ...NO, throttle: 0.5, steer: 1 }, 1 / 60);
    expect(s.yaw).toBeLessThan(0);
  });
});

describe("course : déroulé", () => {
  it("compte à rebours, départ, les adversaires bouclent les tours et la course se termine", () => {
    const spec = parseRace({ seed: 2, laps: 2, opponents: 3, human: false, level: 1 });
    const sim = new RaceSim(spec, ["voitures.0", "voitures.1", "voitures.2"]);
    const seen = new Set<string>();
    const laps: number[] = [];
    for (let i = 0; i < 60 * 240 && sim.phase !== "done"; i++) {
      sim.step(1 / 60, NO);
      for (const e of sim.events) {
        seen.add(e.type);
        if (e.type === "lap") laps.push(Number(e.payload.time));
      }
      sim.events.length = 0;
    }
    expect(seen.has("countdown")).toBe(true);
    expect(seen.has("start")).toBe(true);
    expect(seen.has("finish")).toBe(true);
    expect(sim.phase).toBe("done");
    // un tour de 650 m bouclé en moins d'une minute, sans sortie de piste en boucle
    for (const t of laps) expect(t).toBeLessThan(60);
    const res = sim.results();
    expect(res.map((r) => r.position)).toEqual([1, 2, 3]);
    expect(res.every((r) => r.laps === 2)).toBe(true);
  });
  it("joueur : position publiée, remise en piste sur demande", () => {
    const spec = parseRace({ seed: 3, opponents: 2, countdown: false });
    const sim = new RaceSim(spec, ["a", "b", "c"]);
    for (let i = 0; i < 120; i++) sim.step(1 / 60, { throttle: 1, steer: 0, brake: 0 });
    const p = sim.player!;
    expect(p.s.speed).toBeGreaterThan(5);
    expect(sim.summary()).toMatchObject({ phase: "race", laps: 3, lap: 1, cars: 3, player: p.id });
    sim.reset(p);
    for (let i = 0; i < 90; i++) sim.step(1 / 60, NO);
    expect(Math.abs(p.lat)).toBeLessThan(1);
    sim.events.length = 0;
  });
  it("une voiture loin de la piste est remise en piste", () => {
    const sim = new RaceSim(parseRace({ seed: 3, opponents: 0, countdown: false }), ["a"]);
    const p = sim.player!;
    p.s.x += 200;
    for (let i = 0; i < 120; i++) sim.step(1 / 60, NO);
    expect(Math.abs(p.lat)).toBeLessThan(1);
  });
});
