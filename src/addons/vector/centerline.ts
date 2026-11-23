import type { Multi, Pt } from "./geometry";

/**
 * Ligne du milieu d'une forme pleine (squelette) : la forme devient un trait simple qui suit son milieu, au lieu
 * de deux contours. Pour une découpe ou un tracé au stylo d'un dessin au trait épais.
 *
 * Méthode : la forme est pixellisée (règle pair-impair), amincie jusqu'à un pixel de large (Zhang–Suen), puis le
 * squelette est lu comme un graphe (extrémités, embranchements, boucles). Les barbes (petites branches qui
 * partent vers un coin ou une bosse du contour) sont retirées si elles sont plus courtes que l'épaisseur locale
 * du trait (transformée de distance euclidienne) plus `prune` ; les branches restantes sont recousues aux
 * embranchements de degré 2, lissées et simplifiées (Ramer–Douglas–Peucker). L'épaisseur médiane du trait est
 * rendue pour garder l'aspect.
 */

export type CenterlineOptions = {
  /** Côté d'un pixel de calcul (unités de la forme). Défaut : plus grand côté / `maxSide`. */
  cell?: number;
  /** Nombre maximal de pixels sur le plus grand côté (défaut 1200, borné 64..2400). */
  maxSide?: number;
  /** Longueur ajoutée (unités de la forme) au seuil d'ébarbage : plus grand = moins de petites branches. */
  prune?: number;
  /** Tolérance de simplification (unités de la forme) ; défaut : 0,7 pixel de calcul. */
  tolerance?: number;
};

export type CenterlineResult = {
  /** Polylignes (ouvertes ; une boucle a son premier point répété à la fin). */
  lines: Pt[][];
  /** Épaisseur médiane du trait d'origine (unités de la forme). */
  width: number;
  /** Côté du pixel de calcul utilisé. */
  cell: number;
};

const MAX_CELLS = 4_000_000;

/** Squelette d'une forme (polygones avec trous, règle pair-impair). */
export function centerline(shape: Multi, o: CenterlineOptions = {}): CenterlineResult {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of shape) for (const ring of poly) for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  const empty: CenterlineResult = { lines: [], width: 0, cell: 0 };
  if (!(x1 > x0) || !(y1 > y0)) return empty;
  const side = Math.max(64, Math.min(2400, o.maxSide ?? 1200));
  let cell = o.cell && o.cell > 0 ? o.cell : Math.max(x1 - x0, y1 - y0) / side;
  // Bornes : pas plus de MAX_CELLS pixels.
  const need = ((x1 - x0) / cell + 4) * ((y1 - y0) / cell + 4);
  if (need > MAX_CELLS) cell *= Math.sqrt(need / MAX_CELLS);
  const pad = 2;
  const W = Math.ceil((x1 - x0) / cell) + 2 * pad, H = Math.ceil((y1 - y0) / cell) + 2 * pad;
  const ox = x0 - pad * cell, oy = y0 - pad * cell;
  const img = rasterize(shape, W, H, ox, oy, cell);
  const dist = distanceTransform(img, W, H);
  thin(img, W, H);
  const graph = traceSkeleton(img, W, H);
  const prune = Math.max(0, (o.prune ?? 0) / cell);
  const kept = pruneSpurs(graph, dist, W, prune);
  const chains = mergeChains(kept);
  const tol = (o.tolerance && o.tolerance > 0 ? o.tolerance : 0.7 * cell);
  const lines: Pt[][] = [];
  const radii: number[] = [];
  for (const ch of chains) {
    if (ch.length < 2) continue;
    // Boucle passée par un nœud : premier et dernier pixels voisins → refermée.
    const f = ch[0], l = ch[ch.length - 1];
    if (ch.length > 8 && f !== l && Math.abs((f % W) - (l % W)) <= 3 && Math.abs(Math.floor(f / W) - Math.floor(l / W)) <= 3) ch.push(f);
    for (const p of ch) radii.push(Math.sqrt(dist[p]));
    const pts: Pt[] = ch.map((p) => [ox + ((p % W) + 0.5) * cell, oy + (Math.floor(p / W) + 0.5) * cell]);
    const closed = ch.length > 3 && ch[0] === ch[ch.length - 1];
    const smooth = smoothLine(pts, closed);
    const simple = rdp(smooth, tol);
    if (simple.length >= 2) lines.push(simple);
  }
  radii.sort((a, b) => a - b);
  const r = radii.length ? radii[Math.floor(radii.length / 2)] : 0;
  return { lines, width: Math.max(cell, 2 * r * cell), cell };
}

/** Remplissage pair-impair, échantillonné au centre des pixels. */
function rasterize(shape: Multi, W: number, H: number, ox: number, oy: number, cell: number): Uint8Array {
  const img = new Uint8Array(W * H);
  const edges: [number, number, number, number][] = [];
  for (const poly of shape) for (const ring of poly) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (a[1] === b[1]) continue;
      edges.push([(a[0] - ox) / cell, (a[1] - oy) / cell, (b[0] - ox) / cell, (b[1] - oy) / cell]);
    }
  }
  // Arêtes rangées par ligne de pixels touchée.
  const rows: number[][] = Array.from({ length: H }, () => []);
  edges.forEach(([, ay, , by], k) => {
    const lo = Math.max(0, Math.ceil(Math.min(ay, by) - 0.5)), hi = Math.min(H - 1, Math.floor(Math.max(ay, by) - 0.5));
    for (let y = lo; y <= hi; y++) rows[y].push(k);
  });
  const xs: number[] = [];
  for (let y = 0; y < H; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (const k of rows[y]) {
      const [ax, ay, bx, by] = edges[k];
      if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const a = Math.max(0, Math.ceil(xs[i] - 0.5)), b = Math.min(W - 1, Math.floor(xs[i + 1] - 0.5));
      for (let x = a; x <= b; x++) img[y * W + x] = 1;
    }
  }
  return img;
}

/** Carré de la distance euclidienne au fond (Felzenszwalb–Huttenlocher), en pixels². */
function distanceTransform(img: Uint8Array, W: number, H: number): Float32Array {
  const INF = 1e20;
  const d = new Float32Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = img[i] ? INF : 0;
  const n = Math.max(W, H);
  const f = new Float64Array(n), out = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const pass = (len: number) => {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      out[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = d[y * W + x];
    pass(H);
    for (let y = 0; y < H; y++) d[y * W + x] = out[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = d[y * W + x];
    pass(W);
    for (let x = 0; x < W; x++) d[y * W + x] = out[x];
  }
  return d;
}

/** Amincissement de Zhang–Suen (en place) : un pixel de large, connexité gardée. */
function thin(img: Uint8Array, W: number, H: number): void {
  const del: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          if (!img[i]) continue;
          const p2 = img[i - W], p3 = img[i - W + 1], p4 = img[i + 1], p5 = img[i + W + 1];
          const p6 = img[i + W], p7 = img[i + W - 1], p8 = img[i - 1], p9 = img[i - W - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const a = (+(!p2 && p3)) + (+(!p3 && p4)) + (+(!p4 && p5)) + (+(!p5 && p6)) + (+(!p6 && p7)) + (+(!p7 && p8)) + (+(!p8 && p9)) + (+(!p9 && p2));
          if (a !== 1) continue;
          if (step === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
          del.push(i);
        }
      }
      if (del.length) changed = true;
      for (const i of del) img[i] = 0;
    }
  }
}

type Edge = { a: number; b: number; path: number[] };
type Graph = { edges: Edge[]; nodeOf: Int32Array; endpoints: Set<number> };

const neighbours = (i: number, W: number): number[] => [i - W - 1, i - W, i - W + 1, i - 1, i + 1, i + W - 1, i + W, i + W + 1];

/**
 * Squelette → graphe : nœuds = extrémités (1 voisin) et amas d'embranchements (≥ 3 voisins, voisins entre eux
 * réunis) ; arêtes = chemins de pixels entre deux nœuds. Une boucle sans nœud devient une arête fermée.
 */
function traceSkeleton(img: Uint8Array, W: number, H: number): Graph {
  const N = W * H;
  const deg = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!img[i]) continue;
    const x = i % W, y = (i / W) | 0;
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) { img[i] = 0; continue; }
    let n = 0;
    for (const j of neighbours(i, W)) n += img[j];
    deg[i] = n;
  }
  // Amas d'embranchements numérotés ; extrémités : leur propre nœud.
  const nodeOf = new Int32Array(N).fill(-1);
  let nodes = 0;
  const endpoints = new Set<number>();
  for (let i = 0; i < N; i++) {
    if (!img[i] || nodeOf[i] >= 0) continue;
    if (deg[i] === 1 || deg[i] === 0) { nodeOf[i] = nodes; if (deg[i] === 1) endpoints.add(nodes); nodes++; continue; }
    if (deg[i] < 3) continue;
    const id = nodes++;
    const stack = [i];
    nodeOf[i] = id;
    while (stack.length) {
      const p = stack.pop()!;
      for (const q of neighbours(p, W)) if (img[q] && deg[q] >= 3 && nodeOf[q] < 0) { nodeOf[q] = id; stack.push(q); }
    }
  }
  const edges: Edge[] = [];
  const seen = new Uint8Array(N);
  const walk = (start: number, first: number): Edge => {
    const sNode = nodeOf[start];
    const path = [start, first];
    let prev = start, cur = first;
    while (nodeOf[cur] < 0) {
      seen[cur] = 1;
      let next = -1, toNode = -1;
      for (const q of neighbours(cur, W)) {
        if (!img[q] || q === prev) continue;
        // Un nœud termine l'arête (le nœud de départ seulement après s'en être éloigné : boucle).
        if (nodeOf[q] >= 0) { if (nodeOf[q] !== sNode || path.length > 3) toNode = q; }
        else if (!seen[q]) next = q;
      }
      const n = toNode >= 0 ? toNode : next;
      if (n < 0) break;
      path.push(n);
      prev = cur;
      cur = n;
    }
    return { a: sNode, b: nodeOf[cur] >= 0 ? nodeOf[cur] : -1, path };
  };
  for (let i = 0; i < N; i++) {
    if (!img[i] || nodeOf[i] < 0) continue;
    for (const q of neighbours(i, W)) {
      if (!img[q]) continue;
      if (nodeOf[q] < 0) { if (!seen[q]) edges.push(walk(i, q)); }
      else if (nodeOf[q] !== nodeOf[i] && i < q) {
        // Deux nœuds voisins : courte arête (une seule fois par paire de nœuds).
        const a = nodeOf[i], b = nodeOf[q];
        if (!edges.some((e) => e.path.length === 2 && ((e.a === a && e.b === b) || (e.a === b && e.b === a)))) edges.push({ a, b, path: [i, q] });
      }
    }
  }
  // Boucles sans nœud.
  for (let i = 0; i < N; i++) {
    if (!img[i] || nodeOf[i] >= 0 || seen[i]) continue;
    const path = [i];
    seen[i] = 1;
    let cur = i;
    for (;;) {
      let next = -1;
      for (const q of neighbours(cur, W)) if (img[q] && !seen[q]) { next = q; break; }
      if (next < 0) break;
      seen[next] = 1;
      path.push(next);
      cur = next;
    }
    path.push(i);
    edges.push({ a: -1, b: -1, path });
  }
  return { edges, nodeOf, endpoints };
}

/** Retire les barbes : branches à une extrémité libre, plus courtes que l'épaisseur locale + `extra` (pixels). */
function pruneSpurs(g: Graph, dist: Float32Array, W: number, extra: number): Edge[] {
  let edges = g.edges.filter((e) => e.path.length >= 2);
  for (let round = 0; round < 3; round++) {
    const degree = new Map<number, number>();
    for (const e of edges) {
      if (e.a >= 0) degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
      if (e.b >= 0) degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
    }
    const before = edges.length;
    edges = edges.filter((e) => {
      const da = e.a >= 0 ? degree.get(e.a) ?? 0 : 0, db = e.b >= 0 ? degree.get(e.b) ?? 0 : 0;
      // Barbe : un bout libre (degré 1), l'autre sur un embranchement (degré ≥ 3).
      const spur = (da === 1 && db >= 3) || (db === 1 && da >= 3);
      if (!spur) return true;
      const joint = da >= 3 ? e.path[0] : e.path[e.path.length - 1];
      const len = pathLength(e.path, W);
      return len > Math.sqrt(dist[joint]) * 1.6 + extra;
    });
    if (edges.length === before) break;
  }
  return edges;
}

function pathLength(path: number[], W: number): number {
  let L = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = (path[i] % W) - (path[i - 1] % W), dy = Math.floor(path[i] / W) - Math.floor(path[i - 1] / W);
    L += Math.hypot(dx, dy);
  }
  return L;
}

/** Recoud les arêtes qui se suivent à un nœud de degré 2 ; renvoie les chaînes de pixels. */
function mergeChains(edges: Edge[]): number[][] {
  const at = new Map<number, number[]>();
  edges.forEach((e, k) => {
    if (e.a >= 0) at.set(e.a, [...(at.get(e.a) ?? []), k]);
    if (e.b >= 0 && e.b !== e.a) at.set(e.b, [...(at.get(e.b) ?? []), k]);
  });
  const used = new Uint8Array(edges.length);
  const chains: number[][] = [];
  const extend = (chain: number[], node: number, from: number): number[] => {
    let n = node, k = from;
    for (;;) {
      const list = at.get(n);
      if (!list || list.length !== 2) return chain;
      const next = list[0] === k ? list[1] : list[0];
      if (used[next]) return chain;
      used[next] = 1;
      const e = edges[next];
      const fwd = e.a === n;
      const p = fwd ? e.path : [...e.path].reverse();
      chain.push(...p.slice(1));
      n = fwd ? e.b : e.a;
      k = next;
      if (n < 0) return chain;
    }
  };
  // D'abord depuis les nœuds qui ne sont pas de degré 2 (bouts et embranchements), puis les boucles restantes.
  const order = edges.map((_, k) => k).sort((p, q) => {
    const deg2 = (e: Edge) => (at.get(e.a)?.length === 2 ? 1 : 0) + (at.get(e.b)?.length === 2 ? 1 : 0);
    return deg2(edges[p]) - deg2(edges[q]);
  });
  for (const k of order) {
    if (used[k]) continue;
    used[k] = 1;
    const e = edges[k];
    let chain = [...e.path];
    chain = extend(chain, e.b, k);
    const back = extend([...e.path].reverse().slice(0, 1), e.a, k).slice(1).reverse();
    chains.push([...back, ...chain]);
  }
  return chains;
}

/** Moyenne glissante (efface les marches de la grille), bouts gardés. */
function smoothLine(pts: Pt[], closed: boolean): Pt[] {
  if (pts.length < 4) return pts;
  let cur = pts;
  for (let pass = 0; pass < 2; pass++) {
    const n = cur.length;
    const out: Pt[] = cur.map((p, i) => {
      if (!closed && (i === 0 || i === n - 1)) return p;
      const a = cur[(i - 1 + n) % n], b = cur[(i + 1) % n];
      return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4];
    });
    if (closed) out[n - 1] = out[0];
    cur = out;
  }
  return cur;
}

/** Ramer–Douglas–Peucker. */
function rdp(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let best = -1, bd = t2;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d: number;
      if (L2 === 0) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
        d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
