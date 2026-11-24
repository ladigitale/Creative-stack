/**
 * Tracés pour la gravure au trait : un même point ne doit être brûlé qu'une fois. `optimizeStrokes` reçoit des
 * polylignes (mm) et rend des tracés enchaînés où
 * - les traits superposés (bords communs de tuiles, segments repassés) ne sont plus qu'un ;
 * - à une jonction (plusieurs branches d'un même point, un trait qui en touche un autre), seuls les deux traits
 *   les mieux alignés passent ; les autres s'arrêtent à `gap` mm du point ;
 * - à un croisement, le trait le plus ancien (ordre d'entrée) passe, l'autre est interrompu sur `gap` mm de part
 *   et d'autre ;
 * - les morceaux sont recousus en tracés aussi longs que possible (moins d'allumages, de reprises et de taches).
 * Fonctions pures.
 */

export type P2 = [number, number];
export type Polyline = P2[];

export type StrokeOptions = {
  /** Demi-largeur de l'interruption aux croisements et recul aux jonctions, en mm (≈ largeur du faisceau). 0 : aucun. */
  gap: number;
  /** Distance sous laquelle deux points sont confondus, en mm. */
  snap?: number;
  /** Morceaux plus courts ignorés, en mm. */
  minLength?: number;
};

type Edge = { a: number; b: number; prio: number; cuts: [number, number][] };

const MAX_SEGMENTS = 400_000;

/** Supprime les doublons, interrompt les croisements et les jonctions, recoud les tracés. */
export function optimizeStrokes(lines: Polyline[], o: StrokeOptions): Polyline[] {
  const snap = o.snap ?? 0.01;
  const gap = Math.max(0, o.gap);
  const minLength = o.minLength ?? Math.max(snap * 2, 0.02);

  // ─── Nœuds (points confondus à `snap` près) ───
  const xs: number[] = [], ys: number[] = [];
  const keyOf = new Map<string, number>();
  const node = (p: P2): number => {
    const k = `${Math.round(p[0] / snap)},${Math.round(p[1] / snap)}`;
    let id = keyOf.get(k);
    if (id === undefined) {
      id = xs.length;
      xs.push(Math.round(p[0] / snap) * snap);
      ys.push(Math.round(p[1] / snap) * snap);
      keyOf.set(k, id);
    }
    return id;
  };
  let segs: { a: number; b: number; prio: number }[] = [];
  lines.forEach((l, prio) => {
    for (let i = 1; i < l.length; i++) {
      const a = node(l[i - 1]), b = node(l[i]);
      if (a !== b) segs.push({ a, b, prio });
    }
  });
  if (segs.length > MAX_SEGMENTS) segs = segs.slice(0, MAX_SEGMENTS);
  if (!segs.length) return [];

  // Grille d'accélération.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < x0) x0 = xs[i];
    if (xs[i] > x1) x1 = xs[i];
    if (ys[i] < y0) y0 = ys[i];
    if (ys[i] > y1) y1 = ys[i];
  }
  const span = Math.max(x1 - x0, y1 - y0, snap);
  const cell = Math.max(span / Math.max(8, Math.sqrt(segs.length) * 1.5), snap * 4);
  const cx = (x: number) => Math.floor((x - x0) / cell), cy = (y: number) => Math.floor((y - y0) / cell);
  const gridOf = (list: { a: number; b: number }[]) => {
    const g = new Map<number, number[]>();
    const W = cx(x1) + 2;
    list.forEach((s, i) => {
      const ax = cx(Math.min(xs[s.a], xs[s.b]) - snap), bx = cx(Math.max(xs[s.a], xs[s.b]) + snap);
      const ay = cy(Math.min(ys[s.a], ys[s.b]) - snap), by = cy(Math.max(ys[s.a], ys[s.b]) + snap);
      for (let gx = ax; gx <= bx; gx++) for (let gy = ay; gy <= by; gy++) {
        const k = gy * W + gx;
        const c = g.get(k);
        if (c) c.push(i);
        else g.set(k, [i]);
      }
    });
    return { g, W };
  };

  // ─── 1. Couper chaque segment aux nœuds posés sur lui (jonctions en T, recouvrements colinéaires) ───
  {
    const { g, W } = gridOf(segs);
    const onSeg = new Map<number, { t: number; n: number }[]>();
    for (let n = 0; n < xs.length; n++) {
      const c = g.get(cy(ys[n]) * W + cx(xs[n]));
      if (!c) continue;
      for (const i of c) {
        const s = segs[i];
        if (s.a === n || s.b === n) continue;
        const ax = xs[s.a], ay = ys[s.a], dx = xs[s.b] - ax, dy = ys[s.b] - ay;
        const L2 = dx * dx + dy * dy;
        const t = ((xs[n] - ax) * dx + (ys[n] - ay) * dy) / L2;
        if (t <= 0 || t >= 1) continue;
        const px = ax + t * dx - xs[n], py = ay + t * dy - ys[n];
        if (px * px + py * py > snap * snap) continue;
        const l = onSeg.get(i);
        if (l) l.push({ t, n });
        else onSeg.set(i, [{ t, n }]);
      }
    }
    if (onSeg.size) {
      const next: typeof segs = [];
      segs.forEach((s, i) => {
        const cutsAt = onSeg.get(i);
        if (!cutsAt) return next.push(s);
        cutsAt.sort((p, q) => p.t - q.t);
        let prev = s.a;
        for (const c of cutsAt) {
          if (c.n !== prev) next.push({ a: prev, b: c.n, prio: s.prio });
          prev = c.n;
        }
        if (prev !== s.b) next.push({ a: prev, b: s.b, prio: s.prio });
      });
      segs = next;
    }
  }

  // ─── 2. Doublons ───
  const edges: Edge[] = [];
  {
    const seen = new Map<string, number>();
    for (const s of segs) {
      const k = s.a < s.b ? `${s.a}:${s.b}` : `${s.b}:${s.a}`;
      const at = seen.get(k);
      if (at !== undefined) {
        if (s.prio < edges[at].prio) edges[at].prio = s.prio;
        continue;
      }
      seen.set(k, edges.length);
      edges.push({ a: s.a, b: s.b, prio: s.prio, cuts: [] });
    }
  }
  const len = (e: Edge) => Math.hypot(xs[e.b] - xs[e.a], ys[e.b] - ys[e.a]);

  if (gap > 0) {
    // ─── 3. Croisements : le trait le plus récent est interrompu ───
    const { g } = gridOf(edges);
    const tested = new Set<number>();
    const pairKey = (i: number, j: number) => (i < j ? i * edges.length + j : j * edges.length + i);
    for (const c of g.values()) {
      for (let p = 0; p < c.length; p++) for (let q = p + 1; q < c.length; q++) {
        const i = c[p], j = c[q];
        const E = edges[i], F = edges[j];
        if (E.a === F.a || E.a === F.b || E.b === F.a || E.b === F.b) continue;
        const k = pairKey(i, j);
        if (tested.has(k)) continue;
        tested.add(k);
        const ax = xs[E.a], ay = ys[E.a], rx = xs[E.b] - ax, ry = ys[E.b] - ay;
        const bx = xs[F.a], by = ys[F.a], sx = xs[F.b] - bx, sy = ys[F.b] - by;
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((bx - ax) * sy - (by - ay) * sx) / den;
        const u = ((bx - ax) * ry - (by - ay) * rx) / den;
        if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue;
        // Le moins prioritaire (entré plus tard) s'interrompt.
        const [cut, at] = F.prio > E.prio || (F.prio === E.prio && j > i) ? [F, u] : [E, t];
        const h = gap / Math.max(len(cut), 1e-9);
        cut.cuts.push([at - h, at + h]);
      }
    }

    // ─── 4. Jonctions : les deux traits les mieux alignés passent, les autres reculent ───
    const around = new Map<number, number[]>();
    edges.forEach((e, i) => {
      for (const n of [e.a, e.b]) {
        const l = around.get(n);
        if (l) l.push(i);
        else around.set(n, [i]);
      }
    });
    for (const [n, list] of around) {
      if (list.length < 3) continue;
      const dir = list.map((i) => {
        const e = edges[i];
        const o2 = e.a === n ? e.b : e.a;
        const dx = xs[o2] - xs[n], dy = ys[o2] - ys[n];
        const L = Math.hypot(dx, dy) || 1;
        return [dx / L, dy / L] as P2;
      });
      // Paire la plus droite ; à égalité, celle des traits entrés en premier.
      let best = [0, 1], score = Infinity;
      for (let p = 0; p < list.length; p++) for (let q = p + 1; q < list.length; q++) {
        const d = dir[p][0] * dir[q][0] + dir[p][1] * dir[q][1];
        const s = d + (edges[list[p]].prio + edges[list[q]].prio) * 1e-6;
        if (s < score) { score = s; best = [p, q]; }
      }
      list.forEach((i, p) => {
        if (p === best[0] || p === best[1]) return;
        const e = edges[i];
        const h = gap / Math.max(len(e), 1e-9);
        e.cuts.push(e.a === n ? [-1, h] : [1 - h, 2]);
      });
    }
  }

  // ─── 5. Morceaux gardés ───
  type Piece = { a: number; b: number; pts: P2[] };
  const pieces: Piece[] = [];
  let extra = xs.length;
  for (const e of edges) {
    const L = len(e);
    const P = (t: number): P2 => [xs[e.a] + (xs[e.b] - xs[e.a]) * t, ys[e.a] + (ys[e.b] - ys[e.a]) * t];
    const cuts = e.cuts.map(([p, q]) => [Math.max(0, p), Math.min(1, q)] as [number, number]).filter(([p, q]) => q > p).sort((p, q) => p[0] - q[0]);
    let from = 0;
    const keep: [number, number][] = [];
    for (const [p, q] of cuts) {
      if (p > from) keep.push([from, p]);
      from = Math.max(from, q);
    }
    if (from < 1) keep.push([from, 1]);
    for (const [p, q] of keep) {
      if ((q - p) * L < minLength) continue;
      pieces.push({ a: p === 0 ? e.a : extra++, b: q === 1 ? e.b : extra++, pts: [P(p), P(q)] });
    }
  }

  // ─── 6. Recoudre ───
  const adj = new Map<number, number[]>();
  pieces.forEach((pc, i) => {
    for (const n of [pc.a, pc.b]) {
      const l = adj.get(n);
      if (l) l.push(i);
      else adj.set(n, [i]);
    }
  });
  const used = new Uint8Array(pieces.length);
  const out: Polyline[] = [];
  const walk = (start: number, first: number) => {
    const pts: P2[] = [];
    let at = start, i = first;
    for (;;) {
      used[i] = 1;
      const pc = pieces[i];
      const fwd = pc.a === at;
      const seq = fwd ? pc.pts : [...pc.pts].reverse();
      if (!pts.length) pts.push(seq[0]);
      for (let k = 1; k < seq.length; k++) pts.push(seq[k]);
      at = fwd ? pc.b : pc.a;
      const nexts = adj.get(at) ?? [];
      if (nexts.length !== 2) break;
      const nx = nexts[0] === i ? nexts[1] : nexts[0];
      if (used[nx]) break;
      i = nx;
    }
    out.push(simplifyCollinear(pts));
  };
  // D'abord depuis les bouts et les jonctions restantes, puis les boucles.
  for (const [n, list] of adj) if (list.length !== 2) for (const i of list) if (!used[i]) walk(n, i);
  for (let i = 0; i < pieces.length; i++) if (!used[i]) walk(pieces[i].a, i);
  return out;
}

/** Retire les points intermédiaires alignés (segments découpés puis recousus). */
function simplifyCollinear(pts: P2[]): P2[] {
  if (pts.length < 3) return pts;
  const out: P2[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (Math.abs(cross) > 1e-6 * Math.max(L, 1e-9) * 10) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Longueur totale de tracés, en mm. */
export function strokeLength(lines: Polyline[]): number {
  let s = 0;
  for (const l of lines) for (let i = 1; i < l.length; i++) s += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
  return s;
}
