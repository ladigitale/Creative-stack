/**
 * Monde physique 2D (planck.js, portage de Box2D) piloté par des descriptions
 * de corps (attributs SDUI ou liste en DataProvider). Sans DOM : testable seul.
 *
 * Unités « monde » = pixels de la scène (y vers le bas) ; planck travaille en
 * mètres (`scale` pixels par mètre). Angles en degrés, vitesses en px/s.
 */
import {
  BoxShape,
  ChainShape,
  CircleShape,
  DistanceJoint,
  EdgeShape,
  MouseJoint,
  PolygonShape,
  PrismaticJoint,
  RevoluteJoint,
  RopeJoint,
  Vec2,
  WeldJoint,
  World,
  type Body,
  type Contact,
  type Fixture,
  type Joint,
} from "planck";

export type BodySpec = {
  name: string;
  type: "dynamic" | "static" | "kinematic";
  shape: "circle" | "box" | "polygon" | "edge" | "chain";
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  /** Polygone / segment / chaîne : points relatifs au centre. */
  points: [number, number][];
  loop: boolean;
  angle: number;
  vx: number;
  vy: number;
  spin: number;
  density: number;
  friction: number;
  restitution: number;
  sensor: boolean;
  bullet: boolean;
  fixedRotation: boolean;
  damping: number;
  angularDamping: number;
  gravityScale: number;
  group: string;
  collides: string;
  tags: string[];
  clampX: [number, number] | null;
  clampY: [number, number] | null;
  /** Rendu intégré. */
  fill: string;
  stroke: string;
  line: number;
  label: string;
  hidden: boolean;
};

export type JointSpec = {
  type: "revolute" | "distance" | "prismatic" | "weld" | "rope";
  a: string;
  b: string;
  /** Point d'ancrage (monde) ; défaut : centre de a. */
  x: number | null;
  y: number | null;
  /** Second ancrage (distance, rope) ; défaut : centre de b. */
  x2: number | null;
  y2: number | null;
  /** distance : ressort (Hz, amortissement) ; rope : longueur max. */
  frequency: number;
  damping: number;
  length: number | null;
  /** revolute / prismatic : moteur et limites. */
  motorSpeed: number | null;
  maxTorque: number;
  lower: number | null;
  upper: number | null;
  axis: [number, number];
  collide: boolean;
};

export type PhysicsEvent =
  | { type: "collide"; a: string; b: string; tagsA: string[]; tagsB: string[]; impulse: number; x: number; y: number }
  | { type: "enter" | "leave"; sensor: string; body: string; tags: string[] }
  | { type: "out"; body: string; tags: string[]; side: "left" | "right" | "top" | "bottom" };

export type BodyState = { x: number; y: number; angle: number; vx: number; vy: number; awake: boolean };

export type Drive = {
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
  torque?: number;
  spin?: number;
  /** Impulsion unique quand `n` augmente. */
  impulse?: { n?: number; x?: number; y?: number };
  /** Placement unique quand `n` augmente (position, vitesse, angle). */
  set?: { n?: number; x?: number; y?: number; vx?: number; vy?: number; angle?: number };
};

type BodyData = { name: string; spec: BodySpec; key: string; out: boolean };

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* Lecture des descriptions (attributs ou JSON)                         */
/* ------------------------------------------------------------------ */

const num = (v: unknown, d: number): number => {
  if (v === undefined || v === null || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v: unknown): boolean => v === true || v === "" || v === "true" || v === 1 || v === "1";
const pair = (v: unknown): [number, number] | null => {
  if (Array.isArray(v) && v.length >= 2) return [num(v[0], 0), num(v[1], 0)];
  if (typeof v === "string" && v.trim()) {
    const p = v.trim().split(/[\s,]+/).map(Number);
    if (p.length >= 2 && p.every(Number.isFinite)) return [p[0], p[1]];
  }
  return null;
};
const points = (v: unknown): [number, number][] => {
  if (Array.isArray(v)) return v.map((p) => pair(p)).filter((p): p is [number, number] => !!p);
  if (typeof v !== "string") return [];
  return v
    .trim()
    .split(/\s+/)
    .map((p) => pair(p.replace(/,/g, " ")))
    .filter((p): p is [number, number] => !!p);
};

/** Clé normalisée : `fixed-rotation`, `fixedRotation` → `fixedrotation`. */
const norm = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase().replace(/[-_]/g, ""), v]));

export function parseBody(raw: Record<string, unknown>, fallbackName: string): { spec: BodySpec; errors: string[] } {
  const o = norm(raw);
  const errors: string[] = [];
  const name = String(o.name ?? o.id ?? "").trim() || fallbackName;
  const type = (["dynamic", "static", "kinematic"].includes(String(o.type)) ? o.type : "dynamic") as BodySpec["type"];
  const shapeRaw = String(o.shape ?? (o.r !== undefined ? "circle" : "box"));
  const shape = (["circle", "box", "polygon", "edge", "chain"].includes(shapeRaw) ? shapeRaw : "box") as BodySpec["shape"];
  if (shapeRaw !== shape) errors.push(`${name} : forme "${shapeRaw}" inconnue (circle, box, polygon, edge, chain)`);
  const pts = points(o.points);
  if (shape === "polygon" && (pts.length < 3 || pts.length > 8)) errors.push(`${name} : un polygon demande 3 à 8 points`);
  if ((shape === "edge" && pts.length !== 2) || (shape === "chain" && pts.length < 2)) errors.push(`${name} : ${shape} demande ${shape === "edge" ? "2" : "au moins 2"} points`);
  const tags = (Array.isArray(o.tags) ? o.tags.map(String) : String(o.tags ?? "").split(/[\s,]+/)).filter(Boolean);
  return {
    spec: {
      name,
      type,
      shape,
      x: num(o.x, 0),
      y: num(o.y, 0),
      w: Math.max(0.5, num(o.w, 40)),
      h: Math.max(0.5, num(o.h, 40)),
      r: Math.max(0.5, num(o.r, 20)),
      points: pts,
      loop: bool(o.loop),
      angle: num(o.angle, 0),
      vx: num(o.vx, 0),
      vy: num(o.vy, 0),
      spin: num(o.spin, 0),
      density: Math.max(0, num(o.density, 1)),
      friction: Math.max(0, num(o.friction, 0.3)),
      restitution: Math.max(0, num(o.restitution, 0)),
      sensor: bool(o.sensor),
      bullet: bool(o.bullet),
      fixedRotation: bool(o.fixedrotation),
      damping: Math.max(0, num(o.damping, 0)),
      angularDamping: Math.max(0, num(o.angulardamping, 0)),
      gravityScale: num(o.gravityscale, 1),
      group: String(o.group ?? "").trim(),
      collides: String(o.collides ?? "all").trim() || "all",
      tags,
      clampX: pair(o.clampx),
      clampY: pair(o.clampy),
      fill: String(o.fill ?? ""),
      stroke: String(o.stroke ?? ""),
      line: Math.max(0, num(o.line, 1.5)),
      label: String(o.label ?? ""),
      hidden: bool(o.hidden),
    },
    errors,
  };
}

export function parseJoint(raw: Record<string, unknown>, index: number): { spec: JointSpec | null; errors: string[] } {
  const o = norm(raw);
  const type = String(o.type ?? "revolute");
  if (!["revolute", "distance", "prismatic", "weld", "rope"].includes(type)) {
    return { spec: null, errors: [`joint#${index + 1} : type "${type}" inconnu (revolute, distance, prismatic, weld, rope)`] };
  }
  const a = String(o.a ?? "").trim();
  const b = String(o.b ?? "").trim();
  if (!a || !b) return { spec: null, errors: [`joint#${index + 1} : a et b (noms de corps) requis`] };
  const at = pair(o.at ?? o.anchor);
  const at2 = pair(o.to ?? o.anchor2);
  return {
    spec: {
      type: type as JointSpec["type"],
      a,
      b,
      x: at ? at[0] : null,
      y: at ? at[1] : null,
      x2: at2 ? at2[0] : null,
      y2: at2 ? at2[1] : null,
      frequency: Math.max(0, num(o.frequency ?? o.hz, 0)),
      damping: Math.max(0, num(o.damping, 0.5)),
      length: o.length !== undefined ? num(o.length, 0) : null,
      motorSpeed: o.motorspeed !== undefined || o.motor !== undefined ? num(o.motorspeed ?? o.motor, 0) : null,
      maxTorque: num(o.maxtorque ?? o.maxforce, 1000),
      lower: o.lower !== undefined ? num(o.lower, 0) : null,
      upper: o.upper !== undefined ? num(o.upper, 0) : null,
      axis: pair(o.axis) ?? [1, 0],
      collide: bool(o.collide),
    },
    errors: [],
  };
}

/* ------------------------------------------------------------------ */
/* Monde                                                                */
/* ------------------------------------------------------------------ */

export type WorldOptions = {
  width: number;
  height: number;
  /** Pixels par mètre (stabilité : objets de 0,1 à 10 m). */
  scale: number;
  /** m/s², y vers le bas. */
  gravity: [number, number];
  /** Murs automatiques : none, walls (4 côtés), box (gauche, droite, haut), floor. */
  bounds: "none" | "walls" | "box" | "floor";
  /** Impulsion minimale (N·s) pour signaler un choc. */
  collideMin: number;
  /** Marge (px) au-delà du monde avant un événement `out`. */
  outMargin: number;
};

export class PhysicsWorld {
  readonly world: World;
  opts: WorldOptions;
  readonly bodies = new Map<string, Body>();
  readonly specs = new Map<string, BodySpec>();
  private joints: Joint[] = [];
  private ground: Body;
  private wallBodies: Body[] = [];
  private categories = new Map<string, number>();
  private events: PhysicsEvent[] = [];
  private begun: { contact: Contact; a: Fixture; b: Fixture }[] = [];
  private impulses = new Map<Contact, number>();
  private counters = new Map<string, number>();
  private mouse: MouseJoint | null = null;
  errors: string[] = [];
  time = 0;
  steps = 0;
  collisions = 0;

  constructor(opts: WorldOptions) {
    this.opts = opts;
    this.world = new World({ gravity: Vec2(opts.gravity[0], opts.gravity[1]) });
    this.ground = this.world.createBody();
    this.setBounds(opts.bounds);
    this.world.on("begin-contact", (c: Contact) => {
      const a = c.getFixtureA();
      const b = c.getFixtureB();
      this.begun.push({ contact: c, a, b });
    });
    this.world.on("end-contact", (c: Contact) => {
      const a = c.getFixtureA();
      const b = c.getFixtureB();
      if (a.isSensor() === b.isSensor()) return;
      const [sensor, other] = a.isSensor() ? [a, b] : [b, a];
      const s = this.dataOf(sensor.getBody());
      const o = this.dataOf(other.getBody());
      if (s && o) this.events.push({ type: "leave", sensor: s.name, body: o.name, tags: [...o.spec.tags] });
    });
    this.world.on("post-solve", (c: Contact, imp) => {
      const n = Math.max(0, ...imp.normalImpulses);
      this.impulses.set(c, Math.max(this.impulses.get(c) ?? 0, n));
    });
  }

  /* --- unités --- */

  private m(px: number): number {
    return px / this.opts.scale;
  }

  private px(m: number): number {
    return m * this.opts.scale;
  }

  private v(x: number, y: number): Vec2 {
    return Vec2(this.m(x), this.m(y));
  }

  private dataOf(b: Body): BodyData | null {
    return (b.getUserData() as BodyData | null) ?? null;
  }

  setGravity(g: [number, number]): void {
    this.opts.gravity = g;
    this.world.setGravity(Vec2(g[0], g[1]));
  }

  setBounds(bounds: WorldOptions["bounds"]): void {
    for (const b of this.wallBodies) this.world.destroyBody(b);
    this.wallBodies = [];
    this.opts.bounds = bounds;
    if (bounds === "none") return;
    const { width: w, height: h } = this.opts;
    const segs: [number, number, number, number, string][] = [];
    if (bounds !== "floor") segs.push([0, 0, 0, h, "left"], [w, 0, w, h, "right"], [0, 0, w, 0, "top"]);
    if (bounds === "walls" || bounds === "floor") segs.push([0, h, w, h, "bottom"]);
    for (const [x1, y1, x2, y2, name] of segs) {
      const body = this.world.createBody();
      body.createFixture(new EdgeShape(this.v(x1, y1), this.v(x2, y2)), { friction: 0.3 });
      const { spec } = parseBody({ name: `wall-${name}`, type: "static", tags: "wall" }, name);
      body.setUserData({ name: spec.name, spec, key: "", out: false } satisfies BodyData);
      this.wallBodies.push(body);
    }
  }

  private category(name: string): number {
    if (!name) return 0x0001;
    let c = this.categories.get(name);
    if (c === undefined) {
      if (this.categories.size >= 15) {
        this.errors.push(`groupes de collision : 15 au plus ("${name}" ignoré)`);
        return 0x0001;
      }
      c = 1 << (this.categories.size + 1);
      this.categories.set(name, c);
    }
    return c;
  }

  private mask(collides: string): number {
    if (collides === "all") return 0xffff;
    if (collides === "none") return 0;
    let m = 0;
    for (const n of collides.split(/[\s,]+/).filter(Boolean)) m |= n === "default" ? 0x0001 : this.category(n);
    return m;
  }

  /** Clé de comparaison : ce qui oblige à recréer le corps (forme, type, matière). */
  private static shapeKey(s: BodySpec): string {
    return JSON.stringify([s.type, s.shape, s.w, s.h, s.r, s.points, s.loop, s.density, s.friction, s.restitution, s.sensor, s.bullet, s.fixedRotation, s.group, s.collides]);
  }

  /** Ajoute ou met à jour un corps. Une description identique ne touche à rien (le corps garde sa position). */
  upsert(spec: BodySpec): void {
    const key = PhysicsWorld.shapeKey(spec);
    const existing = this.bodies.get(spec.name);
    if (existing) {
      const data = this.dataOf(existing)!;
      if (data.key === key) {
        data.spec = { ...spec };
        this.specs.set(spec.name, data.spec);
        existing.setLinearDamping(spec.damping);
        existing.setAngularDamping(spec.angularDamping);
        existing.setGravityScale(spec.gravityScale);
        return;
      }
      this.remove(spec.name);
    }
    const body = this.world.createBody({
      type: spec.type,
      position: this.v(spec.x, spec.y),
      angle: spec.angle * DEG,
      linearVelocity: this.v(spec.vx, spec.vy),
      angularVelocity: spec.spin * DEG,
      linearDamping: spec.damping,
      angularDamping: spec.angularDamping,
      fixedRotation: spec.fixedRotation,
      bullet: spec.bullet,
      gravityScale: spec.gravityScale,
    });
    const fix = {
      density: spec.density,
      friction: spec.friction,
      restitution: spec.restitution,
      isSensor: spec.sensor,
      filterCategoryBits: this.category(spec.group),
      filterMaskBits: this.mask(spec.collides),
    };
    const pts = spec.points.map(([x, y]) => this.v(x, y));
    try {
      switch (spec.shape) {
        case "circle":
          body.createFixture(new CircleShape(this.m(spec.r)), fix);
          break;
        case "polygon":
          body.createFixture(new PolygonShape(pts), fix);
          break;
        case "edge":
          body.createFixture(new EdgeShape(pts[0], pts[1]), fix);
          break;
        case "chain":
          body.createFixture(new ChainShape(pts, spec.loop), fix);
          break;
        default:
          body.createFixture(new BoxShape(this.m(spec.w / 2), this.m(spec.h / 2)), fix);
      }
    } catch (e) {
      this.errors.push(`${spec.name} : forme invalide (${e instanceof Error ? e.message : String(e)})`);
      this.world.destroyBody(body);
      return;
    }
    const data: BodyData = { name: spec.name, spec: { ...spec }, key, out: false };
    body.setUserData(data);
    this.bodies.set(spec.name, body);
    this.specs.set(spec.name, data.spec);
  }

  remove(name: string): void {
    const b = this.bodies.get(name);
    if (!b) return;
    if (this.mouse && this.mouse.getBodyB() === b) this.endDrag();
    this.joints = this.joints.filter((j) => j.getBodyA() !== b && j.getBodyB() !== b);
    this.world.destroyBody(b);
    this.bodies.delete(name);
    this.specs.delete(name);
    this.counters.forEach((_v, k) => {
      if (k.startsWith(`${name}\u0000`)) this.counters.delete(k);
    });
  }

  /** Remplace un ensemble de corps (liste du store) : ajoute, met à jour, retire les absents du même ensemble. */
  syncSet(owner: Set<string>, specs: BodySpec[]): Set<string> {
    const next = new Set<string>();
    for (const s of specs) {
      this.upsert(s);
      next.add(s.name);
    }
    for (const n of owner) if (!next.has(n)) this.remove(n);
    return next;
  }

  setJoints(specs: JointSpec[]): void {
    for (const j of this.joints) this.world.destroyJoint(j);
    this.joints = [];
    for (const s of specs) {
      const a = this.bodies.get(s.a) ?? (s.a === "ground" ? this.ground : undefined);
      const b = this.bodies.get(s.b) ?? (s.b === "ground" ? this.ground : undefined);
      if (!a || !b) {
        this.errors.push(`joint ${s.type} : corps "${!a ? s.a : s.b}" introuvable`);
        continue;
      }
      const pa = s.x !== null && s.y !== null ? this.v(s.x, s.y) : a.getPosition();
      const pb = s.x2 !== null && s.y2 !== null ? this.v(s.x2, s.y2) : b.getPosition();
      let joint: Joint | null = null;
      switch (s.type) {
        case "revolute":
          joint = new RevoluteJoint(
            {
              collideConnected: s.collide,
              enableMotor: s.motorSpeed !== null,
              motorSpeed: (s.motorSpeed ?? 0) * DEG,
              maxMotorTorque: s.maxTorque,
              enableLimit: s.lower !== null || s.upper !== null,
              lowerAngle: (s.lower ?? -180) * DEG,
              upperAngle: (s.upper ?? 180) * DEG,
            },
            a,
            b,
            pa,
          );
          break;
        case "distance":
          joint = new DistanceJoint({ collideConnected: s.collide, frequencyHz: s.frequency, dampingRatio: s.damping, length: s.length !== null ? this.m(s.length) : undefined }, a, b, pa, pb);
          break;
        case "rope":
          joint = new RopeJoint({ collideConnected: s.collide, maxLength: this.m(s.length ?? this.px(Vec2.distance(pa, pb))) }, a, b, pa);
          break;
        case "weld":
          joint = new WeldJoint({ collideConnected: s.collide, frequencyHz: s.frequency, dampingRatio: s.damping }, a, b, pa);
          break;
        case "prismatic":
          joint = new PrismaticJoint(
            {
              collideConnected: s.collide,
              enableMotor: s.motorSpeed !== null,
              motorSpeed: this.m(s.motorSpeed ?? 0),
              maxMotorForce: s.maxTorque,
              enableLimit: s.lower !== null || s.upper !== null,
              lowerTranslation: this.m(s.lower ?? -1e4),
              upperTranslation: this.m(s.upper ?? 1e4),
            },
            a,
            b,
            pa,
            Vec2(s.axis[0], s.axis[1]),
          );
          break;
      }
      if (joint) this.joints.push(this.world.createJoint(joint)!);
    }
  }

  /** Pilotage par DataProvider : vitesses / forces à chaque pas, impulsions et placements par compteur. */
  drive(input: Record<string, Drive> | null | undefined): void {
    if (!input || typeof input !== "object") return;
    for (const [name, d] of Object.entries(input)) {
      const b = this.bodies.get(name);
      if (!b || !d || typeof d !== "object") continue;
      if (typeof d.vx === "number" || typeof d.vy === "number") {
        const cur = b.getLinearVelocity();
        b.setLinearVelocity(Vec2(typeof d.vx === "number" ? this.m(d.vx) : cur.x, typeof d.vy === "number" ? this.m(d.vy) : cur.y));
        b.setAwake(true);
      }
      if (typeof d.spin === "number") b.setAngularVelocity(d.spin * DEG);
      if (typeof d.fx === "number" || typeof d.fy === "number") b.applyForceToCenter(Vec2(this.m(d.fx ?? 0), this.m(d.fy ?? 0)), true);
      if (typeof d.torque === "number") b.applyTorque(d.torque, true);
      if (d.impulse && this.counter(name, "impulse", d.impulse.n)) {
        b.applyLinearImpulse(Vec2(this.m(num(d.impulse.x, 0)), this.m(num(d.impulse.y, 0))), b.getWorldCenter(), true);
      }
      if (d.set && this.counter(name, "set", d.set.n)) {
        const p = b.getPosition();
        b.setTransform(
          Vec2(typeof d.set.x === "number" ? this.m(d.set.x) : p.x, typeof d.set.y === "number" ? this.m(d.set.y) : p.y),
          typeof d.set.angle === "number" ? d.set.angle * DEG : b.getAngle(),
        );
        b.setLinearVelocity(Vec2(this.m(num(d.set.vx, 0)), this.m(num(d.set.vy, 0))));
        b.setAngularVelocity(0);
        b.setAwake(true);
        const data = this.dataOf(b);
        if (data) data.out = false;
      }
    }
  }

  /** Compteur : la première valeur sert de référence, chaque hausse déclenche. */
  private counter(name: string, kind: string, n: unknown): boolean {
    if (typeof n !== "number" || !Number.isFinite(n)) return false;
    const key = `${name}\u0000${kind}`;
    const prev = this.counters.get(key);
    this.counters.set(key, n);
    return prev !== undefined && n > prev;
  }

  /** Un pas de simulation (s). Renvoie les événements du pas. */
  step(dt: number): PhysicsEvent[] {
    this.begun = [];
    this.impulses.clear();
    this.world.step(dt, 8, 3);
    this.time += dt;
    this.steps++;
    // Chocs (impulsion du solveur) et entrées de capteurs.
    for (const { contact, a, b } of this.begun) {
      const da = this.dataOf(a.getBody());
      const db = this.dataOf(b.getBody());
      if (!da || !db) continue;
      if (a.isSensor() || b.isSensor()) {
        if (a.isSensor() && b.isSensor()) continue;
        const [s, o] = a.isSensor() ? [da, db] : [db, da];
        this.events.push({ type: "enter", sensor: s.name, body: o.name, tags: [...o.spec.tags] });
        continue;
      }
      const impulse = this.impulses.get(contact) ?? 0;
      if (impulse < this.opts.collideMin) continue;
      const wm = contact.getWorldManifold(null);
      const p = wm?.points?.[0];
      this.collisions++;
      this.events.push({
        type: "collide",
        a: da.name,
        b: db.name,
        tagsA: [...da.spec.tags],
        tagsB: [...db.spec.tags],
        impulse: Math.round(impulse * 1000) / 1000,
        x: p ? Math.round(this.px(p.x)) : 0,
        y: p ? Math.round(this.px(p.y)) : 0,
      });
    }
    // Bornes : `clamp-x / clamp-y`, sorties du monde.
    const { width, height, outMargin } = this.opts;
    for (const [name, b] of this.bodies) {
      const data = this.dataOf(b)!;
      const s = data.spec;
      if (s.clampX || s.clampY) {
        const p = b.getPosition();
        const x = this.px(p.x);
        const y = this.px(p.y);
        const cx = s.clampX ? Math.min(s.clampX[1], Math.max(s.clampX[0], x)) : x;
        const cy = s.clampY ? Math.min(s.clampY[1], Math.max(s.clampY[0], y)) : y;
        if (cx !== x || cy !== y) {
          b.setPosition(this.v(cx, cy));
          const v = b.getLinearVelocity();
          b.setLinearVelocity(Vec2(cx !== x ? 0 : v.x, cy !== y ? 0 : v.y));
        }
      }
      if (s.type === "static") continue;
      const p = b.getPosition();
      const x = this.px(p.x);
      const y = this.px(p.y);
      const side = x < -outMargin ? "left" : x > width + outMargin ? "right" : y < -outMargin ? "top" : y > height + outMargin ? "bottom" : null;
      if (side && !data.out) {
        data.out = true;
        this.events.push({ type: "out", body: name, tags: [...s.tags], side });
      } else if (!side) data.out = false;
    }
    const out = this.events;
    this.events = [];
    return out;
  }

  bodyState(name: string): BodyState | null {
    const b = this.bodies.get(name);
    if (!b) return null;
    const p = b.getPosition();
    const v = b.getLinearVelocity();
    const r = (n: number) => Math.round(n * 10) / 10;
    return { x: r(this.px(p.x)), y: r(this.px(p.y)), angle: r(b.getAngle() / DEG), vx: r(this.px(v.x)), vy: r(this.px(v.y)), awake: b.isAwake() };
  }

  /* --- glisser à la souris (MouseJoint) --- */

  /** Corps dynamique sous le point (monde, px), ou null. */
  bodyAt(x: number, y: number): string | null {
    const p = this.v(x, y);
    let hit: string | null = null;
    const d = this.m(2);
    this.world.queryAABB({ lowerBound: Vec2(p.x - d, p.y - d), upperBound: Vec2(p.x + d, p.y + d) }, (f: Fixture) => {
      if (f.testPoint(p)) {
        const data = this.dataOf(f.getBody());
        if (data && !data.name.startsWith("wall-")) {
          hit = data.name;
          return false;
        }
      }
      return true;
    });
    return hit;
  }

  startDrag(name: string, x: number, y: number): boolean {
    const b = this.bodies.get(name);
    if (!b || b.getType() !== "dynamic") return false;
    this.endDrag();
    this.mouse = this.world.createJoint(new MouseJoint({ maxForce: 1000 * b.getMass(), frequencyHz: 5, dampingRatio: 0.7 }, this.ground, b, this.v(x, y)));
    b.setAwake(true);
    return true;
  }

  moveDrag(x: number, y: number): void {
    this.mouse?.setTarget(this.v(x, y));
  }

  endDrag(): void {
    if (this.mouse) this.world.destroyJoint(this.mouse);
    this.mouse = null;
  }

  get dragging(): string | null {
    return this.mouse ? (this.dataOf(this.mouse.getBodyB())?.name ?? null) : null;
  }

  /** Parcours pour le rendu : chaque corps (murs exclus) avec ses formes en px. */
  forEachBody(cb: (name: string, spec: BodySpec, x: number, y: number, angle: number, shapes: DrawShape[], awake: boolean) => void): void {
    for (const [name, b] of this.bodies) {
      const spec = this.specs.get(name)!;
      const p = b.getPosition();
      const shapes: DrawShape[] = [];
      for (let f = b.getFixtureList(); f; f = f.getNext()) {
        const s = f.getShape();
        const t = s.getType();
        if (t === "circle") {
          const c = s as CircleShape;
          shapes.push({ kind: "circle", r: this.px(c.getRadius()), cx: this.px(c.getCenter().x), cy: this.px(c.getCenter().y) });
        } else if (t === "polygon") {
          shapes.push({ kind: "poly", closed: true, pts: (s as PolygonShape).m_vertices.map((v) => [this.px(v.x), this.px(v.y)] as [number, number]) });
        } else if (t === "edge") {
          const e = s as EdgeShape;
          shapes.push({ kind: "poly", closed: false, pts: [[this.px(e.m_vertex1.x), this.px(e.m_vertex1.y)], [this.px(e.m_vertex2.x), this.px(e.m_vertex2.y)]] });
        } else if (t === "chain") {
          const ch = s as ChainShape;
          shapes.push({ kind: "poly", closed: spec.loop, pts: ch.m_vertices.map((v) => [this.px(v.x), this.px(v.y)] as [number, number]) });
        }
      }
      cb(name, spec, this.px(p.x), this.px(p.y), b.getAngle(), shapes, b.isAwake());
    }
  }

  jointLines(): [number, number, number, number][] {
    const out: [number, number, number, number][] = [];
    for (const j of this.joints) {
      const a = j.getAnchorA();
      const b = j.getAnchorB();
      out.push([this.px(a.x), this.px(a.y), this.px(b.x), this.px(b.y)]);
    }
    if (this.mouse) {
      const a = this.mouse.getAnchorB();
      const t = this.mouse.getTarget();
      out.push([this.px(a.x), this.px(a.y), this.px(t.x), this.px(t.y)]);
    }
    return out;
  }
}

export type DrawShape = { kind: "circle"; r: number; cx: number; cy: number } | { kind: "poly"; closed: boolean; pts: [number, number][] };
