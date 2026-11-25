/**
 * Génération procédurale à graine : labyrinthes (backtracker, Prim, Kruskal, Wilson), cavernes par automate,
 * donjons (découpe BSP, salles reliées par couloirs), semis de Poisson, mélange, tirage pondéré, dés.
 * Tout est déterministe : même graine → même résultat ; chaque fonction rend la graine suivante.
 */
import { DX4, DY4 } from "./grid";
import { lifeStep, parseRule } from "./ops";
import { Rng } from "./rng";

export const MAX_GEN_CELLS = 65_536;

function dims(w: unknown, h: unknown, max = 256): [number, number] {
  const W = Math.max(1, Math.min(max, Math.floor(Number(w) || 0)));
  const H = Math.max(1, Math.min(max, Math.floor(Number(h) || 0)));
  return [W, H];
}

export type MazeAlgo = "backtracker" | "prim" | "kruskal" | "wilson";

/**
 * Labyrinthe parfait de `cw × ch` cellules, rendu en grille `(2cw+1) × (2ch+1)` (murs entre les cellules).
 * backtracker : longs couloirs ; prim : beaucoup d'impasses courtes ; kruskal : aspect régulier ; wilson : uniforme
 * (sans biais).
 */
export function maze(cwIn: unknown, chIn: unknown, rng: Rng, algo: MazeAlgo = "backtracker"): { open: Uint8Array; w: number; h: number } {
  const [cw, ch] = dims(cwIn, chIn, 127);
  const W = cw * 2 + 1, H = ch * 2 + 1;
  const open = new Uint8Array(W * H); // 1 = sol
  const cell = (x: number, y: number) => ((2 * y + 1) * W + 2 * x + 1);
  const carve = (x: number, y: number) => (open[cell(x, y)] = 1);
  const link = (x: number, y: number, nx: number, ny: number) => {
    carve(x, y);
    carve(nx, ny);
    open[(y + ny + 1) * W + (x + nx + 1)] = 1;
  };
  const n = cw * ch;
  const nb = (i: number): number[] => {
    const x = i % cw, y = (i - x) / cw, out: number[] = [];
    for (let d = 0; d < 4; d++) {
      const nx = x + DX4[d], ny = y + DY4[d];
      if (nx >= 0 && ny >= 0 && nx < cw && ny < ch) out.push(ny * cw + nx);
    }
    return out;
  };
  const linkI = (a: number, b: number) => link(a % cw, Math.floor(a / cw), b % cw, Math.floor(b / cw));
  if (algo === "prim") {
    const inMaze = new Uint8Array(n);
    const inFrontier = new Uint8Array(n);
    const frontier: number[] = [];
    const add = (i: number) => {
      inMaze[i] = 1;
      carve(i % cw, Math.floor(i / cw));
      for (const j of nb(i))
        if (!inMaze[j] && !inFrontier[j]) {
          inFrontier[j] = 1;
          frontier.push(j);
        }
    };
    add(rng.int(n));
    while (frontier.length) {
      const fi = rng.int(frontier.length);
      const i = frontier[fi];
      frontier[fi] = frontier[frontier.length - 1];
      frontier.pop();
      const ins = nb(i).filter((j) => inMaze[j]);
      linkI(i, ins[rng.int(ins.length)]);
      add(i);
    }
  } else if (algo === "kruskal") {
    const parent = Int32Array.from({ length: n }, (_, i) => i);
    const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
    const edges: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      if ((i % cw) + 1 < cw) edges.push([i, i + 1]);
      if (i + cw < n) edges.push([i, i + cw]);
    }
    shuffleInPlace(edges, rng);
    for (const [a, b] of edges) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) {
        parent[ra] = rb;
        linkI(a, b);
      }
    }
    if (n === 1) carve(0, 0);
  } else if (algo === "wilson") {
    const inMaze = new Uint8Array(n);
    inMaze[rng.int(n)] = 1;
    carve(0, 0);
    const next = new Int32Array(n);
    let remaining = n - 1;
    for (let start = 0; start < n && remaining > 0; start++) {
      if (inMaze[start]) continue;
      // marche aléatoire à effacement de boucles
      let i = start;
      while (!inMaze[i]) {
        const opts = nb(i);
        next[i] = opts[rng.int(opts.length)];
        i = next[i];
      }
      i = start;
      while (!inMaze[i]) {
        inMaze[i] = 1;
        remaining--;
        linkI(i, next[i]);
        i = next[i];
      }
    }
    for (let i = 0; i < n; i++) if (inMaze[i]) carve(i % cw, Math.floor(i / cw));
  } else {
    const seen = new Uint8Array(n);
    const stack = [rng.int(n)];
    seen[stack[0]] = 1;
    carve(stack[0] % cw, Math.floor(stack[0] / cw));
    while (stack.length) {
      const i = stack[stack.length - 1];
      const opts = nb(i).filter((j) => !seen[j]);
      if (!opts.length) {
        stack.pop();
        continue;
      }
      const j = opts[rng.int(opts.length)];
      seen[j] = 1;
      linkI(i, j);
      stack.push(j);
    }
  }
  return { open, w: W, h: H };
}

/** Caverne : remplissage aléatoire puis automate (règle B5678/S45678 par défaut), bords pleins. 1 = sol. */
export function cave(wIn: unknown, hIn: unknown, rng: Rng, fill = 0.45, steps = 4, rule = "B5678/S45678", keepLargest = true): Uint8Array {
  const [w, h] = dims(wIn, hIn);
  let wall: Uint8Array = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) wall[y * w + x] = x === 0 || y === 0 || x === w - 1 || y === h - 1 || rng.next() < fill ? 1 : 0;
  const r = parseRule(rule);
  for (let s = 0; s < Math.min(20, steps); s++) wall = lifeStep(wall, w, h, r, false, true);
  const floor = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) floor[k] = wall[k] ? 0 : 1;
  if (keepLargest) {
    // garde la plus grande poche de sol : tout est atteignable
    const label = new Int32Array(w * h).fill(-1);
    let best = -1, bestSize = 0, id = 0;
    const q = new Int32Array(w * h);
    for (let k = 0; k < w * h; k++) {
      if (!floor[k] || label[k] >= 0) continue;
      let head = 0, tail = 0, size = 0;
      q[tail++] = k;
      label[k] = id;
      while (head < tail) {
        const c = q[head++];
        size++;
        const x = c % w, y = (c - x) / w;
        for (let d = 0; d < 4; d++) {
          const nx = x + DX4[d], ny = y + DY4[d];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nk = ny * w + nx;
          if (floor[nk] && label[nk] < 0) {
            label[nk] = id;
            q[tail++] = nk;
          }
        }
      }
      if (size > bestSize) {
        bestSize = size;
        best = id;
      }
      id++;
    }
    for (let k = 0; k < w * h; k++) if (floor[k] && label[k] !== best) floor[k] = 0;
  }
  return floor;
}

export interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
  center: [number, number];
}

/** Donjon : découpe BSP de la surface, une salle par feuille, couloirs en L entre feuilles sœurs. 1 = sol. */
export function dungeon(wIn: unknown, hIn: unknown, rng: Rng, o: { min?: number; max?: number; depth?: number } = {}): { floor: Uint8Array; rooms: Room[]; w: number; h: number } {
  const [w, h] = dims(wIn, hIn);
  const minRoom = Math.max(3, Math.floor(o.min ?? 4));
  const maxRoom = Math.max(minRoom, Math.floor(o.max ?? 10));
  const depth = Math.max(1, Math.min(8, Math.floor(o.depth ?? 4)));
  const floor = new Uint8Array(w * h);
  const rooms: Room[] = [];
  const dig = (x: number, y: number) => {
    if (x > 0 && y > 0 && x < w - 1 && y < h - 1) floor[y * w + x] = 1;
  };
  // couloir en L : horizontal puis vertical, ou l'inverse
  const corridor = (a: [number, number], b: [number, number]) => {
    const [x0, y0] = a, [x1, y1] = b;
    const hf = rng.next() < 0.5;
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) dig(x, hf ? y0 : y1);
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) dig(hf ? x1 : x0, y);
  };
  // rend le centre d'une salle de la partition (pour relier les sœurs)
  const split = (x: number, y: number, bw: number, bh: number, d: number): [number, number] | null => {
    const canH = bw >= 2 * (minRoom + 2), canV = bh >= 2 * (minRoom + 2);
    if (d > 0 && (canH || canV)) {
      const vertical = canH && (!canV || (bw > bh ? rng.next() < 0.8 : rng.next() < 0.2));
      const span = vertical ? bw : bh;
      const cut = minRoom + 2 + rng.int(span - 2 * (minRoom + 2) + 1);
      const a = vertical ? split(x, y, cut, bh, d - 1) : split(x, y, bw, cut, d - 1);
      const b = vertical ? split(x + cut, y, bw - cut, bh, d - 1) : split(x, y + cut, bw, bh - cut, d - 1);
      if (a && b) corridor(a, b);
      return a ?? b;
    }
    const rw = Math.min(bw - 2, minRoom + rng.int(Math.max(1, maxRoom - minRoom + 1)));
    const rh = Math.min(bh - 2, minRoom + rng.int(Math.max(1, maxRoom - minRoom + 1)));
    if (rw < 1 || rh < 1) return null;
    const rx = x + 1 + rng.int(Math.max(1, bw - rw - 1));
    const ry = y + 1 + rng.int(Math.max(1, bh - rh - 1));
    for (let j = ry; j < ry + rh; j++) for (let i = rx; i < rx + rw; i++) dig(i, j);
    const room: Room = { x: rx, y: ry, w: rw, h: rh, center: [rx + (rw >> 1), ry + (rh >> 1)] };
    rooms.push(room);
    return room.center;
  };
  split(0, 0, w, h, depth);
  return { floor, rooms, w, h };
}

/** Semis de Poisson (Bridson) : points espacés d'au moins `r` dans `w × h`. */
export function poisson(wIn: unknown, hIn: unknown, rIn: unknown, rng: Rng, max = 2000, tries = 20): [number, number][] {
  const w = Math.max(1, Number(wIn) || 1), h = Math.max(1, Number(hIn) || 1);
  const r = Math.max(1e-3, Number(rIn) || 1);
  const cs = r / Math.SQRT2;
  const gw = Math.ceil(w / cs), gh = Math.ceil(h / cs);
  if (gw * gh > 1_000_000) throw new Error("poisson : rayon trop petit pour la surface");
  const grid = new Int32Array(gw * gh).fill(-1);
  const pts: [number, number][] = [];
  const active: number[] = [];
  const add = (x: number, y: number) => {
    pts.push([x, y]);
    active.push(pts.length - 1);
    grid[Math.floor(y / cs) * gw + Math.floor(x / cs)] = pts.length - 1;
  };
  add(rng.next() * w, rng.next() * h);
  const cap = Math.min(10_000, Math.max(1, max));
  while (active.length && pts.length < cap) {
    const ai = rng.int(active.length);
    const [px, py] = pts[active[ai]];
    let ok = false;
    for (let t = 0; t < tries; t++) {
      const a = rng.next() * Math.PI * 2, d = r * (1 + rng.next());
      const x = px + Math.cos(a) * d, y = py + Math.sin(a) * d;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const gx = Math.floor(x / cs), gy = Math.floor(y / cs);
      let far = true;
      for (let j = Math.max(0, gy - 2); j <= Math.min(gh - 1, gy + 2) && far; j++)
        for (let i = Math.max(0, gx - 2); i <= Math.min(gw - 1, gx + 2); i++) {
          const q = grid[j * gw + i];
          if (q >= 0 && (pts[q][0] - x) ** 2 + (pts[q][1] - y) ** 2 < r * r) {
            far = false;
            break;
          }
        }
      if (far) {
        add(x, y);
        ok = true;
        break;
      }
    }
    if (!ok) {
      active[ai] = active[active.length - 1];
      active.pop();
    }
  }
  return pts.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
}

export function shuffleInPlace<T>(a: T[], rng: Rng): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/** Tirage pondéré : index choisi (poids ≤ 0 jamais tirés), -1 si aucun poids positif. */
export function weightedIndex(weights: number[], rng: Rng): number {
  let total = 0;
  for (const w of weights) if (w > 0) total += w;
  if (!(total > 0)) return -1;
  let r = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    if (!(weights[i] > 0)) continue;
    r -= weights[i];
    if (r < 0) return i;
  }
  for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
  return -1;
}

export interface DiceRoll {
  value: number;
  rolls: { die: string; values: number[]; kept: number[] }[];
  min: number;
  max: number;
}

/**
 * Dés en notation courante : `2d6+1`, `d20`, `4d6kh3` (garder les 3 plus hauts), `2d20kl1` (désavantage), `d%`,
 * `3dF` (dés Fudge −1/0/+1), plusieurs termes (`1d8+1d6-2`). 100 dés au plus.
 */
export function roll(notation: string, rng: Rng): DiceRoll {
  const src = String(notation).replace(/\s+/g, "").toLowerCase();
  if (!src || src.length > 120) throw new Error(`dés : notation invalide « ${notation} »`);
  const re = /([+-]?)(?:(\d*)d(\d+|%|f)(?:(kh|kl|dh|dl)(\d+))?|(\d+))/gy;
  let pos = 0, total = 0, min = 0, max = 0, count = 0;
  const rolls: DiceRoll["rolls"] = [];
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m || m[0] === "" || (pos > 0 && !m[1])) throw new Error(`dés : notation invalide « ${notation} »`);
    pos = re.lastIndex;
    const sign = m[1] === "-" ? -1 : 1;
    if (m[6] !== undefined) {
      const k = Number(m[6]);
      total += sign * k;
      min += sign * k;
      max += sign * k;
      continue;
    }
    const n = m[2] === "" || m[2] === undefined ? 1 : Number(m[2]);
    count += n;
    if (n < 1 || count > 100) throw new Error("dés : 1 à 100 dés");
    const fudge = m[3] === "f";
    const faces = m[3] === "%" ? 100 : fudge ? 3 : Number(m[3]);
    if (!(faces >= 1) || faces > 1000) throw new Error("dés : 1 à 1000 faces");
    const values: number[] = [];
    for (let i = 0; i < n; i++) values.push(fudge ? rng.int(3) - 1 : 1 + rng.int(faces));
    let kept = values.slice();
    let keepN = n;
    if (m[4]) {
      const k = Math.min(n, Number(m[5]));
      const sorted = values.slice().sort((a, b) => a - b);
      keepN = m[4] === "kh" ? k : m[4] === "kl" ? k : n - k;
      kept = m[4] === "kh" || m[4] === "dl" ? sorted.slice(n - keepN) : sorted.slice(0, keepN);
    }
    const sum = kept.reduce((a, b) => a + b, 0);
    total += sign * sum;
    const lo = fudge ? -keepN : keepN, hi = fudge ? keepN : keepN * faces;
    if (sign > 0) {
      min += lo;
      max += hi;
    } else {
      min -= hi;
      max -= lo;
    }
    rolls.push({ die: `${sign < 0 ? "-" : ""}${n}d${m[3]}${m[4] ? m[4] + m[5] : ""}`, values, kept });
  }
  return { value: total, rolls, min, max };
}
