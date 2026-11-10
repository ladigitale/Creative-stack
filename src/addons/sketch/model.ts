import { BLEND_MODES, type BlendMode, type BrushSettings } from "../paint/brush";
import { simplifyLine, type BBox, type Multi, type Pt } from "../vector";
import {
  clampZoomTo, fitBox, panView, sanitizeView2D, screenToWorld, transformAt, visibleBounds, worldToScreen, type View2D,
} from "../../shared/view2d";
import { shapeHit } from "./merge";
import { flatVertices, vertexCount, type Region } from "./flat";

/**
 * Modèle d'un dessin vectoriel à zoom infini : des traits (points en coordonnées du monde, pression,
 * réglages du pinceau) et une vue (centre du monde, zoom). Fonctions pures.
 */

export const MIN_ZOOM = 1e-4;
export const MAX_ZOOM = 1e7;
export const MAX_STROKES = 20_000;
export const MAX_POINTS_PER_STROKE = 20_000;
export const MAX_TOTAL_POINTS = 2_000_000;

export type View = View2D;

/** Modes de fusion : ceux du pinceau de `sonic-paint` (noms CSS `mix-blend-mode`, communs au canvas et au SVG). */
export { BLEND_MODES, type BlendMode } from "../paint/brush";

/** Mode de fusion valide, sinon `fallback`. */
export function sanitizeBlend(v: unknown, fallback: BlendMode = "normal"): BlendMode {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (BLEND_MODES as readonly string[]).includes(s) ? (s as BlendMode) : fallback;
}

/** Pinceau mémorisé dans un trait : diamètre en unités du monde ; `blend` absent = `normal`. */
export type StrokeBrush = Pick<BrushSettings, "size" | "hardness" | "opacity" | "spacing" | "color" | "pressure" | "tip" | "angle" | "angleFollow" | "angleJitter" | "sizeJitter" | "scatter" | "roundness"> & { blend?: BlendMode };

export type Stroke = {
  id: number;
  brush: StrokeBrush;
  /** x, y, pression : trois nombres par point (vide pour une forme). */
  pts: number[];
  /**
   * Carte d'aplats (remplace `pts`) : régions disjointes d'une seule vraie couleur, résultat des traits pleins
   * aplatis (fusions calculées, parties recouvertes retirées, régions de même couleur unies).
   */
  flat?: Region[];
  /** Masque de gomme (remplace `pts`) : efface ce qui est dessous, traits non aplatis compris. */
  mask?: Multi;
  seed: number;
  bbox: BBox;
};

export const DEFAULT_VIEW: View = { x: 0, y: 0, zoom: 1, rotation: 0 };

export const clampZoom = (z: number): number => clampZoomTo(z, MIN_ZOOM, MAX_ZOOM);

export function sanitizeView(v: unknown, base: View = DEFAULT_VIEW): View {
  return sanitizeView2D(v, { ...DEFAULT_VIEW, ...base }, MIN_ZOOM, MAX_ZOOM);
}

/** Écran (px, origine en haut à gauche du canvas) → monde. */
export function toWorld(v: View, sx: number, sy: number, w: number, h: number): [number, number] {
  return screenToWorld(v, sx, sy, w, h);
}

export function toScreen(v: View, wx: number, wy: number, w: number, h: number): [number, number] {
  return worldToScreen(v, wx, wy, w, h);
}

/** Zoom ×`factor` en gardant fixe le point du monde sous (sx, sy). */
export function zoomAt(v: View, factor: number, sx: number, sy: number, w: number, h: number): View {
  return transformAt(v, factor, 0, sx, sy, w, h, MIN_ZOOM, MAX_ZOOM);
}

/** Glisse la vue de (dx, dy) pixels d'écran. */
export function panBy(v: View, dx: number, dy: number): View {
  return panView(v, dx, dy);
}

/** Rectangle du monde visible (contient tout l'écran, rotation comprise). */
export function visibleRect(v: View, w: number, h: number): BBox {
  return visibleBounds(v, w, h);
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

export function makeBrush(b: BrushSettings, size: number, blend: BlendMode = "normal"): StrokeBrush {
  const { hardness, opacity, spacing, color, pressure, tip, angle, angleFollow, angleJitter, sizeJitter, scatter, roundness } = b;
  const out: StrokeBrush = { size, hardness, opacity, spacing, color, pressure, tip, angle, angleFollow, angleJitter, sizeJitter, scatter, roundness };
  if (blend !== "normal") out.blend = blend;
  return out;
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

/** Vue qui cadre une boîte dans un écran w × h, avec une marge (fraction) ; `rotation` conservée. */
export function fitView(b: BBox | null, w: number, h: number, margin = 0.08, rotation = 0): View {
  return fitBox(b, w, h, rotation, MIN_ZOOM, MAX_ZOOM, margin) ?? { ...DEFAULT_VIEW, rotation };
}

/**
 * Compacte les points d'un trait terminé (x, y, pression par point) :
 * 1. jointure des points trop proches (moins de `tol / 2` du dernier gardé) ;
 * 2. Ramer–Douglas–Peucker sur le tracé **et** la pression : un point reste s'il s'écarte de plus de `tol`
 *    (monde) de la corde, ou si sa pression s'écarte de plus de `pressureTol` de la pression interpolée.
 * Extrémités toujours gardées. Itératif (pas de récursion). Retourne un nouveau tableau.
 */
export function compactStroke(pts: number[], tol: number, pressureTol = 0.04): number[] {
  const n0 = Math.floor(pts.length / 3);
  if (n0 <= 2 || !(tol > 0)) return pts.slice(0, n0 * 3);
  // 1. jointure
  const j: number[] = [pts[0], pts[1], pts[2]];
  const near = tol / 2;
  for (let i = 3; i < n0 * 3; i += 3) {
    const k = j.length - 3;
    const last = i === n0 * 3 - 3;
    if (!last && Math.hypot(pts[i] - j[k], pts[i + 1] - j[k + 1]) < near && Math.abs(pts[i + 2] - j[k + 2]) <= pressureTol) continue;
    if (last && j.length > 3 && Math.hypot(pts[i] - j[k], pts[i + 1] - j[k + 1]) < near) j.length -= 3;
    j.push(pts[i], pts[i + 1], pts[i + 2]);
  }
  const n = j.length / 3;
  if (n <= 2) return j;
  // 2a. Sans pression qui compte : RDP de l'addon vector sur le tracé.
  if (!Number.isFinite(pressureTol)) {
    const line: Pt[] = [];
    for (let i = 0; i < n; i++) line.push([j[i * 3], j[i * 3 + 1]]);
    const kept = simplifyLine(line, tol);
    const out: number[] = [];
    let k = 0;
    for (let i = 0; i < n && k < kept.length; i++) {
      if (line[i] === kept[k]) { out.push(j[i * 3], j[i * 3 + 1], j[i * 3 + 2]); k++; }
    }
    return out;
  }
  // 2b. RDP tracé + pression
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ax = j[a * 3], ay = j[a * 3 + 1], ap = j[a * 3 + 2];
    const bx = j[b * 3], by = j[b * 3 + 1], bp = j[b * 3 + 2];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let worst = -1, score = 1;
    for (let i = a + 1; i < b; i++) {
      const px = j[i * 3], py = j[i * 3 + 1];
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) / tol;
      // Pression interpolée selon la position le long de la corde (indice si la corde est nulle).
      const u = l2 === 0 ? (i - a) / (b - a) : t;
      const e = Math.max(d, Math.abs(j[i * 3 + 2] - (ap + u * (bp - ap))) / pressureTol);
      if (e > score) { score = e; worst = i; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(j[i * 3], j[i * 3 + 1], j[i * 3 + 2]);
  return out;
}

/** Distance d'un point à un segment. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Le trait passe-t-il à moins de `r` (monde) du point ? (épaisseur du trait comprise) */
export function strokeHit(s: Stroke, px: number, py: number, r: number): boolean {
  if (s.flat || s.mask) {
    const b = s.bbox;
    if (px < b.x - r || px > b.x + b.w + r || py < b.y - r || py > b.y + b.h + r) return false;
    return s.mask ? false : s.flat!.some((g) => shapeHit(g.shape, px, py, r));
  }
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

/** Points d'un élément : sommets d'une carte ou d'un masque, sinon points du trait. */
export const strokePoints = (s: Stroke): number => (s.flat ? flatVertices(s.flat) : s.mask ? vertexCount(s.mask) : s.pts.length / 3);

/* ------------------------------------------------------------ document et historique */

type Op =
  | { t: "add"; stroke: Stroke }
  | { t: "replace"; before: Stroke[]; after: Stroke[] }
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
    for (const s of this.strokes) n += strokePoints(s);
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

  /**
   * Remplace toute la liste en une étape d'historique (aplatissement, gomme) : les éléments ne sont jamais
   * modifiés en place, l'étape garde les deux listes (références partagées, pas de copie profonde).
   */
  replace(after: Stroke[]): void {
    const before = this.strokes;
    this.strokes = after;
    this.record({ t: "replace", before, after });
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
    else if (op.t === "replace") this.strokes = op.before;
    else if (op.t === "remove") for (const it of op.items) this.strokes.splice(it.index, 0, it.stroke);
    else this.strokes = op.strokes;
    this.future.push(op);
    return true;
  }

  redo(): boolean {
    const op = this.future.pop();
    if (!op) return false;
    if (op.t === "add") this.strokes.push(op.stroke);
    else if (op.t === "replace") this.strokes = op.after;
    else if (op.t === "remove") { const ids = new Set(op.items.map((i) => i.stroke.id)); this.strokes = this.strokes.filter((s) => !ids.has(s.id)); }
    else this.strokes = [];
    this.past.push(op);
    return true;
  }
}
