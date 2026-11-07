import { describe, expect, it } from "vitest";
import { type V3, DEG, dist, len, m4Compose, m4Point, qAxis, sub } from "../core/math";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { character } from "../gen/character";
import { type MotionState, humanoidPose, rigInfo, stepLength, twoBoneIK } from "./locomotion";
import { type Pose, dqSkinPoint, dualQuat } from "./skeleton";

function build(params: Record<string, unknown>) {
  const issues = new Issues();
  const rng = new Rng("rig-test");
  const p = resolveParams(character.schema, params, { rng, vars: {} }, issues);
  return character.build(p, { rng, issues, path: "t" });
}

function skin(asset: ReturnType<typeof build>, pose: Pose): V3[] {
  const sk = asset.skeleton!;
  const S = sk.skinMatrices(sk.world(pose));
  const dq = S.map(dualQuat);
  const m = asset.mesh;
  const out: V3[] = [];
  for (let v = 0; v < m.vertexCount; v++) out.push(dqSkinPoint(m.getPos(v), dq, m.skin!.slice(v * 4, v * 4 + 4), m.weight!.slice(v * 4, v * 4 + 4)));
  return out;
}

describe("quaternions duaux", () => {
  it("un os seul : identique à la matrice rigide", () => {
    const M = m4Compose([0.3, 1, -0.2], qAxis([1, 2, 0.5], 1.1));
    const p: V3 = [0.1, 0.5, 0.7];
    const a = dqSkinPoint(p, [dualQuat(M)], [0, 0, 0, 0], [1, 0, 0, 0]);
    const b = m4Point(M, p);
    expect(dist(a, b)).toBeLessThan(1e-9);
  });
});

describe("personnage : peau continue et jointures", () => {
  const asset = build({ archetype: "stylized", top: "tee", bottom: "shorts", hair: "short", detail: "crowd" });
  const sk = asset.skeleton!;
  const m = asset.mesh;

  it("poids : 4 influences normalisées ; jambe gauche et jambe droite ne partagent aucun sommet", () => {
    const tl = sk.index["thigh.l"], tr = sk.index["thigh.r"], sl = sk.index["shin.l"], sr = sk.index["shin.r"];
    for (let v = 0; v < m.vertexCount; v++) {
      const w = m.weight!.slice(v * 4, v * 4 + 4);
      expect(Math.abs(w.reduce((s, x) => s + x, 0) - 1)).toBeLessThan(1e-4);
      if (Math.abs(m.pos[v * 3]) < 0.02) continue; // couture centrale de l'entrejambe
      const bones = m.skin!.slice(v * 4, v * 4 + 4).filter((_, k) => w[k] > 0.01);
      const left = bones.some((b) => b === tl || b === sl), right = bones.some((b) => b === tr || b === sr);
      expect(left && right).toBe(false);
    }
  });

  it("coudes à 120°, genoux à 110°, bras levés : pas de déchirure (99,9 % des arêtes étirées de moins de ×3)", () => {
    const rot: Pose["rot"] = {};
    for (const s of ["l", "r"]) {
      const ax = sk.axis[sk.index[`forearm.${s}`]];
      rot[`forearm.${s}`] = qAxis([ax[1] * 1 - ax[2] * 0, ax[2] * 0 - ax[0] * 1, 0].map((x, i) => (i === 0 ? ax[1] : i === 1 ? -ax[0] : 0)) as V3, 120 * DEG);
      rot[`shin.${s}`] = qAxis([1, 0, 0], 110 * DEG);
      rot[`upperarm.${s}`] = qAxis([0, 0, 1], (s === "l" ? 1 : -1) * 70 * DEG);
    }
    const posed = skin(asset, { rot, root: [0, 0, 0] });
    const ratios: number[] = [];
    let longest = 0;
    for (let t = 0; t < m.idx.length; t += 3)
      for (let k = 0; k < 3; k++) {
        const a = m.idx[t + k], b = m.idx[t + ((k + 1) % 3)];
        const r = dist(m.getPos(a), m.getPos(b));
        if (r < 1e-5) continue;
        ratios.push(dist(posed[a], posed[b]) / r);
        longest = Math.max(longest, dist(posed[a], posed[b]));
      }
    ratios.sort((x, y) => y - x);
    expect(ratios[Math.floor(ratios.length * 0.001)]).toBeLessThan(3);
    // aucune arête plus longue que 10 cm (personnage de 1,7 m, maillage « foule » de 3 cm) : pas de trou visible
    expect(longest).toBeLessThan(0.1);
  });

  it("le coude plié garde son volume (DQS : pas d'effet « papier de bonbon »)", () => {
    const fi = sk.index["forearm.l"];
    const elbow = sk.bones[fi].head;
    const near: number[] = [];
    for (let v = 0; v < m.vertexCount; v++) if (dist(m.getPos(v), elbow) < sk.bones[fi].radius[0] * 2.2) near.push(v);
    const spread = (pts: V3[]) => {
      const c = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length] as V3, [0, 0, 0] as V3);
      return pts.reduce((s, p) => s + len(sub(p, c)), 0) / pts.length;
    };
    const rest = spread(near.map((v) => m.getPos(v)));
    const ax = sk.axis[fi];
    const posed = skin(asset, { rot: { "forearm.l": qAxis([ax[1], -ax[0], 0], 120 * DEG) }, root: [0, 0, 0] });
    expect(spread(near.map((v) => posed[v])) / rest).toBeGreaterThan(0.7);
  });
});

describe("locomotion", () => {
  const asset = build({ archetype: "stylized", detail: "crowd" });
  const sk = asset.skeleton!;
  const info = rigInfo(sk);

  it("IK deux os : atteint une cible accessible, s'étire sans claquer au-delà", () => {
    const r = twoBoneIK([0, 1, 0], [0.1, 0.3, 0.2], 0.45, 0.42, [0, 0, 1]);
    expect(dist(r.end, [0.1, 0.3, 0.2])).toBeLessThan(1e-6);
    expect(dist(r.mid, [0, 1, 0])).toBeCloseTo(0.45, 6);
    const far = twoBoneIK([0, 1, 0], [0, -1, 0], 0.45, 0.42, [0, 0, 1]);
    expect(dist(far.end, [0, 1, 0])).toBeLessThanOrEqual(0.87 + 1e-9);
    expect(far.reach).toBeLessThan(1);
  });

  it("marche : le pied en appui ne glisse pas (avance par distance parcourue)", () => {
    const speed = 1.3;
    const stride = 2 * stepLength(info, speed);
    const dt = 1 / 60;
    let d = 0;
    const track: { u: number; ankle: V3 }[] = [];
    for (let i = 0; i < 180; i++) {
      const phase = d / stride;
      const st: MotionState = { speed, phase, time: i * dt, action: "idle", actionTime: 0, actionWeight: 0, mood: "neutral", turn: 0, seed: 1 };
      const { pose } = humanoidPose(sk, info, st, [0, 0, d], 0);
      const W = sk.world(pose);
      track.push({ u: ((phase % 1) + 1) % 1, ankle: sk.tailOf(W, "shin.l") });
      d += speed * dt;
    }
    // milieu d'appui (u ∈ [0.15, 0.45]) : la cheville gauche reste quasi immobile au sol
    const stance = track.filter((t) => t.u > 0.15 && t.u < 0.45).map((t) => t.ankle);
    let slide = 0;
    for (let i = 1; i < stance.length; i++) if (dist(stance[i], stance[i - 1]) < 0.2) slide = Math.max(slide, Math.abs(stance[i][2] - stance[i - 1][2]));
    expect(stance.length).toBeGreaterThan(10);
    expect(slide).toBeLessThan(0.012);
  });
});
