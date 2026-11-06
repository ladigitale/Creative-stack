import type { BrushSettings } from "../paint/brush";
import type { BBox } from "../vector/geometry";

/**
 * Modèle d'un dessin vectoriel à zoom infini : des traits (points en coordonnées du monde, pression,
 * réglages du pinceau) et une vue (centre du monde, zoom). Fonctions pures.
 */

export const MIN_ZOOM = 1e-4;
export const MAX_ZOOM = 1e7;
export const MAX_STROKES = 20_000;
export const MAX_POINTS_PER_STROKE = 20_000;
export const MAX_TOTAL_POINTS = 2_000_000;

export type View = {
  /** Point du monde au centre de l'écran. */
  x: number;
  y: number;
  /** Pixels d'écran par unité du monde. */
  zoom: number;
};

/** Pinceau mémorisé dans un trait : diamètre en unités du monde. */
export type StrokeBrush = Pick<BrushSettings, "size" | "hardness" | "opacity" | "spacing" | "color" | "pressure" | "tip" | "angle" | "angleFollow" | "angleJitter" | "sizeJitter" | "scatter" | "roundness">;

export type Stroke = {
  id: number;
  brush: StrokeBrush;
  /** x, y, pression : trois nombres par point. */
  pts: number[];
  seed: number;
  bbox: BBox;
};

export const DEFAULT_VIEW: View = { x: 0, y: 0, zoom: 1 };

export const clampZoom = (z: number): number => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number.isFinite(z) ? z : 1));

export function sanitizeView(v: unknown, base: View = DEFAULT_VIEW): View {
  if (!v || typeof v !== "object") return { ...base };
  const o = v as Record<string, unknown>;
  const n = (k: string, d: number) => (Number.isFinite(Number(o[k])) && o[k] !== "" && o[k] !== null ? Number(o[k]) : d);
  return { x: n("x", base.x), y: n("y", base.y), zoom: clampZoom(n("zoom", base.zoom)) };
}

/** Écran (px, origine en haut à gauche du canvas) → monde. */
export function toWorld(v: View, sx: number, sy: number, w: number, h: number): [number, number] {
  return [v.x + (sx - w / 2) / v.zoom, v.y + (sy - h / 2) / v.zoom];
}

export function toScreen(v: View, wx: number, wy: number, w: number, h: number): [number, number] {
  return [(wx - v.x) * v.zoom + w / 2, (wy - v.y) * v.zoom + h / 2];
}

/** Zoom ×`factor` en gardant fixe le point du monde sous (sx, sy). */
export function zoomAt(v: View, factor: number, sx: number, sy: number, w: number, h: number): View {
  const zoom = clampZoom(v.zoom * factor);
  const [wx, wy] = toWorld(v, sx, sy, w, h);
  return { zoom, x: wx - (sx - w / 2) / zoom, y: wy - (sy - h / 2) / zoom };
}

/** Glisse la vue de (dx, dy) pixels d'écran. */
export function panBy(v: View, dx: number, dy: number): View {
  return { ...v, x: v.x - dx / v.zoom, y: v.y - dy / v.zoom };
}

/** Rectangle du monde visible. */
export function visibleRect(v: View, w: number, h: number): BBox {
  return { x: v.x - w / 2 / v.zoom, y: v.y - h / 2 / v.zoom, w: w / v.zoom, h: h / v.zoom };
}

export function strokeBBox(pts: number[], radius: number): BBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    if (pts[i] < x0) x0 = pts[i];
    if (pts[i] > x1) x1 = pts[i];
    if (pts[i + 1] < y0) y0 = pts[i + 1];
    if (pts[i + 1] > y1) y1 = pts[i + 1];
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0 - radius, y: y0 - radius, w: x1 - x0 + 2 * radius, h: y1 - y0 + 2 * radius };
}

/** Marge de la boîte d'un trait : rayon maximal des empreintes (dispersion comprise). */
export function strokeMargin(b: StrokeBrush): number {
  return (b.size / 2) * (1 + b.scatter * 2) + 1e-9;
}

export function makeBrush(b: BrushSettings, size: number): StrokeBrush {
  const { hardness, opacity, spacing, color, pressure, tip, angle, angleFollow, angleJitter, sizeJitter, scatter, roundness } = b;
  return { size, hardness, opacity, spacing, color, pressure, tip, angle, angleFollow, angleJitter, sizeJitter, scatter, roundness };
}

/** Boîte de tout le contenu, ou `null` si vide. */
export function contentBBox(strokes: Stroke[]): BBox | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    x0 = Math.min(x0, s.bbox.x);
    y0 = Math.min(y0, s.bbox.y);
    x1 = Math.max(x1, s.bbox.x + s.bbox.w);
    y1 = Math.max(y1, s.bbox.y + s.bbox.h);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Vue qui cadre une boîte dans un écran w × h, avec une marge (fraction). */
export function fitView(b: BBox | null, w: number, h: number, margin = 0.08): View {
  if (!b || (b.w <= 0 && b.h <= 0)) return { ...DEFAULT_VIEW };
  const zw = (w * (1 - 2 * margin)) / Math.max(b.w, 1e-12);
  const zh = (h * (1 - 2 * margin)) / Math.max(b.h, 1e-12);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2, zoom: clampZoom(Math.min(zw, zh)) };
}

/** Distance d'un point à un segment. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Le trait passe-t-il à moins de `r` (monde) du point ? (épaisseur du trait comprise) */
export function strokeHit(s: Stroke, px: number, py: number, r: number): boolean {
  const reach = r + s.brush.size / 2;
  const b = s.bbox;
  if (px < b.x - r || px > b.x + b.w + r || py < b.y - r || py > b.y + b.h + r) return false;
  const p = s.pts;
  if (p.length === 3) return Math.hypot(px - p[0], py - p[1]) <= reach;
  for (let i = 0; i + 5 < p.length + 0; i += 3) {
    if (segDist(px, py, p[i], p[i + 1], p[i + 3], p[i + 4]) <= reach) return true;
  }
  return false;
}

/* ------------------------------------------------------------ document et historique */

type Op =
  | { t: "add"; stroke: Stroke }
  | { t: "remove"; items: { index: number; stroke: Stroke }[] }
  | { t: "clear"; strokes: Stroke[] };

/** Les traits et l'historique annuler / rétablir (opérations inversibles, bornées). */
export class Doc {
  strokes: Stroke[] = [];
  private past: Op[] = [];
  private future: Op[] = [];
  nextId = 1;

  constructor(readonly maxOps = 500) {}

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  get totalPoints(): number {
    let n = 0;
    for (const s of this.strokes) n += s.pts.length / 3;
    return n;
  }

  private record(op: Op): void {
    this.past.push(op);
    this.future = [];
    if (this.past.length > this.maxOps) this.past.shift();
  }

  add(stroke: Stroke): boolean {
    if (this.strokes.length >= MAX_STROKES || this.totalPoints + stroke.pts.length / 3 > MAX_TOTAL_POINTS) return false;
    this.strokes.push(stroke);
    this.record({ t: "add", stroke });
    return true;
  }

  /** Retire des traits (par identifiant) en une seule étape d'historique. */
  remove(ids: Set<number>): number {
    const items: { index: number; stroke: Stroke }[] = [];
    this.strokes.forEach((stroke, index) => { if (ids.has(stroke.id)) items.push({ index, stroke }); });
    if (!items.length) return 0;
    this.strokes = this.strokes.filter((s) => !ids.has(s.id));
    this.record({ t: "remove", items });
    return items.length;
  }

  clear(): void {
    if (!this.strokes.length) return;
    this.record({ t: "clear", strokes: this.strokes });
    this.strokes = [];
  }

  undo(): boolean {
    const op = this.past.pop();
    if (!op) return false;
    if (op.t === "add") this.strokes = this.strokes.filter((s) => s !== op.stroke);
    else if (op.t === "remove") for (const it of op.items) this.strokes.splice(it.index, 0, it.stroke);
    else this.strokes = op.strokes;
    this.future.push(op);
    return true;
  }

  redo(): boolean {
    const op = this.future.pop();
    if (!op) return false;
    if (op.t === "add") this.strokes.push(op.stroke);
    else if (op.t === "remove") { const ids = new Set(op.items.map((i) => i.stroke.id)); this.strokes = this.strokes.filter((s) => !ids.has(s.id)); }
    else this.strokes = [];
    this.past.push(op);
    return true;
  }
}
