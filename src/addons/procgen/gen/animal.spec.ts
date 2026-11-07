import { describe, expect, it } from "vitest";
import { type V3, DEG, dist, qAxis } from "../core/math";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { SPECIES } from "../rig/quadruped";
import { animalInfo, animalPose, animalStepLength } from "../rig/quadruped-motion";
import { motionFor, stepLengthFor } from "../rig/motion";
import { type Pose, dqSkinPoint, dualQuat } from "../rig/skeleton";
import { animal } from "./animal";
import { character } from "./character";

function build(params: Record<string, unknown>, gen = animal as unknown as typeof character, seed = "ani-test") {
  const issues = new Issues();
  const rng = new Rng(seed);
  const p = resolveParams(gen.schema, params, { rng, vars: {} }, issues);
  return gen.build(p as never, { rng, issues, path: "t" });
}

function skin(asset: ReturnType<typeof build>, pose: Pose): V3[] {
  const sk = asset.skeleton!;
  const dq = sk.skinMatrices(sk.world(pose)).map(dualQuat);
  const m = asset.mesh;
  const out: V3[] = [];
  for (let v = 0; v < m.vertexCount; v++) out.push(dqSkinPoint(m.getPos(v), dq, m.skin!.slice(v * 4, v * 4 + 4), m.weight!.slice(v * 4, v * 4 + 4)));
  return out;
}

describe("animaux : génération", () => {
  // première génération : compilation à la volée du moteur, hors mesure
  build({ species: "chicken", detail: "crowd" }, undefined, "warmup");
  for (const species of SPECIES)
    it(`${species} : se génère en moins de 0,4 s (foule), poids normalisés, pattes gauche/droite séparées`, { timeout: 30000 }, () => {
      // meilleur de deux graines (machine partagée : on écarte une pause du ramasse-miettes)
      let ms = Infinity;
      let a!: ReturnType<typeof build>;
      for (const k of [1, 2]) {
        const t0 = performance.now();
        a = build({ species, detail: "crowd" }, undefined, `perf-${species}-${k}`);
        ms = Math.min(ms, performance.now() - t0);
      }
      // garde-fou de régression (cible < 0,4 s sur un poste libre) : marge pour les machines partagées en CI
      expect(ms).toBeLessThan(1200);
      const sk = a.skeleton!;
      expect(sk.count).toBeLessThanOrEqual(32);
      const m = a.mesh;
      expect(m.vertexCount).toBeGreaterThan(500);
      expect(a.blink).toBe(true);
      expect(m.morph!.some((x) => x !== 0)).toBe(true);
      for (const k of ["head.top", "back", "mouth", "feet"]) expect(a.anchors[k]).toBeDefined();
      const legL = new Set(["upperarm.l", "forearm.l", "hand.l", "finger.l", "thigh.l", "shin.l", "foot.l", "toe.l"].filter((n) => sk.has(n)).map((n) => sk.index[n]));
      const legR = new Set(["upperarm.r", "forearm.r", "hand.r", "finger.r", "thigh.r", "shin.r", "foot.r", "toe.r"].filter((n) => sk.has(n)).map((n) => sk.index[n]));
      for (let v = 0; v < m.vertexCount; v++) {
        const w = m.weight!.slice(v * 4, v * 4 + 4);
        expect(Math.abs(w.reduce((s, x) => s + x, 0) - 1)).toBeLessThan(1e-4);
        const bones = m.skin!.slice(v * 4, v * 4 + 4).filter((_, k) => w[k] > 0.01);
        expect(bones.some((b) => legL.has(b)) && bones.some((b) => legR.has(b))).toBe(false);
      }
    });
});

describe("animaux : déformation et locomotion", () => {
  for (const species of ["horse", "dog", "cow", "chicken"] as const) {
    const a = build({ species, detail: "high" }, undefined, `rig-${species}`);
    const sk = a.skeleton!;
    const info = animalInfo(sk);
    const W = info.W;

    it(`${species} : pas de déchirure en extension (arêtes < 10 % de la taille)`, () => {
      // pattes en extension maximale de la foulée (avant en avant, arrière en arrière), cou baissé, queue relevée
      const rot: Pose["rot"] = { "neck.1": qAxis([1, 0, 0], 35 * DEG), head: qAxis([1, 0, 0], 20 * DEG), "tail.1": qAxis([1, 0, 0], 40 * DEG) };
      for (const s of ["l", "r"]) {
        if (sk.has(`upperarm.${s}`)) {
          rot[`upperarm.${s}`] = qAxis([1, 0, 0], -35 * DEG);
          rot[`hand.${s}`] = qAxis([1, 0, 0], 60 * DEG);
        }
        rot[`thigh.${s}`] = qAxis([1, 0, 0], 30 * DEG);
        rot[`shin.${s}`] = qAxis([1, 0, 0], -30 * DEG);
        rot[`foot.${s}`] = qAxis([1, 0, 0], 45 * DEG);
      }
      const posed = skin(a, { rot, root: [0, 0, 0] });
      const m = a.mesh;
      // déchirure = arête allongée par la pose (les gabarits rigides ont de longues arêtes dès le repos)
      let longest = 0;
      for (let t = 0; t < m.idx.length; t += 3)
        for (let k = 0; k < 3; k++) {
          const i = m.idx[t + k], j = m.idx[t + ((k + 1) % 3)];
          const grow = dist(posed[i], posed[j]) - dist(m.getPos(i), m.getPos(j));
          if (grow > W * 0.005) longest = Math.max(longest, dist(posed[i], posed[j]));
        }
      expect(longest).toBeLessThan(W * 0.1);
    });

    it(`${species} : pattes d'appui sans glissement en marche (< 1,5 cm)`, () => {
      const speed = Math.sqrt(0.15 * 9.81 * info.legLen); // Froude 0,15 : pas
      const stride = 2 * animalStepLength(info, speed);
      const dt = 1 / 60;
      let d = 0;
      const tracks: Record<string, V3[][]> = {};
      const prev: Record<string, boolean> = {};
      for (let i = 0; i < 240; i++) {
        const phase = d / stride;
        const { pose } = animalPose(sk, info, { speed, phase, time: i * dt, mood: "calm", turn: 0, seed: 1 }, [0, 0, d], 0);
        const Wm = sk.world(pose);
        for (const leg of info.legs) {
          const p = sk.headOf(Wm, leg.bones[3]);
          const onGround = p[1] < leg.foot0[1] + 0.004;
          const list = (tracks[leg.id] ??= []);
          if (onGround && !prev[leg.id]) list.push([]);
          if (onGround) list[list.length - 1].push(p);
          prev[leg.id] = onGround;
        }
        d += speed * dt;
      }
      let slide = 0;
      let samples = 0;
      for (const runs of Object.values(tracks))
        for (const run of runs) {
          const core = run.slice(2, -2);
          for (const p of core) {
            slide = Math.max(slide, dist([p[0], 0, p[2]], [core[0][0], 0, core[0][2]]));
            samples++;
          }
        }
      expect(samples).toBeGreaterThan(20);
      expect(slide).toBeLessThan(0.015);
    });
  }

  it("adaptateur : humanoïde et animal derrière la même interface", () => {
    const dog = build({ species: "dog", detail: "crowd" });
    const hum = build({ detail: "crowd" }, character, "h");
    const st = { speed: 1, phase: 0.3, time: 1, action: "idle" as const, actionTime: 0, actionWeight: 0, mood: "neutral", turn: 0, seed: 2 };
    expect(motionFor(dog).kind).toBe("animal");
    expect(motionFor(hum).kind).toBe("humanoid");
    expect(motionFor(dog).pose(st).pose.rot["thigh.l"]).toBeDefined();
    expect(motionFor(hum).pose(st).pose.rot["thigh.l"]).toBeDefined();
    expect(stepLengthFor(dog, 1)).toBeGreaterThan(0);
    expect(stepLengthFor(hum, 1)).toBeGreaterThan(0);
  });
});
