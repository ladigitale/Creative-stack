/**
 * Ordre des parcours : moins de trajet à vide.
 *
 * - Contours : les intérieurs d'abord (une pièce découpée ne bouge plus quand on en découpe l'intérieur), puis au plus
 *   proche ; un contour fermé commence au sommet le plus proche de la tête ; un trait ouvert se prend par le bout le
 *   plus proche ; une passe 2-opt (budget de temps) défait les croisements de l'ordre glouton.
 * - Hachures : par îles (forme et ses trous), chaque île en serpentin, les îles enchaînées au plus proche (une île peut
 *   être parcourue à l'envers).
 */
import { inRing, type Pt, type Ring } from "../vector";

export type OrderPath = { pts: Pt[]; closed: boolean };

const MAX_DEPTH_PATHS = 8000;
const MAX_ORDER = 12000;

const d2 = (a: Pt, b: Pt): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const dist = (a: Pt, b: Pt): number => Math.sqrt(d2(a, b));

type Box = { x0: number; y0: number; x1: number; y1: number };
function boxOf(pts: Pt[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return { x0, y0, x1, y1 };
}
const boxIn = (a: Box, b: Box): boolean => a.x0 >= b.x0 && a.x1 <= b.x1 && a.y0 >= b.y0 && a.y1 <= b.y1;
/** Distance minimale (au carré) d'un point à une boîte : borne basse de la distance aux sommets du tracé. */
function boxD2(p: Pt, b: Box): number {
  const dx = p[0] < b.x0 ? b.x0 - p[0] : p[0] > b.x1 ? p[0] - b.x1 : 0;
  const dy = p[1] < b.y0 ? b.y0 - p[1] : p[1] > b.y1 ? p[1] - b.y1 : 0;
  return dx * dx + dy * dy;
}

/** Trajet à vide d'une suite de tracés, depuis `from` (fermé : on revient au point de départ). */
export function travelOf(paths: OrderPath[], from: Pt = [0, 0]): number {
  let at = from, total = 0;
  for (const p of paths) {
    if (!p.pts.length) continue;
    total += dist(at, p.pts[0]);
    at = p.closed ? p.pts[0] : p.pts[p.pts.length - 1];
  }
  return total;
}

/** Profondeur d'imbrication de chaque tracé (nombre de contours fermés qui contiennent son premier point). */
function depths(paths: OrderPath[], boxes: Box[]): number[] {
  const closed: number[] = [];
  paths.forEach((p, i) => { if (p.closed && p.pts.length >= 3) closed.push(i); });
  return paths.map((p, i) => {
    let n = 0;
    for (const j of closed) if (j !== i && boxIn(boxes[i], boxes[j]) && inRing(p.pts[0], paths[j].pts)) n++;
    return n;
  });
}

/** Commence un contour fermé au sommet `k`. */
function rotate(pts: Pt[], k: number): Pt[] {
  return k <= 0 ? pts : [...pts.slice(k), ...pts.slice(0, k)];
}

/** Glouton au plus proche dans un groupe, depuis `at`. Retourne les tracés orientés et le point d'arrivée. */
function greedy(group: OrderPath[], boxes: Box[], at: Pt): { out: OrderPath[]; at: Pt } {
  const left = group.map((p, i) => i);
  const out: OrderPath[] = [];
  while (left.length) {
    let best = -1, bestD = Infinity, bestK = 0, reverse = false;
    // Bornes basses par les boîtes : on ne calcule exactement que les candidats qui peuvent battre le meilleur.
    const order = left.map((i, n) => ({ n, lb: boxD2(at, boxes[i]) })).sort((a, b) => a.lb - b.lb);
    for (const { n, lb } of order) {
      if (lb >= bestD) break;
      const p = group[left[n]];
      if (p.closed) {
        for (let k = 0; k < p.pts.length; k++) {
          const d = d2(at, p.pts[k]);
          if (d < bestD) { bestD = d; best = n; bestK = k; reverse = false; }
        }
      } else {
        const s = d2(at, p.pts[0]), e = d2(at, p.pts[p.pts.length - 1]);
        if (s < bestD) { bestD = s; best = n; bestK = 0; reverse = false; }
        if (e < bestD) { bestD = e; best = n; bestK = 0; reverse = true; }
      }
    }
    const [idx] = left.splice(best, 1);
    const p = group[idx];
    const next: OrderPath = p.closed ? (bestK === 0 ? p : { pts: rotate(p.pts, bestK), closed: true }) : reverse ? { pts: [...p.pts].reverse(), closed: false } : p;
    out.push(next);
    at = next.closed ? next.pts[0] : next.pts[next.pts.length - 1];
  }
  return { out, at };
}

/**
 * 2-opt sur une suite : inverser le morceau i..j quand cela raccourcit les deux liaisons qui le bordent.
 * Un tracé ouvert inversé est parcouru à l'envers ; un contour fermé garde son point d'entrée.
 */
function twoOpt(seq: OrderPath[], from: Pt, budgetMs: number): OrderPath[] {
  const n = seq.length;
  if (n < 3) return seq;
  const s = seq.slice();
  const entry = (p: OrderPath): Pt => p.pts[0];
  const exit = (p: OrderPath): Pt => (p.closed ? p.pts[0] : p.pts[p.pts.length - 1]);
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      if (now() - t0 > budgetMs) return s;
      const before = i === 0 ? from : exit(s[i - 1]);
      for (let j = i + 1; j < n; j++) {
        const after = j + 1 < n ? entry(s[j + 1]) : null;
        const old = dist(before, entry(s[i])) + (after ? dist(exit(s[j]), after) : 0);
        // Après inversion : on entre par la sortie de s[j] et on sort par l'entrée de s[i].
        const neu = dist(before, exit(s[j])) + (after ? dist(entry(s[i]), after) : 0);
        if (neu < old - 1e-9) {
          const mid = s.slice(i, j + 1).reverse().map((p) => (p.closed ? p : { pts: [...p.pts].reverse(), closed: false }));
          s.splice(i, j - i + 1, ...mid);
          improved = true;
        }
      }
    }
  }
  return s;
}

/**
 * Ordonne des contours et traits : intérieurs d'abord, puis au plus proche, 2-opt dans chaque niveau.
 * `from` : position de la tête au départ. Au-delà de `MAX_ORDER` tracés, seul le glouton par niveaux s'applique.
 */
export function orderPaths(paths: OrderPath[], from: Pt = [0, 0], budgetMs = 120): OrderPath[] {
  if (paths.length < 2) return paths;
  if (paths.length > MAX_ORDER) return paths;
  const boxes = paths.map((p) => boxOf(p.pts));
  const depth = paths.length <= MAX_DEPTH_PATHS ? depths(paths, boxes) : paths.map(() => 0);
  const levels = [...new Set(depth)].sort((a, b) => b - a);
  const out: OrderPath[] = [];
  let at = from;
  const share = budgetMs / Math.max(1, levels.length);
  for (const lv of levels) {
    const idx = paths.map((_, i) => i).filter((i) => depth[i] === lv);
    const g = greedy(idx.map((i) => paths[i]), idx.map((i) => boxes[i]), at);
    const seq = twoOpt(g.out, at, share);
    out.push(...seq);
    const last = seq[seq.length - 1];
    at = last.closed ? last.pts[0] : last.pts[last.pts.length - 1];
  }
  return out;
}

/**
 * Regroupe des contours (règle pair-impair) en îles : un contour extérieur et ses trous directs. Une forme posée dans
 * un trou forme sa propre île. Au-delà de `MAX_DEPTH_PATHS` contours : une seule île.
 */
export function islands(rings: Ring[]): Ring[][] {
  const rs = rings.filter((r) => r.length >= 3);
  if (rs.length <= 1 || rs.length > MAX_DEPTH_PATHS) return rs.length ? [rs] : [];
  const boxes = rs.map(boxOf);
  const area = (b: Box): number => (b.x1 - b.x0) * (b.y1 - b.y0);
  const parents: number[][] = rs.map((r, i) => {
    const out: number[] = [];
    rs.forEach((c, j) => { if (j !== i && boxIn(boxes[i], boxes[j]) && inRing(r[0], c)) out.push(j); });
    return out;
  });
  const depth = parents.map((p) => p.length);
  const groups = new Map<number, Ring[]>();
  rs.forEach((r, i) => { if (depth[i] % 2 === 0) groups.set(i, [r]); });
  rs.forEach((r, i) => {
    if (depth[i] % 2 === 0) return;
    // Trou : rattaché au plus petit contour extérieur qui le contient.
    const outer = parents[i].filter((j) => depth[j] === depth[i] - 1).sort((a, b) => area(boxes[a]) - area(boxes[b]))[0];
    if (outer !== undefined) groups.get(outer)?.push(r);
  });
  return [...groups.values()];
}

/**
 * Enchaîne des blocs (suites de segments déjà ordonnées, ex. le serpentin d'une île) au plus proche : chaque bloc est
 * pris par son début ou par sa fin (alors parcouru à l'envers).
 */
export function orderBlocks(blocks: OrderPath[][], from: Pt = [0, 0]): OrderPath[] {
  const bs = blocks.filter((b) => b.length);
  if (bs.length < 2 || bs.length > MAX_ORDER) return bs.flat();
  const start = (b: OrderPath[]): Pt => b[0].pts[0];
  const end = (b: OrderPath[]): Pt => { const l = b[b.length - 1]; return l.closed ? l.pts[0] : l.pts[l.pts.length - 1]; };
  const left = bs.map((_, i) => i);
  const out: OrderPath[] = [];
  let at = from;
  while (left.length) {
    let best = 0, bestD = Infinity, rev = false;
    for (let n = 0; n < left.length; n++) {
      const b = bs[left[n]];
      const s = d2(at, start(b)), e = d2(at, end(b));
      if (s < bestD) { bestD = s; best = n; rev = false; }
      if (e < bestD) { bestD = e; best = n; rev = true; }
    }
    const [i] = left.splice(best, 1);
    const b = rev ? bs[i].slice().reverse().map((p) => (p.closed ? p : { pts: [...p.pts].reverse(), closed: false })) : bs[i];
    out.push(...b);
    at = end(b);
  }
  return out;
}
