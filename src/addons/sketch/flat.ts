import { boolean, multiBBox, offset, simplifyMulti, type BBox, type Multi, type Pt } from "../vector";
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

/**
 * Grille commune (repère local, 1e-9 de la taille du trait) : toutes les entrées et sorties des opérations d'un
 * même geste y sont alignées. Deux pièces calculées par des opérations différentes partagent alors exactement
 * leurs sommets de bord, et leur union les recolle au lieu de laisser un interstice de l'ordre de 1e-15.
 */
const GRID = 1e-9;
const local = (f: Frame, m: Multi): Multi => snap(toLocal(f, m), GRID);
const op = (o: "union" | "intersect" | "difference", a: Multi, ...others: Multi[]): Multi =>
  clean(snap(safeBoolean(o, a, ...others), GRID));
/**
 * Retire les aiguilles : anneaux dont la largeur moyenne (2·aire / périmètre) est sous 1e-5 de la taille du
 * trait. Ce sont des restes numériques de bords presque confondus, invisibles mais qui empêchent de recoller
 * les régions et laissent des liserés à l'anticrénelage. Un polygone dont le contour extérieur disparaît part
 * entier ; un trou-aiguille est simplement bouché.
 */
const THIN = 1e-5;
function ringWidth(r: Pt[]): number {
  let a = 0, per = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
    per += Math.hypot(r[i][0] - r[j][0], r[i][1] - r[j][1]);
  }
  return per > 0 ? Math.abs(a) / per : 0;
}
const clean = (m: Multi): Multi =>
  m.filter((p) => p.length && ringWidth(p[0]) >= THIN).map((p) => [p[0], ...p.slice(1).filter((r) => ringWidth(r) >= THIN)]);

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
    const shapes = comp.map((r) => local(f, r.shape));
    out.push(...splitRegions(seed.rgba, toWorld(f, op("union", shapes[0], ...shapes.slice(1))), seed.blend));
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
  const S = local(f, stroke);
  const opaqueNormal = mode === "normal" && src[3] * alpha >= 0.999;
  const out: Region[] = [];
  const fresh: Region[] = [];
  if (opaqueNormal) {
    // Trait couvrant : il remplace tout ce qu'il touche, d'un seul morceau (pas de découpage par région dessous).
    for (const r of regions) {
      if (!overlaps(r.bbox, sb)) { out.push(r); continue; }
      const rest = op("difference", local(f, r.shape), S);
      if (rest.length) out.push(...splitRegions(r.rgba, toWorld(f, rest), r.blend));
    }
    fresh.push(...splitRegions(quantize(src), toWorld(f, S)));
    return mergeSameColor(out, fresh, f);
  }
  // Sinon : on regroupe les régions sous le trait par couleur résultante, puis une seule intersection par
  // couleur ; les pièces voisines de même couleur naissent ainsi d'un même calcul.
  const groups = new Map<string, { rgba: Rgba; blend?: BlendMode; shapes: Multi[] }>();
  const under: Multi[] = [];
  for (const r of regions) {
    if (!overlaps(r.bbox, sb)) { out.push(r); continue; }
    const R = local(f, r.shape);
    if (!op("intersect", R, S).length) { out.push(r); continue; }
    under.push(R);
    const g = { rgba: composite(r.rgba, src, alpha, mode), blend: r.blend } as { rgba: Rgba; blend?: BlendMode };
    if (key(g) === key(r)) {
      // Le trait ne change pas cette couleur (noir sous multiply, même teinte…) : la région reste entière, sans
      // être découpée puis recollée ; les pièces neuves de même couleur s'y uniront.
      out.push(r);
      continue;
    }
    const rest = op("difference", R, S);
    if (rest.length) out.push(...splitRegions(r.rgba, toWorld(f, rest), r.blend));
    const k = key(g);
    const e = groups.get(k);
    if (e) e.shapes.push(R);
    else groups.set(k, { ...g, shapes: [R] });
  }
  for (const g of groups.values()) {
    const inter = op("intersect", S, g.shapes.length === 1 ? g.shapes[0] : op("union", g.shapes[0], ...g.shapes.slice(1)));
    if (inter.length) fresh.push(...splitRegions(g.rgba, toWorld(f, inter), g.blend));
  }
  const outside = under.length ? op("difference", S, ...under) : S;
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
  const E = local(f, eraser);
  const out: Region[] = [];
  for (const r of regions) {
    if (!overlaps(r.bbox, eb)) { out.push(r); continue; }
    const rest = op("difference", local(f, r.shape), E);
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

/**
 * Recolore des régions de la carte (`targets`, par référence) : elles prennent la vraie couleur `rgba` (mode de
 * fusion retiré), puis se ressoudent à leurs voisines de même couleur. Renvoie la nouvelle carte et les régions
 * issues des cibles (pour garder la sélection) ; les régions non touchées gardent leur identité.
 */
export function recolorFlat(regions: Region[], targets: Set<Region>, rgba: Rgba): { regions: Region[]; fresh: Region[] } {
  const hit = regions.filter((r) => targets.has(r));
  if (!hit.length) return { regions, fresh: [] };
  const c = quantize(rgba);
  const f = frameOf(flatBBox(hit));
  const recolored = hit.map((r) => region(c, r.shape));
  const rest = regions.filter((r) => !targets.has(r));
  const out = mergeSameColor(rest, recolored, f);
  const kept = new Set(rest);
  return { regions: out, fresh: out.filter((r) => !kept.has(r)) };
}

/** Retire des régions de la carte (par référence). */
export function deleteFlat(regions: Region[], targets: Set<Region>): Region[] {
  return regions.filter((r) => !targets.has(r));
}

/* ------------------------------------------------------------ retouches de la sélection */

/** Retouches d'une sélection de régions : simplifier, étendre (ou réduire), adoucir, entourer. */
export type FlatEdit = "simplify" | "grow" | "smooth" | "outline";
export const FLAT_EDITS: readonly FlatEdit[] = ["simplify", "grow", "smooth", "outline"];

export type FlatEditOptions = {
  /**
   * Ampleur en unités du monde : tolérance (simplify), décalage signé (grow : négatif = réduire), rayon
   * d'arrondi (smooth), épaisseur de chaque anneau (outline).
   */
  amount: number;
  /** outline : couleur de chaque anneau, de l'intérieur vers l'extérieur (au moins une). */
  colors?: Rgba[];
};

/** Décalage dans le repère local, borné en nombre de segments par disque selon la taille des contours. */
const offsetLocal = (m: Multi, d: number): Multi => (d === 0 || !m.length ? m : clean(snap(offset(m, d, 12), GRID)));

/** Arrondi morphologique : fermeture (bouche les creux) puis ouverture (émousse les pointes) de rayon `r`. */
function smoothShape(m: Multi, r: number): Multi {
  const pre = simplifyMulti(m, r * 0.15);
  const closed = offsetLocal(offsetLocal(pre, r), -r);
  const opened = offsetLocal(offsetLocal(closed, -r), r);
  const out = opened.length ? opened : closed;
  return clean(snap(simplifyMulti(out, r * 0.02), GRID));
}

/**
 * Pose des formes couvrantes sur la carte (ordre donné, chacune par-dessus la précédente) : comme un trait
 * plein opaque, elles remplacent ce qu'elles touchent ; les régions de même couleur qui se touchent sont unies.
 */
function layOver(rest: Region[], pieces: { rgba: Rgba; blend?: BlendMode; shape: Multi }[], f: Frame): { regions: Region[]; fresh: Region[] } {
  let out = rest;
  let fresh = new Set<Region>();
  for (const p of pieces) {
    if (!p.shape.length) continue;
    const pb = multiBBox(toWorld(f, p.shape));
    const next: Region[] = [];
    const nextFresh = new Set<Region>();
    for (const r of out) {
      const wasFresh = fresh.has(r);
      if (!overlaps(r.bbox, pb)) { next.push(r); if (wasFresh) nextFresh.add(r); continue; }
      const left = op("difference", local(f, r.shape), p.shape);
      if (!left.length) continue;
      const parts = splitRegions(r.rgba, toWorld(f, left), r.blend);
      next.push(...parts);
      if (wasFresh) for (const q of parts) nextFresh.add(q);
    }
    const laid = splitRegions(quantize(p.rgba), toWorld(f, p.shape), p.blend);
    for (const q of laid) nextFresh.add(q);
    out = [...next, ...laid];
    fresh = nextFresh;
  }
  return { regions: out, fresh: out.filter((r) => fresh.has(r)) };
}

/**
 * Retouche les régions `targets` (par référence) d'une carte : `simplify` (Ramer–Douglas–Peucker), `grow`
 * (décalage à joints ronds ; négatif = réduire, la place libérée devient vide), `smooth` (arrondi des creux et
 * des pointes), `outline` (anneaux concentriques autour de l'union des cibles, une couleur par anneau). Les formes
 * obtenues passent par-dessus leurs voisines, qu'elles découpent. Renvoie la nouvelle carte et les régions issues
 * de l'opération (cibles retouchées et anneaux), pour garder la sélection. Lève une erreur si le calcul échoue.
 */
export function editFlat(regions: Region[], targets: Set<Region>, edit: FlatEdit, o: FlatEditOptions): { regions: Region[]; fresh: Region[] } {
  const hit = regions.filter((r) => targets.has(r));
  const amount = Number(o.amount);
  if (!hit.length || !Number.isFinite(amount) || amount === 0) return { regions, fresh: hit };
  const box = flatBBox(hit);
  const reach = Math.abs(amount) * ((o.colors?.length ?? 1) + 1);
  const f = frameOf({ x: box.x - reach, y: box.y - reach, w: box.w + 2 * reach, h: box.h + 2 * reach });
  const d = amount / f.k;
  const rest = regions.filter((r) => !targets.has(r));
  if (edit === "outline") {
    const colors = (o.colors?.length ? o.colors : [[0, 0, 0, 1] as Rgba]).slice(0, 8);
    const shapes = hit.map((r) => local(f, r.shape));
    const core = shapes.length === 1 ? shapes[0] : op("union", shapes[0], ...shapes.slice(1));
    const w = Math.abs(d);
    let inner = core;
    const rings: { rgba: Rgba; shape: Multi }[] = [];
    for (const c of colors) {
      const outer = offsetLocal(inner, w);
      rings.push({ rgba: c, shape: op("difference", outer, inner) });
      inner = outer;
    }
    // Les cibles restent intactes (les anneaux ne les touchent pas) ; les anneaux recouvrent le reste.
    const laid = finishEdit(layOver(rest, rings, f), f);
    return { regions: [...laid.regions, ...hit], fresh: [...hit, ...laid.fresh] };
  }
  const pieces = hit.map((r) => {
    const L = local(f, r.shape);
    const shape = edit === "simplify" ? clean(snap(simplifyMulti(L, Math.abs(d)), GRID))
      : edit === "grow" ? offsetLocal(L, d)
      : smoothShape(L, Math.abs(d));
    return { rgba: r.rgba, blend: r.blend, shape };
  });
  return finishEdit(layOver(rest, pieces, f), f);
}

/** Ressoude les pièces retouchées à leurs voisines de même couleur ; la sélection suit les régions obtenues. */
function finishEdit(laid: { regions: Region[]; fresh: Region[] }, f: Frame): { regions: Region[]; fresh: Region[] } {
  const isFresh = new Set(laid.fresh);
  const before = laid.regions.filter((r) => !isFresh.has(r));
  const out = mergeSameColor(before, laid.fresh, f);
  const kept = new Set(before);
  return { regions: out, fresh: out.filter((r) => !kept.has(r)) };
}

/**
 * Recolore plusieurs régions à la fois (`next` : nouvelle couleur par région ciblée), puis ressoude chaque
 * région à ses voisines de même couleur. Renvoie la carte et les régions issues des cibles.
 */
export function recolorManyFlat(regions: Region[], next: Map<Region, Rgba>): { regions: Region[]; fresh: Region[] } {
  const hit = regions.filter((r) => next.has(r));
  if (!hit.length) return { regions, fresh: [] };
  const f = frameOf(flatBBox(hit));
  const recolored = hit.map((r) => region(quantize(next.get(r)!), r.shape, r.blend));
  const rest = regions.filter((r) => !next.has(r));
  const out = mergeSameColor(rest, recolored, f);
  const kept = new Set(rest);
  return { regions: out, fresh: out.filter((r) => !kept.has(r)) };
}
