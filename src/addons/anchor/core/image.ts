/** Image en niveaux de gris (1 octet par pixel). */
export type Gray = { data: Uint8Array; width: number; height: number };

/** RGBA → gris (luminance approchée, entiers). */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Gray {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return { data: out, width, height };
}

/** Redimensionnement bilinéaire. */
export function resizeGray(src: Gray, width: number, height: number): Gray {
  const out = new Uint8Array(width * height);
  const sx = src.width / width, sy = src.height / height;
  const sw = src.width, sd = src.data;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(src.height - 1.001, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = fy | 0, ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(sw - 1.001, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = fx | 0, tx = fx - x0;
      const i = y0 * sw + x0;
      const a = sd[i] + (sd[i + 1] - sd[i]) * tx;
      const b = sd[i + sw] + (sd[i + sw + 1] - sd[i + sw]) * tx;
      out[y * width + x] = (a + (b - a) * ty + 0.5) | 0;
    }
  }
  return { data: out, width, height };
}

/** Flou boîte séparable de rayon `r` (bords répliqués). */
export function boxBlur(src: Gray, r: number): Gray {
  const { width: w, height: h } = src;
  if (r <= 0) return { data: src.data.slice(), width: w, height: h };
  const tmp = new Uint16Array(w * h);
  const out = new Uint8Array(w * h);
  const k = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let i = -r; i <= r; i++) s += src.data[row + Math.min(w - 1, Math.max(0, i))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s;
      s += src.data[row + Math.min(w - 1, x + r + 1)] - src.data[row + Math.max(0, x - r)];
    }
  }
  const kk = k * k;
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, i)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = (s / kk + 0.5) | 0;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return { data: out, width: w, height: h };
}
