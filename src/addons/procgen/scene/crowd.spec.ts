import { describe, expect, it } from "vitest";
import type { V3 } from "../core/math";
import { actorRadius, separate, slideStep, steerAround } from "./crowd";

const mk = (id: string, x: number, z: number) => ({ pos: [x, 0, z] as V3, mo: { legLength: 0.85 }, model: { id, seed: id.length }, yaw: 0 });

describe("foule : personne ne se traverse", () => {
  it("deux marcheurs face à face se croisent sans se chevaucher", () => {
    const a = mk("a", 0, -4), b = mk("b", 0.02, 4);
    const R = actorRadius(a) + actorRadius(b);
    let minD = Infinity;
    for (let k = 0; k < 300; k++) {
      for (const [p, goal] of [[a, 6], [b, -6]] as const) {
        const dz = goal - p.pos[2];
        if (Math.abs(dz) < 0.1) continue;
        const st = steerAround(p, [a, b], 0, Math.sign(dz));
        p.pos[0] += st.vx * 1.3 * st.slow / 30;
        p.pos[2] += st.vz * 1.3 * st.slow / 30;
      }
      separate([a, b], () => true, () => false, () => {});
      minD = Math.min(minD, Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]));
    }
    expect(minD).toBeGreaterThan(R * 0.98);
    // ils sont bien passés l'un à côté de l'autre
    expect(a.pos[2]).toBeGreaterThan(3);
    expect(b.pos[2]).toBeLessThan(-3);
  });

  it("une foule tassée se desserre ; l'assis ne bouge pas ; rien n'entre dans un obstacle", () => {
    const L = Array.from({ length: 30 }, (_, i) => mk(`p${i}`, (i % 6) * 0.1, Math.floor(i / 6) * 0.1));
    const wall = (x: number) => x > 1.5;
    const seated = L[0];
    const s0 = [...seated.pos];
    for (let k = 0; k < 60; k++) separate(L, (x) => !wall(x), (p) => p === seated, () => {});
    expect(seated.pos).toEqual(s0);
    for (const p of L) expect(wall(p.pos[0])).toBe(false);
    let worst = Infinity;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) worst = Math.min(worst, Math.hypot(L[i].pos[0] - L[j].pos[0], L[i].pos[2] - L[j].pos[2]));
    expect(worst).toBeGreaterThan(actorRadius(L[0]) * 2 * 0.9);
  });

  it("un pas contre un mur glisse le long", () => {
    const p: V3 = [0, 0, 0];
    expect(slideStep(p, 0.1, 0.1, (x) => x <= 0)).toBe(true);
    expect(p[0]).toBe(0);
    expect(p[2]).toBeCloseTo(0.1);
  });
});
