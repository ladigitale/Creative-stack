/**
 * Particules : projections de matière, fumée, feu, lumière. Purement visuel (ni contact ni événement).
 *
 * Le processeur n'écrit que les naissances, dans un tampon circulaire de `max` grains (position, vitesse, instant,
 * durée, graine) ; le mouvement est une forme close du temps (gravité, poussée, frottement, vent, turbulence),
 * évaluée par le shader en 3D et par `positionAt` en 2D. Aucune mise à jour par grain et par image.
 */
import { hash32 } from "../rng";

export type V3 = [number, number, number];
export type Range = [number, number];
export type ParticleMode = "salve" | "flux" | "nappe";

const MODE_ALIAS: Record<string, ParticleMode> = {
  salve: "salve", burst: "salve", explosion: "salve",
  flux: "flux", stream: "flux", continu: "flux", continuous: "flux",
  nappe: "nappe", ambient: "nappe", ambiant: "nappe", ambiance: "nappe", layer: "nappe",
};

export type ParticleSpec = {
  id: string;
  preset: string;
  max: number;
  /**
   * Usage : `salve` (explosion, éclat : tout naît d'un coup sur ordre), `flux` (fumée, vapeur : naissances continues
   * à la source, chaque grain monte en opacité), `nappe` (brouillard au sol, météo : population déjà en place au
   * démarrage, âges répartis, grains qui apparaissent et disparaissent en fondu, système qui s'installe en `appear` s).
   */
  mode: ParticleMode;
  /** Naissances par seconde en continu ; `burst` : grains d'une salve. */
  rate: number;
  burst: number;
  /** Fondus d'entrée et de sortie de chaque grain, en fraction de sa vie (0 : aucun). */
  fade: Range;
  /** Montée de l'opacité du système entier à son démarrage (s ; 0 : aucune). */
  appear: number;
  /** Source : instance nommée (suivie), sinon point. */
  from: string;
  at: V3;
  offset: V3;
  shape: "point" | "sphere" | "box" | "ring";
  /** Rayon (sphère, anneau) ou demi-côtés (boîte), mètres. */
  extent: V3;
  dir: V3;
  spread: number;
  speed: Range;
  life: Range;
  gravity: number;
  rise: number;
  drag: number;
  turbulence: number;
  /** Sensibilité au vent du monde (0 à 1). */
  wind: number;
  /** Taille (m) en début et en fin de vie. */
  size: Range;
  /** Rampe de 1 à 4 couleurs sur la vie. */
  color: string[];
  opacity: Range;
  blend: "normal" | "add";
  sprite: "disque" | "flocon" | "goutte" | "eclat" | "trait" | "volute";
  /** Étirement selon la vitesse (s). */
  stretch: number;
  /** Rotation propre (tours par seconde). */
  spin: number;
  /** Ne descend pas sous le sol (y = 0). */
  floor: boolean;
  light: { color: string; intensity: Range; radius: number } | null;
  /** Système lancé à la fin d'une salve (feu puis fumée). */
  then: string;
  seed: string;
};

export const PARTICLE_LIMITS = { systems: 16, maxPerSystem: 4000, total: 16000, lights: 4 } as const;

type Preset = Partial<Omit<ParticleSpec, "id" | "preset" | "seed">>;

const UP: V3 = [0, 1, 0];

/** Préréglages : simples jeux de valeurs par défaut, toute clé écrite les remplace. */
export const PARTICLE_PRESETS: Record<string, Preset> = {
  feu: { rate: 40, life: [0.5, 1.1], speed: [0.3, 0.8], dir: UP, spread: 25, rise: 2.2, drag: 1, turbulence: 0.5, size: [0.35, 0.05], color: ["#fff3b0", "#ffb02e", "#ff5a1f", "#3a0d00"], opacity: [0.95, 0], blend: "add", extent: [0.15, 0.15, 0.15], shape: "sphere", max: 200 },
  etincelles: { burst: 40, life: [0.4, 0.9], speed: [3, 7], dir: UP, spread: 70, gravity: 6, drag: 0.5, size: [0.06, 0.02], color: ["#fffbe0", "#ffb347"], opacity: [1, 0.2], blend: "add", stretch: 0.05, sprite: "trait", max: 300 },
  braise: { rate: 8, life: [1, 2.5], speed: [0.2, 0.6], dir: UP, spread: 30, rise: 0.8, turbulence: 0.8, size: [0.05, 0.02], color: ["#ffcf6b", "#ff6a00"], opacity: [1, 0], blend: "add", max: 100 },
  lueur: { rate: 6, fade: [0.2, 0], life: [1, 2], speed: [0.05, 0.15], spread: 180, size: [0.6, 0.9], color: ["#ffd27a"], opacity: [0.35, 0], blend: "add", max: 40 },
  eclair: { burst: 30, life: [0.08, 0.2], speed: [6, 12], spread: 180, size: [0.08, 0.02], color: ["#ffffff", "#9ad7ff"], opacity: [1, 0], blend: "add", stretch: 0.08, sprite: "trait", max: 120 },
  magie: { rate: 30, life: [0.6, 1.4], speed: [0.5, 1.5], spread: 180, turbulence: 1, rise: 0.3, size: [0.12, 0], color: ["#e9d5ff", "#a855f7", "#22d3ee"], opacity: [1, 0], blend: "add", sprite: "flocon", max: 200 },
  fumee: { rate: 12, fade: [0.12, 0], life: [3, 5], speed: [0.2, 0.5], dir: UP, spread: 15, rise: 0.8, drag: 0.6, turbulence: 0.6, wind: 1, size: [0.3, 1.8], color: ["#5f5f5f", "#bdbdbd"], opacity: [0.5, 0], sprite: "volute", max: 200 },
  vapeur: { rate: 14, fade: [0.1, 0], life: [1.5, 3], speed: [0.3, 0.6], dir: UP, spread: 12, rise: 0.6, drag: 0.8, turbulence: 0.5, wind: 1, size: [0.15, 0.9], color: ["#ffffff"], opacity: [0.4, 0], sprite: "volute", max: 150 },
  brume: { mode: "nappe", rate: 4, life: [6, 10], speed: [0.05, 0.15], spread: 180, shape: "box", extent: [6, 0.3, 6], wind: 1, size: [2, 4], color: ["#e6eef5"], opacity: [0.2, 0.2], fade: [0.3, 0.35], appear: 3, sprite: "volute", max: 60 },
  poussiere: { burst: 30, life: [0.8, 1.6], speed: [0.5, 1.5], dir: UP, spread: 80, gravity: 0.5, drag: 2, wind: 0.6, size: [0.15, 0.5], color: ["#c8b08a", "#e6d8bd"], opacity: [0.6, 0], sprite: "volute", floor: true, max: 150 },
  eclaboussure: { burst: 30, life: [0.4, 0.8], speed: [2, 4], dir: UP, spread: 50, gravity: 9.8, size: [0.07, 0.03], color: ["#9ad7ff", "#e0f4ff"], opacity: [0.9, 0.3], sprite: "goutte", floor: true, max: 150 },
  gouttes: { rate: 20, life: [0.5, 1], speed: [0.5, 1.5], dir: UP, spread: 25, gravity: 9.8, size: [0.05, 0.04], color: ["#9ad7ff"], opacity: [0.9, 0.6], sprite: "goutte", floor: true, max: 100 },
  bulles: { rate: 10, fade: [0.1, 0], life: [1.5, 3], speed: [0.1, 0.3], dir: UP, spread: 20, rise: 0.6, turbulence: 0.4, size: [0.04, 0.1], color: ["#e0f7ff"], opacity: [0.6, 0], sprite: "disque", max: 100 },
  pluie: { mode: "nappe", appear: 1.5, rate: 300, life: [1, 1], speed: [9, 10], dir: [0, -1, 0], spread: 2, shape: "box", extent: [8, 0, 8], offset: [0, 8, 0], wind: 0.5, size: [0.025, 0.025], color: ["#a8c8e8"], opacity: [0.6, 0.6], stretch: 0.06, sprite: "trait", floor: true, max: 1200 },
  neige: { mode: "nappe", appear: 2, fade: [0.04, 0.04], rate: 80, life: [6, 8], speed: [0.5, 0.8], dir: [0, -1, 0], spread: 10, shape: "box", extent: [8, 0, 8], offset: [0, 7, 0], turbulence: 0.6, wind: 0.8, size: [0.06, 0.06], color: ["#ffffff"], opacity: [0.95, 0.95], sprite: "flocon", floor: true, max: 800 },
  confettis: { burst: 80, life: [1.5, 3], speed: [3, 6], dir: UP, spread: 40, gravity: 4, drag: 1.5, turbulence: 0.5, spin: 1.5, size: [0.08, 0.08], color: ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6"], opacity: [1, 1], sprite: "eclat", floor: true, max: 400 },
  debris: { burst: 20, life: [1, 1.8], speed: [2, 5], dir: UP, spread: 60, gravity: 9.8, spin: 1, size: [0.12, 0.1], color: ["#8a7a6a", "#5d5248"], opacity: [1, 1], sprite: "eclat", floor: true, max: 120 },
  eclats: { burst: 24, life: [0.6, 1.2], speed: [3, 6], dir: UP, spread: 75, gravity: 9.8, spin: 2, size: [0.06, 0.05], color: ["#d4d4d8", "#71717a"], opacity: [1, 1], sprite: "eclat", floor: true, max: 150 },
  feuilles: { mode: "nappe", appear: 2, fade: [0.06, 0.06], rate: 6, life: [4, 7], speed: [0.2, 0.5], dir: [0, -1, 0], spread: 40, shape: "box", extent: [5, 0, 5], offset: [0, 5, 0], gravity: 0.6, drag: 2, turbulence: 1, wind: 1, spin: 0.6, size: [0.1, 0.1], color: ["#65a30d", "#ca8a04", "#c2410c"], opacity: [1, 1], sprite: "eclat", floor: true, max: 150 },
};

const BASE: Omit<ParticleSpec, "id" | "preset" | "seed"> = {
  max: 200,
  mode: "salve",
  rate: 0,
  burst: 20,
  fade: [0, 0],
  appear: 0,
  from: "",
  at: [0, 0, 0],
  offset: [0, 0, 0],
  shape: "point",
  extent: [0.1, 0.1, 0.1],
  dir: UP,
  spread: 30,
  speed: [1, 2],
  life: [1, 1.5],
  gravity: 0,
  rise: 0,
  drag: 0,
  turbulence: 0,
  wind: 0,
  size: [0.1, 0.05],
  color: ["#ffffff"],
  opacity: [1, 0],
  blend: "normal",
  sprite: "disque",
  stretch: 0,
  spin: 0,
  floor: false,
  light: null,
  then: "",
};

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const COLOR = /^#[0-9a-fA-F]{6}$/;
const NAME = /^[A-Za-z][\w-]{0,63}$/;

function range(v: unknown, d: Range, k = 1): Range {
  if (fin(v)) return [v * k, v * k];
  if (Array.isArray(v) && fin(v[0])) return [v[0] * k, fin(v[1]) ? v[1] * k : v[0] * k];
  return d;
}

function vec(v: unknown, d: V3, k = 1): V3 {
  if (fin(v)) return [v * k, v * k, v * k];
  if (!Array.isArray(v)) return d;
  return [fin(v[0]) ? v[0] * k : d[0], fin(v[1]) ? v[1] * k : d[1], fin(v[2]) ? v[2] * k : d[2]];
}

/** Lecture de `monde.particles` (longueurs dans l'unité du document, facteur `u` vers le mètre). */
export function readParticles(src: unknown, u: number, issues: { path: string; message: string }[]): ParticleSpec[] {
  if (src === undefined) return [];
  if (!isObj(src)) {
    issues.push({ path: "particles", message: "objet {id: {preset, …}} attendu" });
    return [];
  }
  const out: ParticleSpec[] = [];
  let total = 0;
  for (const [id, raw] of Object.entries(src)) {
    const path = `particles.${id}`;
    if (out.length >= PARTICLE_LIMITS.systems) {
      issues.push({ path: "particles", message: `${PARTICLE_LIMITS.systems} systèmes au plus` });
      break;
    }
    if (!NAME.test(id) || !isObj(raw)) {
      issues.push({ path, message: "nom (lettres, chiffres, - et _) et objet de réglages attendus" });
      continue;
    }
    const preset = typeof raw.preset === "string" ? raw.preset : "";
    const pre = preset && Object.prototype.hasOwnProperty.call(PARTICLE_PRESETS, preset) ? PARTICLE_PRESETS[preset] : null;
    if (preset && !pre) issues.push({ path: `${path}.preset`, message: `préréglage inconnu (${Object.keys(PARTICLE_PRESETS).join(", ")})` });
    const d = { ...BASE, ...(pre ?? {}) };
    let max = fin(raw.max) ? clamp(Math.round(raw.max), 1, PARTICLE_LIMITS.maxPerSystem) : d.max;
    if (total + max > PARTICLE_LIMITS.total) {
      issues.push({ path: `${path}.max`, message: `${PARTICLE_LIMITS.total} grains au plus pour tous les systèmes` });
      max = Math.max(0, PARTICLE_LIMITS.total - total);
      if (!max) continue;
    }
    total += max;
    const dir = vec(raw.dir, d.dir);
    const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const colors = Array.isArray(raw.color) ? raw.color.filter((c): c is string => typeof c === "string" && COLOR.test(c)).slice(0, 4) : typeof raw.color === "string" && COLOR.test(raw.color) ? [raw.color] : d.color;
    const li = raw.light;
    const light = isObj(li)
      ? { color: typeof li.color === "string" && COLOR.test(li.color) ? li.color : colors[0] ?? "#ffffff", intensity: range(li.intensity, [2, 0]), radius: fin(li.radius) ? clamp(li.radius * u, 0.1, 100) : 6 }
      : d.light;
    const shape = (["point", "sphere", "box", "ring"] as const).includes(raw.shape as ParticleSpec["shape"]) ? (raw.shape as ParticleSpec["shape"]) : d.shape;
    const sprite = (["disque", "flocon", "goutte", "eclat", "trait", "volute"] as const).includes(raw.sprite as ParticleSpec["sprite"]) ? (raw.sprite as ParticleSpec["sprite"]) : d.sprite;
    // usage : donné, sinon celui du préréglage, sinon déduit du débit (continu = flux)
    const modeRaw = typeof raw.mode === "string" ? MODE_ALIAS[raw.mode] : undefined;
    if (raw.mode !== undefined && !modeRaw) issues.push({ path: `${path}.mode`, message: "salve, flux ou nappe attendu" });
    let rate = fin(raw.rate) ? clamp(raw.rate, 0, 2000) : d.rate;
    const mode: ParticleMode = modeRaw ?? (pre?.mode ? d.mode : rate > 0 ? "flux" : "salve");
    // une salve ne naît que sur ordre ; un flux ou une nappe sans débit : de quoi garder le tampon aux 4/5
    if (mode === "salve" && !fin(raw.rate)) rate = 0;
    if (mode !== "salve" && rate <= 0) rate = (max * 0.8) / Math.max(0.1, (d.life[0] + d.life[1]) / 2);
    // fondus par défaut selon l'usage quand ni le préréglage ni la recette n'en donnent
    const fadeD: Range = pre?.fade ?? (mode === "nappe" ? [0.25, 0.25] : mode === "flux" ? [0.08, 0] : [0, 0]);
    const fade = raw.fade !== undefined ? range(raw.fade, fadeD) : fadeD;
    out.push({
      id,
      preset: pre ? preset : "",
      max,
      mode,
      fade: [clamp(fade[0], 0, 0.5), clamp(fade[1], 0, 0.5)],
      appear: fin(raw.appear) ? clamp(raw.appear, 0, 30) : pre?.appear ?? (mode === "nappe" ? 2 : 0),
      rate,
      burst: fin(raw.burst) ? clamp(Math.round(raw.burst), 0, max) : Math.min(d.burst, max),
      from: typeof raw.from === "string" ? raw.from.split("@")[0] : typeof raw.at === "string" ? raw.at.split("@")[0] : "",
      at: Array.isArray(raw.at) ? vec(raw.at, [0, 0, 0], u) : [0, 0, 0],
      offset: raw.offset !== undefined ? vec(raw.offset, [0, 0, 0], u) : d.offset,
      shape,
      extent: raw.extent !== undefined ? vec(raw.extent, d.extent, u) : d.extent,
      dir: [dir[0] / dl, dir[1] / dl, dir[2] / dl],
      spread: fin(raw.spread) ? clamp(raw.spread, 0, 180) : d.spread,
      speed: raw.speed !== undefined ? range(raw.speed, d.speed, u) : d.speed,
      life: raw.life !== undefined ? range(raw.life, d.life) : d.life,
      gravity: fin(raw.gravity) ? raw.gravity * u : d.gravity,
      rise: fin(raw.rise) ? raw.rise * u : d.rise,
      drag: fin(raw.drag) ? clamp(raw.drag, 0, 50) : d.drag,
      turbulence: fin(raw.turbulence) ? clamp(raw.turbulence, 0, 10) : d.turbulence,
      wind: fin(raw.wind) ? clamp(raw.wind, 0, 2) : d.wind,
      size: raw.size !== undefined ? range(raw.size, d.size, u) : d.size,
      color: colors.length ? colors : d.color,
      opacity: raw.opacity !== undefined ? range(raw.opacity, d.opacity) : d.opacity,
      blend: raw.blend === "add" || raw.blend === "normal" ? raw.blend : d.blend,
      sprite,
      stretch: fin(raw.stretch) ? clamp(raw.stretch, 0, 1) : d.stretch,
      spin: fin(raw.spin) ? clamp(raw.spin, -20, 20) : d.spin,
      floor: typeof raw.floor === "boolean" ? raw.floor : raw.collide === "sol" ? true : d.floor,
      light,
      then: typeof raw.then === "string" ? raw.then : "",
      seed: typeof raw.seed === "string" || fin(raw.seed) ? String(raw.seed) : id,
    });
  }
  return out;
}

/** Vent du monde (m/s). */
export function readVent(v: unknown, u: number): V3 {
  return Array.isArray(v) ? vec(v, [0, 0, 0], u) : [0, 0, 0];
}

function rand32(s: number): number {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Opacité d'un grain à la fraction `k` de sa vie : rampe `opacity` et fondus `fade` (même calcul que le shader). */
export function opacityAt(s: Pick<ParticleSpec, "opacity" | "fade">, k: number): number {
  let a = s.opacity[0] + (s.opacity[1] - s.opacity[0]) * k;
  const [fi, fo] = s.fade;
  if (fi > 0) a *= smooth(Math.min(1, k / fi));
  if (fo > 0) a *= smooth(Math.min(1, (1 - k) / fo));
  return a;
}
const smooth = (x: number) => (x <= 0 ? 0 : x * x * (3 - 2 * x));

/** Ordre ponctuel `fx.<id>` : point, échelle, couleur, nombre de grains. */
export type FxOrder = { at?: V3; scale?: number; color?: string; count?: number };

/**
 * Un système : tampon circulaire des naissances. `head` avance à chaque grain ; les plages écrites depuis le dernier
 * envoi au GPU sont dans `dirty` (début, fin), remis à zéro par le rendu.
 */
export class ParticleSystem {
  readonly spec: ParticleSpec;
  /** Position et vitesse de naissance (x, y, z), instant de naissance (s), durée de vie (s), graine (0 à 1), échelle. */
  readonly p0: Float32Array;
  readonly v0: Float32Array;
  readonly born: Float32Array;
  readonly life: Float32Array;
  readonly seed: Float32Array;
  readonly scale: Float32Array;
  /** Teinte imposée par un ordre (0 : rampe du système) : rgb empaqueté. */
  readonly tint: Float32Array;
  head = 0;
  dirty: [number, number] | null = null;
  /** Naissances totales, et instant de la dernière salve (lumière). */
  spawned = 0;
  lastBurst = -1e9;
  lastBurstAt: V3 = [0, 0, 0];
  private seq: number;
  private rateAcc = 0;
  /** Salves de `then` à lancer plus tard : instant, point. */
  pending: { t: number; at: V3; scale: number }[] = [];

  constructor(spec: ParticleSpec) {
    this.spec = spec;
    const m = spec.max;
    this.p0 = new Float32Array(m * 3);
    this.v0 = new Float32Array(m * 3);
    this.born = new Float32Array(m).fill(-1e9);
    this.life = new Float32Array(m).fill(1);
    this.seed = new Float32Array(m);
    this.scale = new Float32Array(m).fill(1);
    this.tint = new Float32Array(m);
    this.seq = hash32(spec.seed) | 0;
  }

  private r(): number {
    this.seq = (this.seq + 1) | 0;
    return rand32(this.seq);
  }

  /** Vrai tant qu'un grain est vivant à l'instant `now` (ou qu'il en naît en continu). */
  alive(now: number): boolean {
    if (this.spec.rate > 0 || this.pending.length) return true;
    return now - this.lastBurst < this.spec.life[1] + 0.1 || this.lastRate(now);
  }

  private lastSpawn = -1e9;
  /** Instant du premier pas (montée `appear`), et nappe déjà remplie. */
  private started = Number.NaN;
  filled = false;

  /** Opacité du système entier à l'instant `now` (0 à 1) : montée de `appear` secondes depuis son premier usage. */
  presence(now: number): number {
    if (Number.isNaN(this.started)) this.started = now;
    const a = this.spec.appear;
    if (a <= 0) return 1;
    const k = Math.min(1, Math.max(0, (now - this.started) / a));
    return k * k * (3 - 2 * k);
  }

  /**
   * Nappe : `count` grains d'âges répartis sur leur vie, comme si le système tournait depuis longtemps (aucune
   * vague de naissances simultanées au démarrage). Une seule fois par système.
   */
  prefill(count: number, now: number, at: V3, yaw = 0) {
    this.filled = true;
    count = Math.min(Math.round(count), this.spec.max);
    for (let c = 0; c < count; c++) {
      const i = this.head;
      this.spawn(1, now, at, yaw);
      this.born[i] = now - this.r() * this.life[i];
    }
  }

  /** Population d'un régime établi pour un débit donné (grains vivants en même temps). */
  steady(rate = this.spec.rate): number {
    return Math.min(this.spec.max, rate * ((this.spec.life[0] + this.spec.life[1]) / 2));
  }
  private lastRate(now: number) {
    return now - this.lastSpawn < this.spec.life[1] + 0.1;
  }

  /** Fait naître `count` grains autour de `at`, cap `yaw` (radians) appliqué à la direction et à la forme. */
  spawn(count: number, now: number, at: V3, yaw = 0, scale = 1, tint = 0, vel?: V3) {
    const s = this.spec;
    count = Math.min(count, s.max);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const a = (s.spread * Math.PI) / 180;
    for (let c = 0; c < count; c++) {
      const i = this.head;
      this.head = (this.head + 1) % s.max;
      // point de naissance dans la forme
      let ox = 0, oy = 0, oz = 0;
      const [ex, ey, ez] = s.extent;
      if (s.shape === "sphere") {
        const th = this.r() * Math.PI * 2, ph = Math.acos(2 * this.r() - 1), rr = Math.cbrt(this.r());
        ox = Math.sin(ph) * Math.cos(th) * ex * rr;
        oy = Math.cos(ph) * ey * rr;
        oz = Math.sin(ph) * Math.sin(th) * ez * rr;
      } else if (s.shape === "box") {
        ox = (this.r() * 2 - 1) * ex;
        oy = (this.r() * 2 - 1) * ey;
        oz = (this.r() * 2 - 1) * ez;
      } else if (s.shape === "ring") {
        const th = this.r() * Math.PI * 2;
        ox = Math.cos(th) * ex;
        oz = Math.sin(th) * ez;
      }
      // direction dans le cône `spread` autour de `dir`
      const d = cone(s.dir, a, this.r(), this.r());
      const sp = (s.speed[0] + (s.speed[1] - s.speed[0]) * this.r()) * scale;
      const dx = d[0] * cy + d[2] * sy, dz = -d[0] * sy + d[2] * cy;
      const px = ox * scale, pz = oz * scale;
      this.p0[i * 3] = at[0] + px * cy + pz * sy;
      this.p0[i * 3 + 1] = at[1] + oy * scale;
      this.p0[i * 3 + 2] = at[2] - px * sy + pz * cy;
      this.v0[i * 3] = dx * sp + (vel ? vel[0] : 0);
      this.v0[i * 3 + 1] = d[1] * sp + (vel ? vel[1] : 0);
      this.v0[i * 3 + 2] = dz * sp + (vel ? vel[2] : 0);
      this.born[i] = now;
      this.life[i] = s.life[0] + (s.life[1] - s.life[0]) * this.r();
      this.seed[i] = this.r();
      this.scale[i] = scale;
      this.tint[i] = tint;
      this.mark(i);
    }
    this.spawned += count;
    this.lastSpawn = now;
  }

  private mark(i: number) {
    if (!this.dirty) this.dirty = [i, i + 1];
    else if (i >= this.dirty[0] && i <= this.dirty[1]) this.dirty[1] = Math.max(this.dirty[1], i + 1);
    else this.dirty = [0, this.spec.max];
  }

  /** Salve (`burst` grains) ; `then` programmé à la fin de la salve. */
  burstAt(now: number, at: V3, o: FxOrder = {}, yaw = 0) {
    const sc = o.scale ?? 1;
    const tint = o.color && COLOR.test(o.color) ? packRgb(o.color) : 0;
    this.spawn(Math.round((o.count ?? this.spec.burst) * Math.min(4, Math.max(0.1, sc))), now, at, yaw, sc, tint);
    this.lastBurst = now;
    this.lastBurstAt = [...at] as V3;
  }

  /** Naissances continues de la période (`rate` × `dt`). */
  continuous(dt: number, now: number, at: V3, yaw = 0, rate = this.spec.rate) {
    if (rate <= 0) return;
    // une image très longue (onglet repris) ne lâche pas d'un coup tout ce qui aurait dû naître
    this.rateAcc += Math.min(dt, 0.25) * rate;
    const k = Math.floor(this.rateAcc);
    if (k > 0) {
      this.rateAcc -= k;
      this.spawn(Math.min(k, this.spec.max), now, at, yaw);
    }
  }
}

/** Accélération constante d'un système (gravité, poussée, vent). */
export function accelOf(s: ParticleSpec, vent: V3): V3 {
  return [vent[0] * s.wind, s.rise - s.gravity + vent[1] * s.wind, vent[2] * s.wind];
}

/**
 * Position d'un grain à l'âge `t` (forme close, la même que le shader) : vitesse amortie par `drag`, accélération
 * constante, turbulence en sinus décalés par la graine, sol à y = 0 si `floor`.
 */
export function positionAt(sys: ParticleSystem, i: number, t: number, acc: V3, out: V3): V3 {
  const s = sys.spec;
  const k = s.drag;
  let f: number, g: number;
  if (k > 1e-4) {
    f = (1 - Math.exp(-k * t)) / k;
    g = (t - f) / k;
  } else {
    f = t;
    g = 0.5 * t * t;
  }
  const sd = sys.seed[i] * 6.2831853;
  const tu = s.turbulence * t;
  out[0] = sys.p0[i * 3] + sys.v0[i * 3] * f + acc[0] * g + Math.sin(t * 1.7 + sd) * tu * 0.35;
  out[1] = sys.p0[i * 3 + 1] + sys.v0[i * 3 + 1] * f + acc[1] * g + Math.sin(t * 2.3 + sd * 1.3) * tu * 0.2;
  out[2] = sys.p0[i * 3 + 2] + sys.v0[i * 3 + 2] * f + acc[2] * g + Math.cos(t * 1.9 + sd * 0.7) * tu * 0.35;
  if (s.floor && out[1] < 0) out[1] = 0;
  return out;
}

/** Couleur de la rampe à `k` (0 à 1), en rgb 0..1. */
export function rampAt(colors: readonly number[][], k: number, out: number[]): number[] {
  const n = colors.length;
  if (n === 1) {
    out[0] = colors[0][0];
    out[1] = colors[0][1];
    out[2] = colors[0][2];
    return out;
  }
  const x = Math.min(0.9999, Math.max(0, k)) * (n - 1);
  const i = Math.floor(x), f = x - i;
  for (let c = 0; c < 3; c++) out[c] = colors[i][c] + (colors[i + 1][c] - colors[i][c]) * f;
  return out;
}

export function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function packRgb(hex: string): number {
  // +1 : 0 veut dire « rampe du système »
  return parseInt(hex.slice(1), 16) + 1;
}

export function unpackRgb(v: number, out: number[]): number[] {
  const n = v - 1;
  out[0] = ((n >> 16) & 255) / 255;
  out[1] = ((n >> 8) & 255) / 255;
  out[2] = (n & 255) / 255;
  return out;
}

function cone(d: readonly number[], a: number, u: number, v: number): V3 {
  if (a <= 0) return [d[0], d[1], d[2]];
  const z = 1 - u * (1 - Math.cos(a));
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = v * Math.PI * 2;
  const lx = r * Math.cos(phi), ly = r * Math.sin(phi);
  const up = Math.abs(d[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  let tx = up[1] * d[2] - up[2] * d[1], ty = up[2] * d[0] - up[0] * d[2], tz = up[0] * d[1] - up[1] * d[0];
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl;
  ty /= tl;
  tz /= tl;
  const bx = d[1] * tz - d[2] * ty, by = d[2] * tx - d[0] * tz, bz = d[0] * ty - d[1] * tx;
  return [tx * lx + bx * ly + d[0] * z, ty * lx + by * ly + d[1] * z, tz * lx + bz * ly + d[2] * z];
}

export function readFx(v: unknown, u: number): FxOrder {
  if (!isObj(v)) return {};
  const o: FxOrder = {};
  if (Array.isArray(v.at)) o.at = vec(v.at, [0, 0, 0], u);
  if (fin(v.scale)) o.scale = clamp(v.scale, 0.1, 10);
  if (typeof v.color === "string" && COLOR.test(v.color)) o.color = v.color;
  if (fin(v.count)) o.count = clamp(Math.round(v.count), 1, PARTICLE_LIMITS.maxPerSystem);
  return o;
}
