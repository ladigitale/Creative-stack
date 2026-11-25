/**
 * Graphes en JSON : plus court chemin (Dijkstra), portée depuis un nœud, tri topologique (prérequis : arbres de
 * compétences, quêtes, recettes).
 *
 * Graphe : `{"edges": [["a", "b", 2], ["b", "c"]], "directed": false}` (poids 1 par défaut) ou liste d'adjacence
 * `{"a": {"b": 2}, "b": ["c"]}`.
 */
import { MinHeap } from "./heap";

export const MAX_EDGES = 100_000;

interface Adj {
  names: string[];
  index: Map<string, number>;
  out: [number, number][][];
}

const cache = new WeakMap<object, Adj>();

export function readGraph(g: unknown): Adj {
  if (!g || typeof g !== "object") throw new Error("graphe : objet attendu");
  const hit = cache.get(g as object);
  if (hit) return hit;
  const names: string[] = [];
  const index = new Map<string, number>();
  const out: [number, number][][] = [];
  const id = (n: unknown) => {
    const s = String(n);
    let i = index.get(s);
    if (i === undefined) {
      i = names.length;
      index.set(s, i);
      names.push(s);
      out.push([]);
    }
    return i;
  };
  let count = 0;
  const add = (a: unknown, b: unknown, w: unknown, directed: boolean) => {
    const wt = w === undefined || w === null ? 1 : Number(w);
    if (!(wt >= 0) || !Number.isFinite(wt)) return;
    if (++count > MAX_EDGES) throw new Error(`graphe trop grand (${MAX_EDGES} arêtes au plus)`);
    const ia = id(a), ib = id(b);
    out[ia].push([ib, wt]);
    if (!directed) out[ib].push([ia, wt]);
  };
  const o = g as { edges?: unknown; directed?: unknown; nodes?: unknown };
  if (Array.isArray(o.edges)) {
    if (Array.isArray(o.nodes)) for (const n of o.nodes) id(n);
    for (const e of o.edges) if (Array.isArray(e) && e.length >= 2) add(e[0], e[1], e[2], !!o.directed);
  } else {
    for (const [a, v] of Object.entries(g as Record<string, unknown>)) {
      id(a);
      if (Array.isArray(v)) for (const b of v) add(a, b, 1, true);
      else if (v && typeof v === "object") for (const [b, w] of Object.entries(v)) add(a, b, w, true);
    }
  }
  const adj = { names, index, out };
  cache.set(g as object, adj);
  return adj;
}

function dijkstra(adj: Adj, sources: number[], max = Infinity, stopAt?: Set<number>): { dist: Float64Array; prev: Int32Array; end: number } {
  const n = adj.names.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const hp = new MinHeap(64);
  for (const s of sources) {
    dist[s] = 0;
    hp.push(s, 0);
  }
  let end = -1;
  while (hp.size) {
    const d = hp.peekPriority();
    const k = hp.pop();
    if (d > dist[k]) continue;
    if (stopAt?.has(k)) {
      end = k;
      break;
    }
    for (const [nk, w] of adj.out[k]) {
      const nd = d + w;
      if (nd <= max && nd < dist[nk]) {
        dist[nk] = nd;
        prev[nk] = k;
        hp.push(nk, nd);
      }
    }
  }
  return { dist, prev, end };
}

/** Plus court chemin de `from` vers le plus proche de `to` (nom ou liste de noms). */
export function graphPath(g: unknown, from: unknown, to: unknown): { found: boolean; path: string[]; cost: number | null } {
  const adj = readGraph(g);
  const s = adj.index.get(String(from));
  const goals = new Set((Array.isArray(to) ? to : [to]).map((t) => adj.index.get(String(t))).filter((i): i is number => i !== undefined));
  if (s === undefined || !goals.size) return { found: false, path: [], cost: null };
  const { dist, prev, end } = dijkstra(adj, [s], Infinity, goals);
  if (end < 0) return { found: false, path: [], cost: null };
  const path: string[] = [];
  for (let k = end; k >= 0; k = prev[k]) path.push(adj.names[k]);
  return { found: true, path: path.reverse(), cost: dist[end] };
}

/** Nœuds atteignables depuis `from` avec un coût ≤ `max` : `{nom: coût}`. */
export function graphReach(g: unknown, from: unknown, max: number): Record<string, number> {
  const adj = readGraph(g);
  const froms = (Array.isArray(from) ? from : [from]).map((f) => adj.index.get(String(f))).filter((i): i is number => i !== undefined);
  const { dist } = dijkstra(adj, froms, max);
  const out: Record<string, number> = {};
  dist.forEach((d, i) => {
    if (d !== Infinity) out[adj.names[i]] = d;
  });
  return out;
}

/**
 * Ordre où chaque nœud vient après ses prérequis : `{"forge": ["mine", "feu"], "feu": []}` (Kahn, ordre stable).
 * Lève une erreur qui nomme le cycle s'il y en a un.
 */
export function topoSort(deps: unknown): string[] {
  if (!deps || typeof deps !== "object" || Array.isArray(deps)) throw new Error("tri topologique : objet {nœud: [prérequis]} attendu");
  const names: string[] = [];
  const idx = new Map<string, number>();
  const id = (s: string) => {
    let i = idx.get(s);
    if (i === undefined) {
      i = names.length;
      idx.set(s, i);
      names.push(s);
    }
    return i;
  };
  const edges: [number, number][] = [];
  for (const [n, pre] of Object.entries(deps as Record<string, unknown>)) {
    const b = id(n);
    for (const p of Array.isArray(pre) ? pre : []) edges.push([id(String(p)), b]);
  }
  if (edges.length > MAX_EDGES) throw new Error("tri topologique : trop d'arêtes");
  const indeg = new Int32Array(names.length);
  const out: number[][] = names.map(() => []);
  for (const [a, b] of edges) {
    out[a].push(b);
    indeg[b]++;
  }
  const ready: number[] = [];
  for (let i = 0; i < names.length; i++) if (!indeg[i]) ready.push(i);
  const order: string[] = [];
  for (let h = 0; h < ready.length; h++) {
    const k = ready[h];
    order.push(names[k]);
    for (const b of out[k]) if (--indeg[b] === 0) ready.push(b);
  }
  if (order.length < names.length) {
    const left = names.filter((_, i) => indeg[i] > 0);
    throw new Error(`tri topologique : cycle entre ${left.join(", ")}`);
  }
  return order;
}
