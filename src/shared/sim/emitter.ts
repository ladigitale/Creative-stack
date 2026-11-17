/**
 * Émetteurs : des copies d'un modèle naissent, bougent et meurent sans que le reducer les connaisse une par une.
 *
 * - `ballistic` : projectiles (vitesse, gravité, frottement, contact contre les boîtes du monde et le sol).
 * - `flock` : nuée au sol (séparation, cohésion, alignement, poursuite ou fuite d'une instance, contournement).
 *
 * L'état vit dans des tableaux typés de taille `max` (suppression par échange avec la dernière copie) : aucune
 * allocation en jeu. Pas de temps fixe (1/60 s), graine par émetteur : même graine, même tir. Aucune dépendance au
 * rendu ni au DOM.
 */
import { hash32 } from "../rng";
import { BoxGrid, PointGrid, sweepBox, type Aabb, type BoxQuery } from "./grid";

export type V3 = [number, number, number];
export type Range = [number, number];

export type OnHit = "die" | "bounce" | "stick" | "pierce";

export type FlockSpec = {
  /** Instance poursuivie, ou fuie (`flee`, à moins de `fleeRadius`). */
  seek: string;
  flee: string;
  fleeRadius: number;
  speed: Range;
  separation: number;
  cohesion: number;
  align: number;
  /** Rayon de voisinage (mètres). */
  radius: number;
  /** Errance quand rien n'attire (0 à 1). */
  wander: number;
  /** Étiquettes des boîtes contournées (vide : toutes celles du `mask`, sinon tout le décor solide). */
  avoid: string[];
  /** Reste dans ce rectangle `[x0, z0, x1, z1]` (mètres), s'il est donné. */
  bounds: [number, number, number, number] | null;
};

export type EmitterSpec = {
  id: string;
  /** Modèle écrit et variantes construites (paramètres tirés par copie). */
  model: string;
  variants: { model: string; roles: Record<string, string> }[];
  params: Record<string, unknown> | null;
  behavior: "ballistic" | "flock";
  max: number;
  /** Durée de vie (s) ; 0 : immortelle (nuées). */
  life: Range;
  /** Naissances par seconde, en continu. */
  rate: number;
  /** Source : instance nommée (le tir part d'elle et suit son cap), sinon `at`. */
  from: string;
  at: V3;
  /** Décalage de départ dans le repère de la source. */
  offset: V3;
  dir: V3;
  /** Écart angulaire autour de `dir` (degrés). */
  spread: number;
  speed: Range;
  gravity: number;
  drag: number;
  /** Rayon de la sphère de contact (mètres). */
  radius: number;
  /** Étiquettes touchées (`sol` : le sol ; vide : rien n'est touché). */
  mask: string[];
  onHit: OnHit;
  bounce: number;
  /** Nuée : posée au sol (`on: "sol"`). */
  ground: boolean;
  spawn: { count: number; area: [number, number, number, number] } | null;
  flock: FlockSpec | null;
  scale: Range;
  /** Événements regroupés publiés en plus de `hit` (`expire`). */
  events: string[];
  /** Copies les plus proches de la cible publiées (`near`, 8 au plus). */
  publish: number;
  pick: boolean;
  /** Une copie d'un autre émetteur touchée (nom de l'émetteur dans `mask`) est retirée ; `false` : seulement signalée. */
  kills: boolean;
  /** Impulsion donnée au corps physique touché (N·s, 0 : aucune). */
  push: number;
  /** Particules liées (lot particules) : traînée et salve d'impact, gardées pour plus tard. */
  trail: string;
  burst: string;
  seed: string;
};

export type EmitIssue = { path: string; message: string };

export const EMIT_LIMITS = { emitters: 16, maxPerEmitter: 2000, total: 6000, variants: 8 } as const;

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const NAME = /^[A-Za-z][\w-]{0,63}$/;

function range(v: unknown, d: Range, k = 1): Range {
  if (fin(v)) return [v * k, v * k];
  if (Array.isArray(v) && fin(v[0])) {
    const a = v[0] * k, b = fin(v[1]) ? v[1] * k : a;
    return a <= b ? [a, b] : [b, a];
  }
  return d;
}

function vec(v: unknown, d: V3, k = 1): V3 {
  if (!Array.isArray(v)) return d;
  if (v.length === 2 && fin(v[0]) && fin(v[1])) return [v[0] * k, 0, v[1] * k];
  return [fin(v[0]) ? v[0] * k : d[0], fin(v[1]) ? v[1] * k : d[1], fin(v[2]) ? v[2] * k : d[2]];
}

function strs(v: unknown, max = 16): string[] {
  if (typeof v === "string") return v ? [v] : [];
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 64).slice(0, max) : [];
}

function rect(v: unknown, k: number): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length < 4 || !v.slice(0, 4).every(fin)) return null;
  const [a, b, c, d] = (v as number[]).map((x) => x * k);
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

/** Lecture de `monde.emitters` (longueurs dans l'unité du document, facteur `u` vers le mètre). */
export function readEmitters(src: unknown, u: number, issues: EmitIssue[]): EmitterSpec[] {
  if (src === undefined) return [];
  if (!isObj(src)) {
    issues.push({ path: "emitters", message: "objet {id: {model, …}} attendu" });
    return [];
  }
  const out: EmitterSpec[] = [];
  let total = 0;
  for (const [id, raw] of Object.entries(src)) {
    const path = `emitters.${id}`;
    if (out.length >= EMIT_LIMITS.emitters) {
      issues.push({ path: "emitters", message: `${EMIT_LIMITS.emitters} émetteurs au plus` });
      break;
    }
    if (!NAME.test(id)) {
      issues.push({ path, message: "nom d'émetteur : lettres, chiffres, - et _" });
      continue;
    }
    if (!isObj(raw) || typeof raw.model !== "string" || !raw.model) {
      issues.push({ path, message: "model (nom d'un modèle du monde) attendu" });
      continue;
    }
    const flockIn = raw.flock;
    const behavior: EmitterSpec["behavior"] = isObj(flockIn) || raw.behavior === "flock" ? "flock" : "ballistic";
    let max = fin(raw.max) ? Math.round(raw.max) : behavior === "flock" ? 100 : 64;
    max = clamp(max, 1, EMIT_LIMITS.maxPerEmitter);
    if (total + max > EMIT_LIMITS.total) {
      issues.push({ path: `${path}.max`, message: `${EMIT_LIMITS.total} copies au plus pour tous les émetteurs` });
      max = Math.max(0, EMIT_LIMITS.total - total);
      if (!max) continue;
    }
    total += max;
    const onHit = (["die", "bounce", "stick", "pierce"] as const).includes(raw.onHit as OnHit) ? (raw.onHit as OnHit) : "die";
    if (raw.onHit !== undefined && onHit !== raw.onHit) issues.push({ path: `${path}.onHit`, message: "die, bounce, stick ou pierce" });
    let flock: FlockSpec | null = null;
    if (behavior === "flock") {
      const f = isObj(flockIn) ? flockIn : {};
      flock = {
        seek: typeof f.seek === "string" ? f.seek : "",
        flee: typeof f.flee === "string" ? f.flee : "",
        fleeRadius: fin(f.fleeRadius) ? Math.max(0, f.fleeRadius * u) : 8,
        speed: range(f.speed, [1, 2], u),
        separation: fin(f.separation) ? clamp(f.separation * u, 0, 20) : 0.4,
        cohesion: fin(f.cohesion) ? clamp(f.cohesion, 0, 5) : 0.2,
        align: fin(f.align) ? clamp(f.align, 0, 5) : 0.3,
        radius: fin(f.radius) ? clamp(f.radius * u, 0.05, 50) : 1.5,
        wander: fin(f.wander) ? clamp(f.wander, 0, 1) : 0.3,
        avoid: strs(f.avoid),
        bounds: rect(f.bounds, u),
      };
    }
    const spawnIn = raw.spawn;
    const spawn = isObj(spawnIn) && fin(spawnIn.count) ? { count: clamp(Math.round(spawnIn.count), 0, max), area: rect(spawnIn.area, u) ?? [-5, -5, 5, 5] } : null;
    const dir = vec(raw.dir, [0, 0, 1]);
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    out.push({
      id,
      model: raw.model,
      variants: [],
      params: isObj(raw.params) ? raw.params : null,
      behavior,
      max,
      life: range(raw.life, behavior === "flock" ? [0, 0] : [3, 3]),
      rate: fin(raw.rate) ? clamp(raw.rate, 0, 500) : 0,
      from: typeof raw.from === "string" ? raw.from.split("@")[0] : "",
      at: vec(raw.at, [0, 0, 0], u),
      offset: vec(raw.offset, [0, 0, 0], u),
      dir: [dir[0] / len, dir[1] / len, dir[2] / len],
      spread: fin(raw.spread) ? clamp(raw.spread, 0, 180) : 0,
      speed: range(raw.speed, behavior === "flock" ? [1, 2] : [10, 10], u),
      gravity: fin(raw.gravity) ? raw.gravity * u : 0,
      drag: fin(raw.drag) ? clamp(raw.drag, 0, 50) : 0,
      radius: fin(raw.radius) ? clamp(raw.radius * u, 0.01, 10) : isObj(raw.collider) && fin(raw.collider.sphere) ? clamp(raw.collider.sphere * u, 0.01, 10) : 0.15,
      mask: strs(raw.mask),
      onHit,
      bounce: fin(raw.bounce) ? clamp(raw.bounce, 0, 1) : 0.5,
      ground: raw.on === "sol" || (behavior === "flock" && raw.on !== false),
      spawn,
      flock,
      scale: range(raw.scale, [1, 1]),
      events: strs(raw.events, 4),
      publish: fin(raw.publish) ? clamp(Math.round(raw.publish), 0, 8) : 0,
      pick: raw.pick === true,
      kills: raw.kills !== false,
      push: typeof raw.push === "number" && Number.isFinite(raw.push) ? Math.max(0, Math.min(10000, raw.push)) : 0,
      trail: typeof raw.trail === "string" ? raw.trail : "",
      burst: typeof raw.burst === "string" ? raw.burst : "",
      seed: typeof raw.seed === "string" || fin(raw.seed) ? String(raw.seed) : id,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ simulation */

/** Ce que la simulation demande au monde. */
export type SimWorld = {
  /** Boîtes du monde (décor et instances), indexées. */
  boxes: BoxQuery;
  /** Hauteur du sol sous (x, z). */
  ground(x: number, z: number): number;
  /** Position et cap (radians) d'une instance nommée, ou `null`. */
  pose(name: string): { x: number; y: number; z: number; ry: number } | null;
  /** Autre émetteur du monde (cible d'un `mask`), ou `null`. */
  emitter?(id: string): Emitter | null;
};

/** Touche : `target` = instance, étiquette ou émetteur touché ; `copy` = identifiant de la copie touchée d'un émetteur. */
export type Hit = { emitter: string; id: number; target: string; copy?: number; tags: string[]; x: number; y: number; z: number; /** Direction du projectile (unitaire). */ dir?: [number, number, number] };

/** Ordre de tir lu dans le DataProvider (`emit.<id>`). */
export type EmitOrder = { count?: number; at?: V3; dir?: V3; toward?: string | V3 };

const STEP = 1 / 60;
const TAU = Math.PI * 2;

/** Petit générateur rapide (mulberry32) : un tirage par naissance, sans allocation. */
function rand32(s: number): number {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export class Emitter {
  readonly spec: EmitterSpec;
  n = 0;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly size: Float32Array;
  /** Cap (radians autour de y) et tangage (projectiles). */
  readonly ry: Float32Array;
  readonly rx: Float32Array;
  readonly cruise: Float32Array;
  readonly variant: Uint8Array;
  /** 0 en vol, 1 fiché (stick). */
  readonly state: Uint8Array;
  /** Identifiant stable de la copie (pour `kill`, `pick`, `hit`). */
  readonly ids: Int32Array;
  /** Dernière boîte traversée (pierce : une touche par cible). */
  private lastBox: Int32Array;
  private seq: number;
  private nextId = 1;
  private acc = 0;
  private rateAcc = 0;
  private phase = 0;
  private grid: PointGrid | null;
  emitted = 0;
  dropped = 0;
  expired = 0;
  /** Durée de la dernière avance (ms). */
  ms = 0;

  constructor(spec: EmitterSpec) {
    this.spec = spec;
    const m = spec.max;
    this.px = new Float32Array(m);
    this.py = new Float32Array(m);
    this.pz = new Float32Array(m);
    this.vx = new Float32Array(m);
    this.vy = new Float32Array(m);
    this.vz = new Float32Array(m);
    this.age = new Float32Array(m);
    this.life = new Float32Array(m);
    this.size = new Float32Array(m);
    this.ry = new Float32Array(m);
    this.rx = new Float32Array(m);
    this.cruise = new Float32Array(m);
    this.variant = new Uint8Array(m);
    this.state = new Uint8Array(m);
    this.ids = new Int32Array(m);
    this.lastBox = new Int32Array(m).fill(-1);
    this.seq = hash32(spec.seed) | 0;
    this.grid = spec.flock ? new PointGrid(Math.max(0.2, spec.flock.radius)) : null;
  }

  private r(): number {
    this.seq = (this.seq + 1) | 0;
    return rand32(this.seq);
  }

  private lerp(a: Range): number {
    return a[0] + (a[1] - a[0]) * this.r();
  }

  /** Vide l'émetteur (copies et compteurs de temps ; les totaux restent). */
  clear() {
    this.n = 0;
    this.acc = 0;
    this.rateAcc = 0;
  }

  /** Retire les copies d'identifiants donnés. */
  kill(ids: readonly number[]): number {
    let k = 0;
    for (const id of ids)
      for (let i = 0; i < this.n; i++)
        if (this.ids[i] === id) {
          this.remove(i);
          k++;
          break;
        }
    return k;
  }

  /** Retire la copie de rang `i` (touchée par un autre émetteur). */
  removeAt(i: number) {
    if (i >= 0 && i < this.n) {
      this.remove(i);
      this.expired++;
    }
  }

  private remove(i: number) {
    const j = --this.n;
    if (i === j) return;
    this.px[i] = this.px[j];
    this.py[i] = this.py[j];
    this.pz[i] = this.pz[j];
    this.vx[i] = this.vx[j];
    this.vy[i] = this.vy[j];
    this.vz[i] = this.vz[j];
    this.age[i] = this.age[j];
    this.life[i] = this.life[j];
    this.size[i] = this.size[j];
    this.ry[i] = this.ry[j];
    this.rx[i] = this.rx[j];
    this.cruise[i] = this.cruise[j];
    this.variant[i] = this.variant[j];
    this.state[i] = this.state[j];
    this.ids[i] = this.ids[j];
    this.lastBox[i] = this.lastBox[j];
  }

  /** Emplacement d'une nouvelle copie : la plus ancienne est recyclée quand le pool est plein. */
  private slot(): number {
    if (this.n < this.spec.max) return this.n++;
    let old = 0;
    for (let i = 1; i < this.n; i++) if (this.age[i] > this.age[old]) old = i;
    this.dropped++;
    return old;
  }

  /** Source du tir : position et cap de l'instance `from`, sinon `at`. */
  private origin(world: SimWorld | null, at?: V3): { x: number; y: number; z: number; ry: number } {
    const s = this.spec;
    if (at) return { x: at[0], y: at[1], z: at[2], ry: 0 };
    const p = s.from && world ? world.pose(s.from) : null;
    if (!p) return { x: s.at[0], y: s.at[1], z: s.at[2], ry: 0 };
    const c = Math.cos(p.ry), sn = Math.sin(p.ry);
    const [ox, oy, oz] = s.offset;
    return { x: p.x + ox * c + oz * sn, y: p.y + oy, z: p.z - ox * sn + oz * c, ry: p.ry };
  }

  /** Fait naître `count` copies (salve) ; `toward` vise une instance ou un point. */
  emit(count: number, world: SimWorld | null, o: EmitOrder = {}): number {
    const s = this.spec;
    count = clamp(Math.round(count), 0, s.max);
    const src = this.origin(world, o.at);
    let base: V3 = o.dir ? norm(o.dir) : s.dir;
    let turn = o.dir ? 0 : src.ry;
    if (o.toward !== undefined) {
      const t = typeof o.toward === "string" ? world?.pose(o.toward) : { x: o.toward[0], y: o.toward[1], z: o.toward[2] };
      if (t) {
        base = norm([t.x - src.x, t.y + 0.5 - src.y, t.z - src.z]);
        turn = 0;
      }
    }
    for (let c = 0; c < count; c++) {
      const i = this.slot();
      // direction dans un cône d'ouverture `spread` autour de la direction de base, tournée par le cap de la source
      let d = base;
      if (s.spread > 0) d = jitterDir(base, (s.spread * Math.PI) / 180, this.r(), this.r());
      const ct = Math.cos(turn), st = Math.sin(turn);
      const dx = d[0] * ct + d[2] * st, dz = -d[0] * st + d[2] * ct, dy = d[1];
      const sp = this.lerp(s.speed);
      this.px[i] = src.x;
      this.py[i] = src.y;
      this.pz[i] = src.z;
      this.vx[i] = dx * sp;
      this.vy[i] = dy * sp;
      this.vz[i] = dz * sp;
      this.place(i);
    }
    return count;
  }

  /** Semis initial d'une nuée dans `spawn.area`. */
  seed(world: SimWorld | null) {
    const s = this.spec;
    if (!s.spawn) return;
    const [x0, z0, x1, z1] = s.spawn.area;
    for (let c = 0; c < s.spawn.count; c++) {
      const i = this.slot();
      this.px[i] = x0 + (x1 - x0) * this.r();
      this.pz[i] = z0 + (z1 - z0) * this.r();
      this.py[i] = s.ground && world ? world.ground(this.px[i], this.pz[i]) : s.at[1];
      const a = this.r() * TAU;
      const sp = s.flock ? this.lerp(s.flock.speed) : this.lerp(s.speed);
      this.vx[i] = Math.sin(a) * sp * 0.3;
      this.vy[i] = 0;
      this.vz[i] = Math.cos(a) * sp * 0.3;
      this.place(i);
      this.ry[i] = a;
    }
  }

  /** Fin d'une naissance : identité, durée de vie, taille, variante. */
  private place(i: number) {
    const s = this.spec;
    this.age[i] = 0;
    this.life[i] = s.life[1] > 0 ? this.lerp(s.life) : 0;
    this.size[i] = this.lerp(s.scale);
    this.variant[i] = s.variants.length > 1 ? Math.floor(this.r() * s.variants.length) % s.variants.length : 0;
    this.state[i] = 0;
    this.ids[i] = this.nextId++;
    this.lastBox[i] = -1;
    this.cruise[i] = s.flock ? this.lerp(s.flock.speed) : 0;
    this.ry[i] = Math.atan2(this.vx[i], this.vz[i]);
    this.rx[i] = 0;
    this.emitted++;
  }

  /**
   * Avance de `dt` secondes par pas fixes (4 au plus par appel : un onglet revenu de veille ne rattrape pas tout).
   * Les touches de la période sont ajoutées à `hits`.
   */
  advance(dt: number, world: SimWorld, hits: Hit[]): boolean {
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    const s = this.spec;
    let moved = false;
    if (s.rate > 0) {
      this.rateAcc += dt * s.rate;
      const k = Math.floor(this.rateAcc);
      if (k > 0) {
        this.rateAcc -= k;
        this.emit(Math.min(k, s.max), world);
        moved = true;
      }
    }
    this.acc = Math.min(this.acc + dt, STEP * 4);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      if (this.n === 0) continue;
      if (s.flock) this.tickFlock(world);
      else this.tickBallistic(world, hits);
      moved = true;
    }
    this.ms = (typeof performance !== "undefined" ? performance.now() : 0) - t0;
    return moved;
  }

  private masked(b: Aabb, mask: readonly string[]): boolean {
    if (!mask.length) return false;
    if (b.name && b.name === this.spec.from) return false;
    for (const t of b.tags) if (mask.includes(t)) return true;
    return false;
  }

  private tickBallistic(world: SimWorld, hits: Hit[]) {
    const s = this.spec;
    const dt = STEP;
    const fric = s.drag > 0 ? 1 / (1 + s.drag * dt) : 1;
    const groundHit = s.mask.includes("sol");
    const p0: number[] = [0, 0, 0], p1: number[] = [0, 0, 0];
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.life[i] > 0 && this.age[i] >= this.life[i]) {
        this.expired++;
        this.remove(i--);
        continue;
      }
      if (this.state[i] === 1) continue;
      this.vy[i] -= s.gravity * dt;
      this.vx[i] *= fric;
      this.vy[i] *= fric;
      this.vz[i] *= fric;
      p0[0] = this.px[i];
      p0[1] = this.py[i];
      p0[2] = this.pz[i];
      p1[0] = p0[0] + this.vx[i] * dt;
      p1[1] = p0[1] + this.vy[i] * dt;
      p1[2] = p0[2] + this.vz[i] * dt;
      // contact le plus proche sur le trajet de ce pas
      let best = 2, bn: [number, number, number] = [0, 1, 0], bb: Aabb | null = null, bid = -1;
      if (s.mask.length) {
        const r = s.radius;
        world.boxes.query(Math.min(p0[0], p1[0]) - r, Math.min(p0[2], p1[2]) - r, Math.max(p0[0], p1[0]) + r, Math.max(p0[2], p1[2]) + r, (b, id) => {
          if (!this.masked(b, s.mask)) return;
          const h = sweepBox(p0, p1, r, b);
          if (h && h.t < best) {
            if (s.onHit === "pierce" && id === this.lastBox[i]) return;
            best = h.t;
            bn = h.n;
            bb = b;
            bid = id;
          }
        });
      }
      if (groundHit) {
        const g = world.ground(p1[0], p1[2]) + s.radius;
        if (p1[1] < g && p0[1] >= g - 1e-6) {
          const t = (p0[1] - g) / Math.max(1e-9, p0[1] - p1[1]);
          if (t < best) {
            best = t;
            bn = [0, 1, 0];
            bb = { name: "", tags: ["sol"], lo: [0, 0, 0], hi: [0, 0, 0] };
            bid = -2;
          }
        }
      }
      // copies d'autres émetteurs visés par le masque (une armée de rats sous le tir)
      let victim: Emitter | null = null, vi = -1;
      if (world.emitter) {
        for (const tag of s.mask) {
          const o = tag === s.id ? null : world.emitter(tag);
          if (!o || !o.n) continue;
          const r2 = s.radius + o.spec.radius;
          for (let j = 0; j < o.n; j++) {
            const t = segSphere(p0, p1, o.px[j], o.py[j] + o.spec.radius, o.pz[j], r2);
            if (t !== null && t < best) {
              best = t;
              victim = o;
              vi = j;
              bb = null;
            }
          }
        }
      }
      if (victim && vi >= 0) {
        const x = p0[0] + (p1[0] - p0[0]) * best, y = p0[1] + (p1[1] - p0[1]) * best, z = p0[2] + (p1[2] - p0[2]) * best;
        hits.push({ emitter: s.id, id: this.ids[i], target: victim.spec.id, copy: victim.ids[vi], tags: [victim.spec.id], x, y, z });
        if (s.kills) victim.removeAt(vi);
        if (s.onHit !== "pierce") {
          this.remove(i--);
          continue;
        }
      }
      if (best <= 1 && bb) {
        const hb = bb as Aabb;
        const x = p0[0] + (p1[0] - p0[0]) * best, y = p0[1] + (p1[1] - p0[1]) * best, z = p0[2] + (p1[2] - p0[2]) * best;
        const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
        const dl = Math.hypot(dx, dy, dz) || 1;
        hits.push({ emitter: s.id, id: this.ids[i], target: hb.name || hb.tags[0] || "", tags: [...hb.tags], x, y, z, dir: [dx / dl, dy / dl, dz / dl] });
        if (s.onHit === "die") {
          this.remove(i--);
          continue;
        }
        if (s.onHit === "stick") {
          this.px[i] = x;
          this.py[i] = y;
          this.pz[i] = z;
          this.vx[i] = this.vy[i] = this.vz[i] = 0;
          this.state[i] = 1;
          continue;
        }
        if (s.onHit === "bounce") {
          const vn = this.vx[i] * bn[0] + this.vy[i] * bn[1] + this.vz[i] * bn[2];
          const k = (1 + s.bounce) * vn;
          this.vx[i] -= k * bn[0];
          this.vy[i] -= k * bn[1];
          this.vz[i] -= k * bn[2];
          this.px[i] = x + bn[0] * 1e-3;
          this.py[i] = y + bn[1] * 1e-3;
          this.pz[i] = z + bn[2] * 1e-3;
          // au repos sur le sol : plus de rebond
          if (bid === -2 && Math.abs(this.vy[i]) < 0.5) this.vy[i] = 0;
          this.orient(i);
          continue;
        }
        this.lastBox[i] = bid;
      }
      this.px[i] = p1[0];
      this.py[i] = p1[1];
      this.pz[i] = p1[2];
      this.orient(i);
    }
  }

  private orient(i: number) {
    const h = Math.hypot(this.vx[i], this.vz[i]);
    if (h > 1e-4) this.ry[i] = Math.atan2(this.vx[i], this.vz[i]);
    if (h > 1e-4 || Math.abs(this.vy[i]) > 1e-4) this.rx[i] = -Math.atan2(this.vy[i], h);
  }

  private tickFlock(world: SimWorld) {
    const s = this.spec;
    const f = s.flock!;
    const dt = STEP;
    const n = this.n;
    this.grid!.rebuild(this.px, this.pz, n);
    const seek = f.seek ? world.pose(f.seek) : null;
    const flee = f.flee ? world.pose(f.flee) : null;
    // pilotage recalculé sur une copie sur quatre à chaque pas
    this.phase = (this.phase + 1) & 3;
    const avoid = f.avoid.length ? f.avoid : s.mask;
    for (let i = 0; i < n; i++) {
      if (s.life[1] > 0) {
        this.age[i] += dt;
        if (this.life[i] > 0 && this.age[i] >= this.life[i]) {
          this.expired++;
          this.remove(i--);
          continue;
        }
      } else this.age[i] += dt;
    }
    const N = this.n;
    for (let i = 0; i < N; i++) {
      const x = this.px[i], z = this.pz[i];
      const cruise = this.cruise[i];
      if ((i & 3) === this.phase) {
        let sx = 0, sz = 0, cx = 0, cz = 0, ax = 0, az = 0, k = 0, seen = 0;
        const r = f.radius, sep = Math.max(1e-3, f.separation);
        this.grid!.near(x, z, (j) => {
          if (j === i || j >= N) return true;
          const dx = x - this.px[j], dz = z - this.pz[j];
          const d2 = dx * dx + dz * dz;
          if (d2 > r * r) return ++seen < 24;
          const d = Math.sqrt(d2) || 1e-3;
          // séparation : tous les voisins trop proches comptent ; cohésion et alignement : 7 voisins au plus
          if (d < sep) {
            const w = (sep - d) / sep / d;
            sx += dx * w;
            sz += dz * w;
          }
          if (k < 7) {
            cx += this.px[j];
            cz += this.pz[j];
            ax += this.vx[j];
            az += this.vz[j];
            k++;
          }
          return ++seen < 24;
        });
        let dx = 0, dz = 0;
        if (k > 0) {
          dx += (cx / k - x) * f.cohesion + (ax / k) * f.align * 0.3;
          dz += (cz / k - z) * f.cohesion + (az / k) * f.align * 0.3;
        }
        dx += sx * 3;
        dz += sz * 3;
        let drive = 0;
        if (seek) {
          const tx = seek.x - x, tz = seek.z - z;
          const d = Math.hypot(tx, tz);
          if (d > 0.3) {
            // arrivée : la poursuite faiblit à l'approche, la séparation étale le groupe autour de la cible
            const w = Math.min(1, d / 3);
            dx += (tx / d) * 1.2 * w;
            dz += (tz / d) * 1.2 * w;
            drive = w;
          }
        }
        if (flee) {
          const tx = x - flee.x, tz = z - flee.z;
          const d = Math.hypot(tx, tz);
          if (d < f.fleeRadius && d > 1e-3) {
            const w = 2 * (1 - d / f.fleeRadius);
            dx += (tx / d) * w * 1.5;
            dz += (tz / d) * w * 1.5;
            drive = Math.max(drive, w);
          }
        }
        if (f.wander > 0) {
          const a = this.ry[i] + (this.r() - 0.5) * 2.4 * f.wander;
          dx += Math.sin(a) * f.wander * 0.6;
          dz += Math.cos(a) * f.wander * 0.6;
        }
        if (f.bounds) {
          const [x0, z0, x1, z1] = f.bounds;
          const m = Math.max(0.5, f.radius);
          if (x < x0 + m) dx += 1.5;
          if (x > x1 - m) dx -= 1.5;
          if (z < z0 + m) dz += 1.5;
          if (z > z1 - m) dz -= 1.5;
        }
        const l = Math.hypot(dx, dz);
        // vitesse visée : en croisière quand rien ne presse, plus vite en poursuite ou en fuite
        const want = l > 1e-4 ? cruise * (0.6 + 0.4 * Math.min(1, drive + 0.3)) : 0;
        // la consigne est gardée dans le cap (ry) et la vitesse désirée dans `rx` (inutilisé au sol)
        this.rx[i] = want;
        if (l > 1e-4) this.ry[i] = Math.atan2(dx, dz);
      }
      // la vitesse tourne doucement vers la consigne
      const want = this.rx[i];
      const tx = Math.sin(this.ry[i]) * want, tz = Math.cos(this.ry[i]) * want;
      const k = Math.min(1, dt * 4);
      this.vx[i] += (tx - this.vx[i]) * k;
      this.vz[i] += (tz - this.vz[i]) * k;
      let nx = x + this.vx[i] * dt, nz = z + this.vz[i] * dt;
      // contournement : sortie de la boîte pénétrée par l'axe le plus court
      if (avoid.length) {
        const rr = s.radius;
        world.boxes.query(nx - rr, nz - rr, nx + rr, nz + rr, (b) => {
          if (!this.masked(b, avoid)) return;
          const lx = b.lo[0] - rr, hx = b.hi[0] + rr, lz = b.lo[2] - rr, hz = b.hi[2] + rr;
          if (nx <= lx || nx >= hx || nz <= lz || nz >= hz) return;
          const pen = [nx - lx, hx - nx, nz - lz, hz - nz];
          let m = 0;
          for (let q = 1; q < 4; q++) if (pen[q] < pen[m]) m = q;
          if (m === 0) (nx = lx), (this.vx[i] = Math.min(0, this.vx[i]));
          else if (m === 1) (nx = hx), (this.vx[i] = Math.max(0, this.vx[i]));
          else if (m === 2) (nz = lz), (this.vz[i] = Math.min(0, this.vz[i]));
          else (nz = hz), (this.vz[i] = Math.max(0, this.vz[i]));
        });
      }
      this.px[i] = nx;
      this.pz[i] = nz;
      this.py[i] = s.ground ? world.ground(nx, nz) : this.py[i];
    }
  }

  /** Les `count` copies les plus proches de (x, z). */
  near(x: number, z: number, count: number): { id: number; x: number; y: number; z: number; d: number }[] {
    const best: { id: number; x: number; y: number; z: number; d: number }[] = [];
    for (let i = 0; i < this.n; i++) {
      const d = Math.hypot(this.px[i] - x, this.pz[i] - z);
      if (best.length < count || d < best[best.length - 1].d) {
        best.push({ id: this.ids[i], x: round(this.px[i]), y: round(this.py[i]), z: round(this.pz[i]), d: round(d) });
        best.sort((a, b) => a.d - b.d);
        if (best.length > count) best.pop();
      }
    }
    return best;
  }

  /** Cap affiché d'une copie (une nuée regarde où elle va, pas sa consigne). */
  heading(i: number): number {
    if (!this.spec.flock) return this.ry[i];
    const h = Math.hypot(this.vx[i], this.vz[i]);
    return h > 0.05 ? Math.atan2(this.vx[i], this.vz[i]) : this.ry[i];
  }

  /** Tangage affiché (projectiles seulement). */
  pitch(i: number): number {
    return this.spec.flock ? 0 : this.rx[i];
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Segment `p0 → p1` contre une sphère : fraction du trajet au premier contact, ou `null`. */
function segSphere(p0: readonly number[], p1: readonly number[], cx: number, cy: number, cz: number, r: number): number | null {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
  const fx = p0[0] - cx, fy = p0[1] - cy, fz = p0[2] - cz;
  const c = fx * fx + fy * fy + fz * fz - r * r;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-12) return null;
  const b = fx * dx + fy * dy + fz * dz;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / a;
  return t >= 0 && t <= 1 ? t : null;
}

function norm(v: readonly number[]): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Direction tirée uniformément dans un cône d'ouverture `a` (radians) autour de `d`. */
function jitterDir(d: V3, a: number, u: number, v: number): V3 {
  const cosA = Math.cos(a);
  const z = 1 - u * (1 - cosA);
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = v * TAU;
  const lx = r * Math.cos(phi), ly = r * Math.sin(phi), lz = z;
  // repère orthonormé autour de d
  const up: V3 = Math.abs(d[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const t = norm([up[1] * d[2] - up[2] * d[1], up[2] * d[0] - up[0] * d[2], up[0] * d[1] - up[1] * d[0]]);
  const b: V3 = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]];
  return [t[0] * lx + b[0] * ly + d[0] * lz, t[1] * lx + b[1] * ly + d[1] * lz, t[2] * lx + b[2] * ly + d[2] * lz];
}

/** Ordre `emit.<id>` : copie des seuls champs valides (longueurs du document, facteur `u`). */
export function readOrder(v: unknown, u: number): EmitOrder {
  if (!isObj(v)) return {};
  const o: EmitOrder = {};
  if (fin(v.count)) o.count = clamp(Math.round(v.count), 0, EMIT_LIMITS.maxPerEmitter);
  if (Array.isArray(v.at)) o.at = vec(v.at, [0, 0, 0], u);
  if (Array.isArray(v.dir)) o.dir = vec(v.dir, [0, 0, 1]);
  if (typeof v.toward === "string") o.toward = v.toward;
  else if (Array.isArray(v.toward)) o.toward = vec(v.toward, [0, 0, 0], u);
  return o;
}

export { BoxGrid };
