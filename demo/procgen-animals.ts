/**
 * Banc visuel des animaux (démo seulement) : `ProcgenView` n'anime que des humanoïdes, on remplace localement sa pose
 * d'acteur par l'adaptateur `rig/motion.ts` (même DQS que `poseActor`).
 *
 * ?species=dog,cat|all &mode=idle|walk|trot|gallop &speed=… &seq=N (N poses d'un cycle côte à côte) &phase=…
 * &coat=… &mood=… &camera=side|iso… &zoom … &t=…
 */
import { composeScene } from "../src/addons/procgen/scene/compose";
import { resolveStyle } from "../src/addons/procgen/style/style";
import { ProcgenView } from "../src/addons/procgen/render/view";
import { SPECIES, ANIMAL_PROPS } from "../src/addons/procgen/rig/quadruped";
import { motionFor } from "../src/addons/procgen/rig/motion";
import { dualQuat } from "../src/addons/procgen/rig/skeleton";
import { MAX_BONES } from "../src/addons/procgen/render/shaders";

const q = new URLSearchParams(location.search);
const list = (q.get("species") ?? "all") === "all" ? [...SPECIES] : q.get("species")!.split(",");
const seq = Number(q.get("seq") ?? 0);
const mode = q.get("mode") ?? "idle";
const params: Record<string, unknown> = {};
for (const k of ["coat", "mood", "palette", "variant", "size", "build", "detail"]) if (q.get(k) !== null) params[k] = isNaN(Number(q.get(k))) ? q.get(k) : Number(q.get(k));
const actors: Record<string, unknown> = {};
const sizeOf = (s: string) => {
  const p = (ANIMAL_PROPS as Record<string, { kind: string; W?: number; H?: number; bodyLen?: number }>)[s];
  return p.kind === "bird" ? 0.55 : (p.W ?? 1) * 1.9;
};
let x = 0;
const entries = seq ? Array.from({ length: seq }, (_, i) => ({ s: list[0], i })) : list.map((s, i) => ({ s, i }));
const gap = Number(q.get("gap") ?? 0.25);
const xs: number[] = [];
for (const e of entries) {
  const w = sizeOf(e.s);
  xs.push(x + w / 2);
  x += w + gap;
}
const total = x - gap;
const rows = Number(q.get("rows") ?? 1);
entries.forEach((e, i) => {
  const vary = q.get("vary") ? { seedKey: i } : {};
  actors[`a${i}`] = { gen: "animal", params: { species: e.s, detail: "high", ...params, ...vary }, at: [xs[i] - total / 2, rows > 1 ? (i % rows) * 2 - rows : 0], facing: Number(q.get("facing") ?? 90) };
});
const recipe = q.get("recipe") ? JSON.parse(q.get("recipe")!) : { size: [Math.max(12, total + 4), 8], ground: q.get("ground") === "1" ? { surface: "grass" } : false, actors, view: { camera: q.get("camera") ?? "side" } };
const t0 = performance.now();
const model = composeScene({ recipe: recipe as never, seed: q.get("seed") ?? 1 });
const ms = performance.now() - t0;
const view = new ProcgenView(document.getElementById("c") as HTMLCanvasElement);
view.dpr = 1;
view.maxDpr = 1;
// pose d'acteur remplacée : adaptateur humanoïde / animal
const V = view as unknown as { poseActor: (a: any, dt: number) => void; time: number };
const speeds: Record<string, number> = {};
V.poseActor = function (this: any, a: any, dt: number) {
  const asset = a.model.asset;
  const mo = motionFor(asset);
  const i = Number(String(a.model.id).slice(1));
  const L = mo.legLength;
  const fr = { idle: 0, walk: 0.15, trot: 0.9, gallop: 3.2 }[mode] ?? 0;
  const scene = !!q.get("recipe");
  const sp = scene ? a.speed : q.get("speed") ? Number(q.get("speed")) : Math.sqrt(fr * 9.81 * L);
  // recette : phase intégrée par la distance parcourue, avec le pas propre au squelette (adaptateur)
  a._ph = (a._ph ?? Math.random()) + (scene ? (sp * dt) / (2 * mo.stepLength(Math.max(sp, 0.05))) : 0);
  speeds[a.model.id] = sp;
  const time = (this.time ?? 0) + Number(q.get("t0") ?? 0);
  const phase = scene ? a._ph : seq ? i / seq + Number(q.get("phase") ?? 0) : q.get("phase") ? Number(q.get("phase")) : sp > 0 ? (time * sp) / (2 * mo.stepLength(sp)) : 0;
  const st = { speed: sp, phase, time: time + (seq ? 0 : a.model.seed), action: "idle", actionTime: 0, actionWeight: 0, mood: String(a.model.params.mood ?? "calm"), turn: 0, seed: a.model.seed };
  const { pose } = q.get("rest") ? { pose: { rot: {}, root: [0, 0, 0] as [number, number, number] } } : mo.pose(st as never);
  const sk = asset.skeleton;
  const W = sk.world(pose);
  a.mesh.userData.world = W;
  const S = sk.skinMatrices(W);
  const arr = a.mats.uniforms.uDQ.value;
  for (let k = 0; k < Math.min(S.length, MAX_BONES); k++) {
    const [r, d] = dualQuat(S[k]);
    arr[k * 2].set(r[0], r[1], r[2], r[3]);
    arr[k * 2 + 1].set(d[0], d[1], d[2], d[3]);
  }
  a.mesh.position.set(a.pos[0], a.pos[1], a.pos[2]);
  a.mesh.rotation.set(0, a.yaw, 0);
  a.mesh.updateMatrix();
};
const scene0 = !!q.get("recipe");
view.setModel(model);
view.setStyle(resolveStyle(q.get("style") ?? "gouache"));
const v: Record<string, unknown> = scene0 ? { ...(model.view ?? {}) } : { camera: q.get("camera") ?? "side", cy: Number(q.get("cy") ?? 0.6) };
if (scene0 && q.get("camera")) v.camera = q.get("camera");
for (const k of ["yaw", "pitch", "zoom", "cx", "cy", "cz"]) if (q.get(k) !== null) v[k] = Number(q.get(k));
view.setView(v);
view.setAnim({ play: q.get("play") !== "0" });
(window as any).__view = view;
const wait = Number(q.get("t") ?? 1.5);
setTimeout(() => {
  view.render();
  (window as any).__stats = { compose: Math.round(ms), ...view.stats(), ...model.stats, issues: model.issues.slice(0, 8) };
  (window as any).__ready = true;
}, wait * 1000);
