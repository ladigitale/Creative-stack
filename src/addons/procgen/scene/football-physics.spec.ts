import { describe, expect, it } from "vitest";
import { FootballMatch, parseFootball } from "./football";
import { BALL_R, type Collider, type Flight, aimShot, bodyColliders, collide, flightPath, flightStep, goalColliders } from "./football-physics";

const fly = (p: [number, number, number], v: [number, number, number], curl = 0): Flight => ({ p, v, curl });

/** Vol avec obstacles : sous-pas de 0,005 s, contacts avec les colliders donnés. */
function simulate(f: Flight, cols: Collider[], seconds: number) {
  const hits: string[] = [];
  for (let t = 0; t < seconds; t += 0.005) {
    flightStep(f, 0.005);
    for (const c of cols) {
      const h = collide(f, c);
      if (h) hits.push(c.part);
    }
  }
  return hits;
}

describe("physique du football", () => {
  const L = 60, gw = 5, gh = 2;
  const goal = goalColliders(L / 2, gw, gh);

  it("un tir sur le poteau rebondit, il ne le traverse pas", () => {
    // poteau en z = gw/2 + 0,06 ; tir rasant droit dessus, sur sa hauteur
    const f = fly([L / 2 - 6, 1, gw / 2 + 0.06], [20, 0, 0]);
    const hits = simulate(f, goal, 0.6);
    expect(hits).toContain("post");
    expect(f.v[0]).toBeLessThan(0);
    expect(f.p[0]).toBeLessThan(L / 2);
  });

  it("sous la transversale, le ballon redescend ; au-dessus, il passe", () => {
    const under = fly([L / 2 - 5, gh - 0.3, 0], [18, 3, 0]);
    expect(simulate(under, goal, 0.5)).toContain("bar");
    const over = fly([L / 2 - 5, gh + 0.6, 0], [18, 1, 0]);
    expect(simulate(over, goal, 0.5)).toEqual([]);
  });

  it("une main qui plonge chasse le ballon dans son sens (vitesse du membre comprise)", () => {
    const hand: Collider = { a: [0, 1, 0], b: [0, 1, 0], r: 0.13, v: [0, 0, 6], part: "hand", e: 0.45, mu: 0.25 };
    const f = fly([-0.5, 1, 0.05], [15, 0, 0]);
    let hit = null;
    for (let i = 0; i < 40 && !hit; i++) {
      flightStep(f, 0.002);
      hit = collide(f, hand);
    }
    expect(hit?.part).toBe("hand");
    expect(f.v[0]).toBeLessThan(0);
    expect(f.v[2]).toBeGreaterThan(1);
  });

  it("la visée tient compte de la traînée et de l'effet : le tir arrive où l'on vise", () => {
    for (const curl of [-3, 0, 2.5]) {
      const from: [number, number, number] = [0, BALL_R + 0.02, 3];
      const target: [number, number, number] = [22, 1.6, -2];
      const v = aimShot(from, target, 26, curl);
      const path = flightPath(fly([...from], v, curl), 0.002, 1000);
      const at = path.find((q) => q[0] >= target[0])!;
      expect(Math.abs(at[2] - target[2])).toBeLessThan(0.15);
      expect(Math.abs(at[1] - target[1])).toBeLessThan(0.15);
    }
  });

  it("le gardien en plongeon a ses mains au bout de son allonge, du côté du plongeon, à la hauteur du corps", () => {
    const cols = bodyColliders({ pos: [0, 0], vel: [0, 3], yaw: Math.PI / 2, lift: 1.2, dive: 0.5, diveDir: -1, reach: 0.7, keeper: true, down: 0 });
    const hands = cols.filter((c) => c.part === "hand");
    expect(hands.length).toBeGreaterThan(0);
    const tip = hands[hands.length - 1].a;
    // yaw = π/2 (face à +x) : latéral (0, −1)·diveDir = +z
    expect(tip[2]).toBeGreaterThan(0.8);
    expect(tip[1]).toBeGreaterThan(1.2);
  });

  it("un tir au-dessus de la transversale n'est pas un but (il n'est pas ramené dans les filets)", () => {
    const m = new FootballMatch(parseFootball({ players: 5, minutes: 2, human: "none", seed: 2 }));
    for (let k = 0; k < 30 * 6 && m.phase !== "play"; k++) m.step(1 / 30);
    const { L } = (m as unknown as { dim: { L: number } }).dim;
    // gardiens écartés : seul compte le vol du ballon
    for (const p of m.players) if (p.role === "gk") p.pos = [0, 15];
    Object.assign(m.ball, { p: [L / 2 - 4, 2.7, 0], v: [22, 0.6, 0], owner: -1, curl: 0 });
    const ev: string[] = [];
    for (let k = 0; k < 30; k++) {
      m.step(1 / 30);
      ev.push(...m.events.map((e) => e.type));
      m.events.length = 0;
    }
    expect(ev).not.toContain("goal");
  });

  it("des matchs entiers : des arrêts ET des buts, sans tirage au sort de l'arrêt", { timeout: 240000 }, () => {
    let saves = 0, caught = 0, goals = 0, shots = 0, posts = 0;
    for (const seed of [1, 2, 3, 4]) {
      const m = new FootballMatch(parseFootball({ players: 7, minutes: 6, human: "none", seed }));
      for (let k = 0; k < 30 * 60 * 9 && m.phase !== "fulltime"; k++) {
        m.step(1 / 30);
        for (const e of m.events) {
          if (e.type === "save") {
            saves++;
            if (e.payload.caught) caught++;
          }
          if (e.type === "goal") goals++;
          if (e.type === "shot") shots++;
          if (e.type === "post") posts++;
        }
        m.events.length = 0;
      }
    }
    if (process.env.FOOT_LOG) console.log({ shots, saves, caught, goals, posts });
    expect(shots).toBeGreaterThan(10);
    expect(saves).toBeGreaterThan(2);
    expect(goals).toBeGreaterThan(1);
    // ni passoire ni mur
    expect(goals).toBeLessThan(shots * 0.7);
    expect(saves).toBeLessThan(shots * 0.9);
  });
});
