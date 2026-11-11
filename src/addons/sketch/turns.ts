/**
 * Découpage d'un trait en passes là où il revient sur lui-même (aller-retour de hachure, zigzag de remplissage,
 * boucle, gribouillis). Un trait coupé à ces endroits se pose passe par passe : avec un mode de fusion ou une
 * opacité partielle, les passes qui se recouvrent se cumulent comme au crayon, au lieu de former une seule
 * forme uniforme. Une passe ne se recouvre jamais elle-même.
 */

/** Part du diamètre en deçà de laquelle deux points du trait sont considérés comme superposés. */
export const OVERLAP_RATIO = 0.85;
/** Longueur de trait récent (en diamètres) ignorée : le trait se touche toujours lui-même juste derrière la pointe. */
export const RECENT_RATIO = 2;

/**
 * Détecteur en ligne : `feed` reçoit les points dans l'ordre et répond `true` quand le point courant entre
 * dans l'empreinte d'une partie plus ancienne de la passe en cours ; une nouvelle passe commence alors à ce
 * point précédent. `size` = diamètre du pinceau, dans les unités des points.
 */
export class PassDetector {
  private grid = new Map<string, { x: number; y: number; d: number }[]>();
  private last: { x: number; y: number } | null = null;
  private len = 0;
  private start = 0;
  private readonly near2: number;
  private readonly recent: number;
  private readonly cell: number;

  constructor(private size: number) {
    const s = size > 0 ? size : 0;
    this.near2 = (s * OVERLAP_RATIO) ** 2;
    this.recent = s * RECENT_RATIO;
    this.cell = s > 0 ? s : 1;
  }

  private key(cx: number, cy: number): string {
    return cx + "," + cy;
  }

  private add(x: number, y: number, d: number): void {
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    const list = this.grid.get(k);
    if (list) list.push({ x, y, d });
    else this.grid.set(k, [{ x, y, d }]);
  }

  /** Un point plus ancien que la partie récente touche-t-il (x, y) ? */
  private hits(x: number, y: number, d: number): boolean {
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    const limit = d - this.recent;
    if (limit <= this.start) return false;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const list = this.grid.get(this.key(cx + i, cy + j));
        if (!list) continue;
        for (const p of list) if (p.d < limit && (p.x - x) ** 2 + (p.y - y) ** 2 < this.near2) return true;
      }
    }
    return false;
  }

  /**
   * Ajoute (x, y). Vrai si le segment qui y mène entre dans une partie plus ancienne de la passe : la passe se
   * termine alors au point précédent et la suivante repart de lui, segment compris.
   */
  feed(x: number, y: number): boolean {
    if (!(this.size > 0)) return false;
    const last = this.last;
    if (!last) {
      this.last = { x, y };
      this.add(x, y, 0);
      return false;
    }
    const step = Math.hypot(x - last.x, y - last.y);
    if (step <= 0) return false;
    // Échantillons intermédiaires (au plus un demi-diamètre) : un geste rapide ne traverse pas une partie déjà posée sans la voir.
    const n = Math.max(1, Math.ceil(step / (this.size * 0.5)));
    const samples: [number, number, number][] = [];
    let hit = false;
    for (let k = 1; k <= n && !hit; k++) {
      const t = k / n;
      const sx = last.x + (x - last.x) * t, sy = last.y + (y - last.y) * t;
      const d = this.len + step * t;
      if (this.hits(sx, sy, d)) hit = true;
      else samples.push([sx, sy, d]);
    }
    if (hit) {
      // Nouvelle passe depuis le point précédent : la précédente est déjà posée dessous.
      this.grid.clear();
      this.start = this.len;
      this.add(last.x, last.y, this.len);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        this.add(last.x + (x - last.x) * t, last.y + (y - last.y) * t, this.len + step * t);
      }
    } else for (const [sx, sy, d] of samples.slice(0, -1)) this.add(sx, sy, d);
    this.len += step;
    this.last = { x, y };
    this.add(x, y, this.len);
    return hit;
  }
}

/**
 * Indices (en points) où couper un trait `pts` ([x, y, p]…) de diamètre `size` : chaque passe va d'une coupe à
 * la suivante, en partageant le point de coupe. Vide si le trait ne revient jamais sur lui-même.
 */
export function passCuts(pts: number[], size: number): number[] {
  const det = new PassDetector(size);
  const cuts: number[] = [];
  const n = pts.length / 3;
  for (let i = 0; i < n; i++) if (det.feed(pts[i * 3], pts[i * 3 + 1]) && i > 1) cuts.push(i - 1);
  return cuts;
}

/** Passes d'un trait coupé aux indices `cuts` (point de coupe partagé). */
export function splitPasses(pts: number[], cuts: number[]): number[][] {
  if (!cuts.length) return [pts];
  const out: number[][] = [];
  let start = 0;
  for (const c of [...cuts, pts.length / 3 - 1]) {
    if (c <= start) continue;
    out.push(pts.slice(start * 3, (c + 1) * 3));
    start = c;
  }
  return out;
}

/** Indice du point de `pts` le plus proche de (x, y). */
export function nearestIndex(pts: number[], x: number, y: number): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < pts.length / 3; i++) {
    const d = (pts[i * 3] - x) ** 2 + (pts[i * 3 + 1] - y) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
