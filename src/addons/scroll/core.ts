/** Calcul pur du défilement : lissage, vitesse, avancement des sections. */

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Rapproche `current` de `target` d'une fraction `lerp` par image à 60 Hz, quel que soit le pas de temps `dt` (s) :
 * le résultat est le même à 30, 60 ou 144 images par seconde. `lerp` 1 : suit sans retard ; 0 : ne bouge pas.
 */
export function smoothTo(current: number, target: number, dt: number, lerp: number): number {
  if (lerp >= 1) return target;
  if (lerp <= 0) return current;
  const k = 1 - Math.pow(1 - lerp, Math.max(0, dt) * 60);
  return current + (target - current) * k;
}

export type Rect = { top: number; bottom: number; height: number };

export type SectionMetrics = {
  /** 0 quand le haut de la section touche le bas de l'écran, 1 quand son bas quitte le haut de l'écran. */
  progress: number;
  /** 0 → 1 pendant que la section, plus haute que l'écran, reste épinglée (position: sticky) ; 0 avant, 1 après. */
  pin: number;
  /** Part de l'écran couverte par la section (0..1). */
  visible: number;
  inView: boolean;
};

export function sectionMetrics(r: Rect, vh: number): SectionMetrics {
  const h = Math.max(1, r.height);
  const total = vh + h;
  const progress = clamp01((vh - r.top) / total);
  const travel = h - vh;
  const pin = travel > 1 ? clamp01(-r.top / travel) : clamp01(-r.top / h);
  const shown = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  return { progress, pin, visible: clamp01(shown / Math.max(1, vh)), inView: r.bottom > 0 && r.top < vh };
}

/** Section active : celle qui contient le milieu de l'écran, sinon la plus proche (indice, ou -1 sans section). */
export function activeSection(rects: Rect[], vh: number): number {
  if (!rects.length) return -1;
  const mid = vh / 2;
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r.top <= mid && r.bottom > mid) return i;
    const d = r.top > mid ? r.top - mid : mid - r.bottom;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/** Vitesse lissée (px/s) : moyenne exponentielle de la vitesse instantanée. */
export function ema(prev: number, next: number, dt: number, tau = 0.08): number {
  const a = 1 - Math.exp(-Math.max(0, dt) / tau);
  return prev + (next - prev) * a;
}

export const round = (n: number, d = 4) => { const f = 10 ** d; return Math.round(n * f) / f; };
