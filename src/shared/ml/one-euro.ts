/**
 * Filtre One Euro (Casiez et al., 2012) : lisse le jitter à basse vitesse sans traîner à haute vitesse.
 * Utilisé par les trackers (`smooth`). Valeurs en entrée normalisées 0..1, temps en ms.
 */
export class OneEuro {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(
    public minCutoff = 1,
    public beta = 8,
    public dCutoff = 1,
  ) {}

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }

  filter(x: number, tMs: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = tMs;
      return x;
    }
    const dt = Math.max((tMs - this.tPrev) / 1000, 1e-3);
    this.tPrev = tMs;
    const dx = (x - this.xPrev) / dt;
    const aD = alpha(this.dCutoff, dt);
    this.dxPrev = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxPrev);
    const a = alpha(cutoff, dt);
    this.xPrev = a * x + (1 - a) * this.xPrev;
    return this.xPrev;
  }
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/** `smooth` 0..1 → paramètres du filtre. 0 = pas de lissage (null). */
export function oneEuroFor(smooth: number): OneEuro | null {
  const s = Math.max(0, Math.min(1, Number.isFinite(smooth) ? smooth : 0));
  if (s === 0) return null;
  return new OneEuro(0.1 + 3 * (1 - s), 8, 1);
}
