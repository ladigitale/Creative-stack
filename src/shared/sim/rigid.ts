/**
 * Physique 3D du format monde avec Rapier (WASM embarqué, chargé à la demande) : commun aux rendus 2D et 3D.
 *
 * - Instances nommées avec `corps` : corps rigides (dynamique, statique, cinématique) ; formes tirées des pièces
 *   (boîtes, sphères, cylindres) ou du `collider` écrit.
 * - Instances nommées sans corps : obstacles cinématiques qui suivent leur position (un personnage piloté par
 *   `nodes` pousse les caisses).
 * - Décor sans nom (murs, sols, meubles) : obstacles fixes ; sol infini à y = 0 sauf `sol: false`.
 * - Ordres `forces.<instance>` (vitesse, force, impulsion, téléportation), chocs (`contact`) et repos (`rest`).
 *
 * Le moteur écrit la pose des corps dans `inst.t` (x y z rx ry rz, ordre XYZ) ; les rendus la recopient.
 */
import type * as RapierNS from "@dimforge/rapier3d-compat";
import type { Model, Monde } from "../monde/format";
import { partBoxesOf, placeBoxes, type Obb } from "../monde/collide";
import type { BodySpec, JointSpec, V3 } from "../monde/physique";
import type { MondeDriver } from "../monde/driver";

type R = typeof RapierNS;
type Quat = { x: number; y: number; z: number; w: number };

let loading: Promise<R> | null = null;
/** Charge et initialise Rapier une fois (≈ 1,5 Mo compressé). */
export function loadRapier(): Promise<R> {
  return (loading ??= import("@dimforge/rapier3d-compat").then(async (m) => {
    const R = ((m as unknown as { default?: R }).default ?? m) as R;
    await R.init();
    return R;
  }));
}

export type RigidPose = { x: number; y: number; z: number; rx: number; ry: number; rz: number; vx: number; vy: number; vz: number; awake: boolean };
export type ContactEvent = { a: string; b: string; tagsA: string[]; tagsB: string[]; impulse: number; x: number; y: number; z: number };
export type RigidState = { time: number; count: number; awake: number; bodies: Record<string, RigidPose> };

/* --------------------------------------------------------------- rotations (ordre XYZ, comme m4Compose) */

export function quatFromEuler(x: number, y: number, z: number): Quat {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}

export function eulerFromQuat(q: Quat): V3 {
  const { x, y, z, w } = q;
  const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w);
  const m32 = 2 * (y * z + x * w), m33 = 1 - 2 * (x * x + y * y);
  const ry = Math.asin(Math.max(-1, Math.min(1, m13)));
  if (Math.abs(m13) < 0.9999999) return [Math.atan2(-m23, m33), ry, Math.atan2(-m12, m11)];
  return [Math.atan2(m32, m22), ry, 0];
}

/** Quaternion d'une base orthonormée (colonnes = axes). */
function quatFromAxes(ax: [V3, V3, V3]): Quat {
  const [a, b, c] = ax;
  const m00 = a[0], m10 = a[1], m20 = a[2], m01 = b[0], m11 = b[1], m21 = b[2], m02 = c[0], m12 = c[1], m22 = c[2];
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    return { w: 0.25 / s, x: (m21 - m12) * s, y: (m02 - m20) * s, z: (m10 - m01) * s };
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s };
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s };
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s };
}

function rotate(q: Quat, v: V3): V3 {
  const { x, y, z, w } = q;
  const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
const conj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

/* --------------------------------------------------------------- formes */

type ShapeDesc = { kind: "box" | "ball" | "cyl" | "capsule"; c: V3; q: Quat; h: V3 };

/**
 * Formes d'un corps dans son repère (pied de l'instance, échelle comprise) : collider écrit (sphères et capsules
 * gardées rondes), sinon une forme par pièce (sphère, cylindre, capsule ou boîte), 24 au plus (au-delà : englobante).
 */
export function bodyShapes(model: Model, scale: V3, spec: BodySpec): ShapeDesc[] {
  const boxes: { box: Obb; kind: string }[] =
    model.collider === "none"
      ? []
      : model.collider
        ? model.collider.map((b) => ({ box: b, kind: b.round ?? "box" }))
        : model.gen
          ? placeBoxes(model, [0, 0, 0], [0, 0, 0], [1, 1, 1]).map((b) => ({ box: b, kind: "box" }))
          : partBoxesOf(model).map(({ box, part }) => ({ box, kind: model.parts[part].shape?.kind ?? "box" }));
  const scaled = boxes.map(({ box, kind }) => ({
    kind,
    box: {
      c: [box.c[0] * scale[0], box.c[1] * scale[1], box.c[2] * scale[2]] as V3,
      ax: box.ax,
      h: box.h.map((h, i) => h * Math.hypot(box.ax[i][0] * scale[0], box.ax[i][1] * scale[1], box.ax[i][2] * scale[2])) as V3,
    },
  }));
  if (!scaled.length) return [];
  const englobe = (): ShapeDesc => {
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const { box } of scaled)
      for (let a = 0; a < 3; a++) {
        const e = Math.abs(box.ax[0][a]) * box.h[0] + Math.abs(box.ax[1][a]) * box.h[1] + Math.abs(box.ax[2][a]) * box.h[2];
        lo[a] = Math.min(lo[a], box.c[a] - e);
        hi[a] = Math.max(hi[a], box.c[a] + e);
      }
    return { kind: "box", c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], q: { x: 0, y: 0, z: 0, w: 1 }, h: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2] };
  };
  if (spec.shape === "boite" || scaled.length > 24) return [englobe()];
  if (spec.shape === "sphere" || spec.shape === "capsule") {
    const b = englobe();
    return [{ ...b, kind: spec.shape === "sphere" ? "ball" : "capsule" }];
  }
  return scaled
    .filter(({ box }) => box.h[0] + box.h[1] + box.h[2] > 1e-4)
    .map(({ box, kind }) => {
      const q = quatFromAxes(box.ax);
      const h = box.h.map((x) => Math.max(0.005, x)) as V3;
      const k = kind === "sphere" ? "ball" : kind === "cylinder" || kind === "cone" ? "cyl" : kind === "capsule" ? "capsule" : "box";
      return { kind: k, c: box.c, q, h } as ShapeDesc;
    });
}

/* --------------------------------------------------------------- monde physique */

type BodyRec = { name: string; spec: BodySpec | null; body: RapierNS.RigidBody; tags: string[]; impulseN: number; setN: number; order: Order | null; wasAwake: boolean };
type Order = { vx?: number; vy?: number; vz?: number; fx?: number; fy?: number; fz?: number; torque?: V3; spin?: V3 };

export class RigidWorld {
  readonly world: RapierNS.World;
  private R: R;
  private queue: RapierNS.EventQueue;
  private bodies = new Map<string, BodyRec>();
  private byCollider = new Map<number, BodyRec | null>();
  private acc = 0;
  private time = 0;
  private stepDt: number;
  private contactMin: number;
  /** Paires dont le contact vient de commencer (instant du début). */
  private fresh = new Map<string, number>();
  private firstOrders = true;
  private restSent = false;
  private everAwake = false;
  /** Chocs depuis la dernière lecture. */
  contacts: ContactEvent[] = [];
  /** Tous les corps dynamiques viennent de s'endormir (une fois par réveil). */
  rested: Record<string, RigidPose> | null = null;
  issues: string[] = [];

  constructor(R: R, private monde: Monde, private driver: MondeDriver) {
    this.R = R;
    const spec = monde.physics!;
    this.stepDt = spec.step;
    this.contactMin = spec.contactMin;
    this.world = new R.World({ x: spec.gravity[0], y: spec.gravity[1], z: spec.gravity[2] });
    this.world.timestep = this.stepDt;
    this.queue = new R.EventQueue(true);
    if (spec.ground) {
      const g = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
      const c = this.world.createCollider(R.ColliderDesc.cuboid(2000, 0.5, 2000).setFriction(0.8), g);
      this.byCollider.set(c.handle, null);
    }
    // décor sans nom : obstacles fixes (boîtes de rangement, ou formes rondes écrites)
    for (const pl of monde.place) {
      if (pl.name || pl.hidden || pl.sensor) continue;
      const model = monde.models.get(pl.model);
      if (!model) continue;
      const boxes = placeBoxes(model, pl.at, pl.rot, pl.scale);
      if (!boxes.length) continue;
      const fixed = this.world.createRigidBody(R.RigidBodyDesc.fixed());
      for (const b of boxes.slice(0, 24)) {
        const c = this.world.createCollider(this.colliderDesc({ kind: b.round === "sphere" ? "ball" : "box", c: b.c, q: quatFromAxes(b.ax), h: b.h }).setFriction(0.7), fixed);
        this.byCollider.set(c.handle, null);
      }
    }
    for (const inst of driver.instances.values()) this.addInstance(inst.name);
    for (const j of spec.joints) this.addJoint(j);
    if (spec.paused) for (const b of this.bodies.values()) if (b.spec?.kind === "dynamic") b.body.sleep();
  }

  private colliderDesc(s: ShapeDesc): RapierNS.ColliderDesc {
    const R = this.R;
    const d =
      s.kind === "ball"
        ? R.ColliderDesc.ball(Math.max(s.h[0], s.h[1], s.h[2]))
        : s.kind === "cyl"
          ? R.ColliderDesc.cylinder(s.h[1], Math.max(s.h[0], s.h[2]))
          : s.kind === "capsule"
            ? R.ColliderDesc.capsule(Math.max(0.001, s.h[1] - Math.max(s.h[0], s.h[2])), Math.max(s.h[0], s.h[2]))
            : R.ColliderDesc.cuboid(s.h[0], s.h[1], s.h[2]);
    return d.setTranslation(s.c[0], s.c[1], s.c[2]).setRotation(s.q);
  }

  private addInstance(name: string) {
    const R = this.R;
    const inst = this.driver.instances.get(name);
    if (!inst || inst.placement.sensor || inst.placement.hidden) return;
    const spec = inst.placement.body ?? null;
    const t = inst.t;
    const q = quatFromEuler(t.rx, t.ry, t.rz);
    const desc =
      spec?.kind === "dynamic"
        ? R.RigidBodyDesc.dynamic()
            .setLinearDamping(spec.damping)
            .setAngularDamping(spec.angularDamping)
            .setGravityScale(spec.gravity)
            .setCcdEnabled(spec.ccd)
            .setCanSleep(spec.sleep)
            .setLinvel(spec.vel[0], spec.vel[1], spec.vel[2])
            .enabledRotations(!spec.lockRot[0], !spec.lockRot[1], !spec.lockRot[2])
            .enabledTranslations(!spec.lockPos[0], !spec.lockPos[1], !spec.lockPos[2])
        : spec?.kind === "static"
          ? R.RigidBodyDesc.fixed()
          : R.RigidBodyDesc.kinematicPositionBased();
    desc.setTranslation(t.x, t.y, t.z).setRotation(q);
    const body = this.world.createRigidBody(desc);
    const bs: BodySpec = spec ?? { kind: "kinematic", mass: 0, density: 500, friction: 0.6, restitution: 0.1, damping: 0, angularDamping: 0, gravity: 1, ccd: false, lockRot: [false, false, false], lockPos: [false, false, false], shape: "auto", vel: [0, 0, 0], sleep: true };
    const shapes = bodyShapes(inst.model, [t.sx, t.sy, t.sz], bs);
    if (!shapes.length) {
      this.world.removeRigidBody(body);
      return;
    }
    const tags = [...(inst.placement.tags ?? []), inst.placement.model.split("~")[0]];
    const rec: BodyRec = { name, spec, body, tags, impulseN: NaN, setN: NaN, order: null, wasAwake: false };
    // masse donnée : répartie sur les formes au prorata de leur volume
    const vols = shapes.map((s) => Math.max(1e-6, s.kind === "ball" ? (4 / 3) * Math.PI * Math.max(...s.h) ** 3 : 8 * s.h[0] * s.h[1] * s.h[2]));
    const vol = vols.reduce((a, b) => a + b, 0);
    shapes.forEach((s, i) => {
      const cd = this.colliderDesc(s).setFriction(bs.friction).setRestitution(bs.restitution);
      if (bs.kind === "dynamic") {
        if (bs.mass > 0) cd.setMass((bs.mass * vols[i]) / vol);
        else cd.setDensity(bs.density);
        cd.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS | R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(this.contactMin / this.stepDt);
      }
      const c = this.world.createCollider(cd, body);
      this.byCollider.set(c.handle, rec);
    });
    this.bodies.set(name, rec);
  }

  private addJoint(j: JointSpec) {
    const R = this.R;
    const a = this.bodies.get(j.a);
    if (!a) {
      this.issues.push(`liaison : corps « ${j.a} » introuvable`);
      return;
    }
    const b = j.b ? this.bodies.get(j.b) : null;
    if (j.b && !b) {
      this.issues.push(`liaison : corps « ${j.b} » introuvable`);
      return;
    }
    const ba = a.body;
    const bb = b?.body ?? this.world.createRigidBody(R.RigidBodyDesc.fixed());
    const pa = ba.translation(), qa = ba.rotation();
    const pb = bb.translation(), qb = bb.rotation();
    const at: V3 = j.at ?? [pa.x, pa.y, pa.z];
    const local = (p: { x: number; y: number; z: number }, q: Quat, w: V3) => {
      const v = rotate(conj(q), [w[0] - p.x, w[1] - p.y, w[2] - p.z]);
      return { x: v[0], y: v[1], z: v[2] };
    };
    const a1 = local(pa, qa, at), a2 = local(pb, qb, at);
    const axA = rotate(conj(qa), j.axis);
    const axis = { x: axA[0], y: axA[1], z: axA[2] };
    let data: RapierNS.JointData;
    const dist = () => {
      const pB = b ? [pb.x, pb.y, pb.z] : at;
      return Math.hypot(pa.x - pB[0], pa.y - pB[1], pa.z - pB[2]);
    };
    // ressort et corde : attachés au centre de chaque corps (ou au point `at` dans le monde)
    const c1 = { x: 0, y: 0, z: 0 };
    const c2 = b ? { x: 0, y: 0, z: 0 } : local(pb, qb, at);
    switch (j.kind) {
      case "hinge":
        data = R.JointData.revolute(a1, a2, axis);
        break;
      case "ball":
        data = R.JointData.spherical(a1, a2);
        break;
      case "fixed":
        data = R.JointData.fixed(a1, { x: 0, y: 0, z: 0, w: 1 }, a2, quatMul(conj(qb), qa));
        break;
      case "slider":
        data = R.JointData.prismatic(a1, a2, axis);
        break;
      case "spring":
        data = R.JointData.spring(j.length >= 0 ? j.length : dist(), j.stiffness, j.damping, c1, c2);
        break;
      case "rope":
        data = R.JointData.rope(j.length >= 0 ? j.length : dist(), c1, c2);
        break;
    }
    const joint = this.world.createImpulseJoint(data, ba, bb, true);
    joint.setContactsEnabled(j.collide);
    const unit = j.kind === "hinge" ? Math.PI / 180 : 1;
    const lim = joint as unknown as { setLimits?: (a: number, b: number) => void; configureMotorVelocity?: (v: number, f: number) => void };
    if (j.limits && lim.setLimits) lim.setLimits(j.limits[0] * unit, j.limits[1] * unit);
    if (j.motor && lim.configureMotorVelocity) lim.configureMotorVelocity(j.motor.speed * unit, j.motor.force);
  }

  /**
   * Ordres `forces.<instance>` : `vx vy vz` vitesse imposée (axes donnés), `fx fy fz` force continue (N), `torque`,
   * `spin` (°/s), `impulse {n, x y z | toward [x,y,z] + power, at}` (N·s), `set {n, x y z, rx ry rz (°), vx vy vz}`,
   * `wake`. `impulse` et `set` sont des compteurs : la première lecture ne fait que les mémoriser.
   */
  applyOrders(spec: unknown) {
    if (!spec || typeof spec !== "object") return;
    const first = this.firstOrders;
    this.firstOrders = false;
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
    const v3 = (x: unknown): V3 | undefined => (Array.isArray(x) && x.length >= 3 && x.slice(0, 3).every((v) => typeof v === "number" && Number.isFinite(v)) ? [x[0], x[1], x[2]] : undefined);
    for (const [name, raw] of Object.entries(spec as Record<string, unknown>)) {
      const rec = this.bodies.get(name);
      if (!rec || !raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      const body = rec.body;
      const dyn = rec.spec?.kind === "dynamic";
      const order: Order = { vx: num(o.vx), vy: num(o.vy), vz: num(o.vz), fx: num(o.fx), fy: num(o.fy), fz: num(o.fz), torque: v3(o.torque), spin: v3(o.spin) };
      rec.order = Object.values(order).some((v) => v !== undefined) ? order : null;
      if (rec.order || o.wake === true) body.wakeUp();
      // téléportation d'abord : un même ordre peut replacer puis lancer
      const set = o.set && typeof o.set === "object" ? (o.set as Record<string, unknown>) : null;
      if (set) {
        const n = num(set.n) ?? 0;
        if (!first && n > (Number.isNaN(rec.setN) ? 0 : rec.setN)) {
          const p = body.translation();
          body.setTranslation({ x: num(set.x) ?? p.x, y: num(set.y) ?? p.y, z: num(set.z) ?? p.z }, true);
          if (set.rx !== undefined || set.ry !== undefined || set.rz !== undefined) {
            const [ex, ey, ez] = eulerFromQuat(body.rotation());
            const d = Math.PI / 180;
            body.setRotation(quatFromEuler(num(set.rx) !== undefined ? num(set.rx)! * d : ex, num(set.ry) !== undefined ? num(set.ry)! * d : ey, num(set.rz) !== undefined ? num(set.rz)! * d : ez), true);
          }
          if (dyn) {
            body.setLinvel({ x: num(set.vx) ?? 0, y: num(set.vy) ?? 0, z: num(set.vz) ?? 0 }, true);
            body.setAngvel({ x: 0, y: 0, z: 0 }, true);
          }
          this.restSent = false;
        }
        rec.setN = n;
      }
      const imp = o.impulse && typeof o.impulse === "object" ? (o.impulse as Record<string, unknown>) : null;
      if (imp) {
        const n = num(imp.n) ?? 0;
        if (!first && n > (Number.isNaN(rec.impulseN) ? 0 : rec.impulseN) && dyn) {
          let v: V3 = [num(imp.x) ?? 0, num(imp.y) ?? 0, num(imp.z) ?? 0];
          const to = v3(imp.toward);
          if (to) {
            const p = body.translation();
            const d: V3 = [to[0] - p.x, to[1] - p.y, to[2] - p.z];
            const l = Math.hypot(d[0], d[1], d[2]) || 1;
            const pw = num(imp.power) ?? 1;
            v = [(d[0] / l) * pw, (d[1] / l) * pw, (d[2] / l) * pw];
          }
          const at = v3(imp.at);
          if (at) body.applyImpulseAtPoint({ x: v[0], y: v[1], z: v[2] }, { x: at[0], y: at[1], z: at[2] }, true);
          else body.applyImpulse({ x: v[0], y: v[1], z: v[2] }, true);
          this.restSent = false;
        }
        rec.impulseN = n;
      }
    }
  }

  /** Corps saisi au glisser : il suit le pointeur (cinématique) puis retombe, lancé à la vitesse du geste. */
  grab(name: string): boolean {
    const rec = this.bodies.get(name);
    if (!rec || rec.spec?.kind !== "dynamic") return false;
    rec.body.setBodyType(this.R.RigidBodyType.KinematicPositionBased, true);
    return true;
  }
  release(name: string, vel?: V3) {
    const rec = this.bodies.get(name);
    if (!rec || rec.spec?.kind !== "dynamic") return;
    rec.body.setBodyType(this.R.RigidBodyType.Dynamic, true);
    if (vel) rec.body.setLinvel({ x: vel[0], y: vel[1], z: vel[2] }, true);
    this.restSent = false;
  }

  /** Impulsion ponctuelle (projectile, explosion) sur un corps dynamique. */
  push(name: string, impulse: V3, at: V3) {
    const rec = this.bodies.get(name);
    if (!rec || rec.spec?.kind !== "dynamic" || rec.body.bodyType() !== this.R.RigidBodyType.Dynamic) return;
    rec.body.applyImpulseAtPoint({ x: impulse[0], y: impulse[1], z: impulse[2] }, { x: at[0], y: at[1], z: at[2] }, true);
    this.restSent = false;
  }

  /** Projectiles : les touches d'un émetteur à `push` poussent les corps touchés. */
  hits(list: { emitter: string; target: string; x: number; y: number; z: number; dir?: V3 }[], pushOf: (emitter: string) => number) {
    for (const h of list) {
      const p = h.dir ? pushOf(h.emitter) : 0;
      if (p > 0) this.push(h.target, [h.dir![0] * p, h.dir![1] * p, h.dir![2] * p], [h.x, h.y, h.z]);
    }
  }

  isBody(name: string): boolean {
    const k = this.bodies.get(name)?.spec?.kind;
    return k === "dynamic";
  }

  /**
   * Avance de `dt` secondes (pas fixes, 4 au plus par appel) ; écrit la pose des corps dynamiques dans `inst.t`.
   * Rend les noms des instances déplacées.
   */
  step(dt: number): string[] {
    // obstacles cinématiques : position courante de l'instance (pilotée par nodes, move, glisser)
    for (const rec of this.bodies.values()) {
      if (rec.spec?.kind === "dynamic" && rec.body.bodyType() === this.R.RigidBodyType.Dynamic) continue;
      if (rec.spec?.kind === "static") continue;
      const inst = this.driver.instances.get(rec.name);
      if (!inst) continue;
      const t = inst.t;
      const p = rec.body.translation();
      if (p.x !== t.x || p.y !== t.y || p.z !== t.z) rec.body.setNextKinematicTranslation({ x: t.x, y: t.y, z: t.z });
      rec.body.setNextKinematicRotation(quatFromEuler(t.rx, t.ry, t.rz));
    }
    this.acc = Math.min(this.acc + Math.max(0, dt), this.stepDt * 4);
    let steps = 0;
    while (this.acc >= this.stepDt) {
      this.acc -= this.stepDt;
      for (const rec of this.bodies.values()) {
        const o = rec.order;
        if (!o || rec.spec?.kind !== "dynamic") continue;
        const b = rec.body;
        if (o.vx !== undefined || o.vy !== undefined || o.vz !== undefined) {
          const v = b.linvel();
          b.setLinvel({ x: o.vx ?? v.x, y: o.vy ?? v.y, z: o.vz ?? v.z }, true);
        }
        b.resetForces(false);
        b.resetTorques(false);
        if (o.fx !== undefined || o.fy !== undefined || o.fz !== undefined) b.addForce({ x: o.fx ?? 0, y: o.fy ?? 0, z: o.fz ?? 0 }, true);
        if (o.torque) b.addTorque({ x: o.torque[0], y: o.torque[1], z: o.torque[2] }, true);
        if (o.spin) b.setAngvel({ x: (o.spin[0] * Math.PI) / 180, y: (o.spin[1] * Math.PI) / 180, z: (o.spin[2] * Math.PI) / 180 }, true);
      }
      this.world.step(this.queue);
      this.time += this.stepDt;
      steps++;
      this.drainContacts();
    }
    const moved: string[] = [];
    if (!steps) return moved;
    let awake = 0, dynamic = 0;
    for (const rec of this.bodies.values()) {
      if (rec.spec?.kind !== "dynamic") continue;
      dynamic++;
      const b = rec.body;
      const sleeping = b.isSleeping();
      if (!sleeping) awake++;
      if (sleeping && !rec.wasAwake) continue;
      rec.wasAwake = !sleeping;
      const inst = this.driver.instances.get(rec.name);
      if (!inst) continue;
      const p = b.translation();
      const [rx, ry, rz] = eulerFromQuat(b.rotation());
      Object.assign(inst.t, { x: p.x, y: p.y, z: p.z, rx, ry, rz });
      inst.transformDirty = true;
      moved.push(rec.name);
    }
    if (awake) {
      this.everAwake = true;
      this.restSent = false;
    } else if (dynamic && this.everAwake && !this.restSent) {
      this.restSent = true;
      this.rested = this.state().bodies;
    }
    return moved;
  }

  /**
   * Chocs : seulement au début d'un contact (un objet posé qui pèse sur un autre n'en produit pas), au-delà de
   * `contactMin` (N·s), 32 au plus par pas.
   */
  private drainContacts() {
    const now = this.time;
    const pair = (h1: number, h2: number) => (h1 < h2 ? `${h1}|${h2}` : `${h2}|${h1}`);
    this.queue.drainCollisionEvents((h1, h2, started) => {
      if (started) this.fresh.set(pair(h1, h2), now);
      else this.fresh.delete(pair(h1, h2));
    });
    this.queue.drainContactForceEvents((e) => {
      const h1 = e.collider1(), h2 = e.collider2();
      const key = pair(h1, h2);
      const t0 = this.fresh.get(key);
      if (t0 === undefined || now - t0 > this.stepDt * 3) return;
      const impulse = e.totalForceMagnitude() * this.stepDt;
      if (impulse < this.contactMin || this.contacts.length >= 32) return;
      this.fresh.delete(key);
      const ra = this.byCollider.get(h1) ?? null;
      const rb = this.byCollider.get(h2) ?? null;
      const pa = ra?.body.translation(), pb = rb?.body.translation();
      const p = pa && pb ? { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, z: (pa.z + pb.z) / 2 } : (pa ?? pb ?? { x: 0, y: 0, z: 0 });
      this.contacts.push({ a: ra?.name ?? "", b: rb?.name ?? "", tagsA: ra?.tags ?? ["decor"], tagsB: rb?.tags ?? ["decor"], impulse: +impulse.toFixed(3), x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) });
    });
    if (this.fresh.size > 4096) this.fresh.clear();
  }

  /** Vrai tant qu'un corps dynamique bouge. */
  get active(): boolean {
    for (const rec of this.bodies.values()) if (rec.spec?.kind === "dynamic" && !rec.body.isSleeping()) return true;
    return false;
  }

  state(): RigidState {
    const bodies: Record<string, RigidPose> = {};
    let awake = 0;
    for (const rec of this.bodies.values()) {
      if (rec.spec?.kind !== "dynamic") continue;
      const b = rec.body;
      const p = b.translation(), v = b.linvel();
      const [rx, ry, rz] = eulerFromQuat(b.rotation());
      const r = (x: number) => +x.toFixed(3);
      const d = (x: number) => +((x * 180) / Math.PI).toFixed(1);
      const on = !b.isSleeping();
      if (on) awake++;
      bodies[rec.name] = { x: r(p.x), y: r(p.y), z: r(p.z), rx: d(rx), ry: d(ry), rz: d(rz), vx: r(v.x), vy: r(v.y), vz: r(v.z), awake: on };
    }
    return { time: +this.time.toFixed(3), count: Object.keys(bodies).length, awake, bodies };
  }

  dispose() {
    this.queue.free();
    this.world.free();
    this.bodies.clear();
    this.byCollider.clear();
  }
}

function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
