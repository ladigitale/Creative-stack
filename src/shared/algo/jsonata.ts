/**
 * Fonctions JSONata des algorithmes de jeu, pour les réducteurs de `sonic-store` et les expressions de
 * `sonic-jsonata`. Toutes pures : entrée JSON → sortie JSON neuve, hasard seulement par graine. Doc agent :
 * `src/addons/interactive/algo.md`.
 */
import type { Expression } from "jsonata";
import { fsmStep } from "./fsm";
import { cave, dungeon, maze, type MazeAlgo, poisson, roll, shuffleInPlace, weightedIndex } from "./gen";
import { graphPath, graphReach, topoSort } from "./graph";
import { type Cell, type CellValue, type Grid, cellOf, gridFromCodes, readCell, readCells, readGrid, readOptions, writeGrid } from "./grid";
import { type Hex, hexDistance, hexFromPixel, hexLine, hexNeighbors, hexRange, hexRing, hexToPixel } from "./hex";
import { angleDelta, angleLerp, approach, ease, lerp, remap, smoothDamp } from "./interp";
import { fall, findCells, flood, lifeStep, matches, parseRule, regions } from "./ops";
import { cachedField, distanceField, downhill, gridPath, MAX_VISITS, reach, smoothCells } from "./path";
import { Rng } from "./rng";
import { fov, line, sightClear } from "./sight";
import { fbm3, ridge2, warped2 } from "../noise";
import { type Board, mcts, minimax, movesOf, readBoard, winnerOf } from "./board";
import { delaunay, mst, triEdges, voronoiGrid } from "./voronoi";
import { wfc } from "./wfc";
import { contours } from "./contours";

type Opts = Record<string, unknown>;
const opts = (o: unknown): Opts => readOptions(o) as Opts;
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
const cells = (g: Grid, ks: number[]): Cell[] => ks.map((k) => cellOf(g, k));
const needCell = (p: unknown, what: string): Cell => {
  const c = readCell(p);
  if (!c) throw new Error(`${what} : case [x, y] attendue`);
  return c;
};
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const valueOf = (g: Grid, v: unknown): CellValue => (g.kind === "rows" ? String(v ?? "").slice(0, 1) || " " : typeof v === "number" ? v : String(v));

/** Lignes de texte depuis un masque 0/1. */
function rowsOf(mask: Uint8Array, w: number, h: number, on: string, off: string): string[] {
  const out: string[] = [];
  for (let y = 0; y < h; y++) {
    let s = "";
    for (let x = 0; x < w; x++) s += mask[y * w + x] ? on : off;
    out.push(s);
  }
  return out;
}

// ——— grilles ———

export function gridGet(grid: unknown, p: unknown, o?: unknown): CellValue | undefined {
  const g = readGrid(grid, o);
  const c = readCell(p);
  if (!c || c[0] < 0 || c[1] < 0 || c[0] >= g.w || c[1] >= g.h) return undefined;
  return g.values[g.code[c[1] * g.w + c[0]]];
}

export function gridSet(grid: unknown, p: unknown, value: unknown): unknown[] {
  const g = readGrid(grid);
  const changes = new Map<number, CellValue>();
  for (const c of readCells(p)) if (c[0] >= 0 && c[1] >= 0 && c[0] < g.w && c[1] < g.h) changes.set(c[1] * g.w + c[0], valueOf(g, value));
  return writeGrid(grid as unknown[], g, changes);
}

export function gridFind(grid: unknown, value: unknown): Cell[] {
  const g = readGrid(grid);
  return findCells(g, valueOf(g, value));
}

export function gridFlood(grid: unknown, p: unknown, o?: unknown): Cell[] {
  const g = readGrid(grid, o);
  const op = opts(o);
  return cells(g, flood(g, needCell(p, "$gridFlood"), { diag: !!op.diag, match: op.match === "walkable" ? "walkable" : "same", max: num(op.max, Infinity) }));
}

export function gridFill(grid: unknown, p: unknown, value: unknown, o?: unknown): unknown[] {
  const g = readGrid(grid, o);
  const op = opts(o);
  const v = valueOf(g, value);
  const ks = flood(g, needCell(p, "$gridFill"), { diag: !!op.diag, match: op.match === "walkable" ? "walkable" : "same", max: num(op.max, Infinity) });
  return writeGrid(grid as unknown[], g, new Map(ks.map((k) => [k, v])));
}

export function gridRegions(grid: unknown, o?: unknown) {
  const g = readGrid(grid, o);
  const op = opts(o);
  const values = op.values == null ? null : (Array.isArray(op.values) ? op.values : g.kind === "rows" ? [...String(op.values)] : [op.values]).map((v) => valueOf(g, v));
  const { labels, list } = regions(g, { diag: !!op.diag, values });
  const out = list.map((r) => ({ ...r }));
  if (op.cells) {
    const per: Cell[][] = out.map(() => []);
    for (let k = 0; k < labels.length; k++) if (labels[k] >= 0 && per[labels[k]].length < 4096) per[labels[k]].push(cellOf(g, k));
    out.forEach((r, i) => (r.cells = per[i]));
  }
  return out;
}

export function gridPathFn(grid: unknown, from: unknown, to: unknown, o?: unknown) {
  const g = readGrid(grid, o);
  const op = opts(o);
  const r = gridPath(g, needCell(from, "$gridPath"), readCells(to), Math.min(MAX_VISITS, num(op.maxVisits, MAX_VISITS)));
  const ks = r.found && op.smooth ? smoothCells(g, r.cells) : r.cells;
  return { found: r.found, path: cells(g, ks), cost: r.found ? round3(r.cost) : null, visited: r.visited };
}

export function gridDistance(grid: unknown, sources: unknown, o?: unknown): number[][] {
  const g = readGrid(grid, o);
  const f = distanceField(g, readCells(sources), num(opts(o).max, Infinity));
  const out: number[][] = [];
  for (let y = 0; y < g.h; y++) {
    const row: number[] = [];
    for (let x = 0; x < g.w; x++) {
      const d = f[y * g.w + x];
      row.push(d === Infinity ? -1 : round3(d));
    }
    out.push(row);
  }
  return out;
}

export function gridNext(grid: unknown, from: unknown, goals: unknown, o?: unknown): Cell {
  const g = readGrid(grid, o);
  const f = cachedField(g, readCells(goals));
  return downhill(g, f, needCell(from, "$gridNext"), !!opts(o).flee);
}

export function gridReach(grid: unknown, from: unknown, budget: unknown, o?: unknown) {
  const g = readGrid(grid, o);
  return reach(g, needCell(from, "$gridReach"), num(budget, 0));
}

export function gridLine(a: unknown, b: unknown): Cell[] {
  return line(needCell(a, "$gridLine"), needCell(b, "$gridLine"));
}

export function gridSight(grid: unknown, a: unknown, b: unknown, o?: unknown): boolean {
  const g = readGrid(grid, o);
  return sightClear(g, needCell(a, "$gridSight"), needCell(b, "$gridSight"), opts(o).walk ? "walk" : "see");
}

export function gridFov(grid: unknown, origin: unknown, radius: unknown, o?: unknown): Cell[] | string[] {
  const g = readGrid(grid, o);
  const op = opts(o);
  const seen = fov(g, needCell(origin, "$gridFov"), num(radius, 8));
  if (op.as === "mask") {
    const on = String(op.on ?? "1").slice(0, 1) || "1", off = String(op.off ?? "0").slice(0, 1) || "0";
    // `into` : masque précédent (zones déjà explorées), gardé
    if (Array.isArray(op.into)) {
      op.into.forEach((row, y) => {
        const s = String(row);
        for (let x = 0; x < Math.min(s.length, g.w) && y < g.h; x++) if (s[x] === on) seen[y * g.w + x] = 1;
      });
    }
    return rowsOf(seen, g.w, g.h, on, off);
  }
  const out: Cell[] = [];
  for (let k = 0; k < seen.length; k++) if (seen[k]) out.push(cellOf(g, k));
  return out;
}

export function gridMatches(grid: unknown, min: unknown, o?: unknown) {
  const g = readGrid(grid);
  const op = opts(o);
  const ignore = op.ignore == null ? [] : (Array.isArray(op.ignore) ? op.ignore : g.kind === "rows" ? [...String(op.ignore)] : [op.ignore]).map((v) => valueOf(g, v));
  return matches(g, num(min, 3), { diag: !!op.diag, ignore });
}

export function gridFall(grid: unknown, empty: unknown, dir?: unknown, o?: unknown): unknown[] {
  const g = readGrid(grid, o);
  const d = dir === "up" || dir === "left" || dir === "right" ? dir : "down";
  const code = fall(g, valueOf(g, empty), d);
  return code ? gridFromCodes(g, code) : (grid as unknown[]);
}

export function gridLife(grid: unknown, rule?: unknown, o?: unknown): unknown[] {
  const g = readGrid(grid);
  const op = opts(o);
  const alive = valueOf(g, op.alive ?? (g.kind === "rows" ? "#" : 1));
  const dead = valueOf(g, op.dead ?? (g.kind === "rows" ? "." : 0));
  const ac = g.values.indexOf(alive);
  let mask: Uint8Array = new Uint8Array(g.w * g.h);
  for (let k = 0; k < mask.length; k++) mask[k] = g.code[k] === ac ? 1 : 0;
  const r = parseRule(typeof rule === "string" && rule ? rule : "B3/S23");
  const steps = Math.max(1, Math.min(64, Math.floor(num(op.steps, 1))));
  for (let s = 0; s < steps; s++) mask = lifeStep(mask, g.w, g.h, r, !!op.wrap, op.edge === "alive");
  const values = [dead, alive];
  return gridFromCodes(g, mask, values);
}

/**
 * Contours lissés des cases « dedans » (`values`, défaut : les murs) en boucles fermées `{points, hole, depth, area}`,
 * en unités du monde (`scale` = taille d'une case). Avec `sprites: {prefix, fill, holeFill, stroke, line, layer, z}` :
 * liste prête pour `sonic-2d sprites` (polygones dans l'ordre d'emboîtement : `fill` pour les régions « dedans », `holeFill`
 * pour les trous). Avec `border: "fill"` (murs au-delà du bord), donner au fond la couleur des murs.
 */
export function gridContours(grid: unknown, o?: unknown) {
  const op = opts(o);
  const g = readGrid(grid, o);
  let test: (k: number) => boolean;
  if (op.values == null) test = (k) => g.cost[k] === Infinity;
  else {
    const vals = (Array.isArray(op.values) ? op.values : g.kind === "rows" ? [...String(op.values)] : [op.values]).map((v) => valueOf(g, v));
    const codes = new Set(vals.map((v) => g.values.indexOf(v)).filter((c) => c >= 0));
    test = (k) => codes.has(g.code[k]);
  }
  const off = Array.isArray(op.offset) ? [num(op.offset[0], 0), num(op.offset[1], 0)] as [number, number] : undefined;
  const list = contours(g, test, {
    border: op.border === "fill" ? "fill" : "empty",
    smooth: num(op.smooth, 2),
    scale: num(op.scale, 1),
    offset: off,
    minArea: num(op.minArea, 0),
  });
  const sp = op.sprites && typeof op.sprites === "object" ? (op.sprites as Opts) : null;
  if (!sp) return list;
  const prefix = String(sp.prefix ?? "paroi");
  return list.slice(0, 500).map((c, i) => {
    const s: Record<string, unknown> = { name: `${prefix}${i}`, shape: "polygon", x: 0, y: 0, points: c.points, fill: c.hole ? (sp.holeFill ?? "#0b1020") : (sp.fill ?? "#1e293b"), z: num(sp.z, 0) + c.depth };
    if (sp.stroke) s.stroke = sp.stroke;
    if (sp.line != null) s.line = sp.line;
    if (sp.layer) s.layer = sp.layer;
    return s;
  });
}

// ——— génération ———

function floorRows(mask: Uint8Array, w: number, h: number, o: Opts): string[] {
  return rowsOf(mask, w, h, String(o.floor ?? ".").slice(0, 1) || ".", String(o.wall ?? "#").slice(0, 1) || "#");
}

export function genMaze(w: unknown, h: unknown, seed: unknown, o?: unknown): string[] {
  const op = opts(o);
  const algo = (["backtracker", "prim", "kruskal", "wilson"].includes(String(op.algo)) ? op.algo : "backtracker") as MazeAlgo;
  const m = maze(w, h, new Rng(seed), algo);
  return floorRows(m.open, m.w, m.h, op);
}

export function genCave(w: unknown, h: unknown, seed: unknown, o?: unknown): string[] {
  const op = opts(o);
  const W = Math.max(1, Math.min(256, Math.floor(num(w, 1)))), H = Math.max(1, Math.min(256, Math.floor(num(h, 1))));
  const m = cave(W, H, new Rng(seed), num(op.fill, 0.45), num(op.steps, 4), typeof op.rule === "string" ? op.rule : undefined, op.keep !== "all");
  return floorRows(m, W, H, op);
}

export function genDungeon(w: unknown, h: unknown, seed: unknown, o?: unknown) {
  const op = opts(o);
  const d = dungeon(w, h, new Rng(seed), { min: num(op.min, 4), max: num(op.max, 10), depth: num(op.depth, 4) });
  return { rows: floorRows(d.floor, d.w, d.h, op), rooms: d.rooms };
}

export function genPoisson(w: unknown, h: unknown, r: unknown, seed: unknown, o?: unknown): [number, number][] {
  return poisson(w, h, r, new Rng(seed), num(opts(o).max, 2000));
}

/** Bruit cohérent ∈ [-1, 1] (ridge : [0, 1]). */
export function noiseAt(x: unknown, y: unknown, o?: unknown): number {
  const op = opts(o);
  const seed = new Rng(op.seed ?? 0).next() * 1000;
  const scale = num(op.scale, 1);
  const oct = Math.max(1, Math.min(8, Math.floor(num(op.octaves, 4))));
  const X = num(x, 0) * scale + seed, Y = num(y, 0) * scale - seed * 0.7;
  const v = op.kind === "ridge" ? ridge2(X, Y, oct) : op.kind === "warp" ? warped2(X, Y, num(op.warp, 0.8), oct) : fbm3(X, Y, seed * 0.37, oct);
  return round3(v);
}

/**
 * Carte de bruit `w × h` : matrice de nombres, ou lignes de texte avec `levels` = `[[seuil, "car"], …]` (le premier
 * seuil au-dessus de la valeur gagne ; le dernier sert de « sinon »).
 */
export function genNoise(w: unknown, h: unknown, o?: unknown): string[] | number[][] {
  const op = opts(o);
  const W = Math.max(1, Math.min(256, Math.floor(num(w, 1)))), H = Math.max(1, Math.min(256, Math.floor(num(h, 1))));
  const scale = num(op.scale, 0.1);
  const levels = Array.isArray(op.levels) ? (op.levels as unknown[]).filter(Array.isArray).map((l) => [num((l as unknown[])[0], Infinity), String((l as unknown[])[1] ?? "?").slice(0, 1)] as [number, string]) : null;
  const sub = { ...op, scale };
  const out: (string | number[])[] = [];
  for (let y = 0; y < H; y++) {
    if (levels) {
      let s = "";
      for (let x = 0; x < W; x++) {
        const v = noiseAt(x, y, sub);
        const l = levels.find(([t]) => v < t) ?? levels[levels.length - 1];
        s += l ? l[1] : "?";
      }
      out.push(s);
    } else {
      const row: number[] = [];
      for (let x = 0; x < W; x++) row.push(noiseAt(x, y, sub));
      out.push(row);
    }
  }
  return out as string[] | number[][];
}

export function genWfc(sample: unknown, w: unknown, h: unknown, seed: unknown, o?: unknown): string[] {
  if (!Array.isArray(sample) || !sample.length) throw new Error("$genWfc : exemple attendu (lignes de texte)");
  const op = opts(o);
  const W = Math.max(1, Math.min(128, Math.floor(num(w, 1)))), H = Math.max(1, Math.min(128, Math.floor(num(h, 1))));
  const fixed = Array.isArray(op.fixed) ? op.fixed.map(String) : undefined;
  const out = wfc(sample.map(String), W, H, new Rng(seed), { periodic: !!op.periodic, wrapSample: !!op.wrapSample, fixed, tries: num(op.tries, 8) });
  if (!out) throw new Error(fixed ? "$genWfc : cases imposées incompatibles avec l'exemple" : "$genWfc : pas de solution trouvée (autre graine, exemple plus riche)");
  return out;
}

export function genVoronoi(w: unknown, h: unknown, seed: unknown, o?: unknown) {
  const op = opts(o);
  const W = Math.max(1, Math.min(256, Math.floor(num(w, 1)))), H = Math.max(1, Math.min(256, Math.floor(num(h, 1))));
  const v = voronoiGrid(W, H, new Rng(seed), num(op.count, 8), num(op.relax, 0), op.metric === "manhattan" ? "manhattan" : "euclid");
  const chars = [...String(op.values ?? "abcdefghijklmnopqrstuvwxyz")];
  const rows: string[] = [];
  for (let y = 0; y < H; y++) {
    let s = "";
    for (let x = 0; x < W; x++) s += chars[v.label[y * W + x] % chars.length];
    rows.push(s);
  }
  return { rows, sites: v.sites };
}

function readPoints(p: unknown, what: string): [number, number][] {
  if (!Array.isArray(p)) throw new Error(`${what} : liste de points [x, y] attendue`);
  return p.map((q) => {
    const c = Array.isArray(q) ? q : [(q as { x?: unknown })?.x, (q as { y?: unknown })?.y];
    return [num(c[0], 0), num(c[1], 0)] as [number, number];
  });
}

export function delaunayFn(points: unknown) {
  const tris = delaunay(readPoints(points, "$delaunay"));
  return { triangles: tris, edges: triEdges(tris) };
}

/** Arbre couvrant minimal euclidien (sous-graphe de Delaunay) : `[[i, j, longueur]…]`. */
export function mstFn(points: unknown): [number, number, number][] {
  const pts = readPoints(points, "$mst");
  if (pts.length < 2) return [];
  const edges = pts.length === 2 ? [[0, 1] as [number, number]] : triEdges(delaunay(pts));
  // points alignés : pas de triangle, on les relie dans l'ordre le long de la droite
  let list = edges;
  if (!list.length) {
    const order = pts.map((_, i) => i).sort((p, q) => pts[p][0] - pts[q][0] || pts[p][1] - pts[q][1]);
    list = order.slice(1).map((i, k) => [order[k], i] as [number, number]);
  }
  const w = list.map(([a, b]) => [a, b, Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1])] as [number, number, number]);
  return mst(pts.length, w).map(([a, b, d]) => [a, b, round3(d)]);
}

// ——— plateaux (jeux d'alignement) ———

function boardOpts(o: Opts) {
  return { n: o.n == null ? undefined : num(o.n, 3), gravity: !!o.gravity, empty: typeof o.empty === "string" ? o.empty : undefined };
}

const cellXY = (b: Board, k: number): Cell => [k % b.w, Math.floor(k / b.w)];

/** Premier pion rencontré (pour lire un plateau sans connaître les joueurs). */
function firstStone(rows: unknown, o: Opts): string {
  const e = typeof o.empty === "string" ? o.empty.slice(0, 1) : ".";
  for (const r of Array.isArray(rows) ? rows : []) for (const c of String(r)) if (c !== e) return c;
  return "x";
}

export function boardWinner(rows: unknown, o?: unknown) {
  const op = opts(o);
  const b = readBoard(rows, firstStone(rows, op), undefined, boardOpts(op));
  const w = winnerOf(b);
  return { winner: w.who ? b.chars[w.who] : null, line: w.line.map((k) => cellXY(b, k)), draw: !w.who && !movesOf(b).length };
}

export function boardMoves(rows: unknown, o?: unknown): Cell[] {
  const op = opts(o);
  const b = readBoard(rows, firstStone(rows, op), undefined, boardOpts(op));
  if (winnerOf(b).who) return [];
  return movesOf(b).map((k) => cellXY(b, k));
}

/** Joue un pion : case `[x, y]`, ou colonne (nombre ou `[x, …]`) avec `gravity`. Coup interdit : plateau inchangé. */
export function boardPlay(rows: unknown, at: unknown, player: unknown, o?: unknown): unknown[] {
  const op = opts(o);
  const p = String(player ?? "x").slice(0, 1);
  const b = readBoard(rows, p, undefined, boardOpts(op));
  const x = Array.isArray(at) ? num(at[0], -1) : num(at, -1);
  let k = -1;
  if (b.gravity) {
    for (let y = b.h - 1; y >= 0; y--) if (x >= 0 && x < b.w && !b.cells[y * b.w + x]) {
      k = y * b.w + x;
      break;
    }
  } else {
    const c = readCell(at);
    if (c && c[0] >= 0 && c[1] >= 0 && c[0] < b.w && c[1] < b.h && !b.cells[c[1] * b.w + c[0]]) k = c[1] * b.w + c[0];
  }
  if (k < 0) return rows as unknown[];
  const g = readGrid(rows);
  return writeGrid(rows as unknown[], g, new Map([[k, p]]));
}

/**
 * Meilleur coup de `player` : `{move: [x, y], column, score, depth, nodes}` (null si la partie est finie).
 * `algo` : `minimax` (défaut, parfait sur un petit plateau) ou `mcts` ; `depth` borne la recherche (petite = IA facile),
 * `ms` le temps (40, 200 au plus), `iterations` et `seed` pour MCTS.
 */
export function boardBest(rows: unknown, player: unknown, o?: unknown) {
  const op = opts(o);
  const p = String(player ?? "x").slice(0, 1);
  const b = readBoard(rows, p, typeof op.opponent === "string" ? op.opponent : undefined, boardOpts(op));
  if (winnerOf(b).who) return null;
  const moves = movesOf(b);
  if (!moves.length) return null;
  const ms = Math.max(1, Math.min(200, num(op.ms, 40)));
  let r: { move: number; score: number; depth: number; nodes: number };
  if (op.algo === "mcts") {
    // gagner tout de suite, sinon parer : MCTS seul les rate parfois
    const cells = b.cells;
    let forced = -1;
    for (const who of [1, 2] as const) {
      for (const k of moves) {
        cells[k] = who;
        const w = winnerOf(b, cells).who === who;
        cells[k] = 0;
        if (w) {
          forced = k;
          break;
        }
      }
      if (forced >= 0) break;
    }
    r = forced >= 0 ? { move: forced, score: 1, depth: 1, nodes: 0 } : mcts(b, new Rng(op.seed ?? 1), Math.max(1, Math.min(100_000, num(op.iterations, 3000))), ms);
  } else r = minimax(b, Math.max(1, Math.min(20, num(op.depth, 12))), ms);
  if (r.move < 0) return null;
  const score = Math.abs(r.score) >= 1e8 ? (r.score > 0 ? "win" : "loss") : round3(r.score);
  return { move: cellXY(b, r.move), column: r.move % b.w, score, depth: r.depth, nodes: r.nodes };
}

// ——— hasard à graine ———

export function shuffled(list: unknown, seed: unknown) {
  const rng = new Rng(seed);
  const a = Array.isArray(list) ? list.slice() : [];
  shuffleInPlace(a, rng);
  return { value: a, seed: rng.seed };
}

/** Tirage pondéré : `weights` = liste de poids, ou nom du champ des éléments qui porte le poids. */
export function pick(list: unknown, seed: unknown, weights?: unknown) {
  const rng = new Rng(seed);
  const a = Array.isArray(list) ? list : [];
  if (!a.length) return { value: null, index: -1, seed: rng.seed };
  let i: number;
  if (Array.isArray(weights)) i = weightedIndex(a.map((_, j) => num(weights[j], 0)), rng);
  else if (typeof weights === "string") i = weightedIndex(a.map((x) => num((x as Record<string, unknown> | null)?.[weights], 0)), rng);
  else i = rng.int(a.length);
  return { value: i >= 0 ? a[i] : null, index: i, seed: rng.seed };
}

/** Sac de tirage : chaque élément sort une fois avant que le sac ne se remplisse (mélangé) à nouveau. */
export function bag(rest: unknown, items: unknown, seed: unknown) {
  const rng = new Rng(seed);
  let r = Array.isArray(rest) ? rest.slice() : [];
  if (!r.length) r = shuffleInPlace(Array.isArray(items) ? items.slice() : [], rng);
  const value = r.length ? r.shift() : null;
  return { value, bag: r, seed: rng.seed };
}

export function rollDice(notation: unknown, seed: unknown) {
  const rng = new Rng(seed);
  return { ...roll(String(notation ?? ""), rng), seed: rng.seed };
}

// ——— graphes, hexagones ———

const hex = (p: unknown, what: string): Hex => needCell(p, what);

export function registerAlgoHelpers(e: Expression): void {
  const r = (name: string, fn: (...a: never[]) => unknown) => e.registerFunction(name, fn as never);
  // grilles
  r("gridGet", gridGet);
  r("gridSet", gridSet);
  r("gridFind", gridFind);
  r("gridFlood", gridFlood);
  r("gridFill", gridFill);
  r("gridRegions", gridRegions);
  r("gridPath", gridPathFn);
  r("gridDistance", gridDistance);
  r("gridNext", gridNext);
  r("gridReach", gridReach);
  r("gridLine", gridLine);
  r("gridSight", gridSight);
  r("gridFov", gridFov);
  r("gridMatches", gridMatches);
  r("gridFall", gridFall);
  r("gridLife", gridLife);
  r("gridContours", gridContours);
  // génération
  r("genMaze", genMaze);
  r("genCave", genCave);
  r("genDungeon", genDungeon);
  r("genPoisson", genPoisson);
  r("genNoise", genNoise);
  r("noise", noiseAt);
  r("genWfc", genWfc);
  r("genVoronoi", genVoronoi);
  r("delaunay", delaunayFn);
  r("mst", mstFn);
  // plateaux
  r("boardWinner", boardWinner);
  r("boardMoves", boardMoves);
  r("boardPlay", boardPlay);
  r("boardBest", boardBest);
  // hasard à graine
  r("shuffled", shuffled);
  r("pick", pick);
  r("bag", bag);
  r("roll", rollDice);
  // interpolation
  r("lerp", (a: unknown, b: unknown, t: unknown) => lerp(num(a, 0), num(b, 0), num(t, 0)));
  r("remap", (v: unknown, a0: unknown, a1: unknown, b0: unknown, b1: unknown, c?: unknown) => remap(num(v, 0), num(a0, 0), num(a1, 1), num(b0, 0), num(b1, 1), !!c));
  r("ease", (name: unknown, t: unknown) => ease(String(name ?? "linear"), num(t, 0)));
  r("approach", (v: unknown, t: unknown, s: unknown) => approach(num(v, 0), num(t, 0), num(s, 0)));
  r("angleDelta", (a: unknown, b: unknown) => angleDelta(num(a, 0), num(b, 0)));
  r("angleLerp", (a: unknown, b: unknown, t: unknown) => angleLerp(num(a, 0), num(b, 0), num(t, 0)));
  r("damp", (c: unknown, t: unknown, v: unknown, st: unknown, dt: unknown, max?: unknown) => smoothDamp(num(c, 0), num(t, 0), num(v, 0), num(st, 0.2), num(dt, 1 / 60), num(max, Infinity)));
  // états
  r("fsm", fsmStep);
  // hexagones
  r("hexDistance", (a: unknown, b: unknown) => hexDistance(hex(a, "$hexDistance"), hex(b, "$hexDistance")));
  r("hexNeighbors", (h: unknown) => hexNeighbors(hex(h, "$hexNeighbors")));
  r("hexRing", (h: unknown, n: unknown) => hexRing(hex(h, "$hexRing"), num(n, 1)));
  r("hexRange", (h: unknown, n: unknown) => hexRange(hex(h, "$hexRange"), num(n, 1)));
  r("hexLine", (a: unknown, b: unknown) => hexLine(hex(a, "$hexLine"), hex(b, "$hexLine")));
  r("hexToPixel", (h: unknown, size: unknown, o?: unknown) => hexToPixel(hex(h, "$hexToPixel"), num(size, 1), o === "flat" ? "flat" : "pointy").map(round3));
  r("hexFromPixel", (p: unknown, size: unknown, o?: unknown) => {
    const a = Array.isArray(p) ? p : [0, 0];
    return hexFromPixel([num(a[0], 0), num(a[1], 0)], num(size, 1), o === "flat" ? "flat" : "pointy");
  });
  // graphes
  r("graphPath", graphPath);
  r("graphReach", (g: unknown, from: unknown, max: unknown) => graphReach(g, from, num(max, Infinity)));
  r("topoSort", topoSort);
}
