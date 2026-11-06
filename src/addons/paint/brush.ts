/**
 * Moteur de pinceau (calcul pur) : lissage du tracé, dépôt d'empreintes à espacement régulier,
 * historique borné. Le composant n'y ajoute que le dessin sur canvas.
 */

import { parsePath } from "../vector/svgpath";

export type Pt = { x: number; y: number; p: number; /** Direction du tracé (radians) à cet endroit. */ a?: number };

export type BrushSettings = {
  /** Diamètre (px de la toile). */
  size: number;
  /** 0 (bord flou) à 1 (bord net). */
  hardness: number;
  /** Opacité de chaque empreinte, 0..1. */
  opacity: number;
  /** Espacement des empreintes en fraction du diamètre. */
  spacing: number;
  color: string;
  tool: "paint" | "erase";
  /** Lissage 0..0,95 : plus haut = tracé plus stable et plus en retard. */
  smoothing: number;
  /** La pression du stylet module le diamètre. */
  pressure: boolean;
  /** Pointe personnalisée : chemin SVG `d` (vide : disque doux). Sa taille est celle du diamètre. */
  tip: string;
  /** Rotation de la pointe (°) ; avec `angleFollow`, ajoutée à la direction du tracé. */
  angle: number;
  angleFollow: boolean;
  /** Variation aléatoire de l'angle (± °), de la taille (0..1) et dispersion (fraction du diamètre). */
  angleJitter: number;
  sizeJitter: number;
  scatter: number;
  /** Aplatissement de la pointe (1 : intacte, 0,2 : très plate). */
  roundness: number;
};

export const BRUSH_DEFAULTS: BrushSettings = {
  size: 24,
  hardness: 0.7,
  opacity: 1,
  spacing: 0.12,
  color: "#000000",
  tool: "paint",
  smoothing: 0.5,
  pressure: true,
  tip: "",
  angle: 0,
  angleFollow: false,
  angleJitter: 0,
  sizeJitter: 0,
  scatter: 0,
  roundness: 1,
};

export const MAX_TIP_CHARS = 20_000;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/-]+\)|[a-z]{3,20})$/i;

/** Valide et borne des réglages partiels (valeurs invalides ignorées). */
export function sanitizeBrush(base: BrushSettings, raw: Record<string, unknown> | null | undefined): BrushSettings {
  const o = { ...base };
  if (!raw || typeof raw !== "object") return o;
  const n = (v: unknown) => (v === "" || v === null || v === undefined ? NaN : Number(v));
  if (Number.isFinite(n(raw.size))) o.size = clamp(n(raw.size), 1, 512);
  if (Number.isFinite(n(raw.hardness))) o.hardness = clamp(n(raw.hardness), 0, 1);
  if (Number.isFinite(n(raw.opacity))) o.opacity = clamp(n(raw.opacity), 0.01, 1);
  if (Number.isFinite(n(raw.spacing))) o.spacing = clamp(n(raw.spacing), 0.02, 2);
  if (Number.isFinite(n(raw.smoothing))) o.smoothing = clamp(n(raw.smoothing), 0, 0.95);
  if (typeof raw.color === "string" && COLOR_RE.test(raw.color.trim())) o.color = raw.color.trim();
  if (raw.tool === "paint" || raw.tool === "erase") o.tool = raw.tool;
  if (typeof raw.pressure === "boolean") o.pressure = raw.pressure;
  if (typeof raw.tip === "string") {
    const t = raw.tip.trim();
    if (!t) o.tip = "";
    else if (t.length <= MAX_TIP_CHARS && parsePath(t)) o.tip = t;
  }
  if (Number.isFinite(n(raw.angle))) o.angle = clamp(n(raw.angle), -360, 360);
  if (typeof raw.angleFollow === "boolean") o.angleFollow = raw.angleFollow;
  if (Number.isFinite(n(raw.angleJitter))) o.angleJitter = clamp(n(raw.angleJitter), 0, 180);
  if (Number.isFinite(n(raw.sizeJitter))) o.sizeJitter = clamp(n(raw.sizeJitter), 0, 1);
  if (Number.isFinite(n(raw.scatter))) o.scatter = clamp(n(raw.scatter), 0, 3);
  if (Number.isFinite(n(raw.roundness))) o.roundness = clamp(n(raw.roundness), 0.05, 1);
  return o;
}

/** Diamètre effectif d'une empreinte selon la pression (jamais sous 20 % : un stylet léger reste visible). */
export function dabSize(b: BrushSettings, pressure: number): number {
  return Math.max(1, b.size * (b.pressure ? 0.2 + 0.8 * clamp(pressure, 0, 1) : 1));
}

/**
 * Lissage par moyenne mobile exponentielle : la pointe suit le pointeur avec un retard réglable.
 * `smoothing` 0 : aucun retard.
 */
export class Stabilizer {
  private cur: Pt | null = null;

  reset(): void {
    this.cur = null;
  }

  feed(raw: Pt, smoothing: number): Pt {
    if (!this.cur || smoothing <= 0) return (this.cur = { ...raw });
    const k = 1 - clamp(smoothing, 0, 0.95);
    this.cur = { x: this.cur.x + (raw.x - this.cur.x) * k, y: this.cur.y + (raw.y - this.cur.y) * k, p: this.cur.p + (raw.p - this.cur.p) * k };
    return { ...this.cur };
  }

  /** Dernière position lissée (pour rattraper le pointeur en fin de tracé). */
  get position(): Pt | null {
    return this.cur ? { ...this.cur } : null;
  }
}

/** Dépose des empreintes le long de segments, à distance constante d'un segment à l'autre. */
export class StampWalker {
  private last: Pt | null = null;
  private carry = 0;

  reset(): void {
    this.last = null;
    this.carry = 0;
  }

  /**
   * Empreintes à poser en allant de la dernière position à `to`. La première position pose une empreinte.
   * Le diamètre (donc l'espacement) suit la pression interpolée. `maxStamps` borne le travail d'un appel.
   */
  walk(to: Pt, b: BrushSettings, maxStamps = 2000): Pt[] {
    const out: Pt[] = [];
    if (!this.last) {
      this.last = { ...to };
      out.push({ ...to, a: to.a ?? 0 });
      return out;
    }
    const a = this.last;
    const dx = to.x - a.x, dy = to.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return out;
    const dir = Math.atan2(dy, dx);
    let t = 0;
    let pos = this.carry;
    for (;;) {
      const p = a.p + (to.p - a.p) * t;
      const step = Math.max(0.5, dabSize(b, p) * b.spacing);
      const need = step - pos;
      const remaining = dist * (1 - t);
      if (need > remaining) {
        this.carry = pos + remaining;
        break;
      }
      t += need / dist;
      pos = 0;
      out.push({ x: a.x + dx * t, y: a.y + dy * t, p: a.p + (to.p - a.p) * t, a: dir });
      if (out.length >= maxStamps) {
        this.carry = 0;
        break;
      }
    }
    this.last = { ...to };
    return out;
  }
}

/** Générateur pseudo-aléatoire déterministe (mulberry32) : un trait se redessine à l'identique. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Placement = { x: number; y: number; /** Diamètre. */ size: number; /** Rotation (radians). */ rot: number; /** Aplatissement. */ squash: number };

/**
 * Place une empreinte : position dispersée, diamètre et rotation variés. `r` = tirage du trait
 * (`rng(seed)` consommé dans l'ordre des empreintes : même trait, même rendu).
 */
export function place(pt: Pt, b: BrushSettings, r: () => number): Placement {
  const base = dabSize(b, pt.p);
  const jitterK = b.sizeJitter > 0 ? 1 - b.sizeJitter * r() : (r(), 1);
  const size = Math.max(0.5, base * jitterK);
  let x = pt.x, y = pt.y;
  const sa = r() * Math.PI * 2, sr = Math.sqrt(r());
  if (b.scatter > 0) {
    x += Math.cos(sa) * sr * b.scatter * base;
    y += Math.sin(sa) * sr * b.scatter * base;
  }
  const jitter = (r() * 2 - 1) * b.angleJitter;
  const rot = ((b.angle + jitter) * Math.PI) / 180 + (b.angleFollow ? pt.a ?? 0 : 0);
  return { x, y, size, rot, squash: b.roundness };
}

/** Historique borné par nombre d'étapes et par coût total (pixels) : annuler / rétablir. */
export class History<T> {
  private past: Array<{ v: T; cost: number }> = [];
  private future: Array<{ v: T; cost: number }> = [];

  constructor(readonly maxSteps = 20, readonly maxCost = 64_000_000) {}

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get undoDepth(): number {
    return this.past.length;
  }

  /** Enregistre l'état AVANT une modification (efface l'avenir). */
  push(state: T, cost: number): void {
    this.past.push({ v: state, cost });
    this.future = [];
    let total = this.past.reduce((s, e) => s + e.cost, 0);
    while (this.past.length > this.maxSteps || (total > this.maxCost && this.past.length > 1)) {
      total -= this.past.shift()!.cost;
    }
  }

  /** `current` : l'état actuel (rangé pour rétablir). Retourne l'état précédent, ou null. */
  undo(current: T, cost: number): T | null {
    const e = this.past.pop();
    if (!e) return null;
    this.future.push({ v: current, cost });
    return e.v;
  }

  redo(current: T, cost: number): T | null {
    const e = this.future.pop();
    if (!e) return null;
    this.past.push({ v: current, cost });
    return e.v;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}
