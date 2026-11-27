import { describe, expect, it } from "vitest";
import { FootballMatch, NO_INPUT, footballRecipe, parseFootball } from "./football";

function run(m: FootballMatch, seconds: number, input = NO_INPUT) {
  const all: string[] = [];
  for (let t = 0; t < seconds; t += 1 / 30) {
    m.step(1 / 30, input);
    for (const e of m.events) all.push(e.type);
    m.events.length = 0;
    for (const p of m.players) if (!Number.isFinite(p.pos[0] + p.pos[1] + p.yaw)) throw new Error(`NaN ${p.id}`);
    if (!Number.isFinite(m.ball.p[0] + m.ball.p[1] + m.ball.p[2])) throw new Error("NaN ball");
  }
  return all;
}

describe("football", () => {
  it("joue un match complet entre deux équipes gérées : passes, tirs, sorties, mi-temps, fin", () => {
    const m = new FootballMatch(parseFootball({ players: 11, minutes: 4, human: "none", seed: 3 }));
    const ev: string[] = [];
    for (let k = 0; k < 12 && m.phase !== "fulltime"; k++) ev.push(...run(m, 60));
    const count = (t: string) => ev.filter((e) => e === t).length;
    if (process.env.FOOT_LOG) console.log(Object.fromEntries([...new Set(ev)].map((t) => [t, count(t)])), m.score);
    expect(count("kick")).toBeGreaterThan(40);
    expect(count("shot")).toBeGreaterThan(2);
    expect(count("halftime")).toBe(1);
    expect(count("fulltime")).toBe(1);
    expect(m.phase).toBe("fulltime");
  });

  it("les joueurs ne se traversent pas et le ballon reste près du terrain", () => {
    const m = new FootballMatch(parseFootball({ players: 7, minutes: 2, human: "none", seed: 5 }));
    let overlaps = 0;
    for (let k = 0; k < 30 * 60; k++) {
      m.step(1 / 30);
      m.events.length = 0;
      for (let i = 0; i < m.players.length; i++)
        for (let j = i + 1; j < m.players.length; j++) {
          const a = m.players[i], b = m.players[j];
          if (Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]) < 0.45) overlaps++;
        }
      expect(Math.abs(m.ball.p[0])).toBeLessThan(m.dim.L / 2 + 7);
      expect(Math.abs(m.ball.p[2])).toBeLessThan(m.dim.W / 2 + 6);
    }
    expect(overlaps).toBeLessThan(30);
  });

  it("l'humain contrôle un joueur, conduit le ballon et tire", () => {
    const m = new FootballMatch(parseFootball({ players: 5, minutes: 3, human: "home", seed: 2, level: 0 }));
    run(m, 5);
    expect(m.ctrl).toBeGreaterThanOrEqual(0);
    // donne le ballon au joueur contrôlé devant le but adverse
    const p = m.players[m.ctrl];
    m.phase = "play";
    m.set = null;
    p.pos = [m.dir(0) * (m.dim.L / 2 - 9), 0];
    m.ball.p = [p.pos[0] + m.dir(0) * 0.5, 0.11, 0];
    m.ball.owner = m.ctrl;
    const ev = run(m, 0.3, { ...NO_INPUT, x: m.dir(0), shoot: true });
    ev.push(...run(m, 1.5, { ...NO_INPUT }));
    expect(ev).toContain("shot");
  });

  it("la recette du stade contient terrain, buts, ballon et 22 joueurs", () => {
    const r = footballRecipe(parseFootball({}));
    expect(Object.keys(r.actors as object)).toHaveLength(22);
    expect((r.layers as { gen: string }[]).map((l) => l.gen)).toEqual(expect.arrayContaining(["sport.pitch", "sport.goal", "ball.soccer"]));
  });
});

describe("football : réglages", () => {
  it("lit les équipes publiées en objet indexé", () => {
    const s = parseFootball({ teams: { 0: { name: "Lions" }, 1: { name: "Aigles" } } });
    expect(s.teams.map((t) => t.name)).toEqual(["Lions", "Aigles"]);
  });
});
