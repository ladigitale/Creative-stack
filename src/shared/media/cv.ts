/**
 * Vision classique sans modèle, sur pixels RGBA réduits : détection de mouvement par différence d'images (zones
 * actives avec hystérésis) et suivi d'objets par couleur (OKLab, composantes connexes). Pur : testable sans DOM.
 */

/** Luminance 0..1 de pixels RGBA (Rec. 709). */
export function lumaOf(data: ArrayLike<number>, w: number, h: number, out?: Float32Array): Float32Array {
  const o = out && out.length === w * h ? out : new Float32Array(w * h);
  for (let k = 0, i = 0; k < w * h; k++, i += 4) o[k] = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  return o;
}

export interface MotionResult {
  /** Part des pixels en mouvement (0..1). */
  level: number;
  /** Centre du mouvement (0..1) et boîte [x0, y0, x1, y1] ; null sans mouvement. */
  x: number | null;
  y: number | null;
  box: [number, number, number, number] | null;
  mask: Uint8Array;
}

/** Différence entre deux images de luminance : pixels dont l'écart dépasse `threshold`. */
export function motion(prev: Float32Array, cur: Float32Array, w: number, h: number, threshold: number): MotionResult {
  const mask = new Uint8Array(w * h);
  let n = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (Math.abs(cur[k] - prev[k]) <= threshold) continue;
      mask[k] = 1;
      n++;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  if (!n) return { level: 0, x: null, y: null, box: null, mask };
  return { level: n / (w * h), x: (sx / n + 0.5) / w, y: (sy / n + 0.5) / h, box: [x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h], mask };
}

export interface Zone {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ZoneState {
  level: number;
  active: boolean;
  count: number;
  since: number;
}

/** Lit des zones `[{name, x, y, w, h}]` (fractions 0..1) ou `{nom: [x, y, w, h]}`. 32 au plus. */
export function readZones(v: unknown): Zone[] {
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  const out: Zone[] = [];
  const add = (name: unknown, r: unknown) => {
    const a = Array.isArray(r) ? r : r && typeof r === "object" ? [(r as Zone).x, (r as Zone).y, (r as Zone).w, (r as Zone).h] : null;
    if (!a || out.length >= 32) return;
    const [x, y, w, h] = a.map(Number);
    if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) out.push({ name: String(name), x, y, w, h });
  };
  if (Array.isArray(v)) v.forEach((z, i) => add((z as Zone)?.name ?? `z${i}`, z));
  else if (v && typeof v === "object") for (const [k, r] of Object.entries(v)) add(k, r);
  return out;
}

/** Part des pixels en mouvement dans une zone (miroir horizontal si `mirror`). */
export function zoneLevel(mask: Uint8Array, w: number, h: number, z: Zone, mirror = false): number {
  const zx = mirror ? 1 - z.x - z.w : z.x;
  const xa = Math.max(0, Math.floor(zx * w)), xb = Math.min(w, Math.ceil((zx + z.w) * w));
  const ya = Math.max(0, Math.floor(z.y * h)), yb = Math.min(h, Math.ceil((z.y + z.h) * h));
  let n = 0, t = 0;
  for (let y = ya; y < yb; y++)
    for (let x = xa; x < xb; x++) {
      t++;
      n += mask[y * w + x];
    }
  return t ? n / t : 0;
}

/**
 * Hystérésis d'une zone : s'allume au-dessus de `on`, s'éteint quand le niveau reste sous `on / 2` pendant `holdMs`.
 * `since` = dernier instant où la zone était au-dessus de `on / 2`. Rend true au moment où elle s'allume.
 */
export function updateZone(s: ZoneState, level: number, now: number, on: number, holdMs: number): boolean {
  s.level = level;
  if (!s.active) {
    if (level < on) return false;
    s.active = true;
    s.count++;
    s.since = now;
    return true;
  }
  if (level >= on / 2) s.since = now;
  else if (now - s.since >= holdMs) s.active = false;
  return false;
}

// ——— couleur ———

const lin = (c: number) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const LIN = new Float32Array(256).map((_, i) => lin(i));

/** sRGB 0..255 → OKLab. */
export function oklab(r: number, g: number, b: number): [number, number, number] {
  const R = LIN[r | 0], G = LIN[g | 0], B = LIN[b | 0];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

export function parseHex(hex: unknown): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return null;
  const s = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export const toHex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

export interface ColorBlob {
  x: number;
  y: number;
  area: number;
  box: [number, number, number, number];
}

/**
 * Pixels proches d'une couleur (distance OKLab, la clarté comptée à moitié : l'ombre et la lumière gênent peu),
 * regroupés en taches connexes ; les `max` plus grandes au-dessus de `minArea` (part de l'image), en fractions 0..1.
 */
export function colorBlobs(data: ArrayLike<number>, w: number, h: number, target: [number, number, number], tolerance: number, minArea = 0.002, max = 5): ColorBlob[] {
  const [L, A, B] = oklab(...target);
  const n = w * h;
  const mask = new Uint8Array(n);
  const tol2 = tolerance * tolerance;
  for (let k = 0, i = 0; k < n; k++, i += 4) {
    const [l, a, b] = oklab(data[i], data[i + 1], data[i + 2]);
    const dl = (l - L) * 0.5, da = a - A, db = b - B;
    if (dl * dl + da * da + db * db <= tol2) mask[k] = 1;
  }
  const label = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const blobs: ColorBlob[] = [];
  for (let k = 0; k < n; k++) {
    if (!mask[k] || label[k] >= 0) continue;
    let head = 0, tail = 0, size = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    queue[tail++] = k;
    label[k] = blobs.length;
    while (head < tail) {
      const c = queue[head++];
      const x = c % w, y = (c - x) / w;
      size++;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      if (x > 0 && mask[c - 1] && label[c - 1] < 0) (label[c - 1] = label[k]), (queue[tail++] = c - 1);
      if (x < w - 1 && mask[c + 1] && label[c + 1] < 0) (label[c + 1] = label[k]), (queue[tail++] = c + 1);
      if (y > 0 && mask[c - w] && label[c - w] < 0) (label[c - w] = label[k]), (queue[tail++] = c - w);
      if (y < h - 1 && mask[c + w] && label[c + w] < 0) (label[c + w] = label[k]), (queue[tail++] = c + w);
    }
    blobs.push({ x: (sx / size + 0.5) / w, y: (sy / size + 0.5) / h, area: size / n, box: [x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h] });
  }
  return blobs.filter((b) => b.area >= minArea).sort((p, q) => q.area - p.area).slice(0, max);
}

/** Couleur moyenne d'un petit carré autour d'un point (0..1). */
export function sampleColor(data: ArrayLike<number>, w: number, h: number, nx: number, ny: number, radius = 1): [number, number, number] {
  const cx = Math.min(w - 1, Math.max(0, Math.floor(nx * w))), cy = Math.min(h - 1, Math.max(0, Math.floor(ny * h)));
  let r = 0, g = 0, b = 0, c = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(h - 1, cy + radius); y++)
    for (let x = Math.max(0, cx - radius); x <= Math.min(w - 1, cx + radius); x++) {
      const i = (y * w + x) * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      c++;
    }
  return [r / c, g / c, b / c];
}
