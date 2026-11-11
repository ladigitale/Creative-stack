/**
 * Sélection dans les cartes d'aplats : une « forme » est une région d'une seule vraie couleur et d'un seul tenant
 * (voir flat.ts). Clic → la région visible sous le point ; sélection par couleur → toutes les régions de cette
 * couleur (à une tolérance près, en OKLab), dans tout le dessin ou seulement celles qui se touchent. Fonctions pures.
 */
import { multiArea, type BBox } from "../vector";
import { shapeHit } from "./merge";
import type { Region } from "./flat";
import type { Rgba } from "./flat-color";
import { strokeHit, type Stroke } from "./model";

const toLinear = (u: number) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);

/** sRGB (0..1) → OKLab. */
export function oklab([r, g, b]: Rgba): [number, number, number] {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/**
 * Écart de couleur perçu, ×100 (écart OKLab ; l'opacité compte comme une composante) : 0 = même couleur,
 * ~2 = à peine visible, 100 = noir ↔ blanc.
 */
export function colorDistance(a: Rgba, b: Rgba): number {
  const p = oklab(a), q = oklab(b);
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2], a[3] - b[3]);
}

const inBox = (b: BBox, x: number, y: number, e: number) => x >= b.x - e && x <= b.x + b.w + e && y >= b.y - e && y <= b.y + b.h + e;
const boxesTouch = (a: BBox, b: BBox, e: number) => a.x <= b.x + b.w + e && a.x + a.w + e >= b.x && a.y <= b.y + b.h + e && a.y + a.h + e >= b.y;

/**
 * Région visible sous le point (monde), ou `null` : rien, un trou de gomme, un trait non aplati par-dessus.
 * Sur une frontière (à moins de `tol`), la région qui contient le point l'emporte.
 */
export function regionAt(strokes: Stroke[], x: number, y: number, tol: number): Region | null {
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    if (!inBox(s.bbox, x, y, tol)) continue;
    if (s.mask) { if (s.brush.opacity >= 0.999 && shapeHit(s.mask, x, y, 0)) return null; continue; }
    if (s.erase) continue;
    if (s.flat) {
      const inside = s.flat.find((g) => inBox(g.bbox, x, y, 0) && shapeHit(g.shape, x, y, 0));
      if (inside) return inside;
      const near = s.flat.find((g) => inBox(g.bbox, x, y, tol) && shapeHit(g.shape, x, y, tol));
      if (near) return near;
      continue;
    }
    if (strokeHit(s, x, y, tol)) return null;
  }
  return null;
}

/** Toutes les régions présentes (pour retirer de la sélection celles qu'une modification a remplacées). */
export function allRegions(strokes: Stroke[]): Region[] {
  const out: Region[] = [];
  for (const s of strokes) if (s.flat) out.push(...s.flat);
  return out;
}

/** Deux régions se touchent : un sommet de l'une est sur (ou dans) l'autre, à `eps` près. */
export function touching(a: Region, b: Region, eps: number): boolean {
  if (!boxesTouch(a.bbox, b.bbox, eps)) return false;
  const near = (from: Region, to: Region) => {
    for (const p of from.shape) for (const ring of p) for (const [x, y] of ring) {
      if (inBox(to.bbox, x, y, eps) && shapeHit(to.shape, x, y, eps)) return true;
    }
    return false;
  };
  return near(a, b) || near(b, a);
}

export type ColorSelectOptions = {
  /** Écart de couleur accepté (voir `colorDistance`), 0 = même couleur exacte. */
  tolerance: number;
  /** Seulement les régions reliées à la région de départ (de proche en proche, dans la même carte). */
  contiguous: boolean;
};

/** Sélection par couleur à partir d'une région. */
export function similarRegions(strokes: Stroke[], ref: Region, opts: ColorSelectOptions): Region[] {
  const tol = Math.max(0, opts.tolerance);
  const same = (r: Region) => (tol === 0 ? r.color === ref.color && !r.blend === !ref.blend : colorDistance(r.rgba, ref.rgba) <= tol && !r.blend === !ref.blend);
  if (!opts.contiguous) return allRegions(strokes).filter((r) => r === ref || same(r));
  const map = strokes.find((s) => s.flat?.includes(ref))?.flat ?? [ref];
  const size = Math.max(ref.bbox.w, ref.bbox.h, 1e-300);
  const out: Region[] = [ref];
  const seen = new Set<Region>([ref]);
  for (let i = 0; i < out.length; i++) {
    const cur = out[i];
    const eps = Math.max(cur.bbox.w, cur.bbox.h, size) * 1e-6;
    for (const r of map) {
      if (seen.has(r) || !same(r) || !touching(cur, r, eps)) continue;
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}

export type SelectionInfo = {
  count: number;
  /** Couleurs distinctes de la sélection (#rrggbb ou #rrggbbaa). */
  colors: string[];
  bbox: BBox | null;
  /** Aire totale (unités du monde au carré). */
  area: number;
};

export function selectionInfo(regions: Iterable<Region>): SelectionInfo {
  let count = 0, area = 0;
  const colors = new Set<string>();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of regions) {
    count++;
    area += multiArea(r.shape);
    colors.add(r.color);
    x0 = Math.min(x0, r.bbox.x); y0 = Math.min(y0, r.bbox.y);
    x1 = Math.max(x1, r.bbox.x + r.bbox.w); y1 = Math.max(y1, r.bbox.y + r.bbox.h);
  }
  return { count, colors: [...colors], bbox: count ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null, area };
}
