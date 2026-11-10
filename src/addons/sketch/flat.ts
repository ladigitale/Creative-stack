import { boolean, multiBBox, type BBox, type Multi, type Pt } from "../vector";
import type { BlendMode } from "../paint/brush";
import { composite, quantize, sameColor, toCss, type Rgba } from "./flat-color";

/**
 * Carte d'aplats : des régions **disjointes**, chacune d'une seule couleur réelle et d'un seul tenant (un polygone
 * avec ses trous ; deux morceaux de même couleur qui se touchent sont toujours unis). Peindre un trait plein la
 * découpe (outils booléens de l'addon `vector`) : sous le trait, chaque région prend la couleur calculée du
 * mode de fusion ; ce qui est entièrement recouvert disparaît ; les régions de même couleur sont unies.
 * Gommer retire la forme de la gomme de toutes les régions. Fonctions pures.
 */

export type Region = {
  rgba: Rgba;
  /** Couleur CSS de `rgba` (#rrggbb ou #rrggbbaa). */
  color: string;
  /** Mode gardé seulement quand le fond n'est pas connu (traits non aplatis dessous) : fusion au rendu. */
  blend?: BlendMode;
  shape: Multi;
  bbox: BBox;
};

/** Ce qu'il y a sous la carte : un fond uni connu (null = transparent), ou inconnu (traits non aplatis). */
export type Backdrop = { known: true; color: Rgba | null } | { known: false };

export const MAX_FLAT_VERTICES = 200_000;

export const vertexCount = (m: Multi): number => m.reduce((n, p) => n + p.reduce((k, r) => k + r.length, 0), 0);
export const flatVertices = (regions: Region[]): number => regions.reduce((n, r) => n + vertexCount(r.shape), 0);

const overlaps = (a: BBox, b: BBox): boolean => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;

/* Repère local autour de la forme qui agit (trait, gomme) : les coordonnées du monde vont de 1e-6 à 1e6. */
type Frame = { ox: number; oy: number; k: number };
const frameOf = (b: BBox): Frame => ({ ox: b.x, oy: b.y, k: Math.max(b.w, b.h, 1e-300) });
const toLocal = (f: Frame, m: Multi): Multi => m.map((p) => p.map((r) => r.map(([x, y]): Pt => [(x - f.ox) / f.k, (y - f.oy) / f.k])));
const toWorld = (f: Frame, m: Multi): Multi => m.map((p) => p.map((r) => r.map(([x, y]): Pt => [x * f.k + f.ox, y * f.k + f.oy])));

/** Aligne les sommets sur une grille (repère local) : les prédicats du découpage voient des points identiques. */
const snap = (m: Multi, step: number): Multi =>
  m.map((p) => p.map((r) => r.map(([x, y]): Pt => [Math.round(x / step) * step, Math.round(y / step) * step])));

/**
 * Opération booléenne robuste : polygon-clipping peut échouer sur des géométries accumulées (sommets presque
 * confondus) ; on recommence avec les sommets alignés sur une grille de plus en plus grossière (repère local,
 * de 1e-9 à 1e-5 de la taille du trait : invisible).
 */
export function safeBoolean(op: "union" | "intersect" | "difference", a: Multi, ...others: Multi[]): Multi {
  try {
    return boolean(op, a, ...others);
  } catch (first) {
    for (const step of [1e-9, 1e-7, 1e-5]) {
      try {
        return boolean(op, snap(a, step), ...others.map((m) => snap(m, step)));
      } catch { /* grille suivante */ }
    }
    throw first;
  }
}

const region = (rgba: Rgba, shape: Multi, blend?: BlendMode): Region => {
  const r: Region = { rgba, color: toCss(rgba), shape, bbox: multiBBox(shape) };
  if (blend && blend !== "normal") r.blend = blend;
  return r;
};

const key = (r: { rgba: Rgba; blend?: BlendMode }) => r.rgba.join(",") + "|" + (r.blend ?? "normal");

/** Une région par polygone (contour extérieur + trous) : les morceaux disjoints d'une couleur restent séparés. */
const splitRegions = (rgba: Rgba, m: Multi, blend?: BlendMode): Region[] => m.map((poly) => region(rgba, [poly], blend));

const grow = (b: BBox, e: number): BBox => ({ x: b.x - e, y: b.y - e, w: b.w + 2 * e, h: b.h + 2 * e });

/**
 * Unit les régions de même couleur (et même mode) qui se touchent : en partant des nouvelles pièces, on
 * rassemble de proche en proche (boîtes qui se chevauchent) les régions de même clé, on les unit, puis on
 * redécoupe le résultat en polygones connexes. Les régions qui ne touchent rien de neuf restent telles quelles.
 */
function mergeSameColor(regions: Region[], fresh: Region[], f: Frame): Region[] {
  const all = [...regions, ...fresh].filter((r) => r.shape.length && (r.rgba[3] > 0 || r.blend));
  const isFresh = new Set(fresh);
  const used = new Set<Region>();
  const out: Region[] = [];
  const eps = f.k * 1e-9;
  for (const seed of fresh) {
    if (used.has(seed) || !all.includes(seed)) continue;
    const k = key(seed);
    const comp: Region[] = [seed];
    used.add(seed);
    for (let i = 0; i < comp.length; i++) {
      const b = grow(comp[i].bbox, eps);
      for (const r of all) {
        if (used.has(r) || key(r) !== k || !overlaps(r.bbox, b)) continue;
        used.add(r);
        comp.push(r);
      }
    }
    if (comp.length === 1) { out.push(seed); continue; }
    const shapes = comp.map((r) => toLocal(f, r.shape));
    out.push(...splitRegions(seed.rgba, toWorld(f, safeBoolean("union", shapes[0], ...shapes.slice(1))), seed.blend));
  }
  for (const r of all) if (!used.has(r) && !isFresh.has(r)) out.push(r);
  return out;
}

/**
 * Peint la forme `stroke` (polygones du monde) de couleur `src`, opacité `alpha`, mode `mode` sur la carte.
 * Sous le trait : chaque région devient deux pièces (le reste garde sa couleur, la partie couverte prend la
 * couleur fusionnée) ; hors des régions, le trait se fusionne avec le fond s'il est connu.
 */
export function paintFlat(regions: Region[], stroke: Multi, src: Rgba, alpha: number, mode: BlendMode, back: Backdrop): Region[] {
  if (!stroke.length) return regions;
  const sb = multiBBox(stroke);
  const f = frameOf(sb);
  const S = toLocal(f, stroke);
  const opaqueNormal = mode === "normal" && src[3] * alpha >= 0.999;
  const out: Region[] = [];
  const fresh: Region[] = [];
  const under: Multi[] = [];
  for (const r of regions) {
    if (!overlaps(r.bbox, sb)) { out.push(r); continue; }
    const R = toLocal(f, r.shape);
    const inter = safeBoolean("intersect", R, S);
    if (!inter.length) { out.push(r); continue; }
    under.push(R);
    const rest = safeBoolean("difference", R, S);
    if (rest.length) out.push(...splitRegions(r.rgba, toWorld(f, rest), r.blend));
    // Région à fusion différée : sous un trait opaque normal elle disparaît ; sinon on garde son mode.
    const color = composite(r.rgba, src, alpha, mode);
    fresh.push(...splitRegions(color, toWorld(f, inter), opaqueNormal ? undefined : r.blend));
  }
  const outside = under.length ? safeBoolean("difference", S, ...under) : S;
  if (outside.length) {
    if (back.known) fresh.push(...splitRegions(composite(back.color, src, alpha, mode), toWorld(f, outside)));
    else fresh.push(...splitRegions(quantize([src[0], src[1], src[2], src[3] * alpha]), toWorld(f, outside), mode));
  }
  return mergeSameColor(out, fresh, f);
}

/** Gomme : retire la forme `eraser` de toutes les régions (un trou net, à tout zoom). */
export function eraseFlat(regions: Region[], eraser: Multi): Region[] {
  if (!eraser.length) return regions;
  const eb = multiBBox(eraser);
  const f = frameOf(eb);
  const E = toLocal(f, eraser);
  const out: Region[] = [];
  for (const r of regions) {
    if (!overlaps(r.bbox, eb)) { out.push(r); continue; }
    const rest = safeBoolean("difference", toLocal(f, r.shape), E);
    if (rest.length) out.push(...splitRegions(r.rgba, toWorld(f, rest), r.blend));
  }
  return out;
}

/** Boîte de la carte. */
export function flatBBox(regions: Region[]): BBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of regions) {
    x0 = Math.min(x0, r.bbox.x); y0 = Math.min(y0, r.bbox.y);
    x1 = Math.max(x1, r.bbox.x + r.bbox.w); y1 = Math.max(y1, r.bbox.y + r.bbox.h);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}

export { sameColor };
