/**
 * Course automobile (CPU, pur, testé sans rendu) : circuit fermé généré par graine, pilotage arcade (adhérence
 * limitée, sous-virage, frein à main qui fait glisser, sortie de piste qui ralentit), adversaires qui suivent une ligne
 * de course (vitesse bornée par les virages à venir et la distance de freinage, dépassements), tours, temps et
 * classement.
 *
 * Le moteur est l'autorité : il tient l'état de conduite de chaque voiture (`DriveState`, le même que la conduite de
 * la scène), et le rendu (`render/race.ts`) pose les voitures de la scène là où il les met, règle la caméra et
 * l'habillage. Repère : mètres, cap 0 = +z, croissant vers +x.
 */
import type { DriveInput, DriveState } from "./drive";

export type Pt = [number, number];
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const TAU = Math.PI * 2;
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Sortes de voitures permises et leur réglage de course. */
export const RACE_CARS: Record<string, CarTune> = {
  moderncar: { maxSpeed: 46, accel: 9, brake: 19, grip: 15, wheelbase: 2.6, maxSteer: 0.6, hx: 0.95, hz: 2.25 },
  van: { maxSpeed: 37, accel: 6.5, brake: 15, grip: 11.5, wheelbase: 3.05, maxSteer: 0.57, hx: 1.0, hz: 2.6 },
  truck: { maxSpeed: 31, accel: 4.8, brake: 12, grip: 9.5, wheelbase: 5.1, maxSteer: 0.52, hx: 1.25, hz: 3.6 },
  bus: { maxSpeed: 28, accel: 4.2, brake: 11, grip: 8.5, wheelbase: 7.8, maxSteer: 0.52, hx: 1.3, hz: 5.6 },
  tractor: { maxSpeed: 17, accel: 4.5, brake: 10, grip: 9, wheelbase: 2.2, maxSteer: 0.66, hx: 1.0, hz: 1.9 },
  car: { maxSpeed: 33, accel: 6.5, brake: 13, grip: 11, wheelbase: 2.2, maxSteer: 0.56, hx: 0.85, hz: 2.0 },
};

export type CarTune = {
  /** Vitesse de pointe (m/s), accélération et freinage (m/s²). */
  maxSpeed: number;
  accel: number;
  brake: number;
  /** Accélération latérale tenue avant de glisser (m/s²). */
  grip: number;
  wheelbase: number;
  /** Braquage maximal (rad). */
  maxSteer: number;
  /** Demi-gabarit (m). */
  hx: number;
  hz: number;
};

export const SCENERIES = ["campagne", "foret", "desert", "neige", "nuit"] as const;
export type Scenery = (typeof SCENERIES)[number];

export type DriverSpec = { name: string; paint: string };
export type RaceSpec = {
  laps: number;
  /** Voitures gérées par la machine (0 … 7). */
  opponents: number;
  /** Niveau des adversaires (0 … 1). */
  level: number;
  /** Une voiture pilotée par le joueur (sinon : course entre machines, caméra sur le meneur). */
  human: boolean;
  car: string;
  /** Longueur visée du circuit (m) et largeur de la piste. */
  length: number;
  width: number;
  scenery: Scenery;
  /** Caméra : poursuite, poursuite éloignée, vue de dessus, capot ; `free` laisse la vue à l'artefact. */
  camera: "chase" | "far" | "top" | "hood" | "free";
  /** Joueur puis adversaires (nom affiché, couleur de caisse). */
  drivers: DriverSpec[];
  countdown: boolean;
  seed: number;
};

const PAINTS = ["red", "blue", "yellow", "green", "orange", "purple", "white", "black"];
const NAMES = ["Toi", "Comète", "Brio", "Tornade", "Mistral", "Zéphyr", "Éclair", "Foudre"];

/** Lecture tolérante de `race` du DataProvider. */
export function parseRace(v: unknown): RaceSpec {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const n = (x: unknown, d: number) => (Number.isFinite(Number(x)) && x !== null && x !== "" && typeof x !== "boolean" ? Number(x) : d);
  const opponents = Math.round(clamp(n(o.opponents, 5), 0, 7));
  const human = o.human !== false && o.human !== "none";
  const list: unknown[] = Array.isArray(o.drivers) ? o.drivers : o.drivers && typeof o.drivers === "object" ? Object.values(o.drivers as object) : [];
  const total = opponents + (human ? 1 : 0);
  const drivers: DriverSpec[] = [];
  for (let i = 0; i < Math.max(1, total); i++) {
    const d = (list[i] && typeof list[i] === "object" ? list[i] : {}) as Record<string, unknown>;
    const k = human ? i : i + 1;
    const name = typeof d.name === "string" && d.name.trim() ? d.name.trim().slice(0, 18) : NAMES[k % NAMES.length];
    const own = i === 0 && human && typeof o.paint === "string" && PAINTS.includes(o.paint) ? o.paint : null;
    const paint = own ?? (typeof d.paint === "string" && PAINTS.includes(d.paint) ? d.paint : PAINTS[k % PAINTS.length]);
    drivers.push({ name, paint });
  }
  const cam = ["chase", "far", "top", "hood", "free"].includes(String(o.camera)) ? (String(o.camera) as RaceSpec["camera"]) : "chase";
  return {
    laps: Math.round(clamp(n(o.laps, 3), 1, 20)),
    opponents,
    level: clamp(n(o.level, 0.6), 0, 1),
    human,
    car: RACE_CARS[String(o.car)] ? String(o.car) : "moderncar",
    length: clamp(n(o.length, 650), 300, 1600),
    width: clamp(n(o.width, 12), 8, 20),
    scenery: (SCENERIES as readonly string[]).includes(String(o.scenery)) ? (String(o.scenery) as Scenery) : "campagne",
    camera: cam,
    drivers: drivers.slice(0, Math.max(1, total)),
    countdown: o.countdown !== false,
    seed: Math.floor(n(o.seed, 3)),
  };
}

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- circuit ---------------- */

export type Track = {
  /** Ligne médiane échantillonnée tous les `step` m (boucle : le dernier point rejoint le premier). */
  pts: Pt[];
  /** Cap de la piste en chaque point (rad) et courbure signée (1/m, positive : le cap croît). */
  head: number[];
  kappa: number[];
  step: number;
  L: number;
  width: number;
  bounds: [number, number, number, number];
};

/** Normale de la piste (côté où le cap croît) pour un cap. */
export const normalOf = (h: number): Pt => [Math.cos(h), -Math.sin(h)];

function catmull(ctrl: Pt[], per: number): Pt[] {
  const out: Pt[] = [];
  const N = ctrl.length;
  for (let i = 0; i < N; i++) {
    const p0 = ctrl[(i - 1 + N) % N], p1 = ctrl[i], p2 = ctrl[(i + 1) % N], p3 = ctrl[(i + 2) % N];
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

/** Rééchantillonne une boucle à pas constant. */
function resample(loop: Pt[], step: number): Pt[] {
  const cum = [0];
  for (let i = 1; i <= loop.length; i++) {
    const a = loop[i - 1], b = loop[i % loop.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const L = cum[cum.length - 1];
  const n = Math.max(8, Math.round(L / step));
  const out: Pt[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = (k / n) * L;
    while (cum[j + 1] < s) j++;
    const a = loop[j], b = loop[(j + 1) % loop.length];
    const t = (s - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]);
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

function finish(pts: Pt[], width: number): Track {
  const N = pts.length;
  let L = 0;
  for (let i = 0; i < N; i++) L += Math.hypot(pts[(i + 1) % N][0] - pts[i][0], pts[(i + 1) % N][1] - pts[i][1]);
  const step = L / N;
  const head = pts.map((p, i) => {
    const a = pts[(i - 1 + N) % N], b = pts[(i + 1) % N];
    return Math.atan2(b[0] - a[0], b[1] - a[1]);
  });
  const raw = head.map((h, i) => wrapAngle(head[(i + 1) % N] - head[(i - 1 + N) % N]) / (2 * step));
  // courbure lissée (fenêtre de ±3 points) : la ligne de course ne réagit pas au bruit d'échantillonnage
  const kappa = raw.map((_, i) => {
    let s = 0;
    for (let k = -3; k <= 3; k++) s += raw[(i + k + N) % N];
    return s / 7;
  });
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of pts) ((x0 = Math.min(x0, x)), (z0 = Math.min(z0, z)), (x1 = Math.max(x1, x)), (z1 = Math.max(z1, z)));
  return { pts, head, kappa, step, L, width, bounds: [x0, z0, x1, z1] };
}

/** Plus petite distance entre deux portions de piste non voisines (m) : sous ~2 largeurs, les bas-côtés se touchent. */
export function trackClearance(t: Track): number {
  const N = t.pts.length;
  const skip = Math.ceil((t.width * 3) / t.step);
  let best = Infinity;
  for (let i = 0; i < N; i += 2)
    for (let j = i + skip; j < N; j += 2) {
      if (N - (j - i) < skip) continue;
      const d = Math.hypot(t.pts[i][0] - t.pts[j][0], t.pts[i][1] - t.pts[j][1]);
      if (d < best) best = d;
    }
  return best;
}

/**
 * Circuit fermé : une dizaine de points de contrôle autour du centre (rayons et angles tirés), lissés en
 * Catmull-Rom, rééchantillonnés tous les 2 m et mis à la longueur voulue ; un tirage dont deux portions se
 * frôlent est refait (graine suivante, variations réduites). Départ au milieu de la plus longue ligne droite.
 */
export function genTrack(seed: number, length: number, width: number): Track {
  let best: Track | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const r = rng(seed * 7919 + attempt * 104729 + 17);
    const wild = Math.max(0.15, 0.6 - attempt * 0.06);
    const N = 9 + Math.floor(r() * 6);
    const sx = 1 + r() * 0.45;
    const rad: number[] = [];
    for (let k = 0; k < N; k++) rad.push(1 - wild / 2 + wild * r());
    // pas deux points voisins trop différents (pointes)
    const sm = rad.map((x, k) => (rad[(k - 1 + N) % N] + 2 * x + rad[(k + 1) % N]) / 4);
    const ctrl: Pt[] = sm.map((x, k) => {
      const a = ((k + (r() - 0.5) * 0.45) / N) * TAU;
      return [Math.sin(a) * x * sx, Math.cos(a) * x / sx];
    });
    let pts = resample(catmull(ctrl, 24), 0.01);
    let t = finish(pts, width);
    const scale = length / t.L;
    pts = resample(pts.map(([x, z]) => [x * scale, z * scale] as Pt), 2);
    t = finish(pts, width);
    // virage trop serré pour la piste : on recommence plus sage
    const kmax = Math.max(...t.kappa.map(Math.abs));
    const ok = trackClearance(t) > width * 2.4 && kmax < 1 / Math.max(9, width * 0.9);
    if (!best || ok) best = t;
    if (ok) break;
  }
  return startOnStraight(best!);
}

function startOnStraight(t: Track): Track {
  const N = t.pts.length;
  const w = Math.max(4, Math.round(70 / t.step));
  let bi = 0, bs = Infinity;
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let k = -Math.round(w * 0.6); k <= w; k++) s += Math.abs(t.kappa[(i + k + N) % N]);
    if (s < bs) ((bs = s), (bi = i));
  }
  const rot = <T>(a: T[]) => [...a.slice(bi), ...a.slice(0, bi)];
  const pts = rot(t.pts);
  // centré sur l'origine
  const cx = (t.bounds[0] + t.bounds[2]) / 2, cz = (t.bounds[1] + t.bounds[3]) / 2;
  const moved = pts.map(([x, z]) => [x - cx, z - cz] as Pt);
  return { ...t, pts: moved, head: rot(t.head), kappa: rot(t.kappa), bounds: [t.bounds[0] - cx, t.bounds[1] - cz, t.bounds[2] - cx, t.bounds[3] - cz] };
}

/** Point de la ligne médiane à l'abscisse `s` (m, prise modulo la longueur) : position et cap. */
export function trackAt(t: Track, s: number): { p: Pt; h: number; k: number } {
  const N = t.pts.length;
  const u = (((s % t.L) + t.L) % t.L) / t.step;
  const i = Math.floor(u) % N, j = (i + 1) % N, f = u - Math.floor(u);
  const a = t.pts[i], b = t.pts[j];
  return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], h: t.head[i] + wrapAngle(t.head[j] - t.head[i]) * f, k: t.kappa[i] * (1 - f) + t.kappa[j] * f };
}

/**
 * Projection d'un point sur la piste : abscisse `s` (m), écart latéral signé (le long de `normalOf`) et cap. `hint` :
 * abscisse précédente (recherche locale, ±40 m) ; sans elle, sur toute la boucle.
 */
export function project(t: Track, x: number, z: number, hint?: number): { s: number; lat: number; h: number } {
  const N = t.pts.length;
  let i0 = 0, i1 = N;
  if (hint !== undefined && Number.isFinite(hint)) {
    const c = Math.round((((hint % t.L) + t.L) % t.L) / t.step);
    const w = Math.ceil(40 / t.step);
    i0 = c - w;
    i1 = c + w;
  }
  let bi = 0, bd = Infinity;
  for (let k = i0; k <= i1; k++) {
    const i = ((k % N) + N) % N;
    const d = (t.pts[i][0] - x) ** 2 + (t.pts[i][1] - z) ** 2;
    if (d < bd) ((bd = d), (bi = i));
  }
  // affinage sur les deux segments voisins
  let best = { s: bi * t.step, lat: 0, h: t.head[bi], d: Infinity };
  for (const a of [(bi - 1 + N) % N, bi]) {
    const b = (a + 1) % N;
    const A = t.pts[a], B = t.pts[b];
    const ex = B[0] - A[0], ez = B[1] - A[1];
    const L2 = ex * ex + ez * ez || 1;
    const u = clamp(((x - A[0]) * ex + (z - A[1]) * ez) / L2, 0, 1);
    const px = A[0] + ex * u, pz = A[1] + ez * u;
    const d = (x - px) ** 2 + (z - pz) ** 2;
    if (d < best.d) {
      const h = Math.atan2(ex, ez);
      const nrm = normalOf(h);
      best = { s: (a + u) * t.step, lat: (x - px) * nrm[0] + (z - pz) * nrm[1], h, d };
    }
  }
  return { s: best.s, lat: best.lat, h: best.h };
}

/* ---------------- pilotage arcade ---------------- */

export type CarInput = DriveInput & { handbrake?: boolean };

/**
 * Un pas de voiture : braquage lissé (moins de débattement à haute vitesse), accélération qui s'essouffle près de la
 * pointe, freinage, marche arrière ; l'accélération latérale est bornée par l'adhérence (au-delà, la voiture élargit
 * et perd de la vitesse : sous-virage) ; frein à main : l'arrière décroche (plus de rotation, moins d'adhérence).
 * `grip` multiplie l'adhérence (herbe, sable) et `top` la vitesse de pointe. Rend l'excès de glisse (m/s²).
 */
export function stepCar(c: CarTune, s: DriveState, inp: CarInput, dt: number, grip = 1, top = 1): number {
  if (dt <= 0) return 0;
  const v0 = s.speed;
  const lim = c.maxSteer * clamp(1 - (0.62 * Math.abs(v0)) / c.maxSpeed, 0.28, 1);
  const want = clamp(inp.steer, -1, 1) * lim;
  const rate = 3.4 * dt;
  s.steer += clamp(want - s.steer, -rate, rate);
  const t = clamp(inp.throttle, -1, 1), b = clamp(inp.brake, 0, 1);
  const vmax = c.maxSpeed * top;
  let v = v0;
  if (t > 0.01) {
    if (v < -0.05) v = Math.min(0, v + c.brake * dt);
    else if (v < vmax * t) v += c.accel * t * (1 - 0.75 * (v / vmax) ** 2) * dt;
  } else if (t < -0.01) {
    if (v > 0.3) v = Math.max(0, v - c.brake * -t * dt);
    else v = Math.max(-6 * -t, v - c.accel * 0.5 * -t * dt);
  }
  // traînée : roulement et air
  v -= Math.sign(v) * Math.min(Math.abs(v), (0.25 + 0.0009 * v * v) * dt * 2);
  if (v > vmax) v = Math.max(vmax, v - 14 * dt);
  if (b > 0) v = Math.sign(v) * Math.max(0, Math.abs(v) - c.brake * b * dt);
  if (inp.handbrake) v = Math.sign(v) * Math.max(0, Math.abs(v) - c.brake * 0.35 * dt);
  let yawRate = (-v * Math.tan(s.steer)) / c.wheelbase;
  const g = c.grip * grip * (inp.handbrake ? 0.6 : 1);
  const latAcc = Math.abs(v * yawRate);
  let slip = 0;
  if (latAcc > g) {
    slip = latAcc - g;
    // frein à main : l'arrière décroche, la voiture pivote plus qu'elle ne devrait ; sinon elle élargit
    const k = inp.handbrake ? Math.min(1.5, (g * 1.45) / latAcc) : g / latAcc;
    yawRate *= k;
    v -= Math.sign(v) * slip * (inp.handbrake ? 0.1 : 0.16) * dt;
  }
  if (Math.abs(v) < 1e-3) v = 0;
  const yaw = s.yaw + yawRate * dt;
  const ym = (s.yaw + yaw) / 2;
  const nx = s.x + Math.sin(ym) * v * dt, nz = s.z + Math.cos(ym) * v * dt;
  const kk = 1 - Math.exp(-dt * 5);
  s.lat += (clamp(v * yawRate, -g * 1.2, g * 1.2) - s.lat) * kk;
  s.lon += ((v - v0) / dt - s.lon) * kk;
  s.dist += Math.hypot(nx - s.x, nz - s.z) * Math.sign(v || 1);
  s.x = nx;
  s.z = nz;
  s.yaw = yaw;
  s.speed = v;
  return slip;
}

/* ---------------- course ---------------- */

export type RaceCar = {
  id: string;
  name: string;
  human: boolean;
  tune: CarTune;
  s: DriveState;
  /** Abscisse sur la boucle (m) et progression totale (tours compris). */
  at: number;
  lat: number;
  progress: number;
  lap: number;
  /** Passage au milieu du tour (un tour ne compte qu'après lui). */
  half: boolean;
  lapStart: number;
  last: number | null;
  best: number | null;
  finished: number | null;
  rank: number;
  /** Adversaire : aisance (0,9 … 1,1), couloir préféré (-1 … 1), écart latéral visé. */
  skill: number;
  lane: number;
  aim: number;
  offT: number;
  stallT: number;
  respawn: number;
  slip: number;
  input: CarInput;
};

export type RaceEvent = { type: string; payload: Record<string, unknown> };
export type RacePhase = "countdown" | "race" | "finish" | "done";

export const NO_CAR_INPUT: CarInput = { throttle: 0, steer: 0, brake: 0, handbrake: false };

/** Places de départ : deux colonnes en quinconce derrière la ligne (abscisse négative), le joueur en 4e place au plus. */
export function gridSlots(t: Track, n: number): { x: number; z: number; yaw: number; at: number }[] {
  const out: { x: number; z: number; yaw: number; at: number }[] = [];
  for (let k = 0; k < n; k++) {
    const at = -6 - k * 4.5;
    const q = trackAt(t, at);
    const side = k % 2 ? -1 : 1;
    const nr = normalOf(q.h);
    const off = side * t.width * 0.22;
    out.push({ x: q.p[0] + nr[0] * off, z: q.p[1] + nr[1] * off, yaw: q.h, at });
  }
  return out;
}

/** Rang de départ de chaque pilote (index dans `drivers`) : le joueur part 4e (ou dernier s'il y a moins de voitures). */
export function gridOrder(spec: RaceSpec): number[] {
  const n = spec.drivers.length;
  const order = Array.from({ length: n }, (_, i) => i).filter((i) => !(spec.human && i === 0));
  if (spec.human) order.splice(Math.min(3, order.length), 0, 0);
  return order;
}

export class RaceSim {
  readonly spec: RaceSpec;
  readonly track: Track;
  readonly cars: RaceCar[] = [];
  phase: RacePhase;
  /** Temps de course (s, 0 au départ), compte à rebours restant. */
  time = 0;
  countdown: number;
  /** Fin : temps écoulé depuis l'arrivée du joueur (ou du premier). */
  private endT = 0;
  readonly events: RaceEvent[] = [];
  private lastCount = 4;
  /** Collision avec le décor : pose candidate → id de ce qui gêne (ou `null`). */
  blocked: ((id: string, x: number, z: number, yaw: number) => string | null) | null = null;

  constructor(spec: RaceSpec, ids: string[], track = genTrack(spec.seed, spec.length, spec.width)) {
    this.spec = spec;
    this.track = track;
    const slots = gridSlots(track, ids.length);
    const r = rng(spec.seed * 31 + 5);
    const order = gridOrder(spec);
    ids.forEach((id, slot) => {
      const di = order[slot] ?? slot;
      const d = spec.drivers[di] ?? { name: id, paint: "red" };
      const human = spec.human && di === 0;
      const base = RACE_CARS[spec.car];
      const skill = human ? 1 : clamp(0.86 + 0.16 * spec.level + (r() - 0.5) * 0.08, 0.8, 1.06);
      const tune: CarTune = human ? { ...base } : { ...base, maxSpeed: base.maxSpeed * skill, grip: base.grip * (0.82 + 0.2 * spec.level + (r() - 0.5) * 0.05) };
      const sl = slots[slot];
      this.cars.push({
        id, name: d.name, human, tune,
        s: { x: sl.x, z: sl.z, yaw: sl.yaw, speed: 0, steer: 0, dist: 0, lat: 0, lon: 0 },
        at: sl.at, lat: 0, progress: sl.at, lap: 0, half: false, lapStart: 0, last: null, best: null, finished: null, rank: slot + 1,
        skill, lane: (r() - 0.5) * 1.2, aim: 0, offT: 0, stallT: 0, respawn: 0, slip: 0, input: { ...NO_CAR_INPUT },
      });
    });
    this.countdown = spec.countdown ? 3.999 : 0;
    this.phase = spec.countdown ? "countdown" : "race";
    if (!spec.countdown) this.events.push({ type: "start", payload: { laps: spec.laps, cars: ids.length } });
    for (const c of this.cars) {
      const p = project(track, c.s.x, c.s.z);
      c.at = p.s > track.L / 2 ? p.s - track.L : p.s;
      c.lat = p.lat;
      c.progress = c.at;
    }
  }

  get player(): RaceCar | null {
    return this.cars.find((c) => c.human) ?? null;
  }
  /** Voiture suivie par la caméra : le joueur, sinon le meneur. */
  get focus(): RaceCar {
    return this.player ?? [...this.cars].sort((a, b) => a.rank - b.rank)[0];
  }

  /** Une image : `human` = commande du joueur. */
  step(dt: number, human: CarInput) {
    dt = Math.min(dt, 0.05);
    if (this.phase === "countdown") {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown);
      if (n !== this.lastCount && n >= 1) this.events.push({ type: "countdown", payload: { n } });
      this.lastCount = n;
      if (this.countdown <= 0) {
        this.phase = "race";
        this.countdown = 0;
        this.events.push({ type: "start", payload: { laps: this.spec.laps, cars: this.cars.length } });
      }
      // moteurs qui grondent : rien ne bouge
      for (const c of this.cars) c.input = c.human ? { ...human, throttle: 0, brake: 1 } : { ...NO_CAR_INPUT, brake: 1 };
      return;
    }
    this.time += dt;
    for (const c of this.cars) {
      if (c.respawn > 0) {
        c.respawn -= dt;
        c.input = { ...NO_CAR_INPUT, brake: 1 };
        if (c.respawn <= 0) this.putBack(c);
        continue;
      }
      const done = c.finished !== null;
      c.input = done ? this.autopilot(c, 0.45) : c.human ? human : this.autopilot(c, 1);
      this.drive(c, dt);
    }
    this.collide();
    for (const c of this.cars) this.track1(c, dt);
    this.rank();
    // fin : 25 s après l'arrivée du joueur (ou de tous), la course est close
    if (this.phase === "finish") {
      this.endT += dt;
      if (this.endT > 25 || this.cars.every((c) => c.finished !== null)) this.close();
    }
  }

  private drive(c: RaceCar, dt: number) {
    const t = this.track;
    const off = Math.abs(c.lat) > t.width / 2 + 0.4;
    const far = Math.abs(c.lat) > t.width / 2 + 3;
    const x0 = c.s.x, z0 = c.s.z, y0 = c.s.yaw, d0 = c.s.dist;
    c.slip = stepCar(c.tune, c.s, c.input, dt, off ? 0.62 : 1, far ? 0.42 : off ? 0.62 : 1);
    const hit = this.blocked?.(c.id, c.s.x, c.s.z, c.s.yaw) ?? null;
    if (hit) {
      // choc contre le décor : on reste en place, rebond amorti
      c.s.x = x0;
      c.s.z = z0;
      c.s.yaw = y0;
      c.s.dist = d0;
      const v = c.s.speed;
      c.s.speed = -v * 0.25;
      if (Math.abs(v) > 3) this.events.push({ type: "bump", payload: { car: c.id, hit, speed: Math.round(Math.abs(v) * 3.6) } });
    }
  }

  /** Commande d'un adversaire : poursuite d'un point de la ligne de course, vitesse bornée par les virages à venir. */
  autopilot(c: RaceCar, pace: number): CarInput {
    const t = this.track, s = c.s, tune = c.tune;
    const v = Math.max(0, s.speed);
    // écart visé : couloir préféré, corde des virages, évitement de la voiture devant
    const ahead = trackAt(t, c.at + 25);
    const half = t.width / 2 - tune.hx - 0.6;
    let aim = c.lane * half * 0.5 + clamp(ahead.k * 260, -1, 1) * half * 0.6;
    for (const o of this.cars) {
      if (o === c) continue;
      let d = o.at - c.at;
      if (d < -t.L / 2) d += t.L;
      if (d > t.L / 2) d -= t.L;
      if (d > 0 && d < 16 && Math.abs(o.lat - aim) < tune.hx * 2 + 0.8 && o.s.speed < v + 1) aim = o.lat + (o.lat > 0 ? -1 : 1) * (tune.hx * 2 + 1.4);
    }
    aim = clamp(aim, -half, half);
    c.aim += (aim - c.aim) * 0.08;
    const look = 7 + v * 0.55;
    const q = trackAt(t, c.at + look);
    const nr = normalOf(q.h);
    const tx = q.p[0] + nr[0] * c.aim, tz = q.p[1] + nr[1] * c.aim;
    const dx = tx - s.x, dz = tz - s.z;
    const lateral = dx * Math.cos(s.yaw) - dz * Math.sin(s.yaw);
    const forward = dx * Math.sin(s.yaw) + dz * Math.cos(s.yaw);
    const alpha = Math.atan2(lateral, forward);
    const Ld = Math.max(1, Math.hypot(dx, dz));
    const delta = Math.atan((2 * Math.sin(alpha) * tune.wheelbase) / Ld);
    const steer = clamp(-delta / tune.maxSteer, -1, 1);
    // vitesse permise : courbure des 90 m à venir et distance de freinage
    const g = tune.grip * 0.92;
    const decel = tune.brake * 0.7;
    let vt = tune.maxSpeed * pace;
    for (let d = 0; d <= 90; d += 4) {
      const k = Math.abs(trackAt(t, c.at + d).k);
      const vc = Math.sqrt(g / Math.max(1e-4, k));
      vt = Math.min(vt, Math.sqrt(vc * vc + 2 * decel * Math.max(0, d - 4)));
    }
    // un peu d'élastique : un adversaire loin devant le joueur lève le pied, loin derrière il attaque
    const p = this.player;
    if (p && !c.finished) {
      const gap = c.progress - p.progress;
      vt *= gap > 60 ? 0.93 : gap < -80 ? 1.04 : 1;
    }
    const e = vt - v;
    const throttle = clamp(e * 0.5 + 0.35, 0, 1);
    const brake = e < -1.2 ? clamp(-e * 0.18, 0, 1) : 0;
    // coincé (contre un obstacle) : marche arrière en contre-braquant
    if (c.stallT > 1.6) return { throttle: -1, steer: -steer, brake: 0, handbrake: false };
    return { throttle: brake > 0 ? 0 : throttle, steer, brake, handbrake: false };
  }

  /** Chocs entre voitures : boîtes séparées, vitesses en partie échangées. */
  private collide() {
    const C = this.cars;
    for (let i = 0; i < C.length; i++)
      for (let j = i + 1; j < C.length; j++) {
        const a = C[i], b = C[j];
        if (a.respawn > 0 || b.respawn > 0) continue;
        const dx = b.s.x - a.s.x, dz = b.s.z - a.s.z;
        const R = a.tune.hz + b.tune.hz;
        const d2 = dx * dx + dz * dz;
        if (d2 > R * R) continue;
        // trois cercles par voiture (avant, milieu, arrière)
        let push: Pt | null = null, depth = 0;
        const circ = (c: RaceCar): Pt[] => [-0.62, 0, 0.62].map((f) => [c.s.x + Math.sin(c.s.yaw) * c.tune.hz * f, c.s.z + Math.cos(c.s.yaw) * c.tune.hz * f] as Pt);
        const ra = a.tune.hx + 0.15, rb = b.tune.hx + 0.15;
        for (const p of circ(a))
          for (const q of circ(b)) {
            const ex = q[0] - p[0], ez = q[1] - p[1];
            const d = Math.hypot(ex, ez);
            const pen = ra + rb - d;
            if (pen > depth) ((depth = pen), (push = d > 1e-6 ? [ex / d, ez / d] : [1, 0]));
          }
        if (!push || depth <= 0) continue;
        a.s.x -= push[0] * depth * 0.5;
        a.s.z -= push[1] * depth * 0.5;
        b.s.x += push[0] * depth * 0.5;
        b.s.z += push[1] * depth * 0.5;
        // celui qui rattrape perd de la vitesse, celui qui est poussé en gagne un peu
        const va = a.s.speed, vb = b.s.speed;
        const ahead = push[0] * Math.sin(a.s.yaw) + push[1] * Math.cos(a.s.yaw) > 0;
        if (ahead && va > vb) ((a.s.speed = va * 0.7 + vb * 0.3), (b.s.speed = vb + (va - vb) * 0.2));
        else if (!ahead && vb > va) ((b.s.speed = vb * 0.7 + va * 0.3), (a.s.speed = va + (vb - va) * 0.2));
        const rel = Math.abs(va - vb);
        if (rel > 2.5) this.events.push({ type: "contact", payload: { a: a.id, b: b.id, speed: Math.round(rel * 3.6) } });
      }
  }

  /** Abscisse, tours, sortie de piste, voiture coincée. */
  private track1(c: RaceCar, dt: number) {
    const t = this.track;
    if (c.respawn > 0) return;
    const prev = c.at;
    const p = project(t, c.s.x, c.s.z, prev);
    let at = p.s;
    let d = at - (((prev % t.L) + t.L) % t.L);
    if (d < -t.L / 2) d += t.L;
    if (d > t.L / 2) d -= t.L;
    at = prev + d;
    c.at = at;
    c.lat = p.lat;
    // milieu du tour franchi
    const lapPos = at - c.lap * t.L;
    if (lapPos > t.L * 0.5) c.half = true;
    if (lapPos >= t.L && c.half && c.finished === null) {
      c.lap++;
      c.half = false;
      const lapT = this.time - c.lapStart;
      c.lapStart = this.time;
      if (c.lap >= 1) {
        c.last = lapT;
        const best = c.best === null || lapT < c.best;
        if (best) c.best = lapT;
        this.events.push({ type: "lap", payload: { car: c.id, name: c.name, lap: c.lap, time: round3(lapT), best, human: c.human } });
      }
      if (c.lap >= this.spec.laps) {
        c.finished = this.time;
        const position = this.cars.filter((o) => o.finished !== null).length;
        this.events.push({ type: "finish", payload: { car: c.id, name: c.name, position, time: round3(this.time), human: c.human } });
        if (this.phase === "race" && (c.human || !this.player)) this.phase = "finish";
      }
    }
    c.progress = c.finished !== null ? this.spec.laps * t.L + (1e6 - c.finished) : at;
    // trop loin de la piste, ou à l'envers et arrêté : remise en piste
    const lost = Math.abs(c.lat) > t.width / 2 + 22;
    if (Math.abs(c.s.speed) < 1.2 && this.phase !== "countdown") c.stallT += dt;
    else c.stallT = 0;
    if (Math.abs(c.lat) > t.width / 2 + 0.4) c.offT += dt;
    else c.offT = 0;
    if (lost || c.stallT > 4) this.reset(c, lost ? "lost" : "stuck");
  }

  /** Remise en piste demandée (touche, bouton, ou automatique) : la voiture disparaît 1,2 s puis repart arrêtée. */
  reset(c: RaceCar, reason = "asked") {
    if (c.respawn > 0) return;
    c.respawn = 1.2;
    c.s.speed = 0;
    this.events.push({ type: "respawn", payload: { car: c.id, reason } });
  }

  private putBack(c: RaceCar) {
    const t = this.track;
    // un peu en arrière, au milieu, cap de la piste, sur une place libre
    let at = c.at - 6;
    for (let k = 0; k < 6; k++) {
      const q = trackAt(t, at);
      if (!this.cars.some((o) => o !== c && Math.hypot(o.s.x - q.p[0], o.s.z - q.p[1]) < 6)) break;
      at -= 7;
    }
    const q = trackAt(t, at);
    c.s.x = q.p[0];
    c.s.z = q.p[1];
    c.s.yaw = q.h;
    c.s.speed = 0;
    c.s.steer = 0;
    c.at = at;
    c.lat = 0;
    c.stallT = 0;
    c.respawn = 0;
  }

  private rank() {
    const sorted = [...this.cars].sort((a, b) => b.progress - a.progress);
    sorted.forEach((c, i) => {
      const r = i + 1;
      if (c.human && r !== c.rank && this.phase === "race") this.events.push({ type: "position", payload: { car: c.id, position: r, was: c.rank } });
      c.rank = r;
    });
  }

  private close() {
    if (this.phase === "done") return;
    this.phase = "done";
    this.events.push({ type: "raceEnd", payload: { results: this.results() } });
  }

  results() {
    return [...this.cars].sort((a, b) => a.rank - b.rank).map((c) => ({ car: c.id, name: c.name, position: c.rank, time: c.finished !== null ? round3(c.finished) : null, best: c.best !== null ? round3(c.best) : null, laps: Math.min(c.lap, this.spec.laps), human: c.human }));
  }

  /** Résumé publié (`state-out.race`). */
  summary() {
    const f = this.focus;
    return {
      phase: this.phase,
      countdown: this.phase === "countdown" ? Math.ceil(this.countdown) : 0,
      time: round3(this.time),
      laps: this.spec.laps,
      lap: f ? Math.min(this.spec.laps, f.lap + 1) : 0,
      position: f?.rank ?? 0,
      cars: this.cars.length,
      speed: f ? Math.round(Math.abs(f.s.speed) * 3.6) : 0,
      last: f?.last !== null && f ? round3(f.last!) : null,
      best: f?.best !== null && f ? round3(f.best!) : null,
      player: this.player?.id ?? null,
      offTrack: f ? f.offT > 0 : false,
      length: Math.round(this.track.L),
      standings: this.results(),
    };
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/* ---------------- recette du circuit ---------------- */

const SCENERY_STYLE: Record<Scenery, { surface: string; style?: string; trees: string; rocks: number; density: number }> = {
  campagne: { surface: "grass", trees: "tree", rocks: 0.1, density: 1 },
  foret: { surface: "grass", trees: "tree", rocks: 0.05, density: 2.2 },
  desert: { surface: "sand", style: "desert", trees: "rock", rocks: 0, density: 0.6 },
  neige: { surface: "snow", style: "neige", trees: "tree", rocks: 0.1, density: 1.2 },
  nuit: { surface: "grass", style: "nuit", trees: "tree", rocks: 0.05, density: 0.9 },
};

/** Recette de la scène : piste (route fermée), décor, tribunes et drapeaux au départ, cônes aux virages serrés, voitures sur la grille. */
export function raceRecipe(spec: RaceSpec, track = genTrack(spec.seed, spec.length, spec.width)): Record<string, unknown> {
  const t = track;
  const [x0, z0, x1, z1] = t.bounds;
  const margin = 46;
  const size: Pt = [Math.ceil(x1 - x0 + margin * 2), Math.ceil(z1 - z0 + margin * 2)];
  const sc = SCENERY_STYLE[spec.scenery];
  // piste : un point tous les 6 m, boucle fermée (le premier point est repris à la fin)
  const every = Math.max(1, Math.round(6 / t.step));
  const pts: Pt[] = [];
  for (let i = 0; i < t.pts.length; i += every) pts.push([r2(t.pts[i][0]), r2(t.pts[i][1])]);
  pts.push(pts[0], pts[1]);
  const half = t.width / 2;
  // cônes à l'extérieur des virages serrés
  const cones: { x: number; z: number }[] = [];
  const coneStep = Math.max(1, Math.round(5 / t.step));
  for (let i = 0; i < t.pts.length; i += coneStep) {
    const k = t.kappa[i];
    if (Math.abs(k) < 1 / 38) continue;
    const nr = normalOf(t.head[i]);
    const side = k > 0 ? -1 : 1;
    cones.push({ x: r2(t.pts[i][0] + nr[0] * side * (half + 1.6)), z: r2(t.pts[i][1] + nr[1] * side * (half + 1.6)) });
  }
  // départ : tribune à l'extérieur, drapeaux de part et d'autre de la ligne
  const s0 = trackAt(t, 0);
  const n0 = normalOf(s0.h);
  const standSide = t.kappa.slice(0, 40).reduce((a, b) => a + b, 0) > 0 ? -1 : 1;
  const standAt = { x: r2(s0.p[0] + n0[0] * standSide * (half + 13)), z: r2(s0.p[1] + n0[1] * standSide * (half + 13)), yaw: r2((Math.atan2(-n0[0] * standSide, -n0[1] * standSide) * 180) / Math.PI) };
  const flags = [1, -1].map((sd) => ({ x: r2(s0.p[0] + n0[0] * sd * (half + 1.8)), z: r2(s0.p[1] + n0[1] * sd * (half + 1.8)), yaw: r2((s0.h * 180) / Math.PI + 90) }));
  // voitures sur la grille
  const slots = gridSlots(t, spec.drivers.length);
  const order = gridOrder(spec);
  const paintOf = (slot: number) => spec.drivers[order[slot] ?? slot]?.paint ?? "red";
  let paintExpr = `'${paintOf(slots.length - 1)}'`;
  for (let k = slots.length - 2; k >= 0; k--) paintExpr = `i == ${k} ? '${paintOf(k)}' : ${paintExpr}`;
  const layers: unknown[] = [
    { id: "voitures", gen: `vehicle.${spec.car}`, place: { at: slots.map((s) => ({ x: r2(s.x), z: r2(s.z), yaw: r2((s.yaw * 180) / Math.PI) })) }, params: { paint: `= ${paintExpr}` }, onPath: true },
    { id: "tribune", gen: "sport.stand", place: { at: [standAt] }, params: { length: 34, rows: 7 } },
    { id: "drapeaux", gen: "textile.flag", place: { at: flags } },
  ];
  if (cones.length) layers.push({ id: "cones", gen: "street.trafficcone", place: { at: cones.slice(0, 160) }, onPath: true });
  const dens = sc.density;
  // décor lointain : tirage en grille désordonnée, jamais à moins de 12 m du bord de la piste
  const far = (cell: number, clear: number, salt: number, max: number) => {
    const r = rng(spec.seed * 131 + salt);
    const out: { x: number; z: number }[] = [];
    for (let x = -size[0] / 2 + cell / 2; x < size[0] / 2; x += cell)
      for (let z = -size[1] / 2 + cell / 2; z < size[1] / 2; z += cell) {
        const px = x + (r() - 0.5) * cell * 0.9, pz = z + (r() - 0.5) * cell * 0.9;
        if (Math.abs(px) > size[0] / 2 - 3 || Math.abs(pz) > size[1] / 2 - 3) continue;
        if (Math.abs(project(t, px, pz).lat) < half + clear) continue;
        if (Math.hypot(px - standAt.x, pz - standAt.z) < 24) continue;
        out.push({ x: r2(px), z: r2(pz) });
      }
    return out.slice(0, max);
  };
  if (sc.trees === "rock") {
    layers.push({ id: "rochers", gen: "rock", place: { along: "piste", side: "both", spacing: 26 / dens, offset: 8, jitter: 4 } });
    layers.push({ id: "rochers-loin", gen: "rock", place: { at: far(26 / dens, 12, 1, 220) } });
    layers.push({ id: "buissons", gen: "bush", place: { at: far(34, 10, 2, 120) } });
  } else {
    layers.push({ id: "arbres", gen: "tree", place: { along: "piste", side: "both", spacing: 18 / dens, offset: 9, jitter: 3 } });
    layers.push({ id: "bois", gen: "tree", place: { at: far(17 / dens, 13, 3, 320) } });
    layers.push({ id: "buissons", gen: "bush", place: { along: "piste", side: "both", spacing: 23, offset: 4.5, jitter: 2 } });
    if (sc.rocks > 0) layers.push({ id: "rochers", gen: "rock", place: { at: far(40, 12, 4, 40) } });
  }
  return {
    size,
    seed: spec.seed,
    ground: { relief: 0, surface: sc.surface },
    paths: [{ id: "piste", points: pts, width: t.width, kind: "road", sidewalk: 0 }],
    layers,
    ...(sc.style ? { style: sc.style } : {}),
    view: { camera: "perspective", yaw: (s0.h * 180) / Math.PI + 180, pitch: 18, zoom: 3, cx: s0.p[0], cy: 0, cz: s0.p[1], fov: 60 },
    wind: 0.5,
  };
}

const r2 = (x: number) => Math.round(x * 100) / 100;
