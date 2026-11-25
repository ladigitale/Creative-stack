/**
 * Chemins sur grille : A* (coûts par case, 4 ou 8 voisins, plusieurs cibles), cartes de distances (Dijkstra
 * multi-sources), portée de déplacement, pas suivant vers la cible la plus proche (champ de flux mis en cache),
 * lissage des chemins par ligne de vue.
 *
 * Le cœur `astarCells` ne connaît qu'une fonction de coût : la grille de navigation de procgen (`NavGrid`) s'en sert
 * avec ses propres obstacles.
 */
import { MinHeap } from "./heap";
import { type Cell, type Grid, cellOf, forNeighbors, inside } from "./grid";
import { sightClear } from "./sight";

export const MAX_VISITS = 65_536;

export interface AstarCore {
  w: number;
  h: number;
  /** Coût d'entrée de la case `k` (Infinity = mur). */
  cost: (k: number) => number;
  diag: boolean;
  cut: boolean;
  /** Coût minimal d'une case (heuristique admissible). */
  minCost: number;
}

export interface PathResult {
  found: boolean;
  /** Indices de cases, départ et arrivée compris. */
  cells: number[];
  cost: number;
  /** Cases fermées (mesure du travail). */
  visited: number;
}

const heap = new MinHeap(1024);
let gBuf = new Float64Array(0);
let cameBuf = new Int32Array(0);
let stampBuf = new Uint32Array(0);
let closedBuf = new Uint32Array(0);
let stamp = 0;

/** Tampons réutilisés d'un appel à l'autre (pas de remise à zéro : un numéro d'appel marque les cases touchées). */
function buffers(n: number) {
  if (gBuf.length < n) {
    gBuf = new Float64Array(n);
    cameBuf = new Int32Array(n);
    stampBuf = new Uint32Array(n);
    closedBuf = new Uint32Array(n);
    stamp = 0;
  }
  stamp = (stamp + 1) >>> 0;
  if (stamp === 0) {
    stampBuf.fill(0);
    closedBuf.fill(0);
    stamp = 1;
  }
}

/**
 * A* de `starts` vers la plus proche des `goals` (indices). Heuristique octile (8 voisins) ou Manhattan (4),
 * multipliée par `minCost`, minimum sur les cibles : chemin optimal garanti.
 */
export function astarCells(core: AstarCore, starts: number[], goals: number[], maxVisits = MAX_VISITS): PathResult {
  const { w, h, diag, cut } = core;
  const n = w * h;
  const none: PathResult = { found: false, cells: [], cost: Infinity, visited: 0 };
  if (!starts.length || !goals.length) return none;
  buffers(n);
  const g = gBuf, came = cameBuf, seen = stampBuf, closed = closedBuf, s = stamp;
  const gx = goals.map((k) => k % w), gy = goals.map((k) => (k - (k % w)) / w);
  const goalSet = new Set(goals);
  const m = core.minCost > 0 ? core.minCost : 1;
  const hOf = (k: number) => {
    const x = k % w, y = (k - x) / w;
    let best = Infinity;
    for (let i = 0; i < gx.length; i++) {
      const dx = Math.abs(x - gx[i]), dy = Math.abs(y - gy[i]);
      const d = diag ? dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy) : dx + dy;
      if (d < best) best = d;
    }
    return best * m;
  };
  heap.clear();
  for (const k of starts) {
    if (k < 0 || k >= n) continue;
    g[k] = 0;
    came[k] = -1;
    seen[k] = s;
    heap.push(k, hOf(k));
  }
  let visited = 0;
  let end = -1;
  while (heap.size && visited < maxVisits) {
    const k = heap.pop();
    if (closed[k] === s) continue;
    closed[k] = s;
    visited++;
    if (goalSet.has(k)) {
      end = k;
      break;
    }
    const x = k % w, y = (k - x) / w;
    const gk = g[k];
    const dirs = diag ? 8 : 4;
    for (let d = 0; d < dirs; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nk = ny * w + nx;
      if (closed[nk] === s) continue;
      let c = core.cost(nk);
      if (c === Infinity) continue;
      if (d >= 4) {
        if (!cut && (core.cost(y * w + nx) === Infinity || core.cost(ny * w + x) === Infinity)) continue;
        c *= Math.SQRT2;
      }
      const ng = gk + c;
      if (seen[nk] !== s || ng < g[nk]) {
        seen[nk] = s;
        g[nk] = ng;
        came[nk] = k;
        // départage vers la cible (léger biais sur h) : moins de cases ouvertes à coût égal
        heap.push(nk, ng + hOf(nk) * 1.0000001);
      }
    }
  }
  if (end < 0) return { ...none, visited };
  const cells: number[] = [];
  for (let k = end; k >= 0; k = came[k]) cells.push(k);
  cells.reverse();
  return { found: true, cells, cost: g[end], visited };
}

const DX = [1, 0, -1, 0, 1, -1, -1, 1];
const DY = [0, 1, 0, -1, 1, 1, -1, -1];

export function coreOf(grid: Grid): AstarCore {
  const cost = grid.cost;
  return { w: grid.w, h: grid.h, cost: (k) => cost[k], diag: grid.diag, cut: grid.cut, minCost: grid.minCost };
}

function toIndex(grid: Grid, c: Cell): number {
  return inside(grid, c[0], c[1]) ? c[1] * grid.w + c[0] : -1;
}

/** A* sur une grille lue : `from` → la plus proche des `to`. */
export function gridPath(grid: Grid, from: Cell, to: Cell[], maxVisits = MAX_VISITS): PathResult {
  const s = toIndex(grid, from);
  const goals = to.map((c) => toIndex(grid, c)).filter((k) => k >= 0 && grid.cost[k] !== Infinity);
  if (s < 0) return { found: false, cells: [], cost: Infinity, visited: 0 };
  return astarCells(coreOf(grid), [s], goals, maxVisits);
}

/** Garde seulement les cases où la ligne de vue (franchissable) se rompt. */
export function smoothCells(grid: Grid, cells: number[]): number[] {
  if (cells.length < 3) return cells.slice();
  const out = [cells[0]];
  let anchor = cells[0];
  for (let i = 2; i < cells.length; i++) {
    if (!sightClear(grid, cellOf(grid, anchor), cellOf(grid, cells[i]), "walk")) {
      anchor = cells[i - 1];
      out.push(anchor);
    }
  }
  out.push(cells[cells.length - 1]);
  return out;
}

/**
 * Carte de distances (Dijkstra) depuis plusieurs sources : coût cumulé pour atteindre chaque case depuis la source la
 * plus proche, Infinity si inatteignable ou au-delà de `max`.
 */
export function distanceField(grid: Grid, sources: Cell[], max = Infinity): Float64Array {
  const n = grid.w * grid.h;
  const dist = new Float64Array(n).fill(Infinity);
  const hp = new MinHeap(256);
  for (const c of sources) {
    const k = toIndex(grid, c);
    if (k < 0 || grid.cost[k] === Infinity) continue;
    dist[k] = 0;
    hp.push(k, 0);
  }
  while (hp.size) {
    const p = hp.peekPriority();
    const k = hp.pop();
    if (p > dist[k]) continue;
    forNeighbors(grid, k, (nk, step) => {
      const nd = p + step;
      if (nd <= max && nd < dist[nk]) {
        dist[nk] = nd;
        hp.push(nk, nd);
      }
    });
  }
  return dist;
}

const fieldCache = new Map<string, Float64Array>();
const FIELD_CACHE_MAX = 8;

/** Carte de distances mise en cache (grille + cibles) : un champ de flux partagé par toutes les unités. */
export function cachedField(grid: Grid, goals: Cell[]): Float64Array {
  const key = `${grid.key}|${goals.map((c) => c.join(",")).join(";")}`;
  let f = fieldCache.get(key);
  if (f) {
    fieldCache.delete(key);
    fieldCache.set(key, f);
    return f;
  }
  f = distanceField(grid, goals);
  fieldCache.set(key, f);
  if (fieldCache.size > FIELD_CACHE_MAX) fieldCache.delete(fieldCache.keys().next().value as string);
  return f;
}

/**
 * Case suivante pour descendre le champ (vers la cible la plus proche) ; `flee` : remonter (s'éloigner). Rend la case
 * elle-même si elle est à destination ou sans issue.
 */
export function downhill(grid: Grid, field: Float64Array, from: Cell, flee = false): Cell {
  const k = toIndex(grid, from);
  if (k < 0 || !Number.isFinite(field[k])) return from;
  if (!flee && field[k] === 0) return from;
  let best = k;
  let bestS = flee ? -field[k] : field[k];
  let bestStep = Infinity;
  forNeighbors(grid, k, (nk, step) => {
    const v = field[nk];
    if (!Number.isFinite(v)) return;
    const sc = flee ? -v : v;
    // à score égal, le pas le moins cher (orthogonal) gagne
    if (sc < bestS - 1e-9 || (best !== k && Math.abs(sc - bestS) <= 1e-9 && step < bestStep)) {
      best = nk;
      bestS = sc;
      bestStep = step;
    }
  });
  return cellOf(grid, best);
}

/** Cases atteignables avec un budget de déplacement (portée d'une unité) : `[x, y, coût]`. */
export function reach(grid: Grid, from: Cell, budget: number): [number, number, number][] {
  const f = distanceField(grid, [from], budget);
  const out: [number, number, number][] = [];
  for (let k = 0; k < f.length; k++) if (f[k] !== Infinity) {
    const [x, y] = cellOf(grid, k);
    out.push([x, y, Math.round(f[k] * 1000) / 1000]);
  }
  return out;
}
