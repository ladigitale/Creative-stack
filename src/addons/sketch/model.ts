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
   * Points de passage d'une courbe (Catmull-Rom centripète) plutôt que les sommets d'une ligne brisée : le trait
   * reste lisse à tous les zooms avec peu de points. Tracé réel : `strokePath`.
   */
  curve?: boolean;
  /**
   * Carte d'aplats (remplace `pts`) : régions disjointes d'une seule vraie couleur, résultat des traits pleins
   * aplatis (fusions calculées, parties recouvertes retirées, régions de même couleur unies).
   */
  flat?: Region[];
  /**
   * Masque de gomme (remplace `pts`) : efface ce qui est dessous, traits non aplatis compris, à hauteur de
   * l'opacité de son pinceau (1 : trou net ; moins : ce qui est dessous s'estompe).
   */
  mask?: Multi;
  /**
   * Gomme en empreintes (pointe, bord doux, dispersion… : pas de contour net possible) : ses empreintes
   * effacent ce qui est dessous comme le pinceau peindrait, opacité comprise.
   */
  erase?: boolean;
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
  if (s.erase) return false;
  if (s.flat || s.mask) {
    const b = s.bbox;
    if (px < b.x - r || px > b.x + b.w + r || py < b.y - r || py > b.y + b.h + r) return false;
    return s.mask ? false : s.flat!.some((g) => shapeHit(g.shape, px, py, r));
  }
  const reach = r + s.brush.size / 2;
  const b = s.bbox;
  if (px < b.x - r || px > b.x + b.w + r || py < b.y - r || py > b.y + b.h + r) return false;
  const p = strokePath(s);
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

  /** Ajoute plusieurs traits en une seule étape d'historique (faux si les limites seraient dépassées). */
  addMany(strokes: Stroke[]): boolean {
    const pts = strokes.reduce((n, s) => n + s.pts.length / 3, 0);
    if (this.strokes.length + strokes.length > MAX_STROKES || this.totalPoints + pts > MAX_TOTAL_POINTS) return false;
    this.replace([...this.strokes, ...strokes]);
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


/* ------------------------------------------------------------------ traits en courbe */

const pathCache = new WeakMap<Stroke, { pts: number[]; path: number[] }>();

/**
 * Tracé réel d'un trait (`[x, y, p, …]`, monde) : ses points, ou pour un trait en courbe la courbe de
 * Catmull-Rom centripète qui passe par eux, échantillonnée finement (au plus 1/6 du diamètre entre deux points).
 */
export function strokePath(s: Stroke): number[] {
  if (!s.curve || s.pts.length < 9) return s.pts;
  const hit = pathCache.get(s);
  if (hit && hit.pts === s.pts) return hit.path;
  const path = curvePath(s.pts, Math.max(s.brush.size / 6, 1e-300));
  pathCache.set(s, { pts: s.pts, path });
  return path;
}

/**
 * Catmull-Rom centripète (alpha 0,5 : ni boucle ni pointe parasite) par les points `pts` (`[x, y, p, …]`), un
 * point tous les `step` environ ; pression interpolée de même. Les extrémités sont prolongées en miroir.
 */
export function curvePath(pts: number[], step: number, max = 50_000): number[] {
  const n = pts.length / 3;
  if (n < 3) return pts.slice();
  const P = (i: number): [number, number, number] => {
    if (i < 0) return [2 * pts[0] - pts[3], 2 * pts[1] - pts[4], pts[2]];
    if (i >= n) { const a = (n - 1) * 3, b = (n - 2) * 3; return [2 * pts[a] - pts[b], 2 * pts[a + 1] - pts[b + 1], pts[a + 2]]; }
    return [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
  };
  const out: number[] = [pts[0], pts[1], pts[2]];
  for (let i = 0; i < n - 1; i++) {
    const seg = curveSegment(P(i - 1), P(i), P(i + 1), P(i + 2));
    const len = Math.hypot(pts[i * 3 + 3] - pts[i * 3], pts[i * 3 + 4] - pts[i * 3 + 1]);
    const k = Math.max(1, Math.min(400, Math.ceil(len / step)));
    for (let j = 1; j <= k; j++) {
      if (out.length / 3 >= max) return out;
      const [x, y, p] = seg(j / k);
      out.push(x, y, p);
    }
  }
  return out;
}

/** Segment p1 → p2 d'une Catmull-Rom centripète (formulation de Barry et Goldman), t ∈ [0, 1]. */
function curveSegment(p0: number[], p1: number[], p2: number[], p3: number[]): (t: number) => [number, number, number] {
  const d = (a: number[], b: number[]) => Math.max(1e-12, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const lerp = (a: number[], b: number[], ta: number, tb: number, t: number) => {
    const u = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  };
  return (tt: number) => {
    const t = t1 + (t2 - t1) * tt;
    const a1 = lerp(p0, p1, t0, t1, t), a2 = lerp(p1, p2, t1, t2, t), a3 = lerp(p2, p3, t2, t3, t);
    const b1 = lerp(a1, a2, t0, t2, t), b2 = lerp(a2, a3, t1, t3, t);
    const c = lerp(b1, b2, t1, t2, t);
    return [c[0], c[1], p1[2] + (p2[2] - p1[2]) * tt];
  };
}

/**
 * Points de passage d'une courbe qui suit un tracé brut (`raw`, `[x, y, p, …]`) à `tol` près (monde) et dont
 * la pression suit à `ptol` près (lissée d'abord : le tremblement du stylet ne garde pas de points). On part
 * d'une simplification grossière, puis on ajoute le point brut le plus éloigné de la courbe tant qu'il en faut :
 * bien moins de points qu'une ligne brisée de même précision, et un trait lisse à tout zoom.
 */
export function fitCurvePoints(raw: number[], tol: number, ptol = Infinity): number[] {
  const n = raw.length / 3;
  if (n <= 3 || !(tol > 0)) return raw.slice();
  // Pression lissée (moyenne glissante sur 5 points).
  const pr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) { s += raw[j * 3 + 2]; c++; }
    pr[i] = s / c;
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  // Départ : ligne brisée grossière (3 × la tolérance).
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    let worst = -1, wd = tol * 3;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(raw[i * 3], raw[i * 3 + 1], raw[a * 3], raw[a * 3 + 1], raw[b * 3], raw[b * 3 + 1]);
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  const ctrl = (): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(raw[i * 3], raw[i * 3 + 1], pr[i]);
    return out;
  };
  // Raffinage : pour chaque segment de la courbe, le point brut le plus éloigné (tracé ou pression).
  for (let pass = 0; pass < 12; pass++) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
    const c = ctrl();
    const m = idx.length;
    const P = (i: number): number[] => {
      if (i < 0) return [2 * c[0] - c[3], 2 * c[1] - c[4], c[2]];
      if (i >= m) { const a = (m - 1) * 3, b = (m - 2) * 3; return [2 * c[a] - c[b], 2 * c[a + 1] - c[b + 1], c[a + 2]]; }
      return [c[i * 3], c[i * 3 + 1], c[i * 3 + 2]];
    };
    let added = 0;
    for (let k = 0; k < m - 1; k++) {
      const a = idx[k], b = idx[k + 1];
      if (b - a < 2) continue;
      const seg = m >= 3 ? curveSegment(P(k - 1), P(k), P(k + 1), P(k + 2)) : null;
      // Échantillons de la courbe sur ce segment.
      const S = 16, smp: number[][] = [];
      for (let j = 0; j <= S; j++) smp.push(seg ? seg(j / S) : [c[k * 3] + (c[k * 3 + 3] - c[k * 3]) * (j / S), c[k * 3 + 1] + (c[k * 3 + 4] - c[k * 3 + 1]) * (j / S), c[k * 3 + 2] + (c[k * 3 + 5] - c[k * 3 + 2]) * (j / S)]);
      let worst = -1, we = 1;
      for (let i = a + 1; i < b; i++) {
        const x = raw[i * 3], y = raw[i * 3 + 1];
        let dmin = Infinity, jbest = 0;
        for (let j = 0; j < S; j++) {
          const dd = segDist(x, y, smp[j][0], smp[j][1], smp[j + 1][0], smp[j + 1][1]);
          if (dd < dmin) { dmin = dd; jbest = j; }
        }
        const pe = Number.isFinite(ptol) ? Math.abs(pr[i] - smp[jbest][2]) / ptol : 0;
        const e = Math.max(dmin / tol, pe);
        if (e > we) { we = e; worst = i; }
      }
      if (worst >= 0) { keep[worst] = 1; added++; }
    }
    if (!added) break;
  }
  return ctrl();
}
