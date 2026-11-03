/**
 * Masques de segmentation : statistiques (couverture, centre, boîte) et conversion en pixels RGBA pour un
 * canvas lu par un shader. Données en octets 0..255 (un octet par pixel). Pur : aucun accès au DOM.
 */

export type MaskStats = {
  /** Part de l'image couverte (0..1). */
  coverage: number;
  /** Centre de gravité, 0..1 (haut-gauche = 0,0), miroir appliqué si demandé. */
  cx: number;
  cy: number;
  /** Boîte englobante des pixels au-dessus du seuil, 0..1 ; tout à 0 sans pixel. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export function maskStats(data: ArrayLike<number>, width: number, height: number, threshold = 128, mirror = false): MaskStats {
  let count = 0;
  let sx = 0;
  let sy = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (data[row + x] >= threshold) {
        count++;
        sx += x;
        sy += y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (count === 0 || width === 0 || height === 0) return { coverage: 0, cx: 0.5, cy: 0.5, x0: 0, y0: 0, x1: 0, y1: 0 };
  const cxRaw = (sx / count + 0.5) / width;
  const bx0Raw = x0 / width;
  const bx1Raw = (x1 + 1) / width;
  return {
    coverage: count / (width * height),
    cx: mirror ? 1 - cxRaw : cxRaw,
    cy: (sy / count + 0.5) / height,
    x0: mirror ? 1 - bx1Raw : bx0Raw,
    y0: y0 / height,
    x1: mirror ? 1 - bx0Raw : bx1Raw,
    y1: (y1 + 1) / height,
  };
}

export type MaskMode = "gray" | "alpha";

/**
 * RGBA d'un masque. `gray` : r = g = b = masque, alpha 255 (à lire comme canal de luminosité dans un shader) ;
 * `alpha` : blanc, alpha = masque (à composer par-dessus une image). `mirror` retourne horizontalement,
 * `invert` inverse le masque.
 */
export function maskToRgba(data: ArrayLike<number>, width: number, height: number, mode: MaskMode, mirror: boolean, invert: boolean): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = mirror ? width - 1 - x : x;
      let v = data[y * width + sx] ?? 0;
      if (invert) v = 255 - v;
      const o = (y * width + x) * 4;
      if (mode === "alpha") {
        out[o] = out[o + 1] = out[o + 2] = 255;
        out[o + 3] = v;
      } else {
        out[o] = out[o + 1] = out[o + 2] = v;
        out[o + 3] = 255;
      }
    }
  }
  return out;
}
