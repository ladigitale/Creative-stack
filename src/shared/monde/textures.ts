/**
 * Textures procédurales du format « monde » (sans image ni réseau), communes à `sonic-3d` et `sonic-2d` :
 * un motif tuilable, teinté par la couleur de la pièce, collé en mètres (une même texture garde la même taille
 * de motif sur un bras et sur un mur). Décrites en une ligne : `"rayures"` ou
 * `{"kind": "rayures", "color2": "#fff", "scale": 6, "angle": 30, "contrast": 0.8}`.
 */
import { hash32, mixColor, parseHex, shade } from "./math";

export const TEX_KINDS = [
  "bois",
  "tissu",
  "marbre",
  "bruit",
  "grain",
  "rayures",
  "damier",
  "pois",
  "herbe",
  "brique",
  "carrelage",
  "ecailles",
  "fourrure",
  "metal",
  "pierre",
  "hachures",
  "tricot",
  "nuages",
  "camouflage",
  "parquet",
  "chevron",
  "moquette",
  "beton",
  "gravier",
  "dalles",
  "paillis",
] as const;
export type TexKind = (typeof TEX_KINDS)[number];

const ALIASES: Record<string, TexKind> = {
  wood: "bois",
  felt: "tissu",
  fabric: "tissu",
  marble: "marbre",
  noise: "bruit",
  paper: "grain",
  papier: "grain",
  gouache: "grain",
  stripes: "rayures",
  checker: "damier",
  dots: "pois",
  grass: "herbe",
  brick: "brique",
  tiles: "carrelage",
  scales: "ecailles",
  fur: "fourrure",
  stone: "pierre",
  hatch: "hachures",
  knit: "tricot",
  clouds: "nuages",
  camo: "camouflage",
  "baton-rompu": "chevron",
  herringbone: "chevron",
  carpet: "moquette",
  concrete: "beton",
  gravel: "gravier",
  slabs: "dalles",
  mulch: "paillis",
  gazon: "herbe",
  pelouse: "herbe",
};

export type TexSpec = {
  kind: TexKind;
  /** Seconde couleur du motif (défaut : la couleur de la pièce assombrie). */
  color2: string;
  /** Répétitions du motif par mètre. */
  scale: number;
  /** Rotation du motif (degrés). */
  angle: number;
  /** 0 (à peine visible) à 1 (franc). */
  contrast: number;
  seed: number;
};

const DEFAULT_SCALE: Record<TexKind, number> = {
  bois: 2,
  tissu: 10,
  marbre: 1,
  bruit: 4,
  grain: 6,
  rayures: 6,
  damier: 4,
  pois: 8,
  herbe: 4,
  brique: 3,
  carrelage: 3,
  ecailles: 10,
  fourrure: 8,
  metal: 3,
  pierre: 2,
  hachures: 10,
  tricot: 12,
  nuages: 0.6,
  camouflage: 1.5,
  parquet: 1,
  chevron: 1,
  moquette: 4,
  beton: 0.5,
  gravier: 1.5,
  dalles: 1,
  paillis: 2,
};

/** Lit une texture écrite par l'agent ; null si absente ou inconnue (problème signalé via `issue`). */
export function readTex(v: unknown, issue?: (msg: string) => void): TexSpec | null {
  if (v === undefined || v === null || v === "" || v === false) return null;
  const o = typeof v === "string" ? { kind: v } : v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  if (!o) return null;
  const raw = String(o.kind ?? "").trim().toLowerCase();
  const kind = (TEX_KINDS as readonly string[]).includes(raw) ? (raw as TexKind) : Object.prototype.hasOwnProperty.call(ALIASES, raw) ? ALIASES[raw] : undefined;
  if (!kind) {
    issue?.(`texture inconnue « ${raw} » (${TEX_KINDS.join(", ")})`);
    return null;
  }
  const n = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);
  return {
    kind,
    color2: typeof o.color2 === "string" && parseHex(o.color2) !== null ? o.color2 : "",
    scale: Math.max(0.05, Math.min(200, n(o.scale, DEFAULT_SCALE[kind]))),
    angle: n(o.angle, 0),
    contrast: Math.max(0, Math.min(1, n(o.contrast, 0.6))),
    seed: typeof o.seed === "number" ? o.seed : hash32(raw) % 997,
  };
}

/* ------------------------------------------------------------------ bruit périodique */

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const sm = (t: number) => t * t * (3 - 2 * t);
const mod = (n: number, m: number) => ((n % m) + m) % m;
function vnoise(x: number, y: number, p: number, seed: number) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = sm(x - xi), fy = sm(y - yi);
  const h = (a: number, b: number) => hash(mod(xi + a, p), mod(yi + b, p), seed);
  const t = h(0, 0) + (h(1, 0) - h(0, 0)) * fx;
  const b = h(0, 1) + (h(1, 1) - h(0, 1)) * fx;
  return t + (b - t) * fy;
}
/** fbm périodique sur [0,1[² (p cellules de base). */
function fbm(u: number, v: number, p: number, seed: number, oct = 4) {
  let a = 0.5, s = 0, nrm = 0;
  for (let o = 0; o < oct; o++) {
    const f = 2 ** o;
    s += a * vnoise(u * p * f, v * p * f, p * f, seed + o);
    nrm += a;
    a *= 0.5;
  }
  return s / nrm;
}
/** Distance au point de Voronoï le plus proche (cellules périodiques). */
function cells(u: number, v: number, p: number, seed: number): [number, number] {
  const x = u * p, y = v * p;
  const xi = Math.floor(x), yi = Math.floor(y);
  let d1 = 9, d2 = 9;
  for (let a = -1; a <= 1; a++)
    for (let b = -1; b <= 1; b++) {
      const cx = xi + a, cy = yi + b;
      const px = cx + hash(mod(cx, p), mod(cy, p), seed), py = cy + hash(mod(cx, p), mod(cy, p), seed + 7);
      const d = Math.hypot(px - x, py - y);
      if (d < d1) {
        d2 = d1;
        d1 = d;
      } else if (d < d2) d2 = d;
    }
  return [d1, d2];
}

/** Valeur 0 (couleur de base) à 1 (couleur 2) en (u, v) ∈ [0,1[², tuilable. */
function sample(kind: TexKind, u: number, v: number, seed: number): number {
  switch (kind) {
    case "bois": {
      const w = fbm(u, v, 2, seed) * 3;
      const r = Math.sin((v * 8 + w) * Math.PI * 2) * 0.5 + 0.5;
      return Math.pow(r, 3) * 0.7 + fbm(u * 8, v, 4, seed + 3, 2) * 0.3;
    }
    case "tissu": {
      const a = Math.sin(u * Math.PI * 2 * 16) * 0.5 + 0.5, b = Math.sin(v * Math.PI * 2 * 16) * 0.5 + 0.5;
      return (Math.floor(u * 16) + Math.floor(v * 16)) % 2 ? a * 0.6 : b * 0.6 + fbm(u, v, 16, seed, 2) * 0.4;
    }
    case "marbre": {
      const w = fbm(u, v, 3, seed) * 6;
      return Math.pow(1 - Math.abs(Math.sin((u + v) * Math.PI * 2 + w)), 6);
    }
    case "bruit":
      return fbm(u, v, 4, seed);
    case "parquet": {
      // lames de 12,5 cm × 50 cm (à l'échelle 1), joints décalés d'un rang à l'autre, teinte par lame
      const row = Math.floor(v * 8);
      const x = u * 2 + (row % 2) * 0.5 + (row % 4 >= 2 ? 0.25 : 0);
      const joint = mod(v * 8, 1) < 0.05 || mod(x, 1) < 0.012;
      if (joint) return 0.95;
      return hash(mod(Math.floor(x), 2), row, seed) * 0.35 + fbm(u * 2, v * 8, 8, seed + 5, 2) * 0.2;
    }
    case "chevron": {
      // bâtons en zigzag : quatre bandes par tuile, pente inversée d'une bande à l'autre
      const band = Math.floor(u * 4);
      const f = mod(u * 4, 1);
      const d = v * 8 + (band % 2 ? f : 1 - f) * 2;
      if (mod(d, 1) < 0.07 || f < 0.02) return 0.95;
      return hash(mod(Math.floor(d), 8), band, seed) * 0.35 + fbm(u * 4, v * 4, 8, seed + 5, 2) * 0.15;
    }
    case "moquette":
      return fbm(u, v, 64, seed, 2) * 0.5 + hash(Math.floor(u * 128), Math.floor(v * 128), seed) * 0.4;
    case "beton":
      return fbm(u, v, 3, seed, 4) * 0.4 + (cells(u, v, 24, seed + 2)[0] < 0.07 ? 0.5 : 0);
    case "gravier": {
      const [d1, d2] = cells(u, v, 12, seed);
      return d2 - d1 < 0.08 ? 1 : fbm(u, v, 12, seed + 1, 2) * 0.5 * (1 - d1);
    }
    case "dalles": {
      const row = Math.floor(v * 2);
      const x = u * 2 + (row % 2) * 0.5;
      if (mod(x, 1) < 0.02 || mod(v * 2, 1) < 0.02) return 1;
      return fbm(u, v, 4, seed, 3) * 0.22 + hash(mod(Math.floor(x), 2), row, seed) * 0.15;
    }
    case "paillis": {
      const n = fbm(u, v, 8, seed, 3);
      return Math.pow(Math.abs(Math.sin((u * 14 + v * 9 + n * 6) * Math.PI)), 2) * 0.5 + fbm(u, v, 32, seed + 3, 2) * 0.5;
    }
    case "grain":
      return fbm(u, v, 32, seed, 2) * 0.6 + hash(Math.floor(u * 256), Math.floor(v * 256), seed) * 0.4;
    case "rayures":
      return mod(u * 4, 1) < 0.5 ? 1 : 0;
    case "damier":
      return (Math.floor(u * 2) + Math.floor(v * 2)) % 2;
    case "pois": {
      const x = mod(u * 4, 1) - 0.5, y = mod(v * 4 + (Math.floor(u * 4) % 2) * 0.5, 1) - 0.5;
      return Math.hypot(x, y) < 0.25 ? 1 : 0;
    }
    case "herbe": {
      const blade = Math.pow(Math.abs(Math.sin((u * 24 + fbm(u, v, 4, seed) * 4) * Math.PI)), 8);
      return blade * 0.6 + fbm(u, v, 8, seed + 1) * 0.4;
    }
    case "brique": {
      const row = Math.floor(v * 4);
      const x = mod(u * 2 + (row % 2) * 0.5, 1), y = mod(v * 4, 1);
      const mortar = x < 0.04 || y < 0.08 ? 1 : 0;
      return mortar ? 1 : fbm(u, v, 8, seed, 2) * 0.35;
    }
    case "carrelage": {
      const x = mod(u * 2, 1), y = mod(v * 2, 1);
      return x < 0.04 || y < 0.04 ? 1 : fbm(u, v, 4, seed, 2) * 0.15;
    }
    case "ecailles": {
      const row = Math.floor(v * 6);
      const x = mod(u * 6 + (row % 2) * 0.5, 1) - 0.5, y = mod(v * 6, 1);
      const d = Math.hypot(x, y);
      return d > 0.5 ? 0.15 : Math.pow(d * 2, 4);
    }
    case "fourrure": {
      const n = fbm(u * 1, v * 1, 6, seed);
      const s = Math.pow(Math.abs(Math.sin((u * 40 + n * 8) * Math.PI)), 3);
      return s * 0.5 + n * 0.5;
    }
    case "metal":
      return fbm(u * 0.1, v, 64, seed, 2) * 0.5 + Math.pow(Math.sin(v * Math.PI * 2) * 0.5 + 0.5, 4) * 0.5;
    case "pierre": {
      const [d1, d2] = cells(u, v, 4, seed);
      const crack = d2 - d1 < 0.06 ? 1 : 0;
      return crack ? 1 : fbm(u, v, 6, seed + 2) * 0.4;
    }
    case "hachures": {
      const n = fbm(u, v, 4, seed);
      const line = Math.abs(Math.sin((u + v) * Math.PI * 2 * 10 + n * 2));
      return line < 0.25 + (1 - n) * 0.2 ? 1 : 0;
    }
    case "tricot": {
      const x = mod(u * 8, 1), y = mod(v * 8, 1);
      return Math.abs(x - 0.5) * 2 > 1 - Math.abs(Math.sin(y * Math.PI)) * 0.9 ? 1 : 0.2;
    }
    case "nuages":
      return sm(Math.max(0, Math.min(1, (fbm(u, v, 3, seed, 5) - 0.42) * 4)));
    case "camouflage": {
      const n = fbm(u, v, 3, seed, 3);
      return n < 0.42 ? 0 : n < 0.52 ? 0.5 : 1;
    }
  }
  return 0;
}

/** Taille de départ d'une texture procédurale (pixels de côté). */
export const TEX_SIZE = 128;
/** Tailles possibles : une texture vue de près est recalculée plus finement (texture adaptative). */
export const TEX_LEVELS = [128, 256, 512, 1024] as const;

/**
 * Texture adaptative : plus petite taille (parmi TEX_LEVELS, au plus `max`) qui donne au moins un texel par pixel
 * quand un mètre couvre `pxPerMeter` pixels à l'écran et que le motif se répète `scale` fois par mètre.
 */
export function texSizeFor(pxPerMeter: number, scale: number, max = 512): number {
  const need = pxPerMeter / Math.max(1e-3, scale);
  for (const n of TEX_LEVELS) if (n >= need || n >= max) return Math.min(n, Math.max(TEX_SIZE, max));
  return Math.max(TEX_SIZE, max);
}

/** Pixels RGBA (size²) d'une texture teintée : `base` = couleur de la pièce. Mis en cache. */
const cache = new Map<string, Uint8ClampedArray>();
let cacheBytes = 0;
const pixKey = (t: TexSpec, base: string, size: number) => `${t.kind}|${base}|${t.color2 || shade(base, -0.35)}|${t.contrast}|${t.seed}|${size}`;
function keep(key: string, out: Uint8ClampedArray) {
  // les grandes tailles pèsent lourd : cache borné en octets (32 Mo) autant qu'en nombre
  if (cache.size > 256 || cacheBytes > 32 << 20) {
    cache.clear();
    cacheBytes = 0;
  }
  cache.set(key, out);
  cacheBytes += out.length;
}

/**
 * Calcul d'une texture par bandes de lignes : `step(ms)` avance dans la limite du budget et rend les pixels une fois
 * fini (null sinon). Sert à la texture adaptative, dont les grandes tailles prendraient plusieurs centaines de ms.
 */
export class TexJob {
  readonly key: string;
  private out: Uint8ClampedArray;
  private y = 0;
  private c: number[];
  constructor(private t: TexSpec, base: string, readonly size: number) {
    this.key = pixKey(t, base, size);
    const hit = cache.get(this.key);
    this.out = hit ?? new Uint8ClampedArray(size * size * 4);
    if (hit) this.y = size;
    const c2 = t.color2 || shade(base, -0.35);
    const a = parseHex(base) ?? 0x888888;
    const b = parseHex(mixColor(base, c2, t.contrast)) ?? a;
    this.c = [(a >> 16) & 255, (a >> 8) & 255, a & 255, (b >> 16) & 255, (b >> 8) & 255, b & 255];
  }
  get done() {
    return this.y >= this.size;
  }
  step(budgetMs = Infinity): Uint8ClampedArray | null {
    const N = this.size, out = this.out, t = this.t;
    const [ar, ag, ab, br, bg, bb] = this.c;
    const t0 = budgetMs === Infinity ? 0 : performance.now();
    while (this.y < N) {
      const y = this.y++;
      for (let x = 0; x < N; x++) {
        const s = Math.max(0, Math.min(1, sample(t.kind, x / N, y / N, t.seed)));
        const i = (y * N + x) * 4;
        out[i] = ar + (br - ar) * s;
        out[i + 1] = ag + (bg - ag) * s;
        out[i + 2] = ab + (bb - ab) * s;
        out[i + 3] = 255;
      }
      if (budgetMs !== Infinity && (y & 3) === 3 && performance.now() - t0 > budgetMs) break;
    }
    if (this.y < N) return null;
    if (!cache.has(this.key)) keep(this.key, out);
    return out;
  }
}

export function texPixels(t: TexSpec, base: string, size: number = TEX_SIZE): Uint8ClampedArray {
  return new TexJob(t, base, size).step()!;
}

/** Clé de cache d'une texture teintée (pour les textures GPU des rendus). */
export function texKey(t: TexSpec, base: string): string {
  return `${t.kind}|${base}|${t.color2}|${t.contrast}|${t.seed}`;
}
