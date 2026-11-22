/** Coins normalisés (0..1) d'une zone suivie, dans l'ordre de l'ancre. */
export type Corners = { x: number; y: number }[];

/**
 * Prise de vue stable : parmi les dernières détections (coins mesurés sur l'image analysée, sans lissage),
 * les `n` plus récentes ne doivent pas bouger de plus de `tol` (fraction de l'image) d'une image à l'autre.
 * Renvoie alors l'indice de la plus récente et la médiane, coin par coin, de ces `n` mesures (le tremblement du
 * suivi s'annule) ; sinon `null`.
 */
export function steadyCorners(history: Corners[], n = 3, tol = 0.006): { index: number; corners: Corners } | null {
  if (history.length < n || n < 1) return null;
  const last = history.slice(-n);
  if (last.some((c) => c.length !== 4)) return null;
  for (let i = 1; i < last.length; i++) {
    for (let k = 0; k < 4; k++) {
      if (Math.hypot(last[i][k].x - last[i - 1][k].x, last[i][k].y - last[i - 1][k].y) > tol) return null;
    }
  }
  const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const corners = [0, 1, 2, 3].map((k) => ({ x: median(last.map((c) => c[k].x)), y: median(last.map((c) => c[k].y)) }));
  return { index: history.length - 1, corners };
}
