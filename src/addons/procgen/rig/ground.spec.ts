import { describe, expect, it } from "vitest";
import { composeScene } from "../scene/compose";
import { humanoidPose, rigInfo } from "./locomotion";
import type { Skeleton } from "./skeleton";

/** Hauteur au-dessus du sol de la semelle (sommets du pied et des orteils, skinning linéaire), par pied. */
function soles(arch: string, speed: number, phase: number, ground?: (x: number, z: number) => number) {
  const c = composeScene({ recipe: { size: [6, 6], actors: { a: { params: { archetype: arch, age: "adult", hat: "none", item: "none", shoes: "shoes" }, at: [0, 0] } } }, seed: 1 });
  const a = c.actors[0].asset as unknown as { skeleton: Skeleton; mesh: { vertexCount: number; pos: ArrayLike<number>; skin: ArrayLike<number>; weight: ArrayLike<number> } };
  const sk = a.skeleton, m = a.mesh;
  const info = rigInfo(sk);
  const { pose } = humanoidPose(sk, info, { speed, phase, time: 3, action: "idle", actionTime: 0, actionWeight: 0, mood: "neutral", turn: 0, seed: 7, ground }, [0, 0, 0], 0);
  const S = sk.skinMatrices(sk.world(pose));
  const out: Record<string, number> = {};
  for (const s of ["l", "r"]) {
    const ids = [sk.index[`foot.${s}`], sk.index[`toe.${s}`]];
    let min = Infinity;
    for (let v = 0; v < m.vertexCount; v++) {
      let wf = 0;
      for (let k = 0; k < 4; k++) if (ids.includes(m.skin[v * 4 + k])) wf += m.weight[v * 4 + k];
      if (wf < 0.5) continue;
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < 4; k++) {
        const w = m.weight[v * 4 + k];
        if (!w) continue;
        const M = S[m.skin[v * 4 + k]];
        const px = m.pos[v * 3], py = m.pos[v * 3 + 1], pz = m.pos[v * 3 + 2];
        x += w * (M[0] * px + M[4] * py + M[8] * pz + M[12]);
        y += w * (M[1] * px + M[5] * py + M[9] * pz + M[13]);
        z += w * (M[2] * px + M[6] * py + M[10] * pz + M[14]);
      }
      min = Math.min(min, y - (ground ? ground(x, z) : 0));
    }
    out[s] = min;
  }
  return out;
}

describe("pieds au sol", () => {
  it("la semelle touche le sol en appui (talon, plat, poussée) et ne passe jamais dessous", { timeout: 120000 }, () => {
    for (const arch of ["realistic", "cartoon"])
      for (const speed of [0, 1.3, 3.5, 6])
        for (let i = 0; i < 8; i++) {
          const h = soles(arch, speed, i / 8);
          // au moins un pied posé (sauf en vol, à la course) : à moins de 1 cm ; aucun sous le sol de plus de 6 mm
          const low = Math.min(h.l, h.r);
          expect(low, `${arch} ${speed} ${i}`).toBeGreaterThan(-0.006);
          if (speed < 2) expect(low, `${arch} ${speed} ${i}`).toBeLessThan(0.01);
        }
  });
  it("en pente, chaque pied se pose sur le sol à sa place", { timeout: 60000 }, () => {
    const slope = (_x: number, z: number) => z * 0.25;
    for (let i = 0; i < 8; i++) {
      const h = soles("realistic", 1.3, i / 8, slope);
      expect(Math.min(h.l, h.r), `${i}`).toBeGreaterThan(-0.008);
      expect(Math.min(h.l, h.r), `${i}`).toBeLessThan(0.015);
    }
  });
});
