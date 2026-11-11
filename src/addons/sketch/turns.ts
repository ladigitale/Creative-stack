/**
 * Repérage des changements de direction francs d'un trait (aller-retour de hachure, zigzag de remplissage).
 * Un trait coupé à ces endroits se pose passe par passe : avec un mode de fusion ou une opacité partielle, les
 * passes qui se recouvrent se cumulent comme au crayon, au lieu de former une seule forme uniforme.
 */

/** Angle minimal (degrés) entre la direction d'arrivée et celle de départ pour couper. */
export const TURN_DEGREES = 110;

/**
 * Détecteur en ligne : `feed` reçoit les points dans l'ordre et répond `true` quand le point courant clôt une
 * passe. Les directions sont mesurées sur une longueur `span` (unités du monde, ~ diamètre du pinceau) pour
 * ignorer le tremblement ; deux coupes sont séparées d'au moins `span`.
 */
export class TurnDetector {
  private pts: { x: number; y: number; d: number }[] = [];
  private len = 0;
  private lastCut = 0;
  private readonly cos: number;

  constructor(private span: number, degrees = TURN_DEGREES) {
    this.cos = Math.cos((degrees * Math.PI) / 180);
  }

  /** Point à la distance cumulée `d` (le plus proche par-dessous). */
  private at(d: number): { x: number; y: number; d: number } | null {
    let lo = 0, hi = this.pts.length - 1, best = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (this.pts[m].d <= d) { best = m; lo = m + 1; } else hi = m - 1;
    }
    return best < 0 ? null : this.pts[best];
  }

  feed(x: number, y: number): boolean {
    const last = this.pts[this.pts.length - 1];
    if (last) {
      const step = Math.hypot(x - last.x, y - last.y);
      if (step <= 0) return false;
      this.len += step;
    }
    this.pts.push({ x, y, d: this.len });
    const s = this.span;
    if (!(s > 0) || this.len - this.lastCut < 2 * s) return false;
    // Sommet candidat : le point à `span` en arrière ; arrivée = [sommet − span, sommet], départ = [sommet, ici].
    const c = this.at(this.len - s), a = c && this.at(c.d - s);
    if (!c || !a || a.d < this.lastCut) return false;
    const ix = c.x - a.x, iy = c.y - a.y, ox = x - c.x, oy = y - c.y;
    const ni = Math.hypot(ix, iy), no = Math.hypot(ox, oy);
    if (ni < s * 0.5 || no < s * 0.5) return false;
    if ((ix * ox + iy * oy) / (ni * no) > this.cos) return false;
    this.lastCut = this.len;
    // Garde de quoi mesurer la passe suivante.
    this.pts = this.pts.slice(-1);
    return true;
  }
}

/**
 * Indices (en points) où couper un trait `pts` ([x, y, p]…) : chaque passe va d'une coupe à la suivante,
 * en partageant le point de coupe. Vide si le trait ne change pas franchement de direction.
 */
export function turnCuts(pts: number[], span: number, degrees = TURN_DEGREES): number[] {
  const det = new TurnDetector(span, degrees);
  const cuts: number[] = [];
  const n = pts.length / 3;
  for (let i = 0; i < n; i++) if (det.feed(pts[i * 3], pts[i * 3 + 1]) && i > 0 && i < n - 1) cuts.push(i);
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
