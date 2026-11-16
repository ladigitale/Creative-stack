/**
 * Image en 1 bit (imprimantes thermiques, gravure laser) : niveaux de gris, seuil ou tramage, rotation,
 * emballage en octets (bit de poids fort à gauche, 1 = noir). Fonctions pures, sans DOM.
 */

export type DitherMode = "threshold" | "floyd" | "atkinson" | "bayer" | "jarvis" | "stucki" | "burkes" | "sierra" | "sierra-lite" | "random" | "adaptive";
export const DITHER_MODES: DitherMode[] = ["threshold", "floyd", "atkinson", "bayer", "jarvis", "stucki", "burkes", "sierra", "sierra-lite", "random", "adaptive"];

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
type Kernel = [number, number, number][];
const k = (div: number, taps: [number, number, number][]): Kernel => taps.map(([x, y, w]) => [x, y, w / div]);
const KERNELS: Partial<Record<DitherMode, Kernel>> = {
  floyd: k(16, [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]]),
  atkinson: k(8, [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]]),
  jarvis: k(48, [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]]),
  stucki: k(42, [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]]),
  burkes: k(32, [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]]),
  sierra: k(32, [[1, 0, 5], [2, 0, 3], [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2], [-1, 2, 2], [0, 2, 3], [1, 2, 2]]),
  "sierra-lite": k(4, [[1, 0, 2], [-1, 1, 1], [0, 1, 1]]),
};

/** Moyenne glissante en boîte (deux passes séparables, bords répétés). */
export function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const rad = Math.max(0, Math.round(r));
  if (!rad) return Float32Array.from(src);
  const at = (v: number, n: number) => (v < 0 ? 0 : v >= n ? n - 1 : v);
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const span = rad * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let i = -rad; i <= rad; i++) acc += src[row + at(i, w)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / span;
      acc += src[row + at(x + rad + 1, w)] - src[row + at(x - rad, w)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let i = -rad; i <= rad; i++) acc += tmp[at(i, h) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / span;
      acc += tmp[at(y + rad + 1, h) * w + x] - tmp[at(y - rad, h) * w + x];
    }
  }
  return out;
}

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
  if (mode === "random") {
    // Bruit reproductible (même image, même résultat).
    let a = 0x9e3779b9;
    for (let i = 0; i < bits.length; i++) {
      a = (a + 0x6d2b79f5) >>> 0;
      let r = Math.imul(a ^ (a >>> 15), a | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      const level = (((r ^ (r >>> 14)) >>> 0) / 4294967296 - 0.5) * 255 + t;
      bits[i] = gray[i] < level ? 1 : 0;
    }
    return { width, height, bits };
  }
  if (mode === "adaptive") {
    // Seuil local : noir si plus sombre que la moyenne du voisinage (garde le détail dans les ombres et les lumières).
    const mean = boxMean(gray, width, height, Math.max(3, Math.round(Math.max(width, height) / 40)));
    const offset = 10 + (t - 128) * 0.25;
    for (let i = 0; i < bits.length; i++) bits[i] = gray[i] < mean[i] - offset ? 1 : 0;
    return { width, height, bits };
  }
  const kernel = KERNELS[mode];
  if (kernel) {
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
