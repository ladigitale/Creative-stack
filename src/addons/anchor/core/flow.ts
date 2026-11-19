import { resizeGray, type Gray } from "./image";

/**
 * Flot optique de Lucas-Kanade pyramidal (Bouguet) : suit des points d'une image à la suivante, bien moins
 * cher que de redétecter et réapparier. Vérification aller-retour : un point qui ne revient pas à sa place
 * (occultation, reflet, bord) est écarté.
 */

export type Pyramid = Gray[];

/** Pyramide par moitiés successives (niveau 0 = image d'origine). */
export function buildPyramid(img: Gray, levels = 3): Pyramid {
  const out: Pyramid = [img];
  for (let l = 1; l < levels; l++) {
    const prev = out[l - 1];
    const w = prev.width >> 1, h = prev.height >> 1;
    if (w < 16 || h < 16) break;
    out.push(resizeGray(prev, w, h));
  }
  return out;
}

const sample = (g: Gray, x: number, y: number): number => {
  const w = g.width;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = x - x0, ty = y - y0;
  const i = y0 * w + x0, d = g.data;
  const a = d[i] + (d[i + 1] - d[i]) * tx;
  const b = d[i + w] + (d[i + w + 1] - d[i + w]) * tx;
  return a + (b - a) * ty;
};

export type FlowOptions = {
  /** Demi-fenêtre (pixels) : fenêtre de (2r+1)². */
  radius?: number;
  iterations?: number;
  /** Arrêt quand le pas devient plus petit (pixels). */
  epsilon?: number;
};

/**
 * Suit les points (`xs`, `ys`, pixels de niveau 0) de `prev` vers `next`. Renvoie les nouvelles positions et
 * `ok[i]` (0 = perdu : fenêtre sans texture, sortie d'image, divergence).
 */
export function trackPoints(prev: Pyramid, next: Pyramid, xs: ArrayLike<number>, ys: ArrayLike<number>, opts: FlowOptions = {}): { x: Float32Array; y: Float32Array; ok: Uint8Array } {
  const n = xs.length;
  const r = Math.max(2, Math.min(12, opts.radius ?? 6));
  const iters = Math.max(1, opts.iterations ?? 12);
  const eps2 = (opts.epsilon ?? 0.03) ** 2;
  const levels = Math.min(prev.length, next.length);
  const ox = new Float32Array(n), oy = new Float32Array(n), ok = new Uint8Array(n);
  const win = (2 * r + 1) ** 2;
  const Ix = new Float32Array(win), Iy = new Float32Array(win), I0 = new Float32Array(win);
  for (let i = 0; i < n; i++) {
    let gx = 0, gy = 0;
    let good = true;
    for (let L = levels - 1; L >= 0 && good; L--) {
      const P = prev[L], N = next[L];
      const s = 1 / (1 << L);
      const px = xs[i] * s, py = ys[i] * s;
      if (px < r + 1 || py < r + 1 || px >= P.width - r - 2 || py >= P.height - r - 2) { good = L > 0; if (!good) break; gx *= 2; gy *= 2; continue; }
      // Gradients et intensités de la fenêtre de référence.
      let gxx = 0, gxy = 0, gyy = 0, k = 0;
      for (let v = -r; v <= r; v++) {
        for (let u = -r; u <= r; u++, k++) {
          const x = px + u, y = py + v;
          const dx = (sample(P, x + 1, y) - sample(P, x - 1, y)) * 0.5;
          const dy = (sample(P, x, y + 1) - sample(P, x, y - 1)) * 0.5;
          Ix[k] = dx; Iy[k] = dy; I0[k] = sample(P, x, y);
          gxx += dx * dx; gxy += dx * dy; gyy += dy * dy;
        }
      }
      const det = gxx * gyy - gxy * gxy;
      // Valeur propre minimale trop faible : fenêtre sans texture, le suivi n'a pas de sens.
      const minEig = (gxx + gyy - Math.sqrt((gxx - gyy) ** 2 + 4 * gxy * gxy)) / (2 * win);
      if (!(det > 1e-6) || minEig < 1e-3) { good = false; break; }
      let vx = 0, vy = 0;
      for (let it = 0; it < iters; it++) {
        const qx = px + gx + vx, qy = py + gy + vy;
        if (qx < r + 1 || qy < r + 1 || qx >= N.width - r - 2 || qy >= N.height - r - 2) { good = false; break; }
        let bx = 0, by = 0;
        k = 0;
        for (let v = -r; v <= r; v++) {
          for (let u = -r; u <= r; u++, k++) {
            const e = I0[k] - sample(N, qx + u, qy + v);
            bx += e * Ix[k]; by += e * Iy[k];
          }
        }
        const sx = (gyy * bx - gxy * by) / det, sy = (gxx * by - gxy * bx) / det;
        vx += sx; vy += sy;
        if (sx * sx + sy * sy < eps2) break;
      }
      if (!good) break;
      if (L > 0) { gx = 2 * (gx + vx); gy = 2 * (gy + vy); }
      else { gx += vx; gy += vy; }
    }
    if (good) {
      ox[i] = xs[i] + gx; oy[i] = ys[i] + gy;
      ok[i] = Number.isFinite(ox[i]) && Number.isFinite(oy[i]) ? 1 : 0;
    }
  }
  return { x: ox, y: oy, ok };
}

/** Suivi avec vérification aller-retour : écarte les points qui ne reviennent pas à moins de `maxError` px. */
export function trackChecked(prev: Pyramid, next: Pyramid, xs: ArrayLike<number>, ys: ArrayLike<number>, maxError = 1, opts: FlowOptions = {}): { x: Float32Array; y: Float32Array; ok: Uint8Array } {
  const fwd = trackPoints(prev, next, xs, ys, opts);
  const back = trackPoints(next, prev, fwd.x, fwd.y, opts);
  const m2 = maxError * maxError;
  for (let i = 0; i < xs.length; i++) {
    if (!fwd.ok[i] || !back.ok[i]) { fwd.ok[i] = 0; continue; }
    const ex = back.x[i] - xs[i], ey = back.y[i] - ys[i];
    if (ex * ex + ey * ey > m2) fwd.ok[i] = 0;
  }
  return fwd;
}
