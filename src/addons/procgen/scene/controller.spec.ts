import { describe, expect, it } from "vitest";
import { type CtrlWorld, NO_CTRL, PLATFORM_BASE, ctrlPose, newCtrlState, parseCtrl, parsePlatformer, platformerLevel, platformerRecipe, stepCtrl } from "./controller";
import { matches } from "../render/controller";

/** Monde de test : sol à 0, une caisse de 1 m (x ∈ [3, 4]), un mur haut en x = 8, un trou en x ∈ [12, 14]. */
const world: CtrlWorld = {
  ground(x, _z, feet, stepUp) {
    // le fond du trou est très bas ; hors du trou, le sol n'est un appui que si l'on n'est pas déjà dessous
    let y = (x > 12 && x < 14) || feet + stepUp < -0.01 ? -20 : 0;
    if (x >= 3 && x <= 4 && 1 <= feet + stepUp) y = 1;
    return { y, on: y === 1 ? "caisse" : null };
  },
  blocked(x, _z, feet, stepUp) {
    if (x >= 3 && x <= 4 && 1 > feet + stepUp) return true;
    if (!(x > 12 && x < 14) && feet < -0.1) return true;
    return x >= 8 && x <= 8.5;
  },
};
const spec = parseCtrl({ actor: "heros", plane: "x", lane: 0, killY: -5 })!;
const run = (st: ReturnType<typeof newCtrlState>, inp: Partial<typeof NO_CTRL>, s: number, sp = spec) => {
  const ev: string[] = [];
  for (let i = 0; i < Math.round(s * 60); i++) for (const e of stepCtrl(sp, st, { ...NO_CTRL, ...inp, jumpEdge: i === 0 && !!inp.jumpEdge }, 1 / 60, world)) ev.push(e.type);
  return ev;
};

describe("contrôleur : réglages", () => {
  it("acteur requis, valeurs par défaut, caméra selon le plan", () => {
    expect(parseCtrl({})).toBeNull();
    expect(parseCtrl({ actor: "a" })).toMatchObject({ plane: "free", camera: "third", jump: 1.6, jumps: 1, fire: false });
    expect(parseCtrl({ actor: "a", plane: "x" })!.camera).toBe("side");
    expect(parseCtrl({ actor: "a", camera: "first" })!.fire).toBe(true);
    expect(parseCtrl({ actor: "a", jumps: 9, gravity: -3 })).toMatchObject({ jumps: 3, gravity: 2 });
  });
  it("motifs de ramassage", () => {
    const o = { id: "piece3", layer: "piece3", generator: "assembly" };
    expect(matches("piece*", o)).toBe(true);
    expect(matches("piece3", o)).toBe(true);
    expect(matches("assembly", o)).toBe(true);
    expect(matches("cle", o)).toBe(false);
  });
});

describe("contrôleur : mouvement", () => {
  it("court, s'arrête contre un mur, saute par-dessus une caisse", () => {
    const st = newCtrlState(0, 0, 0, 0);
    run(st, { x: -1, run: true }, 0.5);
    expect(st.pos[0]).toBeLessThan(-1);
    expect(st.yaw).toBeCloseTo(-Math.PI / 2, 1);
    // contre la caisse sans sauter : arrêté devant
    const s2 = newCtrlState(0, 0, 0, 0);
    run(s2, { x: 1, run: true }, 2);
    expect(s2.pos[0]).toBeLessThan(3);
    // avec un saut : monte sur la caisse
    const s3 = newCtrlState(2.3, 0, 0, 0);
    const ev = run(s3, { x: 0.5, run: true, jump: true, jumpEdge: true }, 0.52);
    run(s3, {}, 0.4);
    expect(ev).toContain("jump");
    expect(ev).toContain("land");
    expect(s3.pos[1]).toBe(1);
    expect(s3.on).toBe("caisse");
  });
  it("hauteur de saut réglée par la durée d'appui", () => {
    const peak = (hold: number) => {
      const st = newCtrlState(-5, 0, 0, 0);
      let top = 0;
      for (let i = 0; i < 90; i++) {
        stepCtrl(spec, st, { ...NO_CTRL, jump: i < hold, jumpEdge: i === 0 }, 1 / 60, world);
        top = Math.max(top, st.pos[1]);
      }
      return top;
    };
    expect(Math.abs(peak(60) - 1.6)).toBeLessThan(0.12);
    expect(peak(4)).toBeLessThan(1);
  });
  it("double saut et tolérance au bord", () => {
    const sp = { ...spec, jumps: 2 };
    const st = newCtrlState(-5, 0, 0, 0);
    stepCtrl(sp, st, { ...NO_CTRL, jump: true, jumpEdge: true }, 1 / 60, world);
    for (let i = 0; i < 20; i++) stepCtrl(sp, st, { ...NO_CTRL, jump: true }, 1 / 60, world);
    const y1 = st.pos[1];
    const ev = stepCtrl(sp, st, { ...NO_CTRL, jump: true, jumpEdge: true }, 1 / 60, world);
    expect(ev.map((e) => e.type)).toContain("jump");
    for (let i = 0; i < 20; i++) stepCtrl(sp, st, { ...NO_CTRL, jump: true }, 1 / 60, world);
    expect(st.pos[1]).toBeGreaterThan(y1);
  });
  it("tombe dans un trou, revient au dernier point sûr", () => {
    const st = newCtrlState(10, 0, 0, 0);
    const ev = run(st, { x: 1, run: true }, 1.05);
    run(st, {}, 0.5);
    expect(ev).toContain("fall");
    expect(ev).toContain("respawn");
    expect(st.pos[1]).toBe(0);
    expect(st.pos[0]).toBeLessThan(12.5);
  });
  it("allure affichée", () => {
    const st = newCtrlState(0, 0, 0, 0);
    expect(ctrlPose(st).action).toBe("idle");
    run(st, { x: -1, run: true }, 0.6);
    expect(ctrlPose(st).action).toBe("run");
  });
});

describe("niveau de plateformes", () => {
  it("sauts faisables, pièces au-dessus du vide ou des plateformes, recette et réglages", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const L = platformerLevel(parsePlatformer({ seed, length: 160 }));
      const grounds = L.blocks.filter((b) => b.kind !== "crate").sort((a, b) => a.x - b.x);
      for (let i = 1; i < grounds.length; i++) {
        const gap = grounds[i].x - (grounds[i - 1].x + grounds[i - 1].w);
        expect(gap).toBeLessThan(3.4);
        expect(grounds[i].h - grounds[i - 1].h).toBeLessThan(1.7);
      }
      expect(L.goal).toBeGreaterThan(60);
    }
    const { recipe, player } = platformerRecipe(parsePlatformer({ seed: 2 }));
    expect(player).toMatchObject({ actor: "heros", plane: "x", camera: "side", killY: PLATFORM_BASE - 0.8 });
    expect((recipe.actors as Record<string, unknown>).heros).toBeTruthy();
    expect((recipe.layers as { id: string }[]).some((l) => l.id.startsWith("piece"))).toBe(true);
  });
});
