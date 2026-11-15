/**
 * Image en 1 bit pour les imprimantes thermiques : niveaux de gris, seuil ou tramage, rotation,
 * emballage en octets (bit de poids fort à gauche, 1 = noir). Fonctions pures, sans DOM.
 */

export type DitherMode = "threshold" | "floyd" | "atkinson" | "bayer";
export const DITHER_MODES: DitherMode[] = ["threshold", "floyd", "atkinson", "bayer"];

/** Image binaire : `bits[y * width + x]` vaut 1 (noir) ou 0 (blanc). */
export type Bitmap = { width: number; height: number; bits: Uint8Array };

/** RGBA → luminance 0..255, la transparence étant posée sur du blanc (le papier). */
export function toGray(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const a = rgba[p + 3] / 255;
    const lum = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    out[i] = lum * a + 255 * (1 - a);
  }
  return out;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Diffusion d'erreur : [dx, dy, poids]. */
const FLOYD: [number, number, number][] = [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]];
const ATKINSON: [number, number, number][] = [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]];

/** Niveaux de gris → 1 bit. `threshold` 0..255 : en dessous, le point est noir. */
export function dither(gray: Float32Array, width: number, height: number, mode: DitherMode = "threshold", threshold = 128): Bitmap {
  const bits = new Uint8Array(width * height);
  const t = Math.min(255, Math.max(0, threshold));
  if (mode === "bayer") {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Seuil ordonné centré sur `threshold`.
        const level = ((BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5) * 255 + t;
        bits[y * width + x] = gray[y * width + x] < level ? 1 : 0;
      }
    }
    return { width, height, bits };
  }
  if (mode === "floyd" || mode === "atkinson") {
    const kernel = mode === "floyd" ? FLOYD : ATKINSON;
    const work = Float32Array.from(gray);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const old = work[i];
        const black = old < t;
        bits[i] = black ? 1 : 0;
        const err = old - (black ? 0 : 255);
        for (const [dx, dy, w] of kernel) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny < height) work[ny * width + nx] += err * w;
        }
      }
    }
    return { width, height, bits };
  }
  for (let i = 0; i < bits.length; i++) bits[i] = gray[i] < t ? 1 : 0;
  return { width, height, bits };
}

/** Rotation par quarts de tour dans le sens horaire (90, 180, 270 ; autre valeur : copie). */
export function rotateBitmap(src: Bitmap, degrees: number): Bitmap {
  const turns = ((Math.round(degrees / 90) % 4) + 4) % 4;
  const { width: w, height: h, bits } = src;
  if (turns === 0) return { width: w, height: h, bits: Uint8Array.from(bits) };
  const [nw, nh] = turns === 2 ? [w, h] : [h, w];
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      if (turns === 1) {
        nx = h - 1 - y;
        ny = x;
      } else if (turns === 2) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      out[ny * nw + nx] = bits[y * w + x];
    }
  }
  return { width: nw, height: nh, bits: out };
}

/** Pose l'image au centre d'une bande de `width` points (largeur de la tête), blanc autour ; rogne si elle dépasse. */
export function centerInWidth(src: Bitmap, width: number): Bitmap {
  if (src.width === width) return src;
  const out = new Uint8Array(width * src.height);
  const offset = Math.floor((width - src.width) / 2);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const nx = x + offset;
      if (nx >= 0 && nx < width) out[y * width + nx] = src.bits[y * src.width + x];
    }
  }
  return { width, height: src.height, bits: out };
}

/** Lignes emballées : `ceil(width / 8)` octets par ligne, bit de poids fort = point de gauche, 1 = noir. */
export function packBitmap(src: Bitmap): { bytesPerRow: number; rows: number; data: Uint8Array } {
  const bytesPerRow = Math.ceil(src.width / 8);
  const data = new Uint8Array(bytesPerRow * src.height);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (src.bits[y * src.width + x]) data[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { bytesPerRow, rows: src.height, data };
}

/** Part de points noirs (0..1) : sert à prévenir d'une étiquette vide ou presque toute noire. */
export function coverage(src: Bitmap): number {
  let n = 0;
  for (let i = 0; i < src.bits.length; i++) n += src.bits[i];
  return src.bits.length ? n / src.bits.length : 0;
}

/** Rectangle de destination pour poser une image `sw × sh` dans un cadre `dw × dh`. */
export function fitRect(sw: number, sh: number, dw: number, dh: number, fit: "contain" | "cover" | "stretch"): { x: number; y: number; w: number; h: number } {
  if (fit === "stretch" || !sw || !sh) return { x: 0, y: 0, w: dw, h: dh };
  const scale = fit === "cover" ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}
