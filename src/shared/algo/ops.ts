/**
 * Opérations de case sur grille : remplissage par diffusion, régions connexes, recherche, alignements (N en ligne),
 * chute des cases, automates cellulaires (règle B/S).
 */
import { type Cell, type CellValue, type Grid, cellOf, DX8, DY8, inside } from "./grid";

export interface FloodOptions {
  /** 8 voisins (défaut : 4). */
  diag?: boolean;
  /** `same` (défaut) : cases de même valeur que le départ ; `walkable` : toutes les cases franchissables. */
  match?: "same" | "walkable";
  /** Nombre de cases au plus. */
  max?: number;
}

/** Cases connexes au départ (indices), parcours en largeur sur une file typée. */
export function flood(grid: Grid, start: Cell, o: FloodOptions = {}): number[] {
  if (!inside(grid, start[0], start[1])) return [];
  const w = grid.w, h = grid.h;
  const s = start[1] * w + start[0];
  const walkable = o.match === "walkable";
  if (walkable && grid.cost[s] === Infinity) return [];
  const target = grid.code[s];
  const max = Math.max(1, Math.min(o.max ?? Infinity, w * h));
  const mark = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  queue[tail++] = s;
  mark[s] = 1;
  const dirs = o.diag ? 8 : 4;
  while (head < tail && tail < max) {
    const k = queue[head++];
    const x = k % w, y = (k - x) / w;
    for (let d = 0; d < dirs; d++) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nk = ny * w + nx;
      if (mark[nk]) continue;
      if (walkable ? grid.cost[nk] === Infinity : grid.code[nk] !== target) continue;
      mark[nk] = 1;
      queue[tail++] = nk;
      if (tail >= max) break;
    }
  }
  return Array.from(queue.subarray(0, tail));
}

export interface Region {
  id: number;
  value: CellValue;
  size: number;
  /** Première case rencontrée (en lecture ligne par ligne). */
  at: Cell;
  /** [xmin, ymin, xmax, ymax] */
  bounds: [number, number, number, number];
  cells?: Cell[];
}

/**
 * Toutes les régions connexes de même valeur (union-find en une passe). `labels[k]` = id de région ; régions triées
 * par taille décroissante.
 */
export function regions(grid: Grid, o: { diag?: boolean; values?: CellValue[] | null } = {}): { labels: Int32Array; list: Region[] } {
  const w = grid.w, h = grid.h, n = w * h;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra < rb ? rb : ra] = ra < rb ? ra : rb;
  };
  const keep = o.values ? new Set(o.values.map((v) => grid.values.indexOf(v)).filter((c) => c >= 0)) : null;
  const code = grid.code;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const c = code[k];
      if (keep && !keep.has(c)) continue;
      if (x > 0 && code[k - 1] === c) union(k, k - 1);
      if (y > 0 && code[k - w] === c) union(k, k - w);
      if (o.diag && y > 0) {
        if (x > 0 && code[k - w - 1] === c) union(k, k - w - 1);
        if (x < w - 1 && code[k - w + 1] === c) union(k, k - w + 1);
      }
    }
  const labels = new Int32Array(n).fill(-1);
  const byRoot = new Map<number, Region>();
  const list: Region[] = [];
  for (let k = 0; k < n; k++) {
    if (keep && !keep.has(code[k])) continue;
    const r = find(k);
    let reg = byRoot.get(r);
    const [x, y] = cellOf(grid, k);
    if (!reg) {
      reg = { id: list.length, value: grid.values[code[k]], size: 0, at: [x, y], bounds: [x, y, x, y] };
      byRoot.set(r, reg);
      list.push(reg);
    }
    reg.size++;
    const b = reg.bounds;
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
    labels[k] = reg.id;
  }
  const order = list.slice().sort((a, b) => b.size - a.size || a.id - b.id);
  const remap = new Int32Array(list.length);
  order.forEach((r, i) => {
    remap[r.id] = i;
    r.id = i;
  });
  for (let k = 0; k < n; k++) if (labels[k] >= 0) labels[k] = remap[labels[k]];
  return { labels, list: order };
}

/** Cases portant une valeur. */
export function findCells(grid: Grid, value: CellValue, max = 4096): Cell[] {
  const c = grid.values.indexOf(value);
  const out: Cell[] = [];
  if (c < 0) return out;
  for (let k = 0; k < grid.code.length && out.length < max; k++) if (grid.code[k] === c) out.push(cellOf(grid, k));
  return out;
}

export interface Run {
  value: CellValue;
  cells: Cell[];
  dir: "h" | "v" | "d1" | "d2";
}

/** Alignements d'au moins `min` cases identiques (horizontales, verticales, et diagonales si `diag`). */
export function matches(grid: Grid, min = 3, o: { diag?: boolean; ignore?: CellValue[] } = {}): Run[] {
  const ign = new Set((o.ignore ?? []).map((v) => grid.values.indexOf(v)));
  const dirs: [number, number, Run["dir"]][] = [[1, 0, "h"], [0, 1, "v"]];
  if (o.diag) dirs.push([1, 1, "d1"], [1, -1, "d2"]);
  const out: Run[] = [];
  const m = Math.max(2, min);
  for (const [dx, dy, dir] of dirs)
    for (let y = 0; y < grid.h; y++)
      for (let x = 0; x < grid.w; x++) {
        const c = grid.code[y * grid.w + x];
        if (ign.has(c)) continue;
        // début de série seulement
        const px = x - dx, py = y - dy;
        if (inside(grid, px, py) && grid.code[py * grid.w + px] === c) continue;
        let len = 1;
        while (inside(grid, x + dx * len, y + dy * len) && grid.code[(y + dy * len) * grid.w + x + dx * len] === c) len++;
        if (len >= m) {
          const cells: Cell[] = [];
          for (let i = 0; i < len; i++) cells.push([x + dx * i, y + dy * i]);
          out.push({ value: grid.values[c], cells, dir });
        }
      }
  return out;
}

/** Chute : dans chaque colonne, les cases non vides tombent sur les vides (`dir` : down, up, left, right). */
export function fall(grid: Grid, empty: CellValue, dir: "down" | "up" | "left" | "right" = "down"): Int32Array | null {
  const e = grid.values.indexOf(empty);
  if (e < 0) return null;
  const out = new Int32Array(grid.code);
  const w = grid.w, h = grid.h;
  const vertical = dir === "down" || dir === "up";
  const lines = vertical ? w : h, len = vertical ? h : w;
  const toEnd = dir === "down" || dir === "right";
  const at = (line: number, i: number) => (vertical ? i * w + line : line * w + i);
  for (let l = 0; l < lines; l++) {
    let write = toEnd ? len - 1 : 0;
    const step = toEnd ? -1 : 1;
    for (let i = toEnd ? len - 1 : 0; toEnd ? i >= 0 : i < len; i += step) {
      const k = at(l, i);
      const c = grid.code[k];
      // un mur reste en place et sert d'appui
      if (grid.cost[k] === Infinity && c !== e) {
        out[k] = c;
        write = i + step;
        continue;
      }
      if (c !== e) {
        out[k] = e;
        out[at(l, write)] = c;
        write += step;
      }
    }
  }
  return out;
}

/** Règle d'automate `B3/S23` → masques de naissance et de survie (nombre de voisins 0..8). */
export function parseRule(rule: string): { born: boolean[]; survive: boolean[] } {
  const m = /^\s*B([0-8]*)\s*\/\s*S([0-8]*)\s*$/i.exec(rule);
  const born = Array(9).fill(false), survive = Array(9).fill(false);
  if (!m) throw new Error(`règle d'automate invalide : ${rule} (ex. B3/S23)`);
  for (const ch of m[1]) born[+ch] = true;
  for (const ch of m[2]) survive[+ch] = true;
  return { born, survive };
}

/** Pas d'automate cellulaire (8 voisins). Hors grille = mort, sauf `wrap` (tore) ou `edge: "alive"`. */
export function lifeStep(alive: Uint8Array, w: number, h: number, rule: { born: boolean[]; survive: boolean[] }, wrap = false, edgeAlive = false): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let d = 0; d < 8; d++) {
        let nx = x + DX8[d], ny = y + DY8[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
          if (!wrap) {
            if (edgeAlive) n++;
            continue;
          }
          nx = (nx + w) % w;
          ny = (ny + h) % h;
        }
        n += alive[ny * w + nx];
      }
      const k = y * w + x;
      out[k] = (alive[k] ? rule.survive[n] : rule.born[n]) ? 1 : 0;
    }
  return out;
}
