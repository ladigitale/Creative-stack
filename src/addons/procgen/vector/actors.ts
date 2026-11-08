/**
 * Logique d'acteurs indépendante du rendu (copie adaptée de `render/view.ts`) : intentions `goto` / `drive`,
 * errance et patrouille, actions transitoires, humeur, clignement, zones, événements de jeu. Produit, à chaque pas,
 * la pose 3D (`humanoidPose`) de chaque acteur ; le dessinateur vectoriel la projette.
 */
import { type M4, type V3, clamp } from "../core/math";
import { GENERATORS } from "../gen/index";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { ACTIONS, type Action, type MotionState } from "../rig/locomotion";
import { type Motion, motionFor } from "../rig/motion";
import type { ActorModel, SceneModel } from "../scene/compose";
import type { ActorPose } from "./scene";

export type ActorIntent = { x?: number; z?: number; target?: string; vx?: number; vz?: number; action?: string; speed?: number; run?: boolean; facing?: number; look?: string; mood?: string };
export type GameEvent = { type: "pick" | "select" | "arrive" | "blocked" | "enter" | "leave" | "actionEnd"; payload: Record<string, unknown> };

export type ActorRT = {
  model: ActorModel;
  params: Record<string, unknown>;
  /** Animation (humanoïde ou animal) : pose, longueur de pas, longueur de jambe. */
  mo: Motion;
  pos: V3;
  yaw: number;
  speed: number;
  phase: number;
  action: Action;
  actionTime: number;
  actionWeight: number;
  mood: string;
  path: [number, number][] | null;
  goal: { x: number; z: number; target?: string; seat?: { x: number; y: number; z: number; yaw: number } } | null;
  /** Hauteur de l'assise occupée (m) : le bassin s'y pose quand l'acteur est assis. */
  seatY?: number;
  /** Point libre devant l'assise, où l'acteur se relève. */
  standAt?: [number, number];
  drive: { vx: number; vz: number } | null;
  wantSpeed: number;
  wanderT: number;
  blinkT: number;
  blink: number;
  turn: number;
  zones: Set<string>;
  hidden: boolean;
  lastIntent: string;
  W: M4[];
};

const round = (x: number) => Math.round(x * 100) / 100;

export class ActorSim {
  readonly actors = new Map<string, ActorRT>();
  private model: SceneModel | null = null;
  time = 0;
  onEvent: (e: GameEvent) => void = () => {};

  setModel(model: SceneModel) {
    this.model = model;
    this.actors.clear();
    const issues = new Issues();
    for (const a of model.actors) {
      const sk = a.asset.skeleton;
      if (!sk) continue;
      // apparence résolue par le générateur (valeurs « auto » tirées) ; sinon paramètres résolus par le schéma
      const look = (a.asset.extra as { look?: Record<string, unknown> } | undefined)?.look;
      const ex = a.asset.extra as Record<string, unknown> | undefined;
      const params = look ? { ...a.params, ...look } : a.asset.generator === "animal" ? { ...a.params, ...ex } : (resolveParams(GENERATORS.character?.schema ?? {}, a.params, { rng: new Rng(a.id), vars: {} }, issues) as Record<string, unknown>);
      const rt: ActorRT = {
        model: a, params, mo: motionFor(a.asset), pos: [...a.pos], yaw: a.yaw, speed: 0, phase: (a.seed * 0.618) % 1, action: a.action, actionTime: 0, actionWeight: a.action === "idle" ? 0 : 1,
        mood: String(a.params.mood ?? params.mood ?? "neutral"), path: null, goal: null, drive: null, wantSpeed: 0, wanderT: 1 + (a.seed % 5), blinkT: 1 + (a.seed % 3), blink: 0, turn: 0, zones: new Set(), hidden: false, lastIntent: "", W: [],
      };
      this.actors.set(a.id, rt);
      this.pose(rt);
    }
  }

  setHidden(ids: Set<string>) {
    for (const [id, a] of this.actors) a.hidden = ids.has(id);
  }

  setActors(intents: Record<string, ActorIntent>) {
    for (const [id, it] of Object.entries(intents ?? {})) {
      const a = this.actors.get(id);
      if (!a || !it || typeof it !== "object") continue;
      const sig = JSON.stringify(it);
      if (sig === a.lastIntent) continue;
      a.lastIntent = sig;
      if (it.mood) a.mood = String(it.mood);
      const toSeat = typeof it.target === "string" && /\.sit\.\d+$/.test(it.target);
      // en route vers une place, l'acteur marche : il ne s'assied qu'à l'arrivée
      if (it.action && !(toSeat && it.action === "sit") && (ACTIONS as readonly string[]).includes(it.action) && it.action !== "walk" && it.action !== "run") {
        if (a.action !== it.action) {
          if (it.action !== "sit") this.standUp(a);
          a.action = it.action as Action;
          a.actionTime = 0;
        }
      } else if (it.action === "idle") {
        this.standUp(a);
        a.action = "idle";
      }
      const run = it.run || it.action === "run";
      const leg = a.mo.legLength;
      a.wantSpeed = Number.isFinite(it.speed) ? Number(it.speed) : run ? (3.6 * leg) / 0.85 : (1.35 * leg) / 0.85;
      if (Number.isFinite(it.vx) || Number.isFinite(it.vz)) {
        this.standUp(a);
        a.drive = { vx: Number(it.vx) || 0, vz: Number(it.vz) || 0 };
        a.goal = null;
        a.path = null;
      } else if (it.target || Number.isFinite(it.x) || Number.isFinite(it.z)) {
        let x = Number(it.x ?? a.pos[0]), z = Number(it.z ?? a.pos[2]);
        let seat: { x: number; y: number; z: number; yaw: number } | undefined;
        if (it.target) {
          const o = this.model?.objects.find((ob) => ob.id === it.target || it.target!.startsWith(ob.id + "."));
          if (o) {
            const an = it.target.slice(o.id.length + 1);
            // place assise : on marche jusqu'à l'ancre « approach.N » (devant), puis on s'assied sur « sit.N »
            const sm = /^sit\.(\d+)$/.exec(an);
            const sp = sm ? o.anchors[an] : undefined;
            if (sp) seat = { x: sp[0], y: sp[1] - o.pos[1], z: sp[2], yaw: o.yaw };
            const p = (sm && o.anchors[`approach.${sm[1]}`]) || (an && o.anchors[an]) || o.anchors.door || o.pos;
            [x, z] = [p[0], p[2]];
          }
        }
        this.goto(a, x, z, it.target);
        if (a.goal && seat) a.goal.seat = seat;
      }
      if (Number.isFinite(it.facing) && !a.goal && !a.drive) a.yaw = (Number(it.facing) * Math.PI) / 180;
    }
  }

  /** Quitte une place assise : retour au point libre devant l'assise (sinon l'acteur resterait dans l'obstacle). */
  private standUp(a: ActorRT) {
    if ((a.seatY ?? 0) > 0 && a.standAt) {
      a.pos[0] = a.standAt[0];
      a.pos[2] = a.standAt[1];
      if (a.action === "sit") a.action = "idle";
    }
    a.seatY = 0;
    a.standAt = undefined;
  }

  private goto(a: ActorRT, x: number, z: number, target?: string) {
    this.standUp(a);
    a.drive = null;
    const nav = this.model?.nav;
    const p = nav ? nav.path([a.pos[0], a.pos[2]], [x, z]) : ([[a.pos[0], a.pos[2]], [x, z]] as [number, number][]);
    if (!p) {
      a.goal = null;
      a.path = null;
      this.onEvent({ type: "blocked", payload: { actor: a.model.id, reason: "no-path", x, z, target: target ?? null } });
      return;
    }
    a.path = p.slice(1);
    a.goal = { x, z, target };
  }

  /** Avance la simulation de `dt` secondes. */
  update(dt: number) {
    this.time += dt;
    for (const a of this.actors.values()) this.updateActor(a, dt);
  }

  private updateActor(a: ActorRT, dt: number) {
    const m = this.model!;
    const leg = a.mo.legLength;
    let vx = 0, vz = 0;
    let want = 0;
    if (a.drive) {
      const l = Math.hypot(a.drive.vx, a.drive.vz);
      if (l > 0.05) {
        want = Math.min(l, 1) * (a.wantSpeed || 1.4);
        vx = a.drive.vx / l;
        vz = a.drive.vz / l;
      }
    } else if (a.path && a.path.length) {
      const [tx, tz] = a.path[0];
      const dx = tx - a.pos[0], dz = tz - a.pos[2];
      const d = Math.hypot(dx, dz);
      if (d < 0.25 && a.path.length > 1) a.path.shift();
      else if (d < 0.12) {
        a.path.shift();
        if (!a.path.length) {
          const g = a.goal;
          a.path = null;
          a.goal = null;
          if (g?.seat) {
            a.pos[0] = g.seat.x;
            a.pos[2] = g.seat.z;
            a.yaw = g.seat.yaw;
            a.seatY = g.seat.y;
            a.standAt = [g.x, g.z];
            a.speed = 0;
            if (a.action !== "sit") {
              a.action = "sit";
              a.actionTime = 0;
            }
          }
          if (g) this.onEvent({ type: "arrive", payload: { actor: a.model.id, x: round(a.pos[0]), z: round(a.pos[2]), target: g.target ?? null } });
        }
      } else {
        want = a.wantSpeed || 1.35;
        if (a.path.length === 1) want *= clamp(d / 0.8, 0.3, 1);
        vx = dx / d;
        vz = dz / d;
      }
    } else if ((a.model.behavior === "wander" || a.model.behavior === "patrol") && !(a.action === "sit" && (a.seatY ?? 0) > 0)) {
      a.wanderT -= dt;
      if (a.wanderT <= 0) {
        a.wanderT = 3 + ((a.model.seed * 7.3 + this.time) % 6);
        let tx: number, tz: number;
        const paths = m.terrain?.paths.filter((p) => p.kind !== "river") ?? [];
        if (a.model.behavior === "patrol" && paths.length) {
          const p = paths[0];
          const end = Math.hypot(a.pos[0] - p.points[0][0], a.pos[2] - p.points[0][1]) < 4 ? p.points[p.points.length - 1] : p.points[0];
          [tx, tz] = end;
        } else {
          const ang = (a.model.seed * 3.7 + this.time * 1.3) % (Math.PI * 2);
          const r = 3 + ((a.model.seed + this.time) % 5);
          tx = clamp(a.pos[0] + Math.cos(ang) * r, -m.size[0] / 2 + 1, m.size[0] / 2 - 1);
          tz = clamp(a.pos[2] + Math.sin(ang) * r, -m.size[1] / 2 + 1, m.size[1] / 2 - 1);
        }
        a.wantSpeed = ((1.1 + ((a.model.seed * 13) % 1) * 0.4) * leg) / 0.85;
        this.goto(a, tx, tz);
        if (!a.path) a.wanderT = 1;
      }
    }
    a.speed += (want - a.speed) * (1 - Math.exp(-dt * (want > a.speed ? 4 : 6)));
    if (want > 0.01) {
      const targetYaw = Math.atan2(vx, vz);
      let dy = targetYaw - a.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      const turn = clamp(dy, -dt * 7, dt * 7);
      a.yaw += turn;
      a.turn = turn / Math.max(dt, 1e-3);
    } else a.turn *= 0.8;
    const step = a.speed * dt;
    if (step > 0) {
      const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
      const nx = a.pos[0] + fx * step, nz = a.pos[2] + fz * step;
      if (!m.nav || m.nav.free(nx, nz) || a.path || !a.drive) {
        a.pos[0] = nx;
        a.pos[2] = nz;
      } else this.onEvent({ type: "blocked", payload: { actor: a.model.id, reason: "wall" } });
      a.phase += step / (2 * a.mo.stepLength(Math.max(a.speed, 0.2)));
    }
    a.pos[1] = m.terrain ? m.terrain.height(a.pos[0], a.pos[2]) : a.pos[1];
    const transient = a.action === "wave" || a.action === "cheer" || a.action === "jump" || a.action === "bow" || a.action === "point";
    a.actionTime += dt;
    const target = a.action === "idle" ? 0 : 1;
    a.actionWeight += (target - a.actionWeight) * (1 - Math.exp(-dt * 6));
    if (transient && a.actionTime > (a.action === "jump" ? 1.1 : a.action === "bow" ? 1.4 : 2.6)) {
      this.onEvent({ type: "actionEnd", payload: { actor: a.model.id, action: a.action } });
      a.action = "idle";
    }
    a.blinkT -= dt;
    a.blink = 0;
    if (a.blinkT < 0.14) a.blink = Math.sin(clamp(1 - a.blinkT / 0.14, 0, 1) * Math.PI);
    if (a.blinkT <= 0) a.blinkT = 2 + ((a.model.seed * 17.1 + this.time) % 4);
    for (const zn of m.zones) {
      const inside = zn.box ? a.pos[0] >= zn.box[0] && a.pos[0] <= zn.box[2] && a.pos[2] >= zn.box[1] && a.pos[2] <= zn.box[3] : Math.hypot(a.pos[0] - zn.x, a.pos[2] - zn.z) <= zn.r;
      if (inside && !a.zones.has(zn.id)) {
        a.zones.add(zn.id);
        this.onEvent({ type: "enter", payload: { zone: zn.id, actor: a.model.id } });
      } else if (!inside && a.zones.has(zn.id)) {
        a.zones.delete(zn.id);
        this.onEvent({ type: "leave", payload: { zone: zn.id, actor: a.model.id } });
      }
    }
    this.pose(a);
  }

  pose(a: ActorRT) {
    const sk = a.model.asset.skeleton!;
    const st: MotionState = { speed: a.speed, phase: a.phase, time: this.time + a.model.seed, action: a.action, actionTime: a.actionTime, actionWeight: a.actionWeight, mood: a.mood, turn: a.turn, seed: a.model.seed, seatY: a.action === "sit" ? a.seatY : 0 };
    const { pose } = a.mo.pose(st);
    a.W = sk.world(pose);
  }

  poses(): ActorPose[] {
    return [...this.actors.values()].map((a) => ({ id: a.model.id, obj: a.model.obj, sk: a.model.asset.skeleton!, W: a.W, pos: a.pos, yaw: a.yaw, params: { ...a.params, mood: a.mood }, blink: a.blink, speed: a.speed, hidden: a.hidden, seated: a.action === "sit" && (a.seatY ?? 0) > 0, colors: a.model.asset.colors as Record<string, string> | undefined }));
  }

  state(id: string) {
    const a = this.actors.get(id);
    return a ? { x: round(a.pos[0]), y: round(a.pos[1]), z: round(a.pos[2]), yaw: Math.round((a.yaw * 180) / Math.PI), speed: round(a.speed), action: a.action, moving: !!a.path || a.speed > 0.05 } : null;
  }
}
