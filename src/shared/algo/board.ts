/**
 * IA de plateau pour les jeux d'alignement à deux (morpion, puissance 4 avec `gravity`, gomoku) : vainqueur, coups
 * permis, coup joué, meilleur coup par minimax (négamax, élagage alpha-bêta, approfondissement itératif borné en
 * temps, table de transposition) ou par Monte-Carlo Tree Search (UCT, parties aléatoires à graine).
 */
import { Rng } from "./rng";

export interface BoardOptions {
  /** Longueur d'alignement gagnante. */
  n?: number;
  /** Les pions tombent en bas de la colonne (puissance 4). */
  gravity?: boolean;
  empty?: string;
}

export interface Board {
  w: number;
  h: number;
  cells: Int8Array; // 0 vide, 1 / 2 joueurs
  chars: [string, string, string];
  n: number;
  gravity: boolean;
  windows: Int32Array[]; // toutes les fenêtres de n cases alignées
}

const DIRS: [number, number][] = [[1, 0], [0, 1], [1, 1], [1, -1]];

export function readBoard(rows: unknown, player: string, opponent: string | undefined, o: BoardOptions = {}): Board {
  if (!Array.isArray(rows) || !rows.length) throw new Error("plateau : lignes de texte attendues");
  const lines = rows.map((r) => [...String(r)]);
  const h = lines.length, w = Math.max(...lines.map((l) => l.length));
  if (w * h > 400) throw new Error("plateau : 400 cases au plus (20 × 20)");
  const empty = (o.empty ?? ".").slice(0, 1) || ".";
  const p = String(player).slice(0, 1);
  let q = opponent ? String(opponent).slice(0, 1) : "";
  if (!q) for (const l of lines) for (const c of l) if (!q && c !== empty && c !== p) q = c;
  if (!q) q = p === "o" ? "x" : "o";
  const cells = new Int8Array(w * h);
  lines.forEach((l, y) => {
    for (let x = 0; x < w; x++) {
      const c = l[x] ?? empty;
      cells[y * w + x] = c === p ? 1 : c === q ? 2 : 0;
    }
  });
  const n = Math.max(2, Math.min(Math.max(w, h), Math.floor(o.n ?? (Math.max(w, h) <= 4 ? 3 : Math.max(w, h) >= 9 ? 5 : 4))));
  const windows: Int32Array[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (const [dx, dy] of DIRS) {
        const ex = x + dx * (n - 1), ey = y + dy * (n - 1);
        if (ex < 0 || ey < 0 || ex >= w || ey >= h) continue;
        const win = new Int32Array(n);
        for (let i = 0; i < n; i++) win[i] = (y + dy * i) * w + x + dx * i;
        windows.push(win);
      }
  return { w, h, cells, chars: [empty, p, q], n, gravity: !!o.gravity, windows };
}

/** 1 ou 2 si un joueur a aligné `n` pions, sinon 0 ; `line` : les cases gagnantes. */
export function winnerOf(b: Board, cells = b.cells): { who: 0 | 1 | 2; line: number[] } {
  for (const win of b.windows) {
    const first = cells[win[0]];
    if (!first) continue;
    let all = true;
    for (let i = 1; i < win.length; i++) if (cells[win[i]] !== first) {
      all = false;
      break;
    }
    if (all) return { who: first as 1 | 2, line: Array.from(win) };
  }
  return { who: 0, line: [] };
}

/** Le dernier coup (case k) gagne-t-il ? Vérifie seulement les lignes qui passent par k. */
function winsAt(b: Board, cells: Int8Array, k: number): boolean {
  const who = cells[k];
  const x = k % b.w, y = (k - x) / b.w;
  for (const [dx, dy] of DIRS) {
    let c = 1;
    for (let s = 1; s < b.n; s++) {
      const nx = x + dx * s, ny = y + dy * s;
      if (nx < 0 || ny < 0 || nx >= b.w || ny >= b.h || cells[ny * b.w + nx] !== who) break;
      c++;
    }
    for (let s = 1; s < b.n; s++) {
      const nx = x - dx * s, ny = y - dy * s;
      if (nx < 0 || ny < 0 || nx >= b.w || ny >= b.h || cells[ny * b.w + nx] !== who) break;
      c++;
    }
    if (c >= b.n) return true;
  }
  return false;
}

/** Coups permis (indices de cases). Grand plateau sans gravité : cases à 2 pas d'un pion (ou le centre). */
export function movesOf(b: Board, cells = b.cells): number[] {
  const out: number[] = [];
  if (b.gravity) {
    for (let x = 0; x < b.w; x++)
      for (let y = b.h - 1; y >= 0; y--)
        if (!cells[y * b.w + x]) {
          out.push(y * b.w + x);
          break;
        }
  } else if (b.w * b.h <= 25) {
    for (let k = 0; k < cells.length; k++) if (!cells[k]) out.push(k);
  } else {
    let any = false;
    for (let k = 0; k < cells.length; k++) {
      if (cells[k]) {
        any = true;
        continue;
      }
      const x = k % b.w, y = (k - x) / b.w;
      let near = false;
      for (let j = Math.max(0, y - 2); j <= Math.min(b.h - 1, y + 2) && !near; j++)
        for (let i = Math.max(0, x - 2); i <= Math.min(b.w - 1, x + 2); i++) if (cells[j * b.w + i]) {
          near = true;
          break;
        }
      if (near) out.push(k);
    }
    if (!any) out.push(Math.floor(b.h / 2) * b.w + Math.floor(b.w / 2));
  }
  // centre d'abord : meilleur élagage
  const cx = (b.w - 1) / 2, cy = (b.h - 1) / 2;
  return out.sort((p, q) => Math.hypot((p % b.w) - cx, Math.floor(p / b.w) - cy) - Math.hypot((q % b.w) - cx, Math.floor(q / b.w) - cy));
}

/** Évaluation pour le joueur `me` : fenêtres ouvertes pondérées par le nombre de pions. */
function evaluate(b: Board, cells: Int8Array, me: 1 | 2): number {
  let s = 0;
  const base = 8;
  for (const win of b.windows) {
    let a = 0, o = 0;
    for (let i = 0; i < win.length; i++) {
      const c = cells[win[i]];
      if (c === me) a++;
      else if (c) o++;
    }
    if (a && !o) s += base ** a;
    else if (o && !a) s -= base ** o * 1.2;
  }
  return s;
}

const WIN = 1e9;

export interface Best {
  move: number;
  score: number;
  depth: number;
  nodes: number;
}

/** Meilleur coup du joueur 1 (celui qui joue) par négamax alpha-bêta, profondeur croissante jusqu'au budget. */
export function minimax(b: Board, maxDepth = 12, budgetMs = 40): Best {
  const cells = b.cells.slice();
  const t0 = performance.now();
  let nodes = 0;
  let stop = false;
  const tt = new Map<string, { d: number; v: number }>();
  const neg = (me: 1 | 2, depth: number, alpha: number, beta: number, ply: number): number => {
    if ((++nodes & 63) === 0 && performance.now() - t0 > budgetMs) stop = true;
    if (stop) return 0;
    const moves = movesOf(b, cells);
    if (!moves.length) return 0;
    if (depth === 0) return evaluate(b, cells, me);
    const key = depth > 2 ? cells.join("") + me : "";
    if (key) {
      const hit = tt.get(key);
      if (hit && hit.d >= depth) return hit.v;
    }
    let best = -Infinity;
    for (const k of moves) {
      cells[k] = me;
      const v = winsAt(b, cells, k) ? WIN - ply : -neg((3 - me) as 1 | 2, depth - 1, -beta, -alpha, ply + 1);
      cells[k] = 0;
      if (stop) return 0;
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    if (key && tt.size < 200_000) tt.set(key, { d: depth, v: best });
    return best;
  };
  const root = movesOf(b, cells);
  if (!root.length) return { move: -1, score: 0, depth: 0, nodes: 0 };
  let result: Best = { move: root[0], score: 0, depth: 0, nodes: 0 };
  // gain immédiat, puis parade immédiate : toujours vus, quel que soit le budget
  for (const k of root) {
    cells[k] = 1;
    const w = winsAt(b, cells, k);
    cells[k] = 0;
    if (w) return { move: k, score: WIN, depth: 1, nodes: root.length };
  }
  const empties = cells.reduce((s, c) => s + (c ? 0 : 1), 0);
  for (let d = 1; d <= Math.min(maxDepth, empties); d++) {
    let bestMove = -1, bestV = -Infinity, alpha = -Infinity;
    // meilleur coup de l'itération précédente d'abord
    const order = [result.move, ...root.filter((k) => k !== result.move)];
    for (const k of order) {
      cells[k] = 1;
      const v = -neg(2, d - 1, -Infinity, -alpha, 1);
      cells[k] = 0;
      if (stop) break;
      if (v > bestV) {
        bestV = v;
        bestMove = k;
      }
      if (v > alpha) alpha = v;
    }
    if (stop) break;
    result = { move: bestMove, score: bestV, depth: d, nodes };
    if (Math.abs(bestV) >= WIN - 100) break;
  }
  result.nodes = nodes;
  return result;
}

/** Meilleur coup par MCTS (UCT) : parties aléatoires à graine, `iterations` au plus dans le budget. */
export function mcts(b: Board, rng: Rng, iterations = 3000, budgetMs = 40): Best & { playouts: number } {
  type Node = { move: number; parent: Node | null; kids: Node[]; untried: number[]; wins: number; visits: number; who: 1 | 2 };
  const rootMoves = movesOf(b);
  const mk = (move: number, parent: Node | null, who: 1 | 2, cells: Int8Array, terminal: boolean): Node => ({
    move, parent, kids: [], untried: terminal ? [] : movesOf(b, cells), wins: 0, visits: 0, who,
  });
  const root = mk(-1, null, 2, b.cells, false);
  const t0 = performance.now();
  let it = 0;
  const cells = new Int8Array(b.cells.length);
  const empties = new Int32Array(b.cells.length);
  for (; it < iterations; it++) {
    if (performance.now() - t0 > budgetMs) break;
    cells.set(b.cells);
    let node = root;
    let winner = 0;
    // sélection
    while (!node.untried.length && node.kids.length) {
      const lnN = Math.log(node.visits);
      let best = node.kids[0], bv = -Infinity;
      for (const c of node.kids) {
        const v = c.wins / c.visits + 1.4 * Math.sqrt(lnN / c.visits);
        if (v > bv) {
          bv = v;
          best = c;
        }
      }
      node = best;
      cells[node.move] = node.who;
      if (winsAt(b, cells, node.move)) winner = node.who;
    }
    // expansion
    if (!winner && node.untried.length) {
      const i = rng.int(node.untried.length);
      const k = node.untried[i];
      node.untried[i] = node.untried[node.untried.length - 1];
      node.untried.pop();
      const who = (3 - node.who) as 1 | 2;
      cells[k] = who;
      const won = winsAt(b, cells, k);
      const child = mk(k, node, who, cells, won);
      node.kids.push(child);
      node = child;
      if (won) winner = who;
    }
    // partie aléatoire : sans gravité, cases vides tirées au hasard (bien plus rapide que movesOf à chaque pas)
    let who = (3 - node.who) as 1 | 2;
    if (!winner) {
      if (b.gravity) {
        while (!winner) {
          const ms = movesOf(b, cells);
          if (!ms.length) break;
          const k = ms[rng.int(ms.length)];
          cells[k] = who;
          if (winsAt(b, cells, k)) winner = who;
          who = (3 - who) as 1 | 2;
        }
      } else {
        let ne = 0;
        for (let k = 0; k < cells.length; k++) if (!cells[k]) empties[ne++] = k;
        while (!winner && ne) {
          const i = rng.int(ne);
          const k = empties[i];
          empties[i] = empties[--ne];
          cells[k] = who;
          if (winsAt(b, cells, k)) winner = who;
          who = (3 - who) as 1 | 2;
        }
      }
    }
    // rétropropagation (nul = ½)
    for (let n: Node | null = node; n; n = n.parent) {
      n.visits++;
      n.wins += winner === 0 ? 0.5 : winner === n.who ? 1 : 0;
    }
  }
  let best: Node | null = null;
  for (const c of root.kids) if (!best || c.visits > best.visits) best = c;
  const move = best ? best.move : rootMoves[0] ?? -1;
  return { move, score: best ? Math.round((best.wins / best.visits) * 1000) / 1000 : 0, depth: 0, nodes: it, playouts: it };
}
