import { describe, expect, it } from "vitest";
import { FIGHTER_IDS, FightSim, MOVES, NO_FIGHT_INPUT, fightRecipe, parseFight } from "./fight";

const run = (sim: FightSim, s: number, inp: (t: number) => [typeof NO_FIGHT_INPUT, typeof NO_FIGHT_INPUT] = () => [NO_FIGHT_INPUT, NO_FIGHT_INPUT]) => {
  const ev: { type: string; payload: Record<string, unknown> }[] = [];
  for (let i = 0; i < Math.round(s * 60); i++) {
    sim.step(1 / 60, inp(i / 60));
    ev.push(...sim.events);
    sim.events.length = 0;
  }
  return ev;
};

describe("combat : réglages", () => {
  it("valeurs par défaut, joueurs, arène", () => {
    const s = parseFight({});
    expect(s).toMatchObject({ rounds: 3, time: 60, arena: "dojo", camera: "side" });
    expect(s.fighters.map((f) => f.human)).toEqual([true, false]);
    expect(parseFight({ humans: 2 }).fighters.map((f) => f.human)).toEqual([true, true]);
    expect(parseFight({ rounds: 4 }).rounds).toBe(5);
    expect(parseFight({}, true).arena).toBeNull();
    expect(parseFight({ fighters: [{ weapon: "sword", hp: 150, name: "Akira" }] }).fighters[0]).toMatchObject({ weapon: "sword", hp: 150, name: "Akira" });
  });
  it("arène : deux combattants face à face", () => {
    const r = fightRecipe(parseFight({ arena: "ring", fighters: [{ weapon: "sword" }] })) as { actors: Record<string, { params: Record<string, unknown> }> };
    expect(Object.keys(r.actors)).toEqual(FIGHTER_IDS);
    expect(r.actors.combattant1.params.item).toBe("sword");
  });
  it("coups calés sur les gestes : fenêtre active avant la fin", () => {
    for (const m of Object.values(MOVES)) {
      expect(m.on).toBeLessThan(m.off);
      expect(m.off).toBeLessThan(m.total);
    }
  });
});

describe("combat : déroulé", () => {
  it("un direct touche à portée, la garde réduit les dégâts", () => {
    const sim = new FightSim(parseFight({ humans: 2, time: 0 }));
    run(sim, 1.8);
    expect(sim.phase).toBe("fight");
    sim.f[0].x = -0.5;
    sim.f[1].x = 0.5;
    const ev = run(sim, 0.5, (t) => [{ ...NO_FIGHT_INPUT, light: t < 0.05 }, NO_FIGHT_INPUT]);
    const hit = ev.find((e) => e.type === "hit")!;
    expect(hit.payload).toMatchObject({ attacker: 0, move: "jab", blocked: false });
    expect(sim.f[1].hp).toBe(95);
    sim.f[0].x = -0.5;
    sim.f[1].x = 0.5;
    const ev2 = run(sim, 0.6, (t) => [{ ...NO_FIGHT_INPUT, light: t < 0.05 }, { ...NO_FIGHT_INPUT, guard: true }]);
    const h2 = ev2.find((e) => e.type === "hit")!;
    expect(h2.payload.blocked).toBe(true);
    expect(Number(h2.payload.damage)).toBeLessThan(1);
  });
  it("enchaînement direct, direct arrière, crochet, uppercut qui met au sol", () => {
    const sim = new FightSim(parseFight({ humans: 2, time: 0 }));
    run(sim, 1.8);
    sim.f[0].x = -0.43;
    sim.f[1].x = 0.43;
    // on tape en rythme : chaque appui pendant le coup en cours prépare le suivant
    const ev = run(sim, 2.6, (t) => [{ ...NO_FIGHT_INPUT, light: Math.floor(t / 0.1) % 2 === 0 }, NO_FIGHT_INPUT]);
    const moves = ev.filter((e) => e.type === "hit").map((e) => e.payload.move);
    expect(moves.slice(0, 4)).toEqual(["jab", "cross", "hook", "uppercut"]);
    expect(ev.some((e) => e.type === "hit" && e.payload.combo === 4)).toBe(true);
  });
  it("machine contre machine : manches, K.O. ou temps, fin du match", () => {
    const sim = new FightSim(parseFight({ humans: 0, rounds: 3, time: 30, level: 0.8 }));
    const ev = run(sim, 240);
    expect(ev.some((e) => e.type === "hit")).toBe(true);
    expect(ev.some((e) => e.type === "ko" || e.type === "timeout")).toBe(true);
    expect(sim.phase).toBe("over");
    expect(sim.winner === 0 || sim.winner === 1).toBe(true);
    expect(Math.max(sim.f[0].wins, sim.f[1].wins)).toBe(2);
  });
  it("le joueur contre la machine : la machine se défend et attaque", () => {
    const sim = new FightSim(parseFight({ level: 1, time: 20, rounds: 1 }));
    const ev = run(sim, 22, (t) => [{ ...NO_FIGHT_INPUT, x: 1, light: Math.floor(t / 0.15) % 2 === 0 }, NO_FIGHT_INPUT]);
    expect(ev.some((e) => e.type === "hit" && e.payload.attacker === 1)).toBe(true);
    expect(ev.some((e) => e.type === "hit" && e.payload.attacker === 0 && e.payload.blocked)).toBe(true);
  });
});
