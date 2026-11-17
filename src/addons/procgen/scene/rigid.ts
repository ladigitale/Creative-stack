/**
 * Physique 3D des scènes `sonic-procgen` sur le moteur commun du format monde (`shared/sim/rigid-core.ts`, Rapier
 * chargé à la demande) : seulement quand la recette a `physics` ou qu'une couche demande un corps.
 *
 * - Objets avec `body` dynamique : formes tirées du maillage (boîte, sphère, cylindre, capsule ou enveloppe convexe),
 *   origine du corps au pied de l'objet, cap de départ ; cinématiques : suivent leur pose (glisser).
 * - Décor : emprises procgen (boîtes des bâtiments et des objets, troncs des arbres, tronçons de clôture et
 *   garde-corps, tabliers des ouvrages en dalles) ; sol = relief (champ de hauteurs) ou plan ; bords de la scène.
 * - Acteurs (personnages, animaux) : capsules cinématiques qui suivent leur marche et poussent les corps.
 * - Eau : flottaison et freinage sous le niveau de l'eau, `splash` à l'entrée.
 * - Zones de la recette : capteurs (`enter` / `leave` d'un corps).
 * Les corps endormis ne coûtent rien ; la scène ne se redessine plus quand tout dort.
 */
import type * as RapierNS from "@dimforge/rapier3d-compat";
import { type BodySpec, type V3 } from "../../../shared/monde/physique";
import { type BodyPose, type ContactEvent, KINEMATIC, type Quat, type R, RigidCore, type ShapeDesc, rotate } from "../../../shared/sim/rigid-core";
import type { ObjectInfo, SceneModel, Zone } from "./compose";

export type PhysEvent = { type: "splash" | "enter" | "leave" | "rest" | "hit"; payload: Record<string, unknown> };

/** Ce que la scène dit des acteurs et des objets saisis (pose voulue, repère du monde ; cap en radians). */
export type RigidIO = {
  actorPose(id: string): { x: number; y: number; z: number; yaw: number; hidden: boolean } | null;
  objectPose(id: string): { x: number; y: number; z: number; yaw: number } | null;
};

/** Boîte locale (repère de l'objet, mètres, échelle comprise) et quelques sommets pour l'enveloppe convexe. */
export type LocalBounds = { lo: V3; hi: V3; pts: Float32Array };

type Dyn = {
  o: ObjectInfo;
  /** Centre local de la forme (repère du corps). */
  c: V3;
  hh: number;
  vol: number;
  ball: boolean;
  wet: boolean;
  zones: Set<string>;
  /** Pied de l'objet au départ et ancres (déplacées avec lui). */
  anchors0: Record<string, V3>;
  pos0: V3;
};

const IDENT: Quat = { x: 0, y: 0, z: 0, w: 1 };
const yawQuat = (yaw: number): Quat => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
const PROPS_ROUND = new Set(["barrel", "bin", "pillar", "bollard", "hydrant", "haystack", "milestone", "beehive"]);
const PLANT_SOLID = new Set(["stump", "log", "cactus", "bamboo"]);
const R3 = (x: number) => Math.round(x * 1000) / 1000;

/** Forme automatique d'un objet dynamique : ballon → sphère, tonneaux → cylindre, assises et outils → enveloppe, sinon boîte. */
export function autoShape(o: Pick<ObjectInfo, "generator" | "params">, spec: BodySpec): BodySpec["shape"] {
  if (spec.shape !== "auto") return spec.shape;
  if (o.generator === "ball") return "sphere";
  if (o.generator === "prop" && PROPS_ROUND.has(String(o.params.kind ?? ""))) return "cylindre";
  if (o.generator === "seat" || o.generator === "tool" || o.generator === "vehicle" || o.generator === "assembly" || o.generator === "container") return "enveloppe";
  return "boite";
}

/** Formes d'un corps dynamique dans son repère (pied de l'objet). */
export function dynShapes(o: ObjectInfo, spec: BodySpec, b: LocalBounds | null): ShapeDesc[] {
  const lo: V3 = b?.lo ?? [-o.footprint.hx, 0, -o.footprint.hz];
  const hi: V3 = b?.hi ?? [o.footprint.hx, o.height, o.footprint.hz];
  const c: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const h: V3 = [Math.max(0.01, (hi[0] - lo[0]) / 2), Math.max(0.01, (hi[1] - lo[1]) / 2), Math.max(0.01, (hi[2] - lo[2]) / 2)];
  const shape = autoShape(o, spec);
  if (shape === "sphere") {
    const ph = (o.physics ?? {}) as { radius?: number };
    const r = ph.radius ? ph.radius * o.scale : Math.max(h[0], h[1], h[2]);
    // ballon écrasé ou ovale couché : centre à sa hauteur réelle
    return [{ kind: "ball", c: [c[0], Math.max(r * 0.5, Math.min(c[1], r)), c[2]], q: IDENT, h: [r, r, r] }];
  }
  if (shape === "cylindre") return [{ kind: "cyl", c, q: IDENT, h: [Math.max(h[0], h[2]), h[1], Math.max(h[0], h[2])] }];
  if (shape === "capsule") return [{ kind: "capsule", c, q: IDENT, h: [Math.max(h[0], h[2]), h[1], Math.max(h[0], h[2])] }];
  if (shape === "enveloppe" && b && b.pts.length >= 12) return [{ kind: "hull", c: [0, 0, 0], q: IDENT, h, pts: b.pts }];
  return [{ kind: "box", c, q: IDENT, h }];
}

/** Formes du décor (repère de l'objet : pied, cap) : rien pour l'herbe, les fleurs, l'eau ; troncs ; boîtes. */
export function obstacleShapes(o: ObjectInfo): ShapeDesc[] {
  const g = o.generator;
  if (o.walkable || g === "grass" || g === "flowers" || g === "water" || o.mode === "actor") return [];
  if (g === "plant" && !PLANT_SOLID.has(String(o.params.species ?? ""))) return [];
  if (o.blockers || g === "structure") return [];
  const hx = Math.max(0.02, o.footprint.hx), hz = Math.max(0.02, o.footprint.hz), H = Math.max(0.04, o.height);
  if (g === "tree") {
    const r = Math.min(0.6, Math.max(0.1, o.footprint.r * 0.1));
    return [{ kind: "cyl", c: [0, H * 0.25, 0], q: IDENT, h: [r, H * 0.25, r] }];
  }
  if (g === "ball") {
    const r = Math.max(0.02, H / 2);
    return [{ kind: "ball", c: [0, r, 0], q: IDENT, h: [r, r, r] }];
  }
  return [{ kind: "box", c: [0, H / 2, 0], q: IDENT, h: [hx, H / 2, hz] }];
}

export class ProcgenRigid extends RigidCore {
  private dyn = new Map<string, Dyn>();
  private awake = new Set<string>();
  private waterY: number | null;
  private zones: Zone[];
  /** Pose visée d'un corps dynamique saisi au doigt. */
  readonly dragTarget = new Map<string, BodyPose>();
  /** Événements de la scène depuis la dernière lecture (eau, capteurs, ballons). */
  events: PhysEvent[] = [];
  private actorIds = new Set<string>();

  constructor(R: R, private model: SceneModel, private io: RigidIO, bounds: (o: ObjectInfo) => LocalBounds | null) {
    const spec = model.physics!;
    super(R, spec);
    const scene = model.physicsScene ?? { water: true, walls: true };
    this.waterY = scene.water && model.terrain?.spec.water !== undefined && model.terrain?.spec.water !== null ? model.terrain.spec.water : null;
    this.zones = model.zones ?? [];
    const [W, D] = model.size;
    // sol : relief en champ de hauteurs (une maille par mètre environ, 128 au plus), sinon plan
    if (spec.ground) {
      if (model.terrain) {
        const nx = Math.max(8, Math.min(128, Math.ceil(W))), nz = Math.max(8, Math.min(128, Math.ceil(D)));
        const h = new Float32Array((nx + 1) * (nz + 1));
        // colonne j le long de x, ligne i le long de z (ordre de Rapier : lignes = z)
        for (let j = 0; j <= nx; j++) for (let i = 0; i <= nz; i++) h[j * (nz + 1) + i] = model.terrain.height(-W / 2 + (j / nx) * W, -D / 2 + (i / nz) * D);
        const body = this.world.createRigidBody(R.RigidBodyDesc.fixed());
        const c = this.world.createCollider(R.ColliderDesc.heightfield(nz, nx, h, { x: W, y: 1, z: D }).setFriction(0.8), body);
        this.byCollider.set(c.handle, null);
        this.labelOf.set(c.handle, { name: "", tags: ["sol"] });
      } else this.addPlaneGround(0);
    }
    // bords de la scène : les corps restent dedans
    if (scene.walls) {
      const T = 0.5, Hh = 20;
      this.addFixed([
        { kind: "box", c: [0, Hh / 2, -D / 2 - T], q: IDENT, h: [W / 2 + 2 * T, Hh, T] },
        { kind: "box", c: [0, Hh / 2, D / 2 + T], q: IDENT, h: [W / 2 + 2 * T, Hh, T] },
        { kind: "box", c: [-W / 2 - T, Hh / 2, 0], q: IDENT, h: [T, Hh, D / 2 + 2 * T] },
        { kind: "box", c: [W / 2 + T, Hh / 2, 0], q: IDENT, h: [T, Hh, D / 2 + 2 * T] },
      ], null, { name: "", tags: ["bord"] }, 0.5);
    }
    // tabliers, marches, quais : dalles le long du profil
    for (const d of model.decks ?? []) {
      const q0 = yawQuat(d.yaw);
      const shapes: ShapeDesc[] = [];
      for (let k = 0; k + 1 < d.profile.length && shapes.length < 24; k++) {
        const [z0, y0] = d.profile[k], [z1, y1] = d.profile[k + 1];
        const dz = (z1 - z0) * d.scale, dy = (y1 - y0) * d.scale;
        const L = Math.hypot(dz, dy);
        if (L < 1e-3) continue;
        const a = Math.atan2(dy, dz);
        // rotation autour de x de -a : l'avant local (z) suit la pente
        const qp: Quat = { x: Math.sin(-a / 2), y: 0, z: 0, w: Math.cos(-a / 2) };
        const n: V3 = [0, Math.cos(a), -Math.sin(a)];
        shapes.push({ kind: "box", c: [0, ((y0 + y1) / 2) * d.scale - n[1] * 0.06, ((z0 + z1) / 2) * d.scale - n[2] * 0.06], q: qp, h: [d.hw * d.scale, 0.06, L / 2 + 0.02] });
      }
      if (shapes.length) this.addFixed(shapes, { x: d.x, y: d.y, z: d.z, q: q0 }, { name: "", tags: ["ouvrage"] }, 0.8);
    }
    for (const o of model.objects) {
      if (o.mode === "actor") continue;
      const tags = [o.layer, o.generator];
      if (o.body && o.body.kind !== "static") {
        this.addDynamic(o, o.body, bounds(o), tags);
        continue;
      }
      const at: BodyPose = { x: o.pos[0], y: o.pos[1], z: o.pos[2], q: yawQuat(o.yaw) };
      const label = { name: o.id, tags };
      // clôtures, garde-corps, piles : une boîte par tronçon, à la hauteur de l'objet (garde-corps : 1,1 m)
      if (o.blockers?.length) {
        const H = o.generator === "structure" ? 1.1 : Math.max(0.3, o.height);
        const shapes: ShapeDesc[] = o.blockers.slice(0, 64).map(([bx, bz, bhx, bhz, yaw]) => {
          // repère de l'objet : décalage tourné de -cap, cap relatif
          const dx = bx - o.pos[0], dz = bz - o.pos[2];
          const c = Math.cos(-o.yaw), s = Math.sin(-o.yaw);
          return { kind: "box", c: [dx * c + dz * s, H / 2, -dx * s + dz * c], q: yawQuat(yaw - o.yaw), h: [bhx, H / 2, bhz] };
        });
        this.addFixed(shapes, at, label, o.body?.friction ?? 0.7);
        continue;
      }
      const shapes = obstacleShapes(o);
      if (!shapes.length) continue;
      // un objet posé par point se glisse au doigt : corps nommé (figé, saisissable) ; le reste : décor figé
      if (o.place === "at" || o.body) this.addBody(o.id, o.body ?? { ...KINEMATIC, kind: "static", friction: 0.7 }, at, shapes, tags);
      else this.addFixed(shapes, at, label, 0.7);
    }
    // acteurs : capsules cinématiques
    for (const a of model.actors) {
      const r = Math.max(0.12, Math.min(0.5, a.asset.footprint.r * 0.45));
      const H = Math.max(0.3, a.asset.height);
      if (this.addBody(a.id, null, { x: a.pos[0], y: a.pos[1], z: a.pos[2], q: yawQuat(a.yaw) }, [{ kind: "capsule", c: [0, H / 2, 0], q: IDENT, h: [r, H / 2, r] }], [a.layer ?? "actors", a.asset.generator, "acteur"])) this.actorIds.add(a.id);
    }
    for (const j of spec.joints) this.addJoint(j);
    if (spec.paused) for (const id of this.dyn.keys()) this.bodies.get(id)?.body.sleep();
    else for (const id of this.dyn.keys()) this.awake.add(id);
  }

  private addDynamic(o: ObjectInfo, spec: BodySpec, b: LocalBounds | null, tags: string[]) {
    const shapes = dynShapes(o, spec, b);
    const rec = this.addBody(o.id, spec, { x: o.pos[0], y: o.pos[1], z: o.pos[2], q: yawQuat(o.yaw) }, shapes, tags);
    if (!rec) return;
    const s = shapes[0];
    const ball = s.kind === "ball";
    const lo = b?.lo ?? [-o.footprint.hx, 0, -o.footprint.hz], hi = b?.hi ?? [o.footprint.hx, o.height, o.footprint.hz];
    const c: V3 = ball ? s.c : [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const hh = ball ? s.h[0] : Math.max(0.01, (hi[1] - lo[1]) / 2);
    const vol = ball ? (4 / 3) * Math.PI * s.h[0] ** 3 : Math.max(1e-5, (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]) * (s.kind === "cyl" ? Math.PI / 4 : s.kind === "hull" ? 0.5 : 1));
    const zones = new Set(this.zones.filter((zn) => inside(zn, o.pos[0], o.pos[2])).map((zn) => zn.id));
    this.dyn.set(o.id, { o, c, hh, vol, ball, wet: false, zones, anchors0: Object.fromEntries(Object.entries(o.anchors).map(([k, v]) => [k, [...v] as V3])), pos0: [...o.pos] });
  }

  /** Corps dynamiques (ids). */
  get dynamicIds(): string[] {
    return [...this.dyn.keys()];
  }
  isDynamic(id: string) {
    return this.dyn.has(id);
  }
  isBall(id: string) {
    return !!this.dyn.get(id)?.ball;
  }

  /** Pose courante d'un corps (origine au pied de l'objet de départ). */
  pose(id: string): BodyPose | null {
    const b = this.bodies.get(id)?.body;
    if (!b) return null;
    const p = b.translation();
    return { x: p.x, y: p.y, z: p.z, q: b.rotation() };
  }

  /** Centre d'un corps dynamique (monde) et rayon d'un ballon. */
  center(id: string): { pos: V3; r: number } | null {
    const d = this.dyn.get(id);
    const b = this.bodies.get(id)?.body;
    if (!d || !b) return null;
    const p = b.translation();
    const c = rotate(b.rotation(), d.c);
    return { pos: [p.x + c[0], p.y + c[1], p.z + c[2]], r: d.hh };
  }

  /** Coup (vitesse ajoutée, m/s, norme bornée à 40). */
  kickBody(id: string, v: V3): boolean {
    const rec = this.bodies.get(id);
    if (!rec || !this.dyn.has(id) || rec.body.bodyType() !== this.R.RigidBodyType.Dynamic) return false;
    const cur = rec.body.linvel();
    let n: V3 = [cur.x + (Number.isFinite(v[0]) ? v[0] : 0), cur.y + (Number.isFinite(v[1]) ? v[1] : 0), cur.z + (Number.isFinite(v[2]) ? v[2] : 0)];
    const s = Math.hypot(n[0], n[1], n[2]);
    if (s > 40) n = [(n[0] * 40) / s, (n[1] * 40) / s, (n[2] * 40) / s];
    rec.body.setLinvel({ x: n[0], y: n[1], z: n[2] }, true);
    this.restSent = false;
    return true;
  }

  /** Corps caché (`hidden`) : hors simulation. */
  setHidden(ids: Set<string>) {
    for (const [id, rec] of this.bodies) {
      if (!this.dyn.has(id)) continue;
      const off = ids.has(id);
      if (rec.body.isEnabled() === !off) continue;
      rec.body.setEnabled(!off);
    }
  }

  /** Reprend la pose d'une simulation précédente (recomposition de la même scène). */
  restore(id: string, p: BodyPose) {
    const rec = this.bodies.get(id);
    if (!rec || !this.dyn.has(id)) return;
    rec.body.setTranslation({ x: p.x, y: p.y, z: p.z }, false);
    rec.body.setRotation(p.q, false);
    rec.body.sleep();
    this.awake.delete(id);
    this.writePose(id, { x: p.x, y: p.y, z: p.z }, p.q);
  }

  protected readPose(name: string): BodyPose | null {
    const t = this.dragTarget.get(name);
    if (t) return t;
    if (this.actorIds.has(name)) {
      const a = this.io.actorPose(name);
      if (!a) return null;
      return a.hidden ? { x: a.x, y: -1000, z: a.z, q: IDENT } : { x: a.x, y: a.y, z: a.z, q: yawQuat(a.yaw) };
    }
    const o = this.io.objectPose(name);
    return o ? { x: o.x, y: o.y, z: o.z, q: yawQuat(o.yaw) } : null;
  }

  /** Le pied et le cap de l'objet suivent le corps ; ses ancres glissent avec lui. */
  protected writePose(name: string, p: { x: number; y: number; z: number }, q: Quat) {
    const d = this.dyn.get(name);
    if (!d) return;
    const c = rotate(q, d.c);
    const o = d.o;
    const nx = p.x + c[0], ny = p.y + c[1] - d.c[1], nz = p.z + c[2];
    const f = rotate(q, [0, 0, 1]);
    o.pos = [nx, ny, nz];
    if (Math.hypot(f[0], f[2]) > 0.2) o.yaw = Math.atan2(f[0], f[2]);
    for (const [k, v] of Object.entries(d.anchors0)) o.anchors[k] = [v[0] + nx - d.pos0[0], v[1] + ny - d.pos0[1], v[2] + nz - d.pos0[2]];
  }

  /** Flottaison : poussée proportionnelle à la part immergée, freinage dans l'eau. */
  protected beforeStep(h: number) {
    const wy = this.waterY;
    for (const [id, d] of this.dyn) {
      const b = this.bodies.get(id)?.body;
      if (!b || b.isSleeping() || !b.isEnabled() || b.bodyType() !== this.R.RigidBodyType.Dynamic) continue;
      {
        // repos : un corps presque immobile (ballon qui roule lentement, chaise qui glisse d'un rien sur une pente)
        // est freiné jusqu'à l'arrêt, sans réveil, pour que le moteur l'endorme
        const v = b.linvel();
        const w = b.angvel();
        const sp = Math.hypot(v.x, v.y, v.z);
        if (Math.abs(v.y) < 0.08 && sp < (d.ball ? 0.35 : 0.12) && Math.hypot(w.x, w.y, w.z) < (d.ball ? 4 : 0.6)) {
          const k = Math.max(0, 1 - 4 * h);
          b.setLinvel({ x: v.x * k, y: v.y, z: v.z * k }, false);
          b.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, false);
        }
      }
      if (wy === null) continue;
      const p = b.translation();
      const c = rotate(b.rotation(), d.c);
      const cy = p.y + c[1];
      const f = Math.max(0, Math.min(1, (wy - (cy - d.hh)) / (2 * d.hh)));
      if (f <= 0) {
        d.wet = false;
        continue;
      }
      const v = b.linvel();
      if (!d.wet) {
        d.wet = true;
        if (v.y < -0.5) this.events.push({ type: "splash", payload: { body: id, x: R3(p.x + c[0]), z: R3(p.z + c[2]), speed: R3(Math.hypot(v.x, v.y, v.z)) } });
      }
      // freinage d'abord (il relit la vitesse), puis poussée ; l'eau freine fort (pas de rebonds hors de l'eau)
      const k = Math.max(0, 1 - f * 4 * h);
      b.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, false);
      const w = b.angvel();
      b.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, false);
      // poussée d'Archimède proportionnelle à la part immergée ; densité de l'eau ramenée à 3 fois celle de l'objet
      // au plus (objet très léger : il flotte bien haut sans jaillir ni rebondir sur la surface)
      const rho = Math.min(1000, (3 * b.mass()) / d.vol);
      const lift = f * d.vol * rho * 9.81 * h;
      b.applyImpulseAtPoint({ x: 0, y: lift, z: 0 }, { x: p.x + c[0], y: cy, z: p.z + c[2] }, false);
    }
  }

  /**
   * Avance la scène : pas du moteur, puis capteurs (zones) des corps qui bougent, repos de chaque ballon, contacts
   * acteur-ballon (`hit`). Rend les ids déplacés.
   */
  stepScene(dt: number): string[] {
    const moved = this.step(dt);
    for (const id of moved) {
      const d = this.dyn.get(id);
      if (!d) continue;
      this.awake.add(id);
      if (!this.zones.length) continue;
      const [x, , z] = d.o.pos;
      for (const zn of this.zones) {
        const inz = inside(zn, x, z);
        if (inz && !d.zones.has(zn.id)) {
          d.zones.add(zn.id);
          this.events.push({ type: "enter", payload: { zone: zn.id, body: id, actor: null, ...(d.ball ? { ball: id } : {}) } });
        } else if (!inz && d.zones.has(zn.id)) {
          d.zones.delete(zn.id);
          this.events.push({ type: "leave", payload: { zone: zn.id, body: id, actor: null, ...(d.ball ? { ball: id } : {}) } });
        }
      }
    }
    for (const id of [...this.awake]) {
      const b = this.bodies.get(id)?.body;
      if (b && !b.isSleeping()) continue;
      this.awake.delete(id);
      const d = this.dyn.get(id);
      if (d?.ball) this.events.push({ type: "rest", payload: { ball: id, x: Math.round(d.o.pos[0] * 100) / 100, z: Math.round(d.o.pos[2] * 100) / 100 } });
    }
    for (const c of this.contacts) {
      const ball = this.dyn.get(c.a)?.ball ? c.a : this.dyn.get(c.b)?.ball ? c.b : null;
      const actor = this.actorIds.has(c.a) ? c.a : this.actorIds.has(c.b) ? c.b : null;
      if (ball && actor) this.events.push({ type: "hit", payload: { ball, actor } });
    }
    return moved;
  }

  /** Corps dynamiques qui bougent encore (ou saisis). */
  get moving(): boolean {
    return this.active || this.dragTarget.size > 0;
  }

  /**
   * Requête `{n, ray: {from, dir, max}}`, `{sphere: {at, r}}` ou `{box: {lo, hi}}`, `ignore` (ids), `mask`
   * (étiquettes : calque, générateur, `sol`, `acteur`) : premier objet touché (rayon) ou tout ce qui chevauche (16).
   */
  query(q: Record<string, unknown>): Record<string, unknown> {
    const R = this.R;
    const v3 = (x: unknown): V3 | null => (Array.isArray(x) && x.length >= 3 && x.slice(0, 3).every((v) => typeof v === "number" && Number.isFinite(v)) ? [x[0], x[1], x[2]] : null);
    const list = (x: unknown) => (Array.isArray(x) ? x.map(String) : typeof x === "string" ? [x] : []);
    const ignore = new Set(list(q.ignore));
    const mask = list(q.mask);
    const who = (c: RapierNS.Collider) => {
      const rec = this.byCollider.get(c.handle) ?? null;
      const lab = this.labelOf.get(c.handle);
      const name = rec?.name ?? lab?.name ?? "";
      const tags = rec?.tags ?? lab?.tags ?? ["sol"];
      return { name, tags };
    };
    const ok = (c: RapierNS.Collider) => {
      const w = who(c);
      if (w.name && ignore.has(w.name)) return false;
      if (w.tags.some((t) => ignore.has(t))) return false;
      return !mask.length || mask.includes(w.name) || w.tags.some((t) => mask.includes(t));
    };
    const ray = q.ray && typeof q.ray === "object" ? (q.ray as Record<string, unknown>) : null;
    if (ray) {
      const from = v3(ray.from), dir = v3(ray.dir);
      if (!from || !dir) return { hit: false };
      const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      const max = typeof ray.max === "number" && ray.max > 0 ? Math.min(1000, ray.max) : 100;
      const hit = this.world.castRayAndGetNormal(new R.Ray({ x: from[0], y: from[1], z: from[2] }, { x: dir[0] / l, y: dir[1] / l, z: dir[2] / l }), max, true, undefined, undefined, undefined, undefined, ok);
      if (!hit) return { hit: false };
      const w = who(hit.collider);
      const t = hit.timeOfImpact ?? (hit as unknown as { toi: number }).toi;
      return { hit: true, objectId: w.name || null, tags: w.tags, x: R3(from[0] + (dir[0] / l) * t), y: R3(from[1] + (dir[1] / l) * t), z: R3(from[2] + (dir[2] / l) * t), normal: [R3(hit.normal.x), R3(hit.normal.y), R3(hit.normal.z)], dist: R3(t) };
    }
    const sp = q.sphere && typeof q.sphere === "object" ? (q.sphere as Record<string, unknown>) : null;
    const bx = q.box && typeof q.box === "object" ? (q.box as Record<string, unknown>) : null;
    let shape: RapierNS.Shape | null = null;
    let at: V3 | null = null;
    if (sp) {
      at = v3(sp.at);
      shape = new R.Ball(Math.max(0.01, Math.min(100, Number(sp.r) || 1)));
    } else if (bx) {
      const lo = v3(bx.lo), hi = v3(bx.hi);
      if (lo && hi) {
        at = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
        shape = new R.Cuboid(Math.max(0.01, Math.abs(hi[0] - lo[0]) / 2), Math.max(0.01, Math.abs(hi[1] - lo[1]) / 2), Math.max(0.01, Math.abs(hi[2] - lo[2]) / 2));
      }
    }
    if (!shape || !at) return { hit: false };
    const all: string[] = [];
    this.world.intersectionsWithShape({ x: at[0], y: at[1], z: at[2] }, IDENT, shape, (c) => {
      const w = who(c);
      if (w.name && !all.includes(w.name)) all.push(w.name);
      return all.length < 16;
    }, undefined, undefined, undefined, undefined, ok);
    return { hit: all.length > 0, objectId: all[0] ?? null, all };
  }

  /** Chocs : contacts du moteur, plus étiquettes de l'objet. */
  takeContacts(): ContactEvent[] {
    const c = this.contacts;
    this.contacts = [];
    return c;
  }

  takeEvents(): PhysEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** État publié (200 corps au plus). */
  snapshot() {
    const s = this.state();
    const keys = Object.keys(s.bodies);
    if (keys.length > 200) for (const k of keys.slice(200)) delete s.bodies[k];
    return s;
  }
}

function inside(zn: Zone, x: number, z: number) {
  return zn.box ? x >= zn.box[0] && x <= zn.box[2] && z >= zn.box[1] && z <= zn.box[3] : Math.hypot(x - zn.x, z - zn.z) <= zn.r;
}

/** Boîte locale et sommets (96 au plus) d'un maillage d'objet, à l'échelle. */
export function meshBounds(pos: ArrayLike<number>, scale: number): LocalBounds {
  const n = Math.floor(pos.length / 3);
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++) {
      const v = pos[i * 3 + a] * scale;
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
  if (!n) return { lo: [0, 0, 0], hi: [0, 0, 0], pts: new Float32Array(0) };
  const step = Math.max(1, Math.floor(n / 88));
  const pts: number[] = [];
  for (let i = 0; i < n; i += step) pts.push(pos[i * 3] * scale, pos[i * 3 + 1] * scale, pos[i * 3 + 2] * scale);
  // coins de la boîte en bas : l'objet repose bien à plat
  for (const [x, z] of [[lo[0], lo[2]], [hi[0], lo[2]], [lo[0], hi[2]], [hi[0], hi[2]]]) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 400))) {
      const d = Math.hypot(pos[i * 3] * scale - x, pos[i * 3 + 2] * scale - z) + (pos[i * 3 + 1] * scale - lo[1]) * 2;
      if (d < bd) (bd = d), (best = i);
    }
    if (best >= 0) pts.push(pos[best * 3] * scale, pos[best * 3 + 1] * scale, pos[best * 3 + 2] * scale);
  }
  return { lo, hi, pts: new Float32Array(pts) };
}
