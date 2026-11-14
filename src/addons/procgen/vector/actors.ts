/**
 * Logique d'acteurs indépendante du rendu (copie adaptée de `render/view.ts`) : intentions `goto` / `drive`,
 * errance et patrouille, actions transitoires, humeur, clignement, zones, événements de jeu. Produit, à chaque pas,
 * la pose 3D (`humanoidPose`) de chaque acteur ; le dessinateur vectoriel la projette.
 */
import { BallWorld } from "../scene/balls";
import { type M4, type V3, clamp } from "../core/math";
import { GENERATORS } from "../gen/index";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { ACTIONS, type Action, type MotionState } from "../rig/locomotion";
import { type Motion, motionFor } from "../rig/motion";
import { type ActorModel, type SceneModel, groundHeight, reachOf } from "../scene/compose";
import type { ActorPose } from "./scene";

export type ActorIntent = { x?: number; z?: number; target?: string; vx?: number; vz?: number; action?: string; speed?: number; run?: boolean; facing?: number; look?: string; mood?: string; /** Coup de pied (cible ballon) : vitesse donnée (m/s) et part verticale. */ power?: number; loft?: number; /** Durée de l'action (s) : `actionEnd` puis repos. */ duration?: number };
export type GameEvent = { type: "pick" | "select" | "arrive" | "blocked" | "enter" | "leave" | "actionEnd" | "kick" | "hit" | "rest"; payload: Record<string, unknown> };

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
  goal: {
    x: number; z: number; target?: string; seat?: { x: number; y: number; z: number; yaw: number; action?: Action }; kick?: { ball: string; power: number; loft: number; tries?: number };
    /** Boire, manger, dormir à une ancre `spot` : action lancée à l'arrivée, bouche au-dessus de l'ancre. */
    then?: { action: Action; spot: V3 };
  } | null;
  /** Hauteur de la cible (eau, gamelle) au-dessus des pieds pendant `drink` / `eat`. */
  reachY?: number;
  /** Durée demandée pour l'action en cours (s). */
  actionDur?: number;
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
  /** Ballons dynamiques (null sans ballon). */
  balls: BallWorld | null = null;
  time = 0;
  onEvent: (e: GameEvent) => void = () => {};

  setModel(model: SceneModel) {
    this.model = model;
    this.actors.clear();
    const bw = new BallWorld(model);
    this.balls = bw.count ? bw : null;
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
        seatY: a.seatY, standAt: a.standAt, reachY: a.reachY,
      };
      this.actors.set(a.id, rt);
      this.pose(rt);
    }
  }

  setHidden(ids: Set<string>) {
    for (const [id, a] of this.actors) a.hidden = ids.has(id);
    if (this.balls) this.balls.hidden = new Set([...ids].filter((id) => this.balls!.byId.has(id)));
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
      const toBall = typeof it.target === "string" && !!this.balls?.byId.get(it.target);
      // boire, manger, dormir vers une cible : l'action commence à l'arrivée
      const atTarget = typeof it.target === "string" && !toBall && (it.action === "drink" || it.action === "eat" || it.action === "sleep");
      a.actionDur = Number.isFinite(it.duration) && Number(it.duration) > 0 ? Number(it.duration) : undefined;
      // en route vers une place (ou un ballon), l'acteur marche : il ne s'assied (ou ne tire) qu'à l'arrivée
      if (it.action && !(toSeat && it.action === "sit") && !atTarget && !(toBall && it.action === "kick") && (ACTIONS as readonly string[]).includes(it.action) && it.action !== "walk" && it.action !== "run") {
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
        let kick: { ball: string; power: number; loft: number } | undefined;
        let then: { action: Action; spot: V3 } | undefined;
        const ball = typeof it.target === "string" ? this.balls?.byId.get(it.target) : undefined;
        if (ball) {
          // derrière le ballon, sur la ligne acteur → ballon ; le coup part à l'arrivée
          const dx = ball.pos[0] - a.pos[0], dz = ball.pos[2] - a.pos[2], d = Math.hypot(dx, dz) || 1;
          const back = ball.r + 0.32 * a.mo.legLength;
          x = ball.pos[0] - (dx / d) * back;
          z = ball.pos[2] - (dz / d) * back;
          if (it.action === "kick" || it.power !== undefined) kick = { ball: ball.id, power: Math.max(0, Math.min(30, Number.isFinite(it.power) ? Number(it.power) : 7)), loft: Math.max(0, Math.min(1.5, Number.isFinite(it.loft) ? Number(it.loft) : 0.15)) };
        } else if (it.target) {
          const o = this.model?.objects.find((ob) => ob.id === it.target || it.target!.startsWith(ob.id + "."));
          if (o) {
            const an = it.target.slice(o.id.length + 1);
            // place assise : on marche jusqu'à l'ancre « approach.N » (devant), puis on s'assied sur « sit.N »
            const sm = /^sit\.(\d+)$/.exec(an);
            const sp = sm ? o.anchors[an] : undefined;
            if (sp) seat = { x: sp[0], y: sp[1] - o.pos[1], z: sp[2], yaw: o.seatYaw?.[an] ?? o.yaw, ...(it.action === "sleep" ? { action: "sleep" as Action } : {}) };
            // point d'eau, gamelle : `spot.N` (ou le plus proche si la cible est l'objet seul), on arrive par `approach.N`
            let sa = an;
            if (!sa && atTarget && !o.anchors.door) {
              const spots = Object.keys(o.anchors).filter((k) => /^spot(\.\d+)?$/.test(k));
              sa = spots.sort((u, v) => Math.hypot(o.anchors[u][0] - a.pos[0], o.anchors[u][2] - a.pos[2]) - Math.hypot(o.anchors[v][0] - a.pos[0], o.anchors[v][2] - a.pos[2]))[0] ?? "";
            }
            const spm = /^spot(?:\.(\d+))?$/.exec(sa);
            const ap = spm ? o.anchors[spm[1] !== undefined ? `approach.${spm[1]}` : "approach"] : undefined;
            if (spm && atTarget) then = { action: it.action as Action, spot: o.anchors[sa] };
            const p = (sm && o.anchors[`approach.${sm[1]}`]) || ap || (sa && o.anchors[sa]) || o.anchors.door || o.pos;
            [x, z] = [p[0], p[2]];
          }
        }
        this.goto(a, x, z, it.target);
        if (a.goal && seat) a.goal.seat = seat;
        if (a.goal && kick) a.goal.kick = kick;
        if (a.goal && then) a.goal.then = then;
      }
      if (Number.isFinite(it.facing) && !a.goal && !a.drive) a.yaw = (Number(it.facing) * Math.PI) / 180;
    }
  }

  /** Tir : l'acteur se tourne vers le ballon, lance le geste, le ballon part dans cette direction. */
  private doKick(a: ActorRT, k: { ball: string; power: number; loft: number; tries?: number }) {
    const b = this.balls?.byId.get(k.ball);
    if (!b) return;
    const dx = b.pos[0] - a.pos[0], dz = b.pos[2] - a.pos[2], d = Math.hypot(dx, dz) || 1;
    // le ballon a roulé entre-temps : l'acteur le rattrape (3 essais), sinon `blocked`
    const back = b.r + 0.32 * a.mo.legLength;
    if (d > back + 0.25) {
      const tries = (k.tries ?? 0) + 1;
      if (tries > 3) {
        this.onEvent({ type: "blocked", payload: { actor: a.model.id, reason: "ball-moved", target: b.id } });
        return;
      }
      this.goto(a, b.pos[0] - (dx / d) * back, b.pos[2] - (dz / d) * back, b.id);
      if (a.goal) a.goal.kick = { ...k, tries };
      return;
    }
    a.yaw = Math.atan2(dx, dz);
    a.action = "kick";
    a.actionTime = 0;
    this.balls!.kick(b.id, [(dx / d) * k.power, k.power * k.loft, (dz / d) * k.power]);
    this.onEvent({ type: "kick", payload: { actor: a.model.id, ball: b.id, power: k.power } });
  }

  /** Coup donné à un ballon sans acteur (`kick` du DataProvider) : vitesse en m/s. */
  kickBall(id: string, v: [number, number, number]): boolean {
    const ok = !!this.balls?.kick(id, v);
    if (ok) this.onEvent({ type: "kick", payload: { actor: null, ball: id } });
    return ok;
  }

  /** Position et mouvement des ballons (publiés dans l'état). */
  ballState() {
    return this.balls?.snapshot() ?? {};
  }

  /** Quitte une place assise : retour au point libre devant l'assise (sinon l'acteur resterait dans l'obstacle). */
  private standUp(a: ActorRT) {
    if (a.standAt) {
      a.pos[0] = a.standAt[0];
      a.pos[2] = a.standAt[1];
      if (a.action === "sit" || (a.action === "sleep" && (a.seatY ?? 0) > 0)) a.action = "idle";
    }
    a.seatY = 0;
    a.standAt = undefined;
    a.reachY = undefined;
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
    this.stepBalls(dt);
  }

  private stepBalls(dt: number) {
    const m = this.model;
    if (!this.balls || !m) return;
    const pushers = [...this.actors.values()].filter((a) => !a.hidden && !(a.action === "sit" && (a.seatY ?? 0) > 0)).map((a) => ({ id: a.model.id, pos: a.pos, vel: [Math.sin(a.yaw) * a.speed, 0, Math.cos(a.yaw) * a.speed] as V3, r: 0.18 * a.mo.legLength + 0.08, h: a.mo.legLength * 0.6 }));
    this.balls.step(dt, (x, z) => (m.terrain ? m.terrain.height(x, z) : 0), (x, z) => (m.nav ? m.nav.free(x, z) : true), pushers, (e) => this.onEvent(e));
  }

  /** Centre et rotation courants de chaque ballon (rendu vectoriel). */
  ballPoses(): Map<number, { center: V3; spin: [number, number, number, number] }> {
    const out = new Map<number, { center: V3; spin: [number, number, number, number] }>();
    for (const b of this.balls?.bodies ?? []) out.set(b.obj, { center: b.pos, spin: b.spin });
    return out;
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
          if (g?.kick) this.doKick(a, g.kick);
          if (g?.seat) {
            a.pos[0] = g.seat.x;
            a.pos[2] = g.seat.z;
            a.yaw = g.seat.yaw;
            a.seatY = g.seat.y;
            a.standAt = [g.x, g.z];
            a.speed = 0;
            const sa = g.seat.action ?? "sit";
            if (a.action !== sa) {
              a.action = sa;
              a.actionTime = 0;
            }
          }
          if (g?.then) {
            // face à la cible, la bouche au-dessus : boire au bassin, manger à la gamelle
            const sp = g.then.spot;
            let dx = sp[0] - a.pos[0], dz = sp[2] - a.pos[2];
            const d = Math.hypot(dx, dz) || 1;
            [dx, dz] = [dx / d, dz / d];
            const r = g.then.action === "sleep" ? 0 : reachOf(a.model.asset, g.then.action, sp[1] - groundHeight(m, sp[0] - dx * 0.5, sp[2] - dz * 0.5, a.pos[1]));
            a.standAt = [a.pos[0], a.pos[2]];
            if (d > r) {
              a.pos[0] = sp[0] - dx * r;
              a.pos[2] = sp[2] - dz * r;
            }
            a.yaw = Math.atan2(dx, dz);
            a.speed = 0;
            a.reachY = sp[1] - groundHeight(m, a.pos[0], a.pos[2], a.pos[1]);
            a.action = g.then.action;
            a.actionTime = 0;
          }
          if (g) this.onEvent({ type: "arrive", payload: { actor: a.model.id, x: round(a.pos[0]), z: round(a.pos[2]), target: g.target ?? null } });
        }
      } else {
        want = a.wantSpeed || 1.35;
        if (a.path.length === 1) want *= clamp(d / 0.8, 0.3, 1);
        vx = dx / d;
        vz = dz / d;
      }
    } else if ((a.model.behavior === "wander" || a.model.behavior === "patrol") && !(a.action === "sit" && (a.seatY ?? 0) > 0) && a.action !== "sleep") {
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
    a.pos[1] = groundHeight(m, a.pos[0], a.pos[2], a.pos[1]);
    const transient = a.action === "wave" || a.action === "cheer" || a.action === "jump" || a.action === "bow" || a.action === "point" || a.action === "kick";
    a.actionTime += dt;
    const target = a.action === "idle" ? 0 : 1;
    a.actionWeight += (target - a.actionWeight) * (1 - Math.exp(-dt * 6));
    if ((transient && a.actionDur === undefined && a.actionTime > (a.action === "jump" ? 1.1 : a.action === "bow" ? 1.4 : a.action === "kick" ? 0.7 : 2.6)) || (a.actionDur !== undefined && a.action !== "idle" && !a.goal && a.actionTime > a.actionDur)) {
      this.onEvent({ type: "actionEnd", payload: { actor: a.model.id, action: a.action } });
      a.actionDur = undefined;
      if (a.action === "sleep" && (a.seatY ?? 0) > 0) a.action = "sit";
      else {
        a.action = "idle";
        a.reachY = undefined;
      }
    }
    a.blinkT -= dt;
    a.blink = 0;
    if (a.blinkT < 0.14) a.blink = Math.sin(clamp(1 - a.blinkT / 0.14, 0, 1) * Math.PI);
    if (a.blinkT <= 0) a.blinkT = 2 + ((a.model.seed * 17.1 + this.time) % 4);
    if (a.action === "sleep") a.blink = Math.max(a.blink, a.actionWeight);
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
    const st: MotionState = { speed: a.speed, phase: a.phase, time: this.time + a.model.seed, action: a.action, actionTime: a.actionTime, actionWeight: a.actionWeight, mood: a.mood, turn: a.turn, seed: a.model.seed, seatY: a.action === "sit" || a.action === "sleep" ? a.seatY : 0, reachY: a.action === "drink" || a.action === "eat" ? a.reachY : undefined };
    const { pose } = a.mo.pose(st);
    a.W = sk.world(pose);
  }

  poses(): ActorPose[] {
    return [...this.actors.values()].map((a) => ({ id: a.model.id, obj: a.model.obj, sk: a.model.asset.skeleton!, W: a.W, pos: a.pos, yaw: a.yaw, params: { ...a.params, mood: a.mood }, blink: a.blink, speed: a.speed, hidden: a.hidden, seated: (a.action === "sit" || a.action === "sleep") && (a.seatY ?? 0) > 0, colors: a.model.asset.colors as Record<string, string> | undefined }));
  }

  state(id: string) {
    const a = this.actors.get(id);
    return a ? { x: round(a.pos[0]), y: round(a.pos[1]), z: round(a.pos[2]), yaw: Math.round((a.yaw * 180) / Math.PI), speed: round(a.speed), action: a.action, moving: !!a.path || a.speed > 0.05 } : null;
  }
}
