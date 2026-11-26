/**
 * Détection d'attaques par flux spectral : augmentation moyenne du spectre
 * d'une image à l'autre, comparée à un seuil adaptatif (médiane mobile des
 * dernières valeurs × sensibilité + plancher). Fonctions pures.
 */

/** Flux spectral : moyenne des hausses (bins 0..1) entre deux spectres. */
export function spectralFlux(prev: ArrayLike<number> | null, cur: ArrayLike<number>): number {
  if (!prev || prev.length !== cur.length || !cur.length) return 0;
  let flux = 0;
  for (let i = 0; i < cur.length; i++) {
    const d = cur[i] - prev[i];
    if (d > 0) flux += d;
  }
  return flux / cur.length;
}

export type OnsetOptions = {
  /** Multiplicateur de la médiane (défaut 1,5 : plus haut = moins d'attaques). */
  threshold?: number;
  /** Plancher ajouté au seuil (défaut 0,005), évite les attaques dans le silence. */
  delta?: number;
  /** Fenêtre de la médiane mobile en ms (défaut 500). */
  windowMs?: number;
  /** Écart minimal entre deux attaques en ms (défaut 80). */
  minGapMs?: number;
};

export type OnsetResult = {
  onset: boolean;
  /** Force 0..1 de l'attaque (1 - seuil / flux ; 0 sans attaque). */
  strength: number;
  /** Nouveauté : part du flux au-dessus de la médiane (fonction d'attaque pour le tempo). */
  novelty: number;
  threshold: number;
};

export class OnsetDetector {
  threshold: number;
  delta: number;
  windowMs: number;
  minGapMs: number;
  private hist: { t: number; v: number }[] = [];
  private last = -Infinity;

  constructor(opts: OnsetOptions = {}) {
    this.threshold = opts.threshold ?? 1.5;
    this.delta = opts.delta ?? 0.005;
    this.windowMs = opts.windowMs ?? 500;
    this.minGapMs = opts.minGapMs ?? 80;
  }

  reset(): void {
    this.hist = [];
    this.last = -Infinity;
  }

  /** Ajoute la valeur de flux mesurée à l'instant `tMs`. */
  push(flux: number, tMs: number): OnsetResult {
    const hist = this.hist;
    while (hist.length && hist[0].t < tMs - this.windowMs) hist.shift();
    const med = median(hist.map((h) => h.v));
    const thr = this.threshold * med + this.delta;
    const enough = hist.length >= 3;
    const onset = enough && flux > thr && tMs - this.last >= this.minGapMs;
    hist.push({ t: tMs, v: flux });
    if (hist.length > 512) hist.shift();
    if (onset) this.last = tMs;
    return {
      onset,
      strength: onset ? +(1 - thr / flux).toFixed(3) : 0,
      novelty: enough ? Math.max(0, flux - med) : 0,
      threshold: thr,
    };
  }
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
