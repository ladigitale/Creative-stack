/**
 * Simulation d'essaims (sans DOM) : agents ponctuels à vitesse et force bornées (pilotage de Reynolds), comportements
 * pondérés et cumulés — séparation, alignement, cohésion (boids), errance, chercher, fuir, arriver, poursuivre,
 * esquiver, suivre un chemin, descendre un champ de flux sur grille — avec murs de grille, bords (boucle, rebond,
 * retenue) et captures. Voisins trouvés par grille de hachage : coût ~linéaire en nombre d'agents.
 */
import { type Grid, readGrid } from "../../shared/algo/grid";
import { SmoothWalls } from "../../shared/algo/walls";
import { cachedField } from "../../shared/algo/path";
import { Rng } from "../../shared/algo/rng";

export const MAX_AGENTS = 200;

/**
 * Cible : point `[x, y]`, `"group:<nom>"` (agent le plus proche du groupe), `"agent:<nom>"` ou `"dp:<chemin>"`
 * (`{name}` dans le chemin = nom de l'agent : une cible par agent, ex. `dp:jeu.cibles.{name}`).
 */
export type TargetRef = [number, number] | string;

export interface Weighted {
  weight?: number;
  target?: TargetRef;
  /** fuir / esquiver : distance d'effet ; arriver : distance de freinage ; capture : distance de prise. */
  radius?: number;
}

export interface GroupSpec {
  name: string;
  count?: number;
  /** Préfixe des noms d'agents (`<prefix><i>`), défaut : nom du groupe. */
  prefix?: string;
  maxSpeed?: number;
  maxForce?: number;
  /** Rayon du corps (séparation, murs, captures). */
  radius?: number;
  /** Distance de perception des voisins (boids). */
  view?: number;
  separation?: number | Weighted;
  alignment?: number;
  cohesion?: number;
  wander?: number;
  seek?: Weighted;
  flee?: Weighted;
  arrive?: Weighted;
  pursue?: Weighted;
  evade?: Weighted;
  /** Suivre des points `[[x, y], …]` (boucle par défaut). */
  path?: { points: [number, number][]; loop?: boolean; weight?: number };
  /** Descendre le champ de distances de la grille vers `target`. */
  flow?: Weighted;
  /**
   * Capture : action envoyée quand un agent de `target` (groupe) est à `radius` ; `respawn` replace la proie,
   * `remove` la retire (elle ne revient plus, même si la description change, jusqu'au prochain `respawnAll`).
   */
  catch?: Weighted & { respawn?: boolean; remove?: boolean };
  /**
   * Meneur : chaque agent suit (arrive) l'agent le plus proche de `target` (groupe) à moins de `radius` (sans limite
   * si absent) et le garde ; il change de meneur quand un autre passe à moins de `swap` (radius / 3) et plus près.
   * `colors` {meneur: couleur} : la couleur de l'agent suit son meneur (`color` dans `nodes`, et `roles.<role>` pour
   * une instance monde2d, `role` = "peau") ; `lost` : couleur sans meneur.
   */
  follow?: Weighted & { swap?: number; slow?: number; colors?: Record<string, string>; role?: string; lost?: string };
  /** Zone d'apparition `[x0, y0, x1, y1]`, défaut : tout le monde. */
  spawn?: [number, number, number, number];
  /** Sprite `sonic-2d` publié pour chaque agent (mêmes clés que sonic-sprite, `name` ajouté). */
  sprite?: Record<string, unknown>;
}

export interface WorldSpec {
  bounds?: [number, number, number, number];
  /** `steer` (retenue douce, défaut), `wrap` (tore), `bounce`. */
  edges?: "steer" | "wrap" | "bounce";
  /**
   * Murs : grille de algo (lignes de texte), `cell` = taille d'une case en unités du monde. `smooth` (0 à 4, comme
   * `$gridContours`) : les agents heurtent les parois lissées, celles que `$gridContours` dessine avec le même `smooth`,
   * au lieu des cases carrées.
   */
  grid?: { rows: string[]; cell?: number; walls?: string; costs?: Record<string, number>; diag?: boolean; smooth?: number };
  seed?: number | string;
  groups?: GroupSpec[];
}

export interface Agent {
  name: string;
  group: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  wander: number;
  waypoint: number;
  cooldown: number;
  /** Nom du meneur (`follow`), null sans meneur. */
  leader: string | null;
}

export interface CatchEvent {
  by: string;
  caught: string;
  group: string;
  x: number;
  y: number;
  /** Meneur de la proie (`follow`) au moment de la capture. */
  leader: string | null;
}

type Resolve = (ref: string) => [number, number] | null;

const w = (v: number | Weighted | undefined, d = 1): number => (typeof v === "number" ? v : v ? (v.weight ?? d) : 0);

function limit(x: number, y: number, max: number): [number, number] {
  const m = Math.hypot(x, y);
  return m > max && m > 0 ? [(x / m) * max, (y / m) * max] : [x, y];
}

export class Swarm {
  agents: Agent[] = [];
  /** Agents retirés par une capture `remove` (noms) : absents jusqu'à `respawnAll`. */
  removed = new Set<string>();
  /** Retirés depuis la dernière lecture (`takeRemoved`) : à cacher dans le rendu. */
  private removedNew: string[] = [];
  /** Meneurs changés depuis la dernière lecture (`takeLeaderChanges`). */
  private leaderChanged = new Set<string>();
  groups: GroupSpec[] = [];
  bounds: [number, number, number, number] = [0, 0, 800, 600];
  edges: NonNullable<WorldSpec["edges"]> = "steer";
  grid: Grid | null = null;
  /** Parois lissées (`grid.smooth`), null : cases carrées. */
  walls: SmoothWalls | null = null;
  cell = 32;
  private gridSpec: WorldSpec["grid"] | null = null;
  private rng: Rng;
  private hash = new Map<number, number[]>();
  private hashSize = 50;

  constructor(seed: unknown = 1) {
    this.rng = new Rng(seed);
  }

  /** Applique une description : groupes ajoutés, retirés ou redimensionnés ; les agents existants gardent leur état. */
  configure(spec: WorldSpec): void {
    if (Array.isArray(spec.bounds) && spec.bounds.length === 4) this.bounds = spec.bounds.map(Number) as Swarm["bounds"];
    this.edges = spec.edges === "wrap" || spec.edges === "bounce" ? spec.edges : "steer";
    this.grid = null;
    this.gridSpec = spec.grid ?? null;
    if (spec.grid && Array.isArray(spec.grid.rows) && spec.grid.rows.length) {
      this.cell = Math.max(1, Number(spec.grid.cell) || 32);
      this.grid = readGrid(spec.grid.rows, { walls: spec.grid.walls, costs: spec.grid.costs, diag: spec.grid.diag ?? true });
    }
    this.walls = this.grid && spec.grid && spec.grid.smooth != null && Number.isFinite(Number(spec.grid.smooth))
      ? wallsFor(this.grid, spec.grid, this.cell)
      : null;
    const groups = (spec.groups ?? []).filter((g) => g && typeof g.name === "string").slice(0, 16);
    let total = 0;
    const keep: Agent[] = [];
    groups.forEach((g, gi) => {
      const n = Math.max(0, Math.min(MAX_AGENTS - total, Math.floor(Number(g.count ?? 1))));
      total += n;
      const prefix = g.prefix ?? g.name;
      const old = this.agents.filter((a) => this.groups[a.group]?.name === g.name);
      const byName = new Map(old.map((a) => [a.name, a]));
      for (let i = 0; i < n; i++) {
        const name = `${prefix}${i}`;
        if (this.removed.has(name)) continue;
        const a = byName.get(name);
        if (a) keep.push({ ...a, group: gi });
        else keep.push(this.spawn(g, gi, name));
      }
    });
    // agents en trop (groupe réduit ou retiré) : à cacher dans le rendu, comme une capture
    const kept = new Set(keep.map((a) => a.name));
    for (const a of this.agents) if (!kept.has(a.name)) this.removedNew.push(a.name);
    this.groups = groups;
    this.agents = keep;
    this.hashSize = Math.max(8, ...groups.map((g) => Math.max(g.view ?? 50, (g.radius ?? 6) * 4)));
  }

  private spawn(g: GroupSpec, gi: number, name: string): Agent {
    const [x0, y0, x1, y1] = Array.isArray(g.spawn) && g.spawn.length === 4 ? g.spawn : this.bounds;
    let x = 0, y = 0;
    for (let t = 0; t < 30; t++) {
      x = x0 + this.rng.next() * (x1 - x0);
      y = y0 + this.rng.next() * (y1 - y0);
      if (!this.blocked(x, y)) break;
    }
    const a = this.rng.next() * Math.PI * 2;
    const s = (g.maxSpeed ?? 100) * 0.5;
    return { name, group: gi, x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, wander: a, waypoint: 0, cooldown: 0, leader: null };
  }

  /** Tous les agents replacés dans leur zone d'apparition, les retirés reviennent (nouveau niveau). */
  respawnAll(): void {
    this.removed.clear();
    const before = this.agents.map((a) => a.name);
    const groups = this.groups;
    this.groups = [];
    this.agents = [];
    this.configure({ bounds: this.bounds, edges: this.edges, groups, grid: this.gridSpec ?? undefined });
    const now = new Set(this.agents.map((a) => a.name));
    for (const n of before) if (!now.has(n)) this.removedNew.push(n);
    for (const a of this.agents) this.leaderChanged.add(a.name);
  }

  takeRemoved(): string[] {
    const r = this.removedNew;
    this.removedNew = [];
    return r;
  }

  takeLeaderChanges(): string[] {
    const r = [...this.leaderChanged];
    this.leaderChanged.clear();
    return r;
  }

  /** Suiveurs vivants par meneur (`follow`). */
  followers(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const a of this.agents) if (a.leader) out[a.leader] = (out[a.leader] ?? 0) + 1;
    return out;
  }

  /** Couleur d'un agent selon son meneur (`follow.colors`), ou undefined. */
  colorOf(a: Agent): string | undefined {
    const f = this.groups[a.group]?.follow;
    if (!f || !f.colors) return undefined;
    return (a.leader && f.colors[a.leader]) || f.lost;
  }

  blocked(x: number, y: number): boolean {
    const g = this.grid;
    if (!g) return false;
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h) return true;
    if (this.walls) {
      const hit = this.walls.query(x, y);
      if (hit) return !hit.free;
    }
    return g.cost[cy * g.w + cx] === Infinity;
  }

  private buildHash(): void {
    this.hash.clear();
    const s = this.hashSize;
    this.agents.forEach((a, i) => {
      const k = Math.floor(a.x / s) * 73856093 ^ Math.floor(a.y / s) * 19349663;
      let l = this.hash.get(k);
      if (!l) this.hash.set(k, (l = []));
      l.push(i);
    });
  }

  /** Indices des agents à moins de `r` (r ≤ taille de case du hachage). */
  near(x: number, y: number, r: number, out: number[]): number[] {
    out.length = 0;
    const s = this.hashSize;
    const cx = Math.floor(x / s), cy = Math.floor(y / s);
    const r2 = r * r;
    for (let j = cy - 1; j <= cy + 1; j++)
      for (let i = cx - 1; i <= cx + 1; i++) {
        const l = this.hash.get(i * 73856093 ^ j * 19349663);
        if (!l) continue;
        for (const k of l) {
          const b = this.agents[k];
          const dx = b.x - x, dy = b.y - y;
          if (dx * dx + dy * dy <= r2) out.push(k);
        }
      }
    return out;
  }

  /** Agent le plus proche d'un groupe (par nom), hors `self`. */
  nearestOf(group: string, x: number, y: number, self = -1): Agent | null {
    let best: Agent | null = null, bd = Infinity;
    this.agents.forEach((a, i) => {
      if (i === self || this.groups[a.group]?.name !== group) return;
      const d = (a.x - x) ** 2 + (a.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = a;
      }
    });
    return best;
  }

  private target(ref: TargetRef | undefined, self: Agent, idx: number, resolve: Resolve): { x: number; y: number; vx: number; vy: number } | null {
    if (Array.isArray(ref)) return { x: Number(ref[0]), y: Number(ref[1]), vx: 0, vy: 0 };
    if (typeof ref !== "string") return null;
    if (ref.startsWith("group:")) {
      const a = this.nearestOf(ref.slice(6), self.x, self.y, idx);
      return a ? { x: a.x, y: a.y, vx: a.vx, vy: a.vy } : null;
    }
    if (ref.startsWith("agent:")) {
      const a = this.agents.find((b) => b.name === ref.slice(6));
      return a && a !== self ? { x: a.x, y: a.y, vx: a.vx, vy: a.vy } : null;
    }
    // `dp:jeu.cibles.{name}` : une cible par agent
    const p = resolve(ref.includes("{name}") ? ref.split("{name}").join(self.name) : ref);
    return p ? { x: p[0], y: p[1], vx: 0, vy: 0 } : null;
  }

  /** Avance la simulation de `dt` secondes. Rend les captures survenues. */
  step(dt: number, resolve: Resolve = () => null): CatchEvent[] {
    const events: CatchEvent[] = [];
    if (!this.agents.length || dt <= 0) return events;
    this.buildHash();
    const tmp: number[] = [];
    const acc = new Float64Array(this.agents.length * 2);
    const [bx0, by0, bx1, by1] = this.bounds;
    this.agents.forEach((a, i) => {
      const g = this.groups[a.group];
      const maxSpeed = g.maxSpeed ?? 100, maxForce = g.maxForce ?? 200, radius = g.radius ?? 6, view = Math.min(g.view ?? 50, this.hashSize);
      let fx = 0, fy = 0;
      const steer = (dx: number, dy: number, weight: number) => {
        if (!weight) return;
        const [sx, sy] = limit(dx - a.vx, dy - a.vy, maxForce);
        fx += sx * weight;
        fy += sy * weight;
      };
      const toward = (tx: number, ty: number, speed = maxSpeed): [number, number] => {
        const dx = tx - a.x, dy = ty - a.y, d = Math.hypot(dx, dy) || 1;
        return [(dx / d) * speed, (dy / d) * speed];
      };
      // boids
      const ws = w(g.separation, 1.5), wa = g.alignment ?? 0, wc = g.cohesion ?? 0;
      if (ws || wa || wc) {
        this.near(a.x, a.y, view, tmp);
        let sx = 0, sy = 0, ax = 0, ay = 0, cx = 0, cy = 0, n = 0, ns = 0;
        const space = (typeof g.separation === "object" && g.separation.radius) || radius * 3;
        for (const k of tmp) {
          if (k === i) continue;
          const b = this.agents[k];
          const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy) || 1e-3;
          const reach = space + (this.groups[b.group].radius ?? 6);
          if (d < reach) {
            sx += (dx / d) * (1 - d / reach);
            sy += (dy / d) * (1 - d / reach);
            ns++;
          }
          if (b.group === a.group) {
            ax += b.vx;
            ay += b.vy;
            cx += b.x;
            cy += b.y;
            n++;
          }
        }
        if (ns) steer(...(limit(sx * maxSpeed, sy * maxSpeed, maxSpeed) as [number, number]), ws);
        if (n) {
          const am = Math.hypot(ax, ay);
          if (wa && am > 0) steer((ax / am) * maxSpeed, (ay / am) * maxSpeed, wa);
          if (wc) steer(...toward(cx / n, cy / n), wc);
        }
      }
      // errance : un point qui dérive sur un cercle devant l'agent
      if (g.wander) {
        a.wander += (this.rng.next() - 0.5) * 4 * dt * 6;
        const h = Math.atan2(a.vy, a.vx);
        const px = a.x + Math.cos(h) * maxSpeed * 0.6 + Math.cos(a.wander) * maxSpeed * 0.3;
        const py = a.y + Math.sin(h) * maxSpeed * 0.6 + Math.sin(a.wander) * maxSpeed * 0.3;
        steer(...toward(px, py), g.wander);
      }
      if (g.follow && typeof g.follow.target === "string") {
        const grp = g.follow.target.startsWith("group:") ? g.follow.target.slice(6) : g.follow.target;
        const radius = g.follow.radius ?? Infinity;
        const near = this.nearestOf(grp, a.x, a.y, i);
        const cur = a.leader ? this.agents.find((b) => b.name === a.leader && this.groups[b.group]?.name === grp) ?? null : null;
        let lead = cur;
        if (!cur) lead = near && Math.hypot(near.x - a.x, near.y - a.y) <= radius ? near : null;
        else if (near && near !== cur) {
          const swap = g.follow.swap ?? (Number.isFinite(radius) ? radius / 3 : 40);
          const dn = Math.hypot(near.x - a.x, near.y - a.y), dc = Math.hypot(cur.x - a.x, cur.y - a.y);
          if (dn < swap && dn < dc * 0.6) lead = near;
        }
        const name = lead ? lead.name : null;
        if (name !== a.leader) {
          a.leader = name;
          this.leaderChanged.add(a.name);
        }
        if (lead) {
          const d = Math.hypot(lead.x - a.x, lead.y - a.y);
          const slow = g.follow.slow ?? 60;
          steer(...toward(lead.x, lead.y, d < slow ? (maxSpeed * d) / slow : maxSpeed), w(g.follow));
        }
      }
      if (g.seek) {
        const t = this.target(g.seek.target, a, i, resolve);
        if (t) steer(...toward(t.x, t.y), w(g.seek));
      }
      if (g.arrive) {
        const t = this.target(g.arrive.target, a, i, resolve);
        if (t) {
          const d = Math.hypot(t.x - a.x, t.y - a.y);
          const slow = g.arrive.radius ?? 80;
          steer(...toward(t.x, t.y, d < slow ? (maxSpeed * d) / slow : maxSpeed), w(g.arrive));
        }
      }
      for (const key of ["flee", "evade"] as const) {
        const spec = g[key];
        if (!spec) continue;
        const t = this.target(spec.target, a, i, resolve);
        if (!t) continue;
        let tx = t.x, ty = t.y;
        if (key === "evade") {
          const ahead = Math.hypot(t.x - a.x, t.y - a.y) / maxSpeed;
          tx += t.vx * ahead;
          ty += t.vy * ahead;
        }
        const d = Math.hypot(tx - a.x, ty - a.y);
        const r = spec.radius ?? 120;
        if (d < r) {
          const [dx, dy] = toward(tx, ty);
          steer(-dx, -dy, w(spec) * (1 - d / r) * 2);
        }
      }
      if (g.pursue) {
        const t = this.target(g.pursue.target, a, i, resolve);
        if (t) {
          const ahead = Math.min(2, Math.hypot(t.x - a.x, t.y - a.y) / maxSpeed);
          steer(...toward(t.x + t.vx * ahead, t.y + t.vy * ahead), w(g.pursue));
        }
      }
      if (g.path && Array.isArray(g.path.points) && g.path.points.length) {
        const pts = g.path.points;
        if (a.waypoint >= pts.length) a.waypoint = g.path.loop === false ? pts.length - 1 : 0;
        const p = pts[a.waypoint];
        if (Math.hypot(p[0] - a.x, p[1] - a.y) < Math.max(radius * 2, 12) && (g.path.loop !== false || a.waypoint < pts.length - 1)) a.waypoint++;
        const q = pts[Math.min(a.waypoint, pts.length - 1)];
        steer(...toward(q[0], q[1]), g.path.weight ?? 1);
      }
      if (g.flow && this.grid) {
        const t = this.target(g.flow.target, a, i, resolve);
        if (t) {
          const dir = this.flowDir(a.x, a.y, t.x, t.y);
          if (dir) steer(dir[0] * maxSpeed, dir[1] * maxSpeed, w(g.flow));
        }
      }
      // murs : répulsion des cases pleines proches, le long de la normale (deux murs d'un couloir s'annulent)
      if (this.walls) {
        // parois lissées : écartement selon la normale de la paroi la plus proche
        const range = radius + this.cell * 0.4;
        const hit = this.walls.query(a.x, a.y);
        if (hit && (!hit.free || hit.dist < range)) {
          const m = hit.free ? 1 - hit.dist / range : 1.5;
          const along = a.vx * hit.nx + a.vy * hit.ny;
          steer(a.vx - Math.min(0, along) * hit.nx + hit.nx * maxSpeed * m, a.vy - Math.min(0, along) * hit.ny + hit.ny * maxSpeed * m, 2);
        }
      } else if (this.grid) {
        const range = radius + this.cell * 0.4;
        const cx = Math.floor(a.x / this.cell), cy = Math.floor(a.y / this.cell);
        let px = 0, py = 0;
        for (let j = cy - 1; j <= cy + 1; j++)
          for (let k = cx - 1; k <= cx + 1; k++) {
            if (!this.blocked((k + 0.5) * this.cell, (j + 0.5) * this.cell)) continue;
            const qx = Math.min(Math.max(a.x, k * this.cell), (k + 1) * this.cell);
            const qy = Math.min(Math.max(a.y, j * this.cell), (j + 1) * this.cell);
            const dx = a.x - qx, dy = a.y - qy, d = Math.hypot(dx, dy);
            if (d > 0 && d < range) {
              px += (dx / d) * (1 - d / range);
              py += (dy / d) * (1 - d / range);
            }
          }
        if (px || py) {
          const m = Math.hypot(px, py);
          // vitesse voulue : on garde la composante le long du mur, on écarte selon la normale
          const nx = px / m, ny = py / m;
          const along = a.vx * nx + a.vy * ny;
          steer(a.vx - Math.min(0, along) * nx + nx * maxSpeed * Math.min(1, m), a.vy - Math.min(0, along) * ny + ny * maxSpeed * Math.min(1, m), 2);
        }
      }
      // bords
      if (this.edges === "steer") {
        const m = Math.min(60, (bx1 - bx0) * 0.1, (by1 - by0) * 0.1);
        let dx = 0, dy = 0;
        if (a.x < bx0 + m) dx = maxSpeed;
        else if (a.x > bx1 - m) dx = -maxSpeed;
        if (a.y < by0 + m) dy = maxSpeed;
        else if (a.y > by1 - m) dy = -maxSpeed;
        if (dx || dy) steer(dx || a.vx, dy || a.vy, 2);
      }
      const [lx, ly] = limit(fx, fy, maxForce * 3);
      acc[i * 2] = lx;
      acc[i * 2 + 1] = ly;
    });
    // intégration (après le calcul de tous les agents : ordre sans effet)
    this.agents.forEach((a, i) => {
      const g = this.groups[a.group];
      const maxSpeed = g.maxSpeed ?? 100, radius = g.radius ?? 6;
      [a.vx, a.vy] = limit(a.vx + acc[i * 2] * dt, a.vy + acc[i * 2 + 1] * dt, maxSpeed);
      let nx = a.x + a.vx * dt, ny = a.y + a.vy * dt;
      if (this.grid) {
        // glisser le long des murs, axe par axe
        if (this.blocked(nx, a.y)) {
          nx = a.x;
          a.vx *= -0.2;
        }
        if (this.blocked(nx, ny)) {
          ny = a.y;
          a.vy *= -0.2;
        }
      }
      if (this.edges === "wrap") {
        const W = bx1 - bx0, H = by1 - by0;
        nx = bx0 + ((((nx - bx0) % W) + W) % W);
        ny = by0 + ((((ny - by0) % H) + H) % H);
      } else {
        if (nx < bx0 + radius || nx > bx1 - radius) {
          if (this.edges === "bounce") a.vx = -a.vx;
          nx = Math.min(bx1 - radius, Math.max(bx0 + radius, nx));
        }
        if (ny < by0 + radius || ny > by1 - radius) {
          if (this.edges === "bounce") a.vy = -a.vy;
          ny = Math.min(by1 - radius, Math.max(by0 + radius, ny));
        }
      }
      a.x = nx;
      a.y = ny;
      if (a.cooldown > 0) a.cooldown -= dt;
    });
    // captures
    const gone = new Set<Agent>();
    this.agents.forEach((a) => {
      if (gone.has(a)) return;
      const g = this.groups[a.group];
      const c = g.catch;
      if (!c || typeof c.target !== "string" || a.cooldown > 0) return;
      const group = c.target.startsWith("group:") ? c.target.slice(6) : c.target;
      const prey = this.nearestOf(group, a.x, a.y, this.agents.indexOf(a));
      if (!prey || gone.has(prey)) return;
      const r = (c.radius ?? 0) || (g.radius ?? 6) + (this.groups[prey.group].radius ?? 6);
      if (Math.hypot(prey.x - a.x, prey.y - a.y) > r) return;
      events.push({ by: a.name, caught: prey.name, group, x: Math.round(prey.x), y: Math.round(prey.y), leader: prey.leader });
      a.cooldown = 0.5;
      if (c.remove) {
        this.removed.add(prey.name);
        this.removedNew.push(prey.name);
        gone.add(prey);
      } else if (c.respawn) {
        const fresh = this.spawn(this.groups[prey.group], prey.group, prey.name);
        Object.assign(prey, fresh);
      }
    });
    if (gone.size) this.agents = this.agents.filter((a) => !gone.has(a));
    return events;
  }

  /** Direction (unitaire) de descente du champ de distances vers la case du point visé. */
  private flowDir(x: number, y: number, tx: number, ty: number): [number, number] | null {
    const g = this.grid!;
    const s = this.cell;
    const goal: [number, number] = [Math.floor(tx / s), Math.floor(ty / s)];
    if (goal[0] < 0 || goal[1] < 0 || goal[0] >= g.w || goal[1] >= g.h) return null;
    const f = cachedField(g, [goal]);
    const cx = Math.floor(x / s), cy = Math.floor(y / s);
    if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h) return null;
    const here = f[cy * g.w + cx];
    if (here === 0) {
      const dx = tx - x, dy = ty - y, d = Math.hypot(dx, dy) || 1;
      return [dx / d, dy / d];
    }
    // gradient pondéré par les 8 voisins (mouvement plus doux qu'un pas de case en case)
    let gx = 0, gy = 0;
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        if (!i && !j) continue;
        const nx = cx + i, ny = cy + j;
        if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
        const v = f[ny * g.w + nx];
        if (!Number.isFinite(v) || !(v < here)) continue;
        const k = (here - v) / Math.hypot(i, j);
        gx += i * k;
        gy += j * k;
      }
    const m = Math.hypot(gx, gy);
    return m > 0 ? [gx / m, gy / m] : null;
  }
}

/** Parois lissées partagées entre essaims et reconfigurations (une grille de niveau est relue à chaque description). */
const wallsCache = new Map<string, SmoothWalls>();
function wallsFor(grid: Grid, spec: NonNullable<WorldSpec["grid"]>, cell: number): SmoothWalls {
  const smooth = Math.max(0, Math.min(4, Math.floor(Number(spec.smooth))));
  const key = `${smooth}|${cell}|${spec.walls ?? ""}|${spec.rows.join("\n")}`;
  let w = wallsCache.get(key);
  if (!w) {
    w = new SmoothWalls(grid, (k) => grid.cost[k] !== Infinity, { smooth, scale: cell });
    if (wallsCache.size >= 4) wallsCache.delete(wallsCache.keys().next().value as string);
    wallsCache.set(key, w);
  }
  return w;
}
