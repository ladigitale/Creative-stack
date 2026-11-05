/**
 * Remplissage de trous d'une image par diffusion des couleurs voisines (pyramide « push-pull ») : les pixels connus
 * sont moyennés en niveaux de plus en plus grossiers, puis les trous reprennent la couleur du niveau plus grossier
 * (interpolée). Donne un fond plausible, doux, à la place d'une zone masquée (une personne retirée d'une photo).
 * Calcul pur sur des tableaux RGBA : pas de DOM.
 */

type Level = { w: number; h: number; r: Float32Array; g: Float32Array; b: Float32Array; wt: Float32Array };

function level(w: number, h: number): Level {
  const n = w * h;
  return { w, h, r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n), wt: new Float32Array(n) };
}

/**
 * Remplit en place les pixels de `data` (RGBA, `w` × `h`) que `hole` marque (valeur non nulle, un octet par pixel) ;
 * leur alpha devient 255. Retourne le nombre de pixels remplis (0 si rien n'est connu ou si rien ne manque).
 */
export function fillHoles(data: Uint8ClampedArray, hole: ArrayLike<number>, w: number, h: number): number {
  const n = w * h;
  if (w < 1 || h < 1 || data.length < n * 4 || hole.length < n) return 0;
  const base = level(w, h);
  let known = 0;
  for (let i = 0; i < n; i++) {
    if (hole[i]) continue;
    base.r[i] = data[i * 4];
    base.g[i] = data[i * 4 + 1];
    base.b[i] = data[i * 4 + 2];
    base.wt[i] = 1;
    known++;
  }
  if (known === 0 || known === n) return 0;

  // Push : sommes pondérées (couleur × poids, poids) par blocs 2 × 2
  const levels: Level[] = [base];
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const f = levels[levels.length - 1];
    const c = level(Math.ceil(f.w / 2), Math.ceil(f.h / 2));
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x;
        const j = (y >> 1) * c.w + (x >> 1);
        c.r[j] += f.r[i];
        c.g[j] += f.g[i];
        c.b[j] += f.b[i];
        c.wt[j] += f.wt[i];
      }
    }
    levels.push(c);
  }

  // Pull : un pixel sans poids prend la couleur interpolée du niveau plus grossier
  for (let k = levels.length - 2; k >= 0; k--) {
    const f = levels[k];
    const c = levels[k + 1];
    const color = (cx: number, cy: number): [number, number, number] | null => {
      const x = Math.max(0, Math.min(c.w - 1, cx));
      const y = Math.max(0, Math.min(c.h - 1, cy));
      const j = y * c.w + x;
      const wt = c.wt[j];
      return wt > 0 ? [c.r[j] / wt, c.g[j] / wt, c.b[j] / wt] : null;
    };
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x;
        if (f.wt[i] > 0) continue;
        // position du centre du pixel dans le niveau grossier
        const px = (x + 0.5) / 2 - 0.5;
        const py = (y + 0.5) / 2 - 0.5;
        const x0 = Math.floor(px);
        const y0 = Math.floor(py);
        const fx = px - x0;
        const fy = py - y0;
        let r = 0;
        let g = 0;
        let b = 0;
        let sum = 0;
        for (const [dx, dy, wgt] of [
          [0, 0, (1 - fx) * (1 - fy)],
          [1, 0, fx * (1 - fy)],
          [0, 1, (1 - fx) * fy],
          [1, 1, fx * fy],
        ] as const) {
          if (wgt <= 0) continue;
          const col = color(x0 + dx, y0 + dy);
          if (!col) continue;
          r += col[0] * wgt;
          g += col[1] * wgt;
          b += col[2] * wgt;
          sum += wgt;
        }
        if (sum <= 0) continue;
        f.r[i] = r / sum;
        f.g[i] = g / sum;
        f.b[i] = b / sum;
        f.wt[i] = 1;
      }
    }
  }

  let filled = 0;
  for (let i = 0; i < n; i++) {
    if (!hole[i] || base.wt[i] <= 0) continue;
    data[i * 4] = Math.round(base.r[i] / base.wt[i]);
    data[i * 4 + 1] = Math.round(base.g[i] / base.wt[i]);
    data[i * 4 + 2] = Math.round(base.b[i] / base.wt[i]);
    data[i * 4 + 3] = 255;
    filled++;
  }
  return filled;
}

/** Seuil d'alpha (0..255) au-delà duquel un pixel du masque compte comme trou. */
export const HOLE_ALPHA = 24;

/** Trous d'un masque dont l'alpha (octet 3 de chaque pixel RGBA) dépasse `HOLE_ALPHA` ; `invert` : le contraire. */
export function holesFromMask(maskRgba: Uint8ClampedArray, w: number, h: number, invert = false): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const on = maskRgba[i * 4 + 3] > HOLE_ALPHA;
    out[i] = on !== invert ? 1 : 0;
  }
  return out;
}

/** Agrandit les trous d'un pixel (voisinage 3 × 3) : la frange de la personne, mal masquée, ne contamine pas le fond. */
export function dilateHoles(hole: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(hole);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!hole[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && xx < w && yy >= 0 && yy < h) out[yy * w + xx] = 1;
        }
      }
    }
  }
  return out;
}
