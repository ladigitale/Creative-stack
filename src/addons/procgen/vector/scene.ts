/**
 * Génération des formes d'une scène vectorielle : ciel et lointain, bandes de sol, voirie, eau, ombres portées,
 * objets (dessinateurs par générateur, repli générique) et personnages posés.
 *
 * Les formes statiques sont calculées une fois par (modèle, caméra, nuit) et triées ; les formes animées (feux,
 * personnages) sont recalculées à chaque image et fusionnées par ordre de dessin.
 */
import type { V3 } from "../core/math";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { GENERATORS } from "../gen/index";
import type { Skeleton } from "../rig/skeleton";
import type { M4 } from "../core/math";
import type { ObjectInfo, SceneModel } from "../scene/compose";
import { drawBuilding } from "./draw/building";
import { drawCharacter } from "./draw/character";
import { drawAnimal } from "./draw/animal";
import { AnimalSkeleton } from "../rig/quadruped";
import { bandsOf, drawGround, drawSky } from "./draw/ground";
import { Emitter, Frame, Kit, lightDir } from "./draw/kit";
import { drawBush, drawFlowers, drawGrass, drawRock, drawTree, natureShadow } from "./draw/nature";
import { drawEmblem, drawGeneric, drawProp } from "./draw/props";
import { drawVehicle, drawWall } from "./draw/fences";
import { drawPlant } from "./draw/more";
import { drawBall } from "./draw/ball";
import { drawAssembly, drawContainer, drawPet, drawSeat, drawStreet, drawTool } from "./draw/parts";
import type { DrawEnv, ObjectDrawer } from "./draw/types";
import { type VectorCamera, Projector } from "./project";
import type { Shape } from "./shape";
import { type Plan, buildPlan } from "./buildplan";
import { VECTOR_META } from "./compose";
import { hash32 } from "../core/rng";

export const DRAWERS: Record<string, ObjectDrawer> = { building: drawBuilding, tree: drawTree, bush: drawBush, grass: drawGrass, flowers: drawFlowers, rock: drawRock, prop: drawProp, emblem: drawEmblem, wall: drawWall, vehicle: drawVehicle, plant: drawPlant, ball: drawBall, seat: drawSeat, assembly: drawAssembly, tool: drawTool, container: drawContainer, street: drawStreet, pet: drawPet };

/** Générateurs dessinés par gabarit (même dessin pour mêmes paramètres : végétation, rochers). */
const TEMPLATED = new Set(["tree", "bush", "grass", "rock", "plant"]);
const TEMPLATES = new Map<string, Shape[]>();

/** Objets dont le dessin dépend du temps (redessinés à chaque image). */
const ANIMATED = (o: ObjectInfo, p: Record<string, unknown>) => (o.generator === "prop" && (p.kind === "campfire" || p.kind === "boat")) || o.generator === "ball";

/** Ballon en mouvement : centre et rotation courants (simulation `BallWorld`). */
export type BallPose = { center: V3; spin: [number, number, number, number] };

export type ActorPose = { id: string; obj: number; sk: Skeleton; W: M4[]; pos: V3; yaw: number; params: Record<string, unknown>; blink: number; speed: number; hidden?: boolean; /** Assis sur une assise : ordonné par ses genoux (devant ou derrière le dossier). */ seated?: boolean; colors?: Record<string, string> };

export type ViewOpts = { camera: VectorCamera; lift?: number; angle?: number; k?: number };

/** Paramètres résolus (valeurs par défaut comprises) de chaque objet, retrouvés dans les clés d'instances. */
export function objectParams(model: SceneModel): Map<number, Record<string, unknown>> {
  const out = new Map<number, Record<string, unknown>>();
  for (const g of model.instances) {
    const i = g.key.indexOf("|");
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(g.key.slice(i + 1));
    } catch {
      parsed = null;
    }
    if (parsed) for (const obj of g.objs) out.set(obj, parsed);
  }
  const issues = new Issues();
  for (const o of model.objects) {
    if (out.has(o.obj)) continue;
    const gen = GENERATORS[o.generator];
    if (!gen) {
      out.set(o.obj, { ...o.params });
      continue;
    }
    out.set(o.obj, resolveParams(gen.schema, o.params, { rng: new Rng(o.id), vars: {} }, issues) as Record<string, unknown>);
  }
  return out;
}

export class VectorScene {
  readonly pr: Projector;
  readonly model: SceneModel;
  readonly params: Map<number, Record<string, unknown>>;
  readonly L: V3;
  readonly seed: string;
  private staticCache: { night: number; shapes: Shape[]; ms: number } | null = null;
  private animated: ObjectInfo[] = [];
  /** Clé d'ordre de chaque objet (profondeur du point le plus proche de l'emprise). */
  readonly keys = new Map<number, number>();

  constructor(model: SceneModel, view: ViewOpts, opts: { lightElevation?: number; seed?: string } = {}) {
    this.model = model;
    this.pr = new Projector(view.camera, { lift: view.lift, k: view.k, angle: view.angle });
    this.pr.zMin = -model.size[1] / 2;
    this.pr.zMax = model.size[1] / 2;
    this.params = objectParams(model);
    this.L = lightDir(opts.lightElevation ?? 48);
    this.seed = opts.seed ?? "1";
    for (const o of model.objects) {
      const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
      let best = -Infinity;
      for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const x = o.pos[0] + a * o.footprint.hx * c + b * o.footprint.hz * s, z = o.pos[2] - a * o.footprint.hx * s + b * o.footprint.hz * c;
        best = Math.max(best, this.pr.key([x, o.pos[1], z]));
      }
      this.keys.set(o.obj, o.mode === "actor" ? this.pr.key(o.pos) : best);
    }
  }

  /** Plan d'un bâtiment : mémorisé par `composeVector`, sinon retiré de la graine de la couche (même clé que la composition). */
  private planOf(o: ObjectInfo, p: Record<string, unknown>): Plan {
    const meta = VECTOR_META.get(this.model);
    const hit = meta?.plans.get(o.id) ?? meta?.byParams.get(JSON.stringify(p));
    if (hit) return hit;
    const dot = o.id.lastIndexOf(".");
    const key = dot > 0 ? `${meta?.seed ?? this.seed}/${o.id.slice(0, dot)}/${o.id.slice(dot + 1)}` : `${meta?.seed ?? this.seed}/actor/${o.id}`;
    return buildPlan(p, new Rng(key));
  }

  layerOf(z: number) {
    return 2 + Math.round((1 - this.pr.far(z)) * 6);
  }

  private env(out: Shape[], shadows: Shape[], time: number, night: number): DrawEnv {
    const T = this.model.terrain;
    return { pr: this.pr, L: this.L, out, shadows, ground: (x, z) => (T ? T.height(x, z) : 0), time, night, waterLevel: T?.spec.water ?? null };
  }

  private drawObject(o: ObjectInfo, env: DrawEnv, ball?: BallPose) {
    const p = this.params.get(o.obj) ?? o.params;
    const zPos = ball ? ball.center[2] : o.pos[2];
    const em = new Emitter(env.out, ball ? this.pr.key(ball.center) : (this.keys.get(o.obj) ?? 0), this.layerOf(zPos), o.obj, this.pr.far(zPos));
    const kit = new Kit(this.pr, new Frame(o.pos, o.yaw, o.scale), em, this.L);
    const ctx = { obj: o, env, rng: new Rng(`${this.seed}/${o.id}`), mirror: (hash32(o.id) & 1) === 1, plan: o.generator === "building" ? this.planOf(o, p) : undefined, ball };
    if (TEMPLATED.has(o.generator) && DRAWERS[o.generator]) {
      // gabarit : dessiné une fois à l'origine (échelle 1), puis translaté / mis à l'échelle par instance
      const key = `${o.generator}|${JSON.stringify(p)}|${ctx.mirror}|${this.pr.ax.toFixed(3)}|${this.pr.ay.toFixed(3)}|${this.L[1].toFixed(3)}`;
      let tpl = TEMPLATES.get(key);
      if (!tpl) {
        const tmp: Shape[] = [];
        const tenv: DrawEnv = { ...env, out: tmp, shadows: [] };
        const tem = new Emitter(tmp, 0, 0, 0, 0);
        try {
          DRAWERS[o.generator](new Kit(this.pr, new Frame([0, 0, 0], 0, 1), tem, this.L), p, { ...ctx, env: tenv });
        } catch {
          tmp.length = 0;
        }
        tpl = tmp;
        TEMPLATES.set(key, tpl);
        if (TEMPLATES.size > 600) TEMPLATES.delete(TEMPLATES.keys().next().value as string);
      }
      if (tpl.length) {
        const [u, v] = this.pr.pv(o.pos);
        const k = o.scale;
        for (const t of tpl) env.out.push({ ...t, t: [k, u, v], z: em.z0 + t.z, layer: em.layer, objId: o.obj, depth: em.depth });
        const sh = natureShadow(o.generator, p);
        if (sh) kit.castShadow(env.shadows, sh[0], sh[1], sh[2], env.ground, em.z0 - 0.5, em.layer, em.depth, true);
        return;
      }
    }
    const fn = DRAWERS[o.generator] ?? drawGeneric;
    const n0 = env.out.length, s0 = env.shadows.length;
    try {
      fn(kit, p, ctx);
    } catch {
      // valeur inattendue (générateur d'une autre équipe, paramètre nouveau) : silhouette générique
      env.out.length = n0;
      env.shadows.length = s0;
      drawGeneric(kit, p, ctx);
    }
  }

  /** Formes statiques triées (mémoïsées par niveau de nuit). */
  staticShapes(night: number, hidden?: Set<string>): { shapes: Shape[]; ms: number } {
    if (this.staticCache && this.staticCache.night === night && !hidden?.size) return this.staticCache;
    const t0 = now();
    const out: Shape[] = [], shadows: Shape[] = [];
    const env = this.env(out, shadows, 0, night);
    drawSky(this.model, env, this.seed, night);
    const bands = bandsOf(this.model, this.pr);
    if (this.model.terrain) drawGround(this.model, env, bands, this.seed);
    this.animated = [];
    for (const o of this.model.objects) {
      if (o.mode === "actor" || hidden?.has(o.id)) continue;
      const p = this.params.get(o.obj) ?? o.params;
      if (ANIMATED(o, p)) {
        this.animated.push(o);
        continue;
      }
      this.drawObject(o, env);
    }
    // ombres portées : juste au-dessus du sol de leur bande, sous tous les objets
    const groundTop = this.model.terrain ? Math.max(...bands.map((b) => b.key)) : -1e4;
    for (const s of shadows) {
      // la bande qui contient l'objet : clé de la dernière bande plus lointaine que l'ombre
      let k = -1e4;
      for (const b of bands) if (b.key < s.z) k = b.key;
      s.z = Math.min(k + 9e-6, groundTop + 9e-6);
      out.push(s);
    }
    out.sort((a, b) => a.z - b.z);
    const res = { night, shapes: out, ms: now() - t0 };
    if (!hidden?.size) this.staticCache = res;
    return res;
  }

  /** Formes animées (feux, barques, personnages) au temps `time`, triées. */
  dynamicShapes(time: number, night: number, actors: ActorPose[], balls?: Map<number, BallPose>): Shape[] {
    const out: Shape[] = [], shadows: Shape[] = [];
    const env = this.env(out, shadows, time, night);
    if (!this.staticCache) this.staticShapes(night);
    for (const o of this.animated) this.drawObject(o, env, balls?.get(o.obj));
    for (const a of actors) {
      if (a.hidden) continue;
      const kp: V3 = a.seated ? [a.pos[0] + Math.sin(a.yaw) * 0.6, a.pos[1], a.pos[2] + Math.cos(a.yaw) * 0.6] : a.pos;
      const em = new Emitter(out, this.pr.key(kp) + 0.05, this.layerOf(a.pos[2]), a.obj, this.pr.far(a.pos[2]), "ink", a.colors);
      try {
        if (a.sk instanceof AnimalSkeleton) drawAnimal(this.pr, em, { sk: a.sk, W: a.W, pos: a.pos, yaw: a.yaw, params: a.params, blink: a.blink });
        else drawCharacter(this.pr, em, { sk: a.sk, W: a.W, pos: a.pos, yaw: a.yaw, params: a.params, blink: a.blink, time, speed: a.speed }, shadows, env.ground);
      } catch {
        /* pose dégénérée : personnage ignoré pour cette image */
      }
    }
    for (const s of shadows) out.push(s);
    out.sort((a, b) => a.z - b.z);
    return out;
  }
}

export const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Fusion de deux listes triées par `z`. */
export function mergeSorted(a: Shape[], b: Shape[]): Shape[] {
  if (!b.length) return a;
  const out: Shape[] = new Array(a.length + b.length);
  let i = 0, j = 0, k = 0;
  while (i < a.length && j < b.length) out[k++] = a[i].z <= b[j].z ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}
