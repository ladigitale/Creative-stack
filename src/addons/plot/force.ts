/**
 * Graphes nœuds / liens : lecture des données, placement par forces (écrit à la main, sans d3) et placements
 * fixes (cercle, grille, arbre en couches). Logique pure, sans DOM : testable et déterministe (graine).
 */
import { Rng } from "../../shared/rng";

export const MAX_NODES = 2000;
export const MAX_LINKS = 10_000;
/** Au-delà, la répulsion passe par un quadtree de Barnes-Hut. */
export const BARNES_HUT_FROM = 300;

export type GraphNodeIn = { id: string; label?: string; group?: string; size?: number; x?: number; y?: number; fixed?: boolean };
export type GraphLinkIn = { source: string; target: string; weight?: number; label?: string; directed?: boolean };
export type GraphData = { nodes: GraphNodeIn[]; links: GraphLinkIn[]; errors: string[] };

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown): string | undefined => (v === null || v === undefined || typeof v === "object" ? undefined : String(v));

/**
 * Normalise un graphe. Formes acceptées :
 * - `{nodes: [{id, label?, group?, size?, x?, y?, fixed?}], links: [{source, target, weight?, label?, directed?}]}`
 *   (`edges` = alias de `links` ; un nœud peut être une simple chaîne ; `source` / `target` = id, ou rang du nœud) ;
 * - la forme de `$graphPath` : `{edges: [["a", "b", 2], …], directed?, nodes?: ["a", …]}` ;
 * - une liste d'adjacence `{"a": {"b": 2}, "b": ["c"]}` (liens orientés, comme pour `$graphPath`).
 * Les nœuds cités par un lien mais absents de `nodes` sont créés.
 */
export function normalizeGraph(input: unknown): GraphData {
  const errors: string[] = [];
  const nodes: GraphNodeIn[] = [];
  const links: GraphLinkIn[] = [];
  const byId = new Map<string, GraphNodeIn>();
  let dropped = 0;
  const ensure = (id: string): GraphNodeIn | null => {
    const hit = byId.get(id);
    if (hit) return hit;
    if (nodes.length >= MAX_NODES) {
      dropped++;
      return null;
    }
    const n: GraphNodeIn = { id };
    nodes.push(n);
    byId.set(id, n);
    return n;
  };
  if (!input || typeof input !== "object") return { nodes, links, errors };
  const o = input as Record<string, unknown>;
  const linkList = Array.isArray(o.links) ? o.links : Array.isArray(o.edges) ? o.edges : null;
  const isGraphShape = Array.isArray(o.nodes) || linkList !== null;
  const globalDirected = o.directed === true;

  if (isGraphShape) {
    const rawNodes = Array.isArray(o.nodes) ? o.nodes : [];
    for (const raw of rawNodes) {
      const r: Record<string, unknown> = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : { id: raw };
      const id = str(r.id);
      if (id === undefined || id === "") continue;
      if (byId.has(id)) continue;
      const n = ensure(id);
      if (!n) continue;
      const label = str(r.label);
      if (label !== undefined) n.label = label;
      const group = str(r.group);
      if (group !== undefined) n.group = group;
      const size = num(r.size);
      if (size !== undefined && size > 0) n.size = size;
      const x = num(r.x), y = num(r.y);
      if (x !== undefined && y !== undefined) {
        n.x = x;
        n.y = y;
      }
      if (r.fixed === true) n.fixed = true;
    }
    const declared = nodes.slice();
    const ref = (v: unknown): string | undefined => {
      if (v && typeof v === "object") return str((v as Record<string, unknown>).id);
      const s = str(v);
      if (s === undefined) return undefined;
      // Rang du nœud (comme d3) quand l'id n'existe pas.
      if (!byId.has(s) && typeof v === "number" && Number.isInteger(v) && v >= 0 && v < declared.length) return declared[v].id;
      return s;
    };
    for (const raw of linkList ?? []) {
      if (links.length >= MAX_LINKS) {
        errors.push(`trop de liens : ${MAX_LINKS} au plus`);
        break;
      }
      let s: string | undefined, t: string | undefined;
      const l: Partial<GraphLinkIn> = {};
      if (Array.isArray(raw)) {
        s = ref(raw[0]);
        t = ref(raw[1]);
        const w = num(raw[2]);
        if (w !== undefined) l.weight = w;
        if (globalDirected) l.directed = true;
      } else if (raw && typeof raw === "object") {
        const r = raw as Record<string, unknown>;
        s = ref(r.source ?? r.from);
        t = ref(r.target ?? r.to);
        const w = num(r.weight ?? r.value);
        if (w !== undefined) l.weight = w;
        const label = str(r.label);
        if (label !== undefined) l.label = label;
        if (r.directed === true || (globalDirected && r.directed !== false)) l.directed = true;
      }
      if (s === undefined || t === undefined || s === "" || t === "") continue;
      if (!ensure(s) || !ensure(t)) continue;
      links.push({ source: s, target: t, ...l });
    }
  } else {
    // Liste d'adjacence (forme de $graphPath).
    for (const [a, v] of Object.entries(o)) {
      if (!ensure(a)) continue;
      const add = (b: string, w?: number) => {
        if (links.length >= MAX_LINKS || !ensure(b)) return;
        links.push({ source: a, target: b, directed: true, ...(w !== undefined && w !== 1 ? { weight: w } : {}) });
      };
      if (Array.isArray(v)) for (const b of v) { const s = str(b); if (s) add(s); }
      else if (v && typeof v === "object") for (const [b, w] of Object.entries(v)) add(b, num(w));
    }
  }
  if (dropped) errors.push(`trop de nœuds : ${MAX_NODES} au plus (${dropped} ignorés)`);
  return { nodes, links, errors };
}

/* ———————————————————————— simulation ———————————————————————— */

export type SimNode = {
  id: string;
  index: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** Position imposée (nœud figé : donnée `fixed`, glisser, `pin`). */
  fx: number | null;
  fy: number | null;
};
export type SimLink = { s: number; t: number; strength: number; bias: number; distance: number };

export type ForceOptions = {
  seed?: string | number;
  /** Répulsion entre nœuds (négative = repousse). */
  charge?: number;
  /** Longueur de repos des liens. */
  linkDistance?: number;
  /** Attraction vers le centre (0..1). */
  gravity?: number;
  /** Marge de collision ajoutée au rayon. */
  collidePadding?: number;
  alphaMin?: number;
  /** Frottement : part de la vitesse perdue à chaque pas. */
  velocityDecay?: number;
  theta?: number;
};

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Rayon affiché d'un nœud (`size` = rayon en unités du graphe, 6 par défaut). */
export const nodeRadius = (n: { size?: number }): number => clamp(n.size ?? 6, 2, 40);

type Quad = { x0: number; y0: number; size: number; count: number; cx: number; cy: number; kids: Quad[] | null; pts: number[] | null };

export class ForceSim {
  nodes: SimNode[] = [];
  links: SimLink[] = [];
  alpha = 1;
  alphaMin: number;
  alphaDecay: number;
  alphaTarget = 0;
  readonly charge: number;
  readonly linkDistance: number;
  readonly gravity: number;
  readonly padding: number;
  readonly velocityDecay: number;
  readonly theta2: number;
  private rng: Rng;
  private index = new Map<string, number>();
  ticks = 0;

  constructor(opts: ForceOptions = {}) {
    this.rng = new Rng(opts.seed ?? 1);
    this.charge = opts.charge ?? -60;
    this.linkDistance = opts.linkDistance ?? 40;
    this.gravity = clamp(opts.gravity ?? 0.06, 0, 1);
    this.padding = opts.collidePadding ?? 2;
    this.alphaMin = opts.alphaMin ?? 0.002;
    this.alphaDecay = 1 - Math.pow(this.alphaMin, 1 / 300);
    this.velocityDecay = clamp(opts.velocityDecay ?? 0.4, 0, 1);
    const th = opts.theta ?? 0.9;
    this.theta2 = th * th;
  }

  /**
   * Charge (ou recharge) le graphe. Les nœuds déjà présents (même id) gardent position et vitesse ; un nouveau
   * nœud part près d'un voisin déjà placé, sinon d'une position tirée de la graine (`x` / `y` des données sinon).
   * Renvoie le nombre de nœuds conservés.
   */
  setGraph(data: GraphData): number {
    const prev = new Map(this.nodes.map((n) => [n.id, n]));
    const index = new Map<string, number>();
    data.nodes.forEach((n, i) => index.set(n.id, i));
    const neighbors = new Map<string, string[]>();
    for (const l of data.links) {
      (neighbors.get(l.source) ?? neighbors.set(l.source, []).get(l.source)!).push(l.target);
      (neighbors.get(l.target) ?? neighbors.set(l.target, []).get(l.target)!).push(l.source);
    }
    let kept = 0;
    const spread = 10 * Math.sqrt(data.nodes.length + 1) + 20;
    const out: SimNode[] = [];
    const rng = this.rng.fork("place");
    data.nodes.forEach((n, i) => {
      const old = prev.get(n.id);
      const r = nodeRadius(n);
      const fixed = n.fixed && n.x !== undefined && n.y !== undefined;
      if (old) {
        kept++;
        out.push({ ...old, index: i, r, fx: fixed ? n.x! : old.fx, fy: fixed ? n.y! : old.fy });
        return;
      }
      let x: number, y: number;
      const near = (neighbors.get(n.id) ?? []).map((id) => prev.get(id)).find(Boolean);
      const local = rng.fork(n.id);
      if (n.x !== undefined && n.y !== undefined) {
        x = n.x;
        y = n.y;
      } else if (near) {
        const a = local.next() * Math.PI * 2;
        x = near.x + Math.cos(a) * this.linkDistance * 0.5;
        y = near.y + Math.sin(a) * this.linkDistance * 0.5;
      } else {
        // Disque de rayon `spread`, tirage stable par id.
        const a = local.next() * Math.PI * 2;
        const d = Math.sqrt(local.next()) * spread;
        x = Math.cos(a) * d;
        y = Math.sin(a) * d;
      }
      out.push({ id: n.id, index: i, x, y, vx: 0, vy: 0, r, fx: fixed ? x : null, fy: fixed ? y : null });
    });
    this.nodes = out;
    this.index = index;
    const degree = new Array(out.length).fill(0);
    const pairs: [number, number, number][] = [];
    for (const l of data.links) {
      const s = index.get(l.source), t = index.get(l.target);
      if (s === undefined || t === undefined || s === t) continue;
      degree[s]++;
      degree[t]++;
      pairs.push([s, t, l.weight ?? 1]);
    }
    this.links = pairs.map(([s, t, w]) => ({
      s,
      t,
      // Lien plus lourd = ressort plus raide (borné pour rester stable).
      strength: clamp((1 / Math.min(degree[s], degree[t])) * clamp(Math.abs(w), 0.25, 3), 0, 1),
      bias: degree[s] / (degree[s] + degree[t]),
      distance: this.linkDistance + (out[s].r + out[t].r) * 0.5,
    }));
    return kept;
  }

  indexOf(id: string): number | undefined {
    return this.index.get(id);
  }

  /** Relance le refroidissement (après un changement de données ou un glisser). */
  reheat(alpha = 1): void {
    this.alpha = Math.max(this.alpha, clamp(alpha, 0, 1));
  }

  get settled(): boolean {
    return this.alpha < this.alphaMin && this.alphaTarget < this.alphaMin;
  }

  /** Énergie cinétique (somme des carrés des vitesses) : décroît quand le graphe se pose. */
  energy(): number {
    let e = 0;
    for (const n of this.nodes) e += n.vx * n.vx + n.vy * n.vy;
    return e;
  }

  tick(count = 1): void {
    for (let k = 0; k < count; k++) {
      this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay;
      this.ticks++;
      this.forceLinks();
      this.forceCharge();
      this.forceGravity();
      this.forceCollide();
      const keep = 1 - this.velocityDecay;
      for (const n of this.nodes) {
        if (n.fx !== null && n.fy !== null) {
          n.x = n.fx;
          n.y = n.fy;
          n.vx = n.vy = 0;
          continue;
        }
        n.vx *= keep;
        n.vy *= keep;
        n.x += n.vx;
        n.y += n.vy;
      }
    }
  }

  private jiggle(): number {
    return (this.rng.next() - 0.5) * 1e-6;
  }

  private forceLinks(): void {
    const N = this.nodes;
    for (const l of this.links) {
      const s = N[l.s], t = N[l.t];
      let x = t.x + t.vx - s.x - s.vx || this.jiggle();
      let y = t.y + t.vy - s.y - s.vy || this.jiggle();
      let d = Math.sqrt(x * x + y * y);
      d = ((d - l.distance) / d) * this.alpha * l.strength;
      x *= d;
      y *= d;
      t.vx -= x * l.bias;
      t.vy -= y * l.bias;
      s.vx += x * (1 - l.bias);
      s.vy += y * (1 - l.bias);
    }
  }

  private forceCharge(): void {
    const N = this.nodes;
    const k = this.charge * this.alpha;
    if (!k || N.length < 2) return;
    if (N.length <= BARNES_HUT_FROM) {
      for (let i = 0; i < N.length; i++) {
        const a = N[i];
        for (let j = i + 1; j < N.length; j++) {
          const b = N[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          if (!dx && !dy) {
            dx = this.jiggle();
            dy = this.jiggle();
          }
          const l = Math.max(dx * dx + dy * dy, 1);
          const f = k / l;
          // a est poussé loin de b (k < 0) et inversement.
          a.vx += dx * f;
          a.vy += dy * f;
          b.vx -= dx * f;
          b.vy -= dy * f;
        }
      }
      return;
    }
    const root = this.quadtree();
    for (const n of N) this.applyQuad(root, n, k);
  }

  /** Quadtree de Barnes-Hut (centre de masse par cellule). */
  quadtree(): Quad {
    const N = this.nodes;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of N) {
      if (n.x < x0) x0 = n.x;
      if (n.y < y0) y0 = n.y;
      if (n.x > x1) x1 = n.x;
      if (n.y > y1) y1 = n.y;
    }
    const size = Math.max(x1 - x0, y1 - y0, 1);
    const build = (pts: number[], qx: number, qy: number, s: number, depth: number): Quad => {
      let cx = 0, cy = 0;
      for (const i of pts) {
        cx += N[i].x;
        cy += N[i].y;
      }
      const q: Quad = { x0: qx, y0: qy, size: s, count: pts.length, cx: cx / pts.length, cy: cy / pts.length, kids: null, pts: null };
      if (pts.length <= 1 || depth >= 16) {
        q.pts = pts;
        return q;
      }
      const h = s / 2;
      const parts: number[][] = [[], [], [], []];
      for (const i of pts) parts[(N[i].x >= qx + h ? 1 : 0) + (N[i].y >= qy + h ? 2 : 0)].push(i);
      q.kids = [];
      parts.forEach((p, k) => {
        if (p.length) q.kids!.push(build(p, qx + (k & 1 ? h : 0), qy + (k & 2 ? h : 0), h, depth + 1));
      });
      return q;
    };
    return build(N.map((_, i) => i), x0, y0, size, 0);
  }

  private applyQuad(q: Quad, n: SimNode, k: number): void {
    const dx = q.cx - n.x, dy = q.cy - n.y;
    const d2 = dx * dx + dy * dy;
    if (q.kids && (q.size * q.size) / Math.max(d2, 1e-9) < this.theta2) {
      const f = (k * q.count) / Math.max(d2, 1);
      n.vx += dx * f;
      n.vy += dy * f;
      return;
    }
    if (q.kids) {
      for (const c of q.kids) this.applyQuad(c, n, k);
      return;
    }
    for (const j of q.pts!) {
      const b = this.nodes[j];
      if (b === n) continue;
      let ex = b.x - n.x, ey = b.y - n.y;
      if (!ex && !ey) {
        ex = this.jiggle();
        ey = this.jiggle();
      }
      const f = k / Math.max(ex * ex + ey * ey, 1);
      n.vx += ex * f;
      n.vy += ey * f;
    }
  }

  private forceGravity(): void {
    const g = this.gravity * this.alpha;
    if (!g) return;
    for (const n of this.nodes) {
      n.vx -= n.x * g;
      n.vy -= n.y * g;
    }
  }

  /** Collision par rayon, grille de hachage (cellule = plus grand diamètre). */
  private forceCollide(): void {
    const N = this.nodes;
    if (N.length < 2) return;
    let maxR = 0;
    for (const n of N) maxR = Math.max(maxR, n.r + this.padding);
    const cell = maxR * 2;
    const grid = new Map<string, number[]>();
    const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    N.forEach((n, i) => {
      const k = key(n.x + n.vx, n.y + n.vy);
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    });
    const strength = 0.7;
    for (let i = 0; i < N.length; i++) {
      const a = N[i];
      const ax = a.x + a.vx, ay = a.y + a.vy;
      const gx = Math.floor(ax / cell), gy = Math.floor(ay / cell);
      for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++) {
          const list = grid.get(`${gx + ox},${gy + oy}`);
          if (!list) continue;
          for (const j of list) {
            if (j <= i) continue;
            const b = N[j];
            const r = a.r + b.r + this.padding * 2;
            let dx = ax - (b.x + b.vx) || this.jiggle(), dy = ay - (b.y + b.vy) || this.jiggle();
            let l = dx * dx + dy * dy;
            if (l >= r * r) continue;
            l = Math.sqrt(l);
            const m = ((r - l) / l) * strength;
            dx *= m;
            dy *= m;
            const rb = b.r * b.r, ra = a.r * a.r;
            const wa = rb / (ra + rb);
            a.vx += dx * wa;
            a.vy += dy * wa;
            b.vx -= dx * (1 - wa);
            b.vy -= dy * (1 - wa);
          }
        }
    }
  }
}

/* ———————————————————————— placements fixes ———————————————————————— */

export type LayoutKind = "force" | "circle" | "grid" | "tree";
export const LAYOUTS: LayoutKind[] = ["force", "circle", "grid", "tree"];
export const sanitizeLayout = (v: unknown): LayoutKind => (LAYOUTS.includes(v as LayoutKind) ? (v as LayoutKind) : "force");

/**
 * Positions d'un placement fixe (centrées sur 0, 0). `spacing` = écart entre nœuds voisins.
 * `tree` : arbre en couches depuis `root` (id ; défaut : premier nœud sans lien entrant, sinon le premier),
 * parcours en largeur sur les liens pris sans sens ; chaque parent est centré sur ses enfants ; les nœuds
 * hors de l'arbre forment d'autres arbres posés à droite.
 */
export function staticLayout(kind: Exclude<LayoutKind, "force">, data: GraphData, opts: { root?: string; spacing?: number } = {}): Map<string, [number, number]> {
  const pos = new Map<string, [number, number]>();
  const N = data.nodes;
  const sp = opts.spacing ?? 50;
  if (!N.length) return pos;
  if (kind === "circle") {
    const R = N.length === 1 ? 0 : Math.max(sp * 1.5, (N.length * sp) / (2 * Math.PI));
    N.forEach((n, i) => {
      const a = -Math.PI / 2 + (i / N.length) * Math.PI * 2;
      pos.set(n.id, [Math.cos(a) * R, Math.sin(a) * R]);
    });
    return pos;
  }
  if (kind === "grid") {
    const cols = Math.ceil(Math.sqrt(N.length));
    const rows = Math.ceil(N.length / cols);
    N.forEach((n, i) => pos.set(n.id, [((i % cols) - (cols - 1) / 2) * sp, (Math.floor(i / cols) - (rows - 1) / 2) * sp]));
    return pos;
  }
  // Arbre en couches.
  const adj = new Map<string, string[]>(N.map((n) => [n.id, []]));
  const incoming = new Set<string>();
  for (const l of data.links) {
    adj.get(l.source)?.push(l.target);
    adj.get(l.target)?.push(l.source);
    incoming.add(l.target);
  }
  const roots: string[] = [];
  if (opts.root && adj.has(opts.root)) roots.push(opts.root);
  const children = new Map<string, string[]>();
  const depth = new Map<string, number>();
  const visit = (r: string) => {
    depth.set(r, 0);
    children.set(r, []);
    const queue = [r];
    for (let qi = 0; qi < queue.length; qi++) {
      const u = queue[qi];
      for (const v of adj.get(u) ?? []) {
        if (depth.has(v)) continue;
        depth.set(v, depth.get(u)! + 1);
        children.get(u)!.push(v);
        children.set(v, []);
        queue.push(v);
      }
    }
  };
  if (roots[0]) visit(roots[0]);
  const candidates = [...N.filter((n) => !incoming.has(n.id)), ...N];
  for (const n of candidates) {
    if (depth.has(n.id)) continue;
    roots.push(n.id);
    visit(n.id);
  }
  // Feuilles posées l'une après l'autre ; parent centré sur ses enfants.
  let slot = 0;
  const xs = new Map<string, number>();
  const place = (u: string): number => {
    const kids = children.get(u) ?? [];
    let x: number;
    if (!kids.length) x = slot++;
    else {
      const k = kids.map(place);
      x = (k[0] + k[k.length - 1]) / 2;
    }
    xs.set(u, x);
    return x;
  };
  for (const r of roots) {
    place(r);
    slot += 0.5; // écart entre deux arbres
  }
  let maxDepth = 0;
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
  const width = Math.max(slot - 1.5, 0);
  for (const n of N) pos.set(n.id, [(xs.get(n.id)! - width / 2) * sp, (depth.get(n.id)! - maxDepth / 2) * sp * 1.4]);
  return pos;
}
