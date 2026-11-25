import { describe, expect, it } from "vitest";
import { Swarm } from "./core";

const run = (s: Swarm, seconds: number, resolve?: (r: string) => [number, number] | null) => {
  const ev = [];
  for (let i = 0; i < seconds * 60; i++) ev.push(...s.step(1 / 60, resolve));
  return ev;
};

describe("Swarm", () => {
  it("crée les agents, garde l'état quand le nombre change, plafonne à 200", () => {
    const s = new Swarm(1);
    s.configure({ groups: [{ name: "a", count: 3 }] });
    expect(s.agents.map((a) => a.name)).toEqual(["a0", "a1", "a2"]);
    const x = s.agents[0].x;
    s.configure({ groups: [{ name: "a", count: 5 }] });
    expect(s.agents[0].x).toBe(x);
    expect(s.agents.length).toBe(5);
    s.configure({ groups: [{ name: "a", count: 150 }, { name: "b", count: 150 }] });
    expect(s.agents.length).toBe(200);
  });

  it("même graine, même mouvement", () => {
    const mk = () => {
      const s = new Swarm(9);
      s.configure({ seed: 9, groups: [{ name: "f", count: 20, wander: 1, separation: 1, alignment: 1, cohesion: 1 }] });
      run(s, 2);
      return s.agents.map((a) => [a.x, a.y]);
    };
    expect(mk()).toEqual(mk());
  });

  it("chercher puis arriver : l'agent rejoint la cible et s'y arrête", () => {
    const s = new Swarm(2);
    s.configure({ bounds: [0, 0, 400, 400], groups: [{ name: "a", count: 1, spawn: [20, 20, 21, 21], arrive: { target: [300, 300] }, separation: 0 }] });
    run(s, 8);
    const a = s.agents[0];
    expect(Math.hypot(a.x - 300, a.y - 300)).toBeLessThan(10);
    expect(Math.hypot(a.vx, a.vy)).toBeLessThan(20);
  });

  it("cible lue dans un DataProvider", () => {
    const s = new Swarm(2);
    s.configure({ bounds: [0, 0, 400, 400], groups: [{ name: "a", count: 1, spawn: [20, 20, 21, 21], arrive: { target: "dp:p" }, separation: 0 }] });
    run(s, 8, (r) => (r === "dp:p" ? [100, 350] : null));
    expect(Math.hypot(s.agents[0].x - 100, s.agents[0].y - 350)).toBeLessThan(10);
  });

  it("le banc reste groupé et aligné", () => {
    const s = new Swarm(4);
    s.configure({ bounds: [0, 0, 2000, 2000], edges: "wrap", groups: [{ name: "f", count: 40, view: 80, spawn: [900, 900, 1100, 1100], separation: 1.5, alignment: 1.2, cohesion: 1 }] });
    run(s, 6);
    let vx = 0, vy = 0, sp = 0;
    for (const a of s.agents) {
      vx += a.vx;
      vy += a.vy;
      sp += Math.hypot(a.vx, a.vy);
    }
    // ordre : norme de la vitesse moyenne / vitesse moyenne (1 = tous dans le même sens)
    expect(Math.hypot(vx, vy) / sp).toBeGreaterThan(0.8);
    for (let i = 0; i < s.agents.length; i++)
      for (let j = i + 1; j < s.agents.length; j++) expect(Math.hypot(s.agents[i].x - s.agents[j].x, s.agents[i].y - s.agents[j].y)).toBeGreaterThan(2);
  });

  it("poursuite et capture, proie replacée", () => {
    const s = new Swarm(5);
    s.configure({
      bounds: [0, 0, 300, 300],
      groups: [
        { name: "prey", count: 1, maxSpeed: 40, spawn: [250, 250, 251, 251], wander: 1 },
        { name: "hunter", count: 1, maxSpeed: 120, spawn: [20, 20, 21, 21], pursue: { target: "group:prey" }, catch: { target: "group:prey", respawn: true } },
      ],
    });
    const ev = run(s, 10);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev[0]).toMatchObject({ by: "hunter0", caught: "prey0", group: "prey" });
  });

  it("champ de flux : traverse un labyrinthe sans entrer dans les murs", () => {
    const rows = ["#########", "#S..#...#", "###.#.#.#", "#...#.#.#", "#.###.#.#", "#.....#X#", "#########"];
    const cell = 40;
    const s = new Swarm(6);
    s.configure({
      bounds: [0, 0, 9 * cell, 7 * cell],
      grid: { rows, cell },
      groups: [{ name: "a", count: 1, maxSpeed: 80, radius: 6, spawn: [cell * 1.4, cell * 1.4, cell * 1.6, cell * 1.6], flow: { target: [7.5 * cell, 5.5 * cell] }, separation: 0 }],
    });
    let hit = false;
    for (let i = 0; i < 60 * 40; i++) {
      s.step(1 / 60);
      if (s.blocked(s.agents[0].x, s.agents[0].y)) hit = true;
    }
    expect(hit).toBe(false);
    expect(Math.floor(s.agents[0].x / cell)).toBe(7);
    expect(Math.floor(s.agents[0].y / cell)).toBe(5);
  });

  it("chemin en boucle et bords en tore", () => {
    const s = new Swarm(7);
    s.configure({ bounds: [0, 0, 200, 200], groups: [{ name: "p", count: 1, spawn: [10, 10, 11, 11], separation: 0, path: { points: [[150, 20], [150, 150], [20, 150]] } }] });
    run(s, 6);
    expect(s.agents[0].waypoint).toBeGreaterThan(1);
    const t = new Swarm(8);
    t.configure({ bounds: [0, 0, 100, 100], edges: "wrap", groups: [{ name: "w", count: 1, spawn: [95, 50, 96, 51], seek: { target: [300, 50] } }] });
    run(t, 1);
    expect(t.agents[0].x).toBeLessThan(100);
    expect(t.agents[0].x).toBeGreaterThanOrEqual(0);
  });

  it("200 agents : une image de simulation bien sous la milliseconde ×4", () => {
    const s = new Swarm(1);
    s.configure({ bounds: [0, 0, 1600, 900], groups: [{ name: "f", count: 200, separation: 1.5, alignment: 1, cohesion: 1, wander: 0.3, view: 50 }] });
    run(s, 1);
    const t0 = performance.now();
    run(s, 1);
    expect((performance.now() - t0) / 60).toBeLessThan(4);
  });
});
