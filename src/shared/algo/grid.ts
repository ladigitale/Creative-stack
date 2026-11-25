/**
 * Grille de jeu lue depuis le JSON d'un état : lignes de texte (`["#..#", "#@.#"]`) ou matrice (`[[1, 0], [0, 0]]`,
 * celle de `$matrix`). Tout est ramené à des tableaux typés indexés par `k = y * w + x` (x = colonne, y = ligne) :
 * `code` (valeur de la case, numérotée), `cost` (coût d'entrée, Infinity = mur), `opaque` (bloque la vue).
 *
 * La lecture est mise en cache (clé = contenu + options) : un réducteur qui appelle plusieurs fonctions sur la même
 * grille, ou la même grille à chaque action, ne la relit pas.
 */
export const MAX_CELLS = 65_536; // 256 × 256

export type Cell = [number, number];
export type CellValue = string | number;

export interface GridOptions {
  /** Valeurs infranchissables : chaîne de caractères (`"#T"`) ou liste. Défaut : `"#"` (texte), `1` (matrice). */
  walls?: string | CellValue[];
  /** Coût d'entrée par valeur (`{"~": 3, "^": 2}`), 1 sinon. Un coût ≤ 0 ou non fini vaut mur. */
  costs?: Record<string, number>;
  /** Valeurs qui bloquent la vue (champ de vision, ligne de vue). Défaut : les murs. */
  opaque?: string | CellValue[];
  /** 8 voisins au lieu de 4. */
  diag?: boolean;
  /** En diagonale, passer entre deux murs qui se touchent par un coin (défaut : non). */
  cut?: boolean;
}

export interface Grid {
  w: number;
  h: number;
  /** "rows" : lignes de texte ; "matrix" : tableau de lignes. */
  kind: "rows" | "matrix";
  code: Int32Array;
  values: CellValue[];
  cost: Float32Array;
  opaque: Uint8Array;
  minCost: number;
  diag: boolean;
  cut: boolean;
  /** Valeur d'une case manquante (ligne courte) : premier mur. */
  pad: CellValue;
  /** Clé de cache (contenu + options). */
  key: string;
}

const cache = new Map<string, Grid>();
const CACHE_MAX = 16;

function toList(v: unknown, kind: Grid["kind"]): CellValue[] | null {
  if (v == null) return null;
  if (typeof v === "string") return kind === "rows" ? [...v] : [v];
  if (Array.isArray(v)) return v.map((x) => (typeof x === "number" ? x : String(x)));
  if (typeof v === "number") return [v];
  return null;
}

function optKey(o: GridOptions): string {
  return JSON.stringify([o.walls ?? null, o.costs ?? null, o.opaque ?? null, !!o.diag, !!o.cut]);
}

export function readOptions(o: unknown): GridOptions {
  return o && typeof o === "object" && !Array.isArray(o) ? (o as GridOptions) : {};
}

/** Lit une grille (lignes de texte ou matrice). Lève une erreur claire si la forme est mauvaise. */
export function readGrid(input: unknown, options: unknown = {}): Grid {
  if (!Array.isArray(input) || !input.length) throw new Error("grille : liste de lignes attendue");
  const o = readOptions(options);
  const kind: Grid["kind"] = typeof input[0] === "string" ? "rows" : "matrix";
  const body = kind === "rows" ? (input as unknown[]).join("\n") : JSON.stringify(input);
  const key = `${kind}|${optKey(o)}|${body}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const h = input.length;
  let w = 0;
  for (const row of input) {
    const len = kind === "rows" ? String(row).length : Array.isArray(row) ? row.length : 0;
    if (len > w) w = len;
  }
  if (!w) throw new Error("grille : lignes vides");
  if (w * h > MAX_CELLS) throw new Error(`grille trop grande : ${w}×${h} (${MAX_CELLS} cases au plus)`);

  const walls = new Set(toList(o.walls, kind) ?? (kind === "rows" ? ["#"] : [1]));
  const opaqueList = toList(o.opaque, kind);
  const opaqueSet = opaqueList ? new Set(opaqueList) : walls;
  const costs = o.costs && typeof o.costs === "object" ? o.costs : {};
  const n = w * h;
  const code = new Int32Array(n);
  const cost = new Float32Array(n);
  const opaque = new Uint8Array(n);
  const values: CellValue[] = [];
  const index = new Map<CellValue, number>();
  const costOf: number[] = [];
  const opaqueOf: number[] = [];
  let minCost = Infinity;
  const intern = (v: CellValue): number => {
    let c = index.get(v);
    if (c === undefined) {
      c = values.length;
      index.set(v, c);
      values.push(v);
      let cv = 1;
      if (walls.has(v)) cv = Infinity;
      else if (Object.prototype.hasOwnProperty.call(costs, String(v))) {
        const x = Number(costs[String(v)]);
        cv = Number.isFinite(x) && x > 0 ? x : Infinity;
      }
      costOf.push(cv);
      opaqueOf.push(opaqueSet.has(v) ? 1 : 0);
      if (cv < minCost) minCost = cv;
    }
    return c;
  };
  // case manquante d'une ligne courte = premier mur
  const pad: CellValue = [...walls][0] ?? (kind === "rows" ? "#" : 1);
  for (let y = 0; y < h; y++) {
    const row = input[y];
    for (let x = 0; x < w; x++) {
      let v: CellValue;
      if (kind === "rows") {
        const s = String(row);
        v = x < s.length ? s[x] : pad;
      } else {
        const r = Array.isArray(row) ? row : [];
        const raw = r[x];
        v = raw === undefined || raw === null ? pad : typeof raw === "number" ? raw : String(raw);
      }
      const c = intern(v);
      const k = y * w + x;
      code[k] = c;
      cost[k] = costOf[c];
      opaque[k] = opaqueOf[c];
    }
  }
  const g: Grid = {
    w,
    h,
    kind,
    code,
    values,
    cost,
    opaque,
    minCost: Number.isFinite(minCost) ? minCost : 1,
    diag: !!o.diag,
    cut: !!o.cut,
    pad,
    key,
  };
  cache.set(key, g);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return g;
}

/** Point `[x, y]` ou `{x, y}` → `[x, y]` entier, ou null. */
export function readCell(p: unknown): Cell | null {
  if (Array.isArray(p) && p.length >= 2) {
    const x = Number(p[0]), y = Number(p[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? [Math.round(x), Math.round(y)] : null;
  }
  if (p && typeof p === "object") {
    const q = p as { x?: unknown; y?: unknown };
    const x = Number(q.x), y = Number(q.y);
    return Number.isFinite(x) && Number.isFinite(y) ? [Math.round(x), Math.round(y)] : null;
  }
  return null;
}

/** Un point ou une liste de points → liste de points (cibles multiples). */
export function readCells(p: unknown): Cell[] {
  if (Array.isArray(p) && p.length && (Array.isArray(p[0]) || (p[0] && typeof p[0] === "object"))) {
    const out: Cell[] = [];
    for (const q of p) {
      const c = readCell(q);
      if (c) out.push(c);
    }
    return out;
  }
  const c = readCell(p);
  return c ? [c] : [];
}

export function inside(g: Grid, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < g.w && y < g.h;
}

export const DX4 = [1, 0, -1, 0];
export const DY4 = [0, 1, 0, -1];
export const DX8 = [1, 0, -1, 0, 1, -1, -1, 1];
export const DY8 = [0, 1, 0, -1, 1, 1, -1, -1];

/**
 * Parcourt les voisins franchissables de `k` : `fn(nk, stepCost)` (coût de la case d'arrivée × √2 en diagonale).
 * Règle des coins : sans `cut`, une diagonale exige les deux cases orthogonales franchissables.
 */
export function forNeighbors(g: Grid, k: number, fn: (nk: number, step: number) => void): void {
  const w = g.w, h = g.h, cost = g.cost;
  const x = k % w, y = (k - x) / w;
  const n = g.diag ? 8 : 4;
  for (let d = 0; d < n; d++) {
    const nx = x + DX8[d], ny = y + DY8[d];
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
    const nk = ny * w + nx;
    const c = cost[nk];
    if (c === Infinity) continue;
    if (d >= 4) {
      if (!g.cut && (cost[y * w + nx] === Infinity || cost[ny * w + x] === Infinity)) continue;
      fn(nk, c * Math.SQRT2);
    } else fn(nk, c);
  }
}

/** Nouvelle grille, même forme que l'entrée, avec des cases changées (`changes` : k → valeur). */
export function writeGrid(input: unknown[], g: Grid, changes: Map<number, CellValue>): unknown[] {
  if (!changes.size) return input;
  const byRow = new Map<number, [number, CellValue][]>();
  for (const [k, v] of changes) {
    const y = Math.floor(k / g.w);
    let l = byRow.get(y);
    if (!l) byRow.set(y, (l = []));
    l.push([k - y * g.w, v]);
  }
  return input.map((row, y) => {
    const l = byRow.get(y);
    if (!l) return row;
    if (g.kind === "rows") {
      const chars = [...String(row).padEnd(g.w, String(g.pad))];
      for (const [x, v] of l) chars[x] = String(v).slice(0, 1) || " ";
      return chars.join("");
    }
    const r = Array.isArray(row) ? row.slice() : [];
    for (const [x, v] of l) r[x] = v;
    return r;
  });
}

/** Grille entière rendue depuis un tableau de codes (même forme que l'entrée). */
export function gridFromCodes(g: Grid, code: ArrayLike<number>, values: CellValue[] = g.values): unknown[] {
  const out: unknown[] = [];
  for (let y = 0; y < g.h; y++) {
    if (g.kind === "rows") {
      let s = "";
      for (let x = 0; x < g.w; x++) s += String(values[code[y * g.w + x]]);
      out.push(s);
    } else {
      const r: CellValue[] = [];
      for (let x = 0; x < g.w; x++) r.push(values[code[y * g.w + x]]);
      out.push(r);
    }
  }
  return out;
}

export function cellOf(g: Grid, k: number): Cell {
  const x = k % g.w;
  return [x, (k - x) / g.w];
}
