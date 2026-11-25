/**
 * Pavages : Voronoï sur grille (sites aléatoires à graine, relaxation de Lloyd), triangulation de Delaunay
 * (Bowyer-Watson) et arbre couvrant minimal (Kruskal) d'un nuage de points.
 */
import { Rng } from "./rng";

export function voronoiGrid(w: number, h: number, rng: Rng, count: number, relax = 0, metric: "euclid" | "manhattan" = "euclid"): { label: Int32Array; sites: [number, number][] } {
  const n = Math.max(1, Math.min(256, Math.floor(count)));
  let sites: [number, number][] = [];
  for (let i = 0; i < n; i++) sites.push([rng.next() * w, rng.next() * h]);
  const label = new Int32Array(w * h);
  const assign = () => {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let best = 0, bd = Infinity;
        for (let i = 0; i < sites.length; i++) {
          const dx = x + 0.5 - sites[i][0], dy = y + 0.5 - sites[i][1];
          const d = metric === "manhattan" ? Math.abs(dx) + Math.abs(dy) : dx * dx + dy * dy;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        label[y * w + x] = best;
      }
  };
  assign();
  for (let r = 0; r < Math.min(10, relax); r++) {
    const sx = new Float64Array(n), sy = new Float64Array(n), c = new Float64Array(n);
    for (let k = 0; k < w * h; k++) {
      const i = label[k];
      sx[i] += (k % w) + 0.5;
      sy[i] += Math.floor(k / w) + 0.5;
      c[i]++;
    }
    sites = sites.map((s, i) => (c[i] ? [sx[i] / c[i], sy[i] / c[i]] : s));
    assign();
  }
  return { label, sites: sites.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]) };
}

/** Triangles (indices des points, sens quelconque) de la triangulation de Delaunay. 2000 points au plus. */
export function delaunay(points: [number, number][]): [number, number, number][] {
  const n = points.length;
  if (n < 3) return [];
  if (n > 2000) throw new Error("delaunay : 2000 points au plus");
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const d = Math.max(maxX - minX, maxY - minY) || 1;
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const P = points.concat([[mx - 20 * d, my - d], [mx, my + 20 * d], [mx + 20 * d, my - d]]);
  type Tri = { a: number; b: number; c: number; x: number; y: number; r2: number };
  const circ = (a: number, b: number, c: number): Tri => {
    const [ax, ay] = P[a], [bx, by] = P[b], [cx, cy] = P[c];
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(D) < 1e-12) return { a, b, c, x: 0, y: 0, r2: Infinity };
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const x = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / D;
    const y = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / D;
    return { a, b, c, x, y, r2: (ax - x) ** 2 + (ay - y) ** 2 };
  };
  let tris: Tri[] = [circ(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const [px, py] = P[i];
    const bad: Tri[] = [], keep: Tri[] = [];
    for (const t of tris) ((px - t.x) ** 2 + (py - t.y) ** 2 < t.r2 * (1 + 1e-12) ? bad : keep).push(t);
    const edges = new Map<string, [number, number]>();
    for (const t of bad)
      for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as [number, number][]) {
        const k = u < v ? `${u},${v}` : `${v},${u}`;
        if (edges.has(k)) edges.delete(k);
        else edges.set(k, [u, v]);
      }
    for (const [u, v] of edges.values()) keep.push(circ(u, v, i));
    tris = keep;
  }
  return tris.filter((t) => t.a < n && t.b < n && t.c < n).map((t) => [t.a, t.b, t.c]);
}

/** Arêtes uniques d'une liste de triangles. */
export function triEdges(tris: [number, number, number][]): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const [a, b, c] of tris)
    for (let [u, v] of [[a, b], [b, c], [c, a]]) {
      if (u > v) [u, v] = [v, u];
      const k = `${u},${v}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push([u, v]);
      }
    }
  return out;
}

/** Arbre couvrant minimal (Kruskal) sur des arêtes pondérées `[u, v, poids]`. */
export function mst(n: number, edges: [number, number, number][]): [number, number, number][] {
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  const out: [number, number, number][] = [];
  for (const e of edges.slice().sort((p, q) => p[2] - q[2])) {
    const a = find(e[0]), b = find(e[1]);
    if (a !== b) {
      parent[a] = b;
      out.push(e);
    }
  }
  return out;
}
