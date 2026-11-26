/**
 * Murs lissés : les parois d'une grille telles que `$gridContours` les dessine (milieux d'arêtes puis Chaikin), pour
 * que ce qui bouge (essaims, personnages) heurte exactement ce qui est affiché, et non les cases carrées.
 *
 * `query(x, y)` répond près d'une paroi (côté libre ou mur, distance, normale vers le côté libre) ; loin de toute
 * paroi, `null` : la case suffit alors à trancher (une case loin du bord est entièrement libre ou entièrement pleine).
 */
import type { Grid } from "./grid";
import { contours } from "./contours";

export interface WallHit {
  /** Point du côté libre (dans la région praticable). */
  free: boolean;
  /** Distance à la paroi la plus proche (unités du monde). */
  dist: number;
  /** Normale unitaire, de la paroi vers le côté libre. */
  nx: number;
  ny: number;
}

export interface SmoothWallsOptions {
  /** Passes de Chaikin, comme `$gridContours` (0 à 4, défaut 2). */
  smooth?: number;
  /** Taille d'une case en unités du monde (défaut 1). */
  scale?: number;
}

export class SmoothWalls {
  /** Segments à plat : ax, ay, bx, by (le côté libre est à gauche du sens de parcours, repère y vers le bas). */
  private seg: Float64Array;
  private buckets = new Map<number, number[]>();
  readonly cell: number;
  readonly count: number;

  constructor(grid: Grid, free: (k: number) => boolean, o: SmoothWallsOptions = {}) {
    this.cell = o.scale ?? 1;
    const loops = contours(grid, free, { smooth: o.smooth ?? 2, scale: this.cell });
    let n = 0;
    for (const c of loops) n += c.points.length;
    this.seg = new Float64Array(n * 4);
    let i = 0;
    for (const c of loops) {
      const p = c.points;
      for (let k = 0; k < p.length; k++) {
        const a = p[k], b = p[(k + 1) % p.length];
        this.seg.set([a[0], a[1], b[0], b[1]], i * 4);
        const s = this.cell;
        const x0 = Math.floor(Math.min(a[0], b[0]) / s), x1 = Math.floor(Math.max(a[0], b[0]) / s);
        const y0 = Math.floor(Math.min(a[1], b[1]) / s), y1 = Math.floor(Math.max(a[1], b[1]) / s);
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const key = this.key(x, y);
            let l = this.buckets.get(key);
            if (!l) this.buckets.set(key, (l = []));
            l.push(i);
          }
        i++;
      }
    }
    this.count = i;
  }

  private key(x: number, y: number): number {
    return (x + 32768) * 65536 + (y + 32768);
  }

  /** Paroi la plus proche (cases voisines), ou null si aucune à moins d'une case environ. */
  query(x: number, y: number): WallHit | null {
    const s = this.cell;
    const cx = Math.floor(x / s), cy = Math.floor(y / s);
    let best = Infinity, bestLine = -1, bi = -1, qx = 0, qy = 0;
    const seen = new Set<number>();
    for (let j = cy - 1; j <= cy + 1; j++)
      for (let k = cx - 1; k <= cx + 1; k++) {
        const l = this.buckets.get(this.key(k, j));
        if (!l) continue;
        for (const i of l) {
          if (seen.has(i)) continue;
          seen.add(i);
          const ax = this.seg[i * 4], ay = this.seg[i * 4 + 1], bx = this.seg[i * 4 + 2], by = this.seg[i * 4 + 3];
          const ex = bx - ax, ey = by - ay, len2 = ex * ex + ey * ey || 1e-12;
          const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / len2));
          const px = ax + ex * t, py = ay + ey * t;
          const d = Math.hypot(x - px, y - py);
          // à un sommet partagé, le segment dont la droite passe le plus loin donne le bon côté
          const line = Math.abs((x - ax) * ey - (y - ay) * ex) / Math.sqrt(len2);
          if (d < best - 1e-9 || (d < best + 1e-9 && line > bestLine)) {
            best = d;
            bestLine = line;
            bi = i;
            qx = px;
            qy = py;
          }
        }
      }
    if (bi < 0) return null;
    const ax = this.seg[bi * 4], ay = this.seg[bi * 4 + 1], bx = this.seg[bi * 4 + 2], by = this.seg[bi * 4 + 3];
    // côté libre à gauche du parcours, repère y vers le bas : produit vectoriel négatif
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    const free = cross < 0;
    let nx: number, ny: number;
    if (best > 1e-9) {
      nx = (x - qx) / best;
      ny = (y - qy) / best;
      if (!free) {
        nx = -nx;
        ny = -ny;
      }
    } else {
      // sur la paroi : normale du segment, vers la gauche du parcours
      const l = Math.hypot(bx - ax, by - ay) || 1;
      nx = (by - ay) / l;
      ny = -(bx - ax) / l;
    }
    return { free, dist: best, nx, ny };
  }
}
