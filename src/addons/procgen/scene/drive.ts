/**
 * Conduite (CPU, pur, testé sans rendu) : gabarits des véhicules et des montures, modèle « bicyclette » (empattement,
 * braquage, vitesse maximale par sorte), itinéraires (routes de la recette ou du monde, grille de navigation élargie
 * au gabarit, eau pour les bateaux), suivi de trajectoire (poursuite d'un point devant soi), collisions sur les
 * emprises (boîtes orientées).
 *
 * Le rendu (`render/view.ts`) tient l'état de chaque véhicule (`DriveState`), appelle `stepDrive` à chaque image avec
 * la commande directe (`drive` du DataProvider) ou celle de `followRoute`, puis pose la caisse, les roues et les
 * occupants. Rien ici ne touche à three.js.
 */
import type { ObjectInfo } from "./compose";
import { NavGrid } from "./nav";
import type { PathSpec } from "./terrain";

const DEG = Math.PI / 180;
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

export type Medium = "ground" | "water" | "rails" | "air";
/** Pose d'un occupant : `drive` (assis, mains au volant ou aux rênes), `ride` (à califourchon), `row` (rame), `stand` (debout, pousse ou tient), `sit`. */
export type SeatPose = "drive" | "ride" | "row" | "stand" | "sit";

export type VehicleSpec = {
  /** Sorte : `moderncar`, `bicycle`, `rowboat`…, ou l'espèce d'une monture (`horse`). */
  kind: string;
  mount: boolean;
  medium: Medium;
  /** Empattement (m, échelle comprise). */
  wheelbase: number;
  /** Braquage maximal (rad). */
  maxSteer: number;
  /** Vitesse maximale en marche avant (m/s) et arrière. */
  maxSpeed: number;
  reverse: number;
  /** Accélération et freinage (m/s²). */
  accel: number;
  brake: number;
  /** Demi-gabarit (m). */
  hx: number;
  hz: number;
  /** Portières (montée par `approach.door.*`). */
  doors: boolean;
  /** Inclinaison de la caisse : roulis dans les virages (rad au plus), le vélo se penche franchement. */
  lean: number;
  /** Pose du conducteur et des passagers. */
  pose: SeatPose;
  passengerPose: SeatPose;
  /** Pédalage (vélo) : les pieds tournent avec la vitesse. */
  pedal?: boolean;
  /** Deux-roues : la caisse se penche vers l'intérieur du virage (moto, scooter). */
  bank?: boolean;
  /** À califourchon : hauteur des pieds sous la selle (m ; repose-pieds, plancher) ; absent : jambes pendantes. */
  feet?: number;
};

type Base = Omit<VehicleSpec, "kind" | "mount" | "hx" | "hz" | "wheelbase"> & { wheelbase: number };
const V = (medium: Medium, wheelbase: number, steerDeg: number, maxSpeed: number, accel: number, brake: number, more: Partial<Base> = {}): Base => ({
  medium, wheelbase, maxSteer: steerDeg * DEG, maxSpeed, reverse: Math.min(3, maxSpeed * 0.3), accel, brake, doors: false, lean: 0.035, pose: "drive", passengerPose: "sit", ...more,
});

/** Sortes de `vehicle` conduites (le wagon n'a ni conducteur ni moteur : il n'en fait pas partie). */
export const VEHICLE_KINDS: Record<string, Base> = {
  moderncar: V("ground", 2.6, 35, 14, 3.5, 7, { doors: true }),
  van: V("ground", 3.05, 33, 12, 2.8, 6, { doors: true }),
  bus: V("ground", 7.8, 30, 10, 1.8, 5, { doors: true }),
  truck: V("ground", 5.1, 30, 10, 2, 5, { doors: true }),
  tractor: V("ground", 2.2, 38, 7, 2.5, 6),
  car: V("ground", 2.2, 32, 10, 2.5, 5),
  carriage: V("ground", 1.75, 30, 6, 1.5, 4),
  bicycle: V("ground", 1.04, 40, 6, 1.8, 4, { lean: 0.35, pose: "ride", pedal: true }),
  handcart: V("ground", 1.0, 45, 1.6, 1.2, 3, { pose: "stand", lean: 0 }),
  rowboat: V("water", 2.0, 40, 2, 0.8, 1, { pose: "row", lean: 0.05 }),
  sailboat: V("water", 3.5, 30, 4, 1, 0.8, { pose: "sit", lean: 0.12 }),
  balloon: V("air", 2, 60, 3, 0.6, 0.8, { pose: "stand", passengerPose: "stand", lean: 0 }),
  locomotive: V("rails", 5, 0, 12, 1.2, 3, { pose: "drive", passengerPose: "stand", lean: 0 }),
  motorbike: V("ground", 1.44, 38, 22, 5, 8, { lean: 0.45, pose: "ride", passengerPose: "ride", bank: true, feet: 0.48 }),
  scooter: V("ground", 1.18, 42, 12, 3, 6, { lean: 0.35, pose: "ride", passengerPose: "ride", bank: true, feet: 0.52 }),
  jetski: V("water", 1.6, 40, 15, 4, 3, { lean: 0.28, pose: "ride", passengerPose: "ride", bank: true, feet: 0.42 }),
  snowmobile: V("ground", 1.7, 32, 16, 4, 5, { lean: 0.1, pose: "ride", passengerPose: "ride", feet: 0.5 }),
  sled: V("ground", 0.9, 25, 7, 1.5, 3, { lean: 0.06, pose: "sit", passengerPose: "sit" }),
};

/** Montures (`animal`) : espèce → vitesse (m/s) au galop ; la selle est l'ancre `seat.rider` (dos). */
export const MOUNTS: Record<string, { maxSpeed: number; accel: number; steerDeg: number }> = {
  horse: { maxSpeed: 9, accel: 3, steerDeg: 50 },
  deer: { maxSpeed: 8, accel: 3.5, steerDeg: 55 },
  cow: { maxSpeed: 3, accel: 1.5, steerDeg: 45 },
  bear: { maxSpeed: 5, accel: 2.5, steerDeg: 50 },
};

/** Gabarit d'un objet conduit (véhicule ou monture), ou `null` s'il ne se conduit pas. */
export function vehicleSpecOf(o: Pick<ObjectInfo, "generator" | "params" | "footprint" | "scale">): VehicleSpec | null {
  const p = o.params ?? {};
  if (o.generator === "vehicle") {
    const kind = String(p.kind ?? "car");
    const b = VEHICLE_KINDS[kind];
    if (!b) return null;
    const s = o.scale || 1;
    return { ...b, kind, mount: false, wheelbase: b.wheelbase * s, hx: Math.max(0.2, o.footprint.hx), hz: Math.max(0.3, o.footprint.hz) };
  }
  if (o.generator === "animal") {
    const kind = String(p.species ?? "dog");
    const m = MOUNTS[kind];
    if (!m) return null;
    const hz = Math.max(0.4, o.footprint.hz);
    return { kind, mount: true, medium: "ground", wheelbase: hz * 1.1, maxSteer: m.steerDeg * DEG, maxSpeed: m.maxSpeed, reverse: 1, accel: m.accel, brake: m.accel * 2, hx: Math.max(0.2, o.footprint.hx), hz, doors: false, lean: 0.06, pose: "ride", passengerPose: "ride" };
  }
  return null;
}

/** Ce que permet un véhicule ou une monture (ajouté à `affords`). */
export const DRIVE_AFFORDS = ["board", "drive"];

/** Places : `seat.driver` (sinon `seat`, ou `seat.rider` d'une monture) puis `seat.N` dans l'ordre. */
export function seatNames(anchorKeys: Iterable<string>): string[] {
  const keys = [...anchorKeys];
  const driver = keys.includes("seat.driver") ? "seat.driver" : keys.includes("seat.rider") ? "seat.rider" : keys.includes("seat") ? "seat" : null;
  const rest = keys.filter((k) => /^seat\.\d+$/.test(k)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  return driver ? [driver, ...rest] : rest;
}

/** Place visée par un ordre `seat` : `"driver"` (défaut), un rang N (`seat.N`), ou un nom d'ancre. */
export function seatFor(seat: unknown, names: string[]): string | null {
  if (!names.length) return null;
  if (seat === undefined || seat === null || seat === "driver" || seat === "rider") return names[0];
  if (typeof seat === "number" && Number.isFinite(seat)) return names.find((n) => n === `seat.${Math.round(seat)}`) ?? null;
  const s = String(seat);
  if (/^\d+$/.test(s)) return names.find((n) => n === `seat.${s}`) ?? null;
  return names.find((n) => n === s || n === `seat.${s}`) ?? null;
}

/**
 * Portière d'une place (repère de l'objet) : l'ancre `approach.door.X` la plus proche de la place dont la partie
 * `door.X` existe. `null` sans portière (on monte directement).
 */
export function doorFor(seatLocal: [number, number, number], anchorsLocal: Record<string, [number, number, number]>, parts: string[]): { door: string; approach: string } | null {
  let best: { door: string; approach: string } | null = null;
  let bd = Infinity;
  for (const [k, p] of Object.entries(anchorsLocal)) {
    const m = /^approach\.(door\..+)$/.exec(k);
    if (!m || !parts.includes(m[1])) continue;
    // une portière du même côté que la place d'abord (x de même signe), puis la plus proche
    const side = Math.sign(p[0]) === Math.sign(seatLocal[0]) || Math.abs(seatLocal[0]) < 0.05 ? 0 : 4;
    const d = Math.hypot(p[0] - seatLocal[0], p[2] - seatLocal[2]) + side;
    if (d < bd) ((bd = d), (best = { door: m[1], approach: k }));
  }
  return best;
}

/** Point où l'on monte sans portière : à côté de la place, du côté de l'arrivant (repère de l'objet). */
export function sideApproach(seatLocal: [number, number, number], hx: number, fromLocal: [number, number]): [number, number] {
  const sx = fromLocal[0] >= 0 ? 1 : -1;
  return [sx * (hx + 0.45), seatLocal[2]];
}

/* ---------------- modèle bicyclette ---------------- */

export type DriveState = {
  x: number;
  z: number;
  /** Cap (rad, 0 = +z, croît vers +x : virage à gauche). */
  yaw: number;
  /** Vitesse le long du cap (m/s, négative en marche arrière). */
  speed: number;
  /** Braquage courant (rad, positif = à droite). */
  steer: number;
  /** Distance parcourue (m) : rotation des roues. */
  dist: number;
  /** Accélération latérale lissée (m/s²) : roulis de la caisse. */
  lat: number;
  /** Accélération longitudinale lissée (m/s²) : tangage. */
  lon: number;
};

/** Commande : `throttle` -1…1 (négatif = marche arrière ou frein), `steer` -1…1 (positif = à droite), `brake` 0…1. */
export type DriveInput = { throttle: number; steer: number; brake: number };

export const newDriveState = (x: number, z: number, yaw: number): DriveState => ({ x, z, yaw, speed: 0, steer: 0, dist: 0, lat: 0, lon: 0 });

/** Lecture tolérante d'une commande (`drive.<id>` du DataProvider). */
export function readInput(v: unknown): DriveInput | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return { throttle: clamp(n(o.throttle), -1, 1), steer: clamp(n(o.steer), -1, 1), brake: clamp(n(o.brake), 0, 1) };
}

/**
 * Un pas du modèle bicyclette : braquage et vitesse lissés, cap = vitesse × tan(braquage) / empattement.
 * `blocked(x, z, cap)` rend l'id de ce qui gêne la nouvelle pose (ou `null`) : le véhicule s'y arrête net.
 */
/**
 * Voilier : part de la vitesse maximale selon l'angle entre le cap et le vent d'où il vient (diagramme polaire
 * simplifié) — dans le lit du vent (moins de 40°) il n'avance presque pas, travers et largue au plus vite, vent
 * arrière un peu moins ; × force du vent.
 */
export function sailFactor(yaw: number, wind: Pt): number {
  const w = Math.hypot(wind[0], wind[1]);
  if (w < 0.05) return 0.15;
  // angle entre le cap et la direction d'où vient le vent (0 : face au vent)
  const fromX = -wind[0] / w, fromZ = -wind[1] / w;
  const a = (Math.acos(clamp(Math.sin(yaw) * fromX + Math.cos(yaw) * fromZ, -1, 1)) * 180) / Math.PI;
  const P: [number, number][] = [[0, 0.08], [38, 0.12], [45, 0.5], [60, 0.85], [90, 1], [120, 1.05], [150, 0.9], [180, 0.75]];
  let f = 0.08;
  for (let i = 0; i < P.length - 1; i++) if (a >= P[i][0] && a <= P[i + 1][0]) f = P[i][1] + ((a - P[i][0]) / (P[i + 1][0] - P[i][0])) * (P[i + 1][1] - P[i][1]);
  return f * clamp(w / 2.5, 0.35, 1.3);
}

export function stepDrive(sp: VehicleSpec, s: DriveState, inp: DriveInput, dt: number, blocked?: (x: number, z: number, yaw: number) => string | null, wind?: Pt): { hit: string | null; moved: boolean } {
  if (dt <= 0) return { hit: null, moved: false };
  // voilier : la vitesse possible dépend du vent
  if (sp.kind === "sailboat" && wind) sp = { ...sp, maxSpeed: sp.maxSpeed * sailFactor(s.yaw, wind) };
  // braquage : moins de débattement à haute vitesse, retour au centre en douceur
  const lim = sp.maxSteer * clamp(1 - (0.5 * Math.abs(s.speed)) / Math.max(1, sp.maxSpeed), 0.4, 1);
  const want = clamp(inp.steer, -1, 1) * lim;
  const rate = (sp.mount ? 4 : 2.4) * dt;
  s.steer += clamp(want - s.steer, -rate, rate);
  const v0 = s.speed;
  const t = clamp(inp.throttle, -1, 1), b = clamp(inp.brake, 0, 1);
  let v = s.speed;
  const drag = sp.medium === "water" ? 0.5 + 0.15 * v * v : sp.medium === "air" ? 0.4 : 0.8;
  if (t > 0.01) {
    if (v < -0.05) v = Math.min(0, v + sp.brake * dt);
    else if (v < sp.maxSpeed * t) v = Math.min(sp.maxSpeed * t, v + sp.accel * t * dt);
    else v = Math.max(sp.maxSpeed * t, v - drag * dt);
  } else if (t < -0.01) {
    if (v > 0.05) v = Math.max(0, v - sp.brake * -t * dt);
    else if (v > -sp.reverse * -t) v = Math.max(-sp.reverse * -t, v - sp.accel * 0.6 * -t * dt);
    else v = Math.min(-sp.reverse * -t, v + drag * dt);
  } else v = Math.sign(v) * Math.max(0, Math.abs(v) - drag * dt);
  if (b > 0) v = Math.sign(v) * Math.max(0, Math.abs(v) - sp.brake * b * dt);
  if (Math.abs(v) < 1e-3) v = 0;
  // cap : rotation autour de l'essieu arrière ; une monture tourne aussi sur place, au pas
  const tanS = Math.tan(s.steer);
  let yawRate = sp.medium === "rails" ? 0 : (-v * tanS) / Math.max(0.3, sp.wheelbase);
  if (sp.mount && Math.abs(v) < 0.6) yawRate += -Math.sign(s.steer) * Math.min(1, Math.abs(s.steer) / Math.max(0.1, sp.maxSteer)) * 1.2 * (1 - Math.abs(v) / 0.6);
  const yaw = s.yaw + yawRate * dt;
  const ym = (s.yaw + yaw) / 2;
  const nx = s.x + Math.sin(ym) * v * dt, nz = s.z + Math.cos(ym) * v * dt;
  // accélérations lissées (roulis dans les virages, tangage au freinage)
  const k = 1 - Math.exp(-dt * 5);
  s.lat += (v * yawRate - s.lat) * k;
  s.lon += ((v - v0) / dt - s.lon) * k;
  const hit = (Math.abs(v) > 1e-4 || yaw !== s.yaw) && blocked ? blocked(nx, nz, yaw) : null;
  if (hit) {
    // au contact : on avance de la plus grande fraction libre du pas (pas grossier sur une machine lente)
    let f = 0;
    for (let k = 0, lo = 0, hi = 1; k < 4; k++) {
      const m = (lo + hi) / 2;
      if (blocked!(s.x + (nx - s.x) * m, s.z + (nz - s.z) * m, s.yaw + (yaw - s.yaw) * m)) hi = m;
      else ((lo = m), (f = m));
    }
    if (f > 0) {
      s.dist += Math.hypot(nx - s.x, nz - s.z) * f * Math.sign(v || 1);
      s.x += (nx - s.x) * f;
      s.z += (nz - s.z) * f;
      s.yaw += (yaw - s.yaw) * f;
    }
    s.speed = 0;
    return { hit, moved: f > 0 };
  }
  const moved = nx !== s.x || nz !== s.z || yaw !== s.yaw;
  s.dist += Math.hypot(nx - s.x, nz - s.z) * Math.sign(v || 1);
  s.x = nx;
  s.z = nz;
  s.yaw = yaw;
  s.speed = v;
  return { hit: null, moved };
}

/* ---------------- collisions sur les emprises ---------------- */

export type Obb = { x: number; z: number; hx: number; hz: number; yaw: number };
export type Obstacle = Obb & { id: string };

/** Deux boîtes orientées (repère xz) se chevauchent-elles ? Axes séparateurs. */
export function obbOverlap(a: Obb, b: Obb): boolean {
  const ax = [Math.cos(a.yaw), -Math.sin(a.yaw)], az = [Math.sin(a.yaw), Math.cos(a.yaw)];
  const bx = [Math.cos(b.yaw), -Math.sin(b.yaw)], bz = [Math.sin(b.yaw), Math.cos(b.yaw)];
  const d = [b.x - a.x, b.z - a.z];
  for (const u of [ax, az, bx, bz]) {
    const ra = a.hx * Math.abs(ax[0] * u[0] + ax[1] * u[1]) + a.hz * Math.abs(az[0] * u[0] + az[1] * u[1]);
    const rb = b.hx * Math.abs(bx[0] * u[0] + bx[1] * u[1]) + b.hz * Math.abs(bz[0] * u[0] + bz[1] * u[1]);
    if (Math.abs(d[0] * u[0] + d[1] * u[1]) > ra + rb) return false;
  }
  return true;
}

const SOFT = new Set(["grass", "flowers", "ball", "tool", "plant", "textile"]);

/** Emprises qui arrêtent un véhicule : objets du décor (bâtiments, arbres, mobilier, autres véhicules), tronçons de clôture, garde-corps et piles d'ouvrage. */
export function obstaclesOf(objects: readonly ObjectInfo[], skip: (o: ObjectInfo) => boolean = () => false): Obstacle[] {
  const out: Obstacle[] = [];
  for (const o of objects) {
    if (o.mode === "actor" || o.walkable || SOFT.has(o.generator) || skip(o)) continue;
    if (o.blockers?.length) {
      for (const [x, z, hx, hz, yaw] of o.blockers) out.push({ id: o.id, x, z, hx, hz, yaw });
      continue;
    }
    // petits objets bas (pierres, seaux) : on passe dessus
    if (o.height < 0.25 || Math.max(o.footprint.hx, o.footprint.hz) < 0.12) continue;
    // arbres : le tronc seul (l'emprise est celle du houppier)
    const trunk = o.generator === "tree" || o.generator === "bush" ? 0.35 : 1;
    out.push({ id: o.id, x: o.pos[0], z: o.pos[2], hx: o.footprint.hx * (o.generator === "tree" ? Math.min(1, 0.3 / Math.max(0.3, o.footprint.hx)) : trunk), hz: o.footprint.hz * (o.generator === "tree" ? Math.min(1, 0.3 / Math.max(0.3, o.footprint.hz)) : trunk), yaw: o.yaw });
  }
  return out;
}

/** Emprises rangées par cases de 4 m : chevauchement d'une boîte en quelques comparaisons. */
export class ObstacleSet {
  private cells = new Map<string, Obstacle[]>();
  private static C = 4;
  constructor(list: Obstacle[]) {
    for (const o of list) {
      const r = Math.hypot(o.hx, o.hz);
      this.each(o.x - r, o.z - r, o.x + r, o.z + r, (k) => {
        let c = this.cells.get(k);
        if (!c) this.cells.set(k, (c = []));
        c.push(o);
      });
    }
  }
  private each(x0: number, z0: number, x1: number, z1: number, f: (k: string) => void) {
    const C = ObstacleSet.C;
    for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++) for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++) f(`${i},${j}`);
  }
  /** Ids de tous les obstacles chevauchés. */
  hits(b: Obb): string[] {
    const r = Math.hypot(b.hx, b.hz);
    const out = new Set<string>();
    this.each(b.x - r, b.z - r, b.x + r, b.z + r, (k) => {
      for (const o of this.cells.get(k) ?? []) if (obbOverlap(b, o)) out.add(o.id);
    });
    return [...out];
  }
  /** Id du premier obstacle chevauché (hors `ignore`), ou `null`. */
  hit(b: Obb, ignore?: (id: string) => boolean): string | null {
    const r = Math.hypot(b.hx, b.hz);
    let found: string | null = null;
    this.each(b.x - r, b.z - r, b.x + r, b.z + r, (k) => {
      if (found) return;
      for (const o of this.cells.get(k) ?? []) if (!ignore?.(o.id) && obbOverlap(b, o)) return void (found = o.id);
    });
    return found;
  }
}

/* ---------------- itinéraires ---------------- */

type Pt = [number, number];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export type RouteCtx = {
  /** Routes et chemins praticables (repère du monde) ; rivières exclues par l'appelant ou ici. */
  roads?: PathSpec[];
  /** Grille de navigation de la scène (chemin élargi au gabarit) ou façade du monde infini (`path` seul). */
  nav?: { pathWide?: NavGrid["pathWide"]; path?: (a: Pt, b: Pt) => Pt[] | null } | null;
  /** Bateaux : la cellule est-elle de l'eau navigable ? Avec le rectangle à couvrir. */
  water?: (x: number, z: number) => boolean;
  bounds?: { x0: number; z0: number; x1: number; z1: number };
  /** Id du véhicule (son emprise mobile ne le gêne pas). */
  self?: string;
};

/** Plus court chemin sur le réseau de routes (nœuds tous les 6 m au plus, carrefours raccordés). */
export function roadRoute(roads: PathSpec[], from: Pt, to: Pt, minWidth = 0): { pts: Pt[]; entry: number; exit: number } | null {
  const nodes: Pt[] = [];
  const adj: { to: number; w: number }[][] = [];
  const owner: number[] = [];
  const add = (p: Pt, r: number) => {
    nodes.push(p);
    adj.push([]);
    owner.push(r);
    return nodes.length - 1;
  };
  const link = (a: number, b: number) => {
    const w = dist(nodes[a], nodes[b]);
    adj[a].push({ to: b, w });
    adj[b].push({ to: a, w });
  };
  const usable = roads.filter((r) => r.kind !== "river" && r.points.length >= 2 && r.width >= minWidth);
  usable.forEach((r, ri) => {
    let prev = -1;
    for (let i = 0; i < r.points.length; i++) {
      const p = r.points[i];
      if (prev >= 0) {
        const q = nodes[prev];
        const n = Math.ceil(dist(q, p) / 6);
        for (let k = 1; k < n; k++) {
          const m = add([q[0] + ((p[0] - q[0]) * k) / n, q[1] + ((p[1] - q[1]) * k) / n], ri);
          link(prev, m);
          prev = m;
        }
      }
      const cur = add([p[0], p[1]], ri);
      if (prev >= 0) link(prev, cur);
      prev = cur;
    }
  });
  if (nodes.length < 2) return null;
  // carrefours : nœuds de routes différentes assez proches
  for (let a = 0; a < nodes.length; a++)
    for (let b = a + 1; b < nodes.length; b++) {
      if (owner[a] === owner[b]) continue;
      const lim = (usable[owner[a]].width + usable[owner[b]].width) / 2 + 3;
      if (dist(nodes[a], nodes[b]) <= lim) link(a, b);
    }
  const near = (p: Pt) => {
    let bi = -1, bd = Infinity;
    nodes.forEach((n, i) => {
      const d = dist(n, p);
      if (d < bd) ((bd = d), (bi = i));
    });
    return { i: bi, d: bd };
  };
  const s = near(from), g = near(to);
  // Dijkstra (graphes de quelques centaines de nœuds)
  const D = new Float64Array(nodes.length).fill(Infinity);
  const P = new Int32Array(nodes.length).fill(-1);
  const done = new Uint8Array(nodes.length);
  D[s.i] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && D[i] < Infinity && (u < 0 || D[i] < D[u])) u = i;
    if (u < 0 || u === g.i) break;
    done[u] = 1;
    for (const e of adj[u]) if (D[u] + e.w < D[e.to]) ((D[e.to] = D[u] + e.w), (P[e.to] = u));
  }
  if (D[g.i] === Infinity) return null;
  const pts: Pt[] = [];
  for (let k = g.i; k >= 0; k = P[k]) pts.push(nodes[k]);
  pts.reverse();
  return { pts, entry: s.d, exit: g.d };
}

/** Chemin pour un bateau : grille de l'eau (cases de 1 m) élargie au gabarit. */
export function waterRoute(from: Pt, to: Pt, water: (x: number, z: number) => boolean, b: { x0: number; z0: number; x1: number; z1: number }, clearance: number): Pt[] | null {
  const w = Math.min(240, b.x1 - b.x0), d = Math.min(240, b.z1 - b.z0);
  const g = new NavGrid(w, d, 1).shift((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2);
  for (let j = 0; j < g.nz; j++)
    for (let i = 0; i < g.nx; i++) {
      const [x, z] = g.center(i, j);
      if (!water(x, z)) g.blocked[j * g.nx + i] = 1;
    }
  // cible à terre : le bord de l'eau le plus proche (on accoste) ; aucune eau autour = pas de passage
  let goal = to;
  if (!water(to[0], to[1])) {
    const c = g.nearestFree(to[0], to[1]);
    if (!c) return null;
    goal = g.center(c[0], c[1]);
    if (dist(goal, to) > 6) return null;
  }
  return g.pathWide(from, goal, Math.max(0.25, clearance - 0.5));
}

/**
 * Itinéraire d'un véhicule de `from` à `to` : par les routes quand elles rapprochent (gabarit compatible, réseau
 * relié), sinon par la grille de navigation élargie au gabarit ; bateaux par l'eau ; montgolfière et train en ligne
 * droite. `null` : aucun passage.
 */
export function planRoute(sp: VehicleSpec, from: Pt, to: Pt, ctx: RouteCtx): Pt[] | null {
  if (sp.medium === "air" || sp.medium === "rails") return [from, to];
  if (sp.medium === "water") {
    if (!ctx.water || !ctx.bounds) return [from, to];
    return waterRoute(from, to, ctx.water, ctx.bounds, sp.hx) ?? null;
  }
  const off = (a: Pt, b: Pt): Pt[] | null => {
    if (dist(a, b) < 0.5) return [a, b];
    if (ctx.nav?.pathWide) return ctx.nav.pathWide(a, b, sp.hx, ctx.self);
    if (ctx.nav?.path) return ctx.nav.path(a, b);
    return [a, b];
  };
  const direct = dist(from, to);
  // routes : seulement si elles servent (point d'entrée et de sortie proches, détour raisonnable)
  if (ctx.roads?.length && direct > 12) {
    const r = roadRoute(ctx.roads, from, to, sp.mount || sp.kind === "bicycle" || sp.kind === "handcart" ? 0 : sp.hx * 2 + 0.2);
    if (r && r.pts.length >= 2 && r.entry < 25 && r.exit < 25) {
      let len = r.entry + r.exit;
      for (let i = 1; i < r.pts.length; i++) len += dist(r.pts[i - 1], r.pts[i]);
      if (len < direct * 1.8 + 10) {
        const a = off(from, r.pts[0]);
        const c = off(r.pts[r.pts.length - 1], to);
        if (a && c) return dedupe([...a, ...r.pts.slice(1, -1), ...c]);
      }
    }
  }
  return off(from, to);
}

function dedupe(p: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const q of p) if (!out.length || dist(out[out.length - 1], q) > 0.3) out.push(q);
  return out;
}

/* ---------------- suivi de trajectoire ---------------- */

export type Route = {
  pts: Pt[];
  /** Segment courant. */
  i: number;
  /** Rayon d'arrivée (m). */
  arriveR: number;
  /** Vitesse de croisière visée (m/s). */
  cruise: number;
  /** Marche arrière en cours (manœuvre), temps restant (s). */
  back: number;
  /** Meilleure distance restante et temps sans progrès (s) : véhicule coincé. */
  best: number;
  stall: number;
  /** Voilier qui remonte au vent : bord en cours (1 / -1) et temps passé dessus (s). */
  tack?: number;
  tackT?: number;
};

export const newRoute = (pts: Pt[], arriveR: number, cruise: number): Route => ({ pts, i: 0, arriveR, cruise, back: 0, best: Infinity, stall: 0 });

/**
 * Commande qui suit l'itinéraire : poursuite d'un point devant soi (distance de visée selon la vitesse), vitesse
 * bornée par la courbure et par la distance d'arrêt (freinage doux). `done` à l'arrivée (presque arrêté),
 * `stuck` si rien n'avance depuis 6 s.
 */
export function followRoute(sp: VehicleSpec, s: DriveState, r: Route, dt: number, wind?: Pt): { input: DriveInput; done: boolean; stuck: boolean; remaining: number } {
  const P = r.pts;
  const pos: Pt = [s.x, s.z];
  // train : avance ou recule le long de la voie jusqu'au point visé (projeté sur son axe)
  if (sp.medium === "rails") {
    const e = P[P.length - 1];
    const along = (e[0] - s.x) * Math.sin(s.yaw) + (e[1] - s.z) * Math.cos(s.yaw);
    const rem = Math.abs(along);
    if (rem <= r.arriveR && Math.abs(s.speed) < 0.4) return { input: { throttle: 0, steer: 0, brake: 1 }, done: true, stuck: false, remaining: rem };
    if (rem < r.best - 0.3) ((r.best = rem), (r.stall = 0));
    else r.stall += dt;
    if (r.stall > 6) return { input: { throttle: 0, steer: 0, brake: 1 }, done: false, stuck: true, remaining: rem };
    const vt = Math.sign(along) * Math.min(r.cruise, Math.sqrt(2 * sp.brake * 0.45 * Math.max(0, rem - r.arriveR * 0.6)));
    const e2 = vt - s.speed;
    return { input: { throttle: clamp(e2 * 0.8 + vt / Math.max(1, sp.maxSpeed) * 0.5, -1, 1), steer: 0, brake: Math.abs(vt) < Math.abs(s.speed) - 0.3 ? 0.5 : 0 }, done: false, stuck: false, remaining: rem };
  }
  // projection sur le segment courant ; on passe au suivant une fois dépassé
  let proj: Pt = P[Math.min(r.i, P.length - 1)];
  while (r.i < P.length - 1) {
    const a = P[r.i], b = P[r.i + 1];
    const ab: Pt = [b[0] - a[0], b[1] - a[1]];
    const L2 = ab[0] * ab[0] + ab[1] * ab[1] || 1;
    const t = ((pos[0] - a[0]) * ab[0] + (pos[1] - a[1]) * ab[1]) / L2;
    if (t >= 1 && r.i < P.length - 2) {
      r.i++;
      continue;
    }
    const tc = clamp(t, 0, 1);
    proj = [a[0] + ab[0] * tc, a[1] + ab[1] * tc];
    break;
  }
  // distance restante le long de l'itinéraire
  let remaining = r.i < P.length - 1 ? dist(proj, P[r.i + 1]) : dist(pos, P[P.length - 1]);
  for (let k = r.i + 1; k < P.length - 1; k++) remaining += dist(P[k], P[k + 1]);
  remaining = Math.max(remaining, dist(pos, P[P.length - 1]) * (r.i >= P.length - 2 ? 1 : 0));
  // point visé : à L devant la projection
  const L = clamp(1.2 * sp.wheelbase + Math.abs(s.speed) * 0.7, 1.5, 12);
  let target: Pt = P[P.length - 1];
  let left = L;
  let cur = proj;
  for (let k = r.i + 1; k < P.length; k++) {
    const d = dist(cur, P[k]);
    if (d >= left) {
      target = [cur[0] + ((P[k][0] - cur[0]) * left) / d, cur[1] + ((P[k][1] - cur[1]) * left) / d];
      break;
    }
    left -= d;
    cur = P[k];
  }
  // voilier face au vent : il tire des bords (cap à 50° du vent, d'un côté puis de l'autre toutes les 9 s) au lieu de
  // viser droit dans le lit du vent où il n'avance pas
  if (sp.kind === "sailboat" && wind && Math.hypot(wind[0], wind[1]) > 0.05) {
    const bx = target[0] - s.x, bz = target[1] - s.z;
    const bearing = Math.atan2(bx, bz), from = Math.atan2(-wind[0], -wind[1]);
    let off = bearing - from;
    off = Math.atan2(Math.sin(off), Math.cos(off));
    if (Math.abs(off) < (45 * Math.PI) / 180 && Math.hypot(bx, bz) > 3) {
      r.tackT = (r.tackT ?? 0) + dt;
      if (r.tackT > 9) ((r.tackT = 0), (r.tack = -(r.tack ?? 1)));
      const h = from + (r.tack ?? (off >= 0 ? 1 : -1)) * ((50 * Math.PI) / 180);
      const Lt = Math.max(4, Math.hypot(bx, bz));
      target = [s.x + Math.sin(h) * Lt, s.z + Math.cos(h) * Lt];
    }
  }
  const dx = target[0] - s.x, dz = target[1] - s.z;
  const lateral = dx * Math.cos(s.yaw) - dz * Math.sin(s.yaw);
  const forward = dx * Math.sin(s.yaw) + dz * Math.cos(s.yaw);
  const alpha = Math.atan2(lateral, forward);
  const Ld = Math.max(0.5, Math.hypot(dx, dz));
  const kappa = (2 * Math.sin(alpha)) / Ld;
  const delta = Math.atan(kappa * sp.wheelbase);
  const end = dist(pos, P[P.length - 1]);
  // arrivée
  if ((remaining <= r.arriveR || end <= r.arriveR) && Math.abs(s.speed) < 0.4) return { input: { throttle: 0, steer: 0, brake: 1 }, done: true, stuck: false, remaining };
  // coincé : aucun progrès depuis 6 s
  if (remaining < r.best - 0.3) ((r.best = remaining), (r.stall = 0));
  else r.stall += dt;
  if (r.stall > 6) return { input: { throttle: 0, steer: 0, brake: 1 }, done: false, stuck: true, remaining };
  // cible derrière et proche : on y va en marche arrière (poursuite inversée), jusqu'à l'avoir de nouveau devant
  const turnR = sp.wheelbase / Math.max(0.05, Math.tan(sp.maxSteer));
  if (!sp.mount && (sp.medium === "ground" || sp.medium === "water") && r.back <= 0 && Math.abs(alpha) > 1.9 && Ld < turnR * 2.5) r.back = 1;
  if (r.back > 0 && (Math.abs(alpha) < 1.2 || Ld > turnR * 3.5)) r.back = 0;
  if (r.back > 0) {
    const ar = Math.atan2(-lateral, -forward);
    const dr = Math.atan(((2 * Math.sin(ar)) / Ld) * sp.wheelbase);
    const vb = -Math.min(sp.reverse, 2, Math.sqrt(2 * sp.brake * 0.45 * Math.max(0, Math.min(remaining, end + 1) - r.arriveR * 0.6)));
    const eb = vb - s.speed;
    return { input: { throttle: clamp(eb * 0.8 + vb / Math.max(1, sp.reverse) * 0.5, -1, 0), steer: clamp(dr / Math.max(0.05, sp.maxSteer), -1, 1), brake: eb > 0.3 ? clamp(eb * 0.6, 0, 1) : 0 }, done: false, stuck: false, remaining };
  }
  const brakeDecel = sp.brake * 0.45;
  const vEnd = Math.sqrt(2 * brakeDecel * Math.max(0, Math.min(remaining, end + 1) - r.arriveR * 0.6));
  const vCurve = Math.sqrt((sp.mount ? 4 : 3) / Math.max(1e-3, Math.abs(kappa)));
  const vt = Math.min(r.cruise, vEnd, vCurve, Math.abs(alpha) > 1.2 ? 1.5 : Infinity);
  const e = vt - s.speed;
  const throttle = clamp(e * 0.8 + (vt / Math.max(1, sp.maxSpeed)) * 0.5, 0, 1);
  const brake = e < -0.3 ? clamp(-e * 0.6, 0, 1) : 0;
  const steer = sp.maxSteer > 0 ? clamp(-delta / sp.maxSteer, -1, 1) : 0;
  return { input: { throttle: brake > 0 ? 0 : throttle, steer, brake }, done: false, stuck: false, remaining };
}

/** Valeur de la partie `steer.f*` (0…1, 0,5 = tout droit, course ±35°) pour un braquage (rad, positif = à droite). */
export const steerPartValue = (steer: number) => clamp(0.5 - steer / (2 * 35 * DEG), 0, 1);
/** Valeur d'une roue (0…1 = un tour) après `dist` mètres, rayon `r`. */
export const wheelPartValue = (dist: number, r: number) => {
  const t = dist / (2 * Math.PI * Math.max(0.05, r));
  return t - Math.floor(t);
};
