/**
 * Mathématiques minimales du format « monde » : matrices 4×4 colonnes (convention three.js / glTF),
 * Euler XYZ en radians, aléa déterministe. Aucune allocation dans les fonctions « …Into » appelées à chaque image.
 */

export type V3 = [number, number, number];
export type M4 = Float32Array;

export const DEG = Math.PI / 180;

export function m4(): M4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function m4Identity(o: M4): M4 {
  o.fill(0);
  o[0] = o[5] = o[10] = o[15] = 1;
  return o;
}

/** o = a × b (o peut être a ou b). */
export function m4Mul(o: M4, a: M4, b: M4): M4 {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    o[i * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    o[i * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    o[i * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    o[i * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
  return o;
}

/** Position, rotation Euler XYZ (radians, ordre three.js « XYZ »), échelle → matrice. */
export function m4Compose(o: M4, px: number, py: number, pz: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number): M4 {
  const a = Math.cos(rx), b = Math.sin(rx);
  const c = Math.cos(ry), d = Math.sin(ry);
  const e = Math.cos(rz), f = Math.sin(rz);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  // Matrice de rotation XYZ (identique à THREE.Matrix4.makeRotationFromEuler, ordre XYZ)
  o[0] = c * e * sx;
  o[1] = (af + be * d) * sx;
  o[2] = (bf - ae * d) * sx;
  o[3] = 0;
  o[4] = -c * f * sy;
  o[5] = (ae - bf * d) * sy;
  o[6] = (be + af * d) * sy;
  o[7] = 0;
  o[8] = d * sz;
  o[9] = -b * c * sz;
  o[10] = a * c * sz;
  o[11] = 0;
  o[12] = px;
  o[13] = py;
  o[14] = pz;
  o[15] = 1;
  return o;
}

export function m4Point(m: M4, x: number, y: number, z: number, out: V3): V3 {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

export function m4Dir(m: M4, x: number, y: number, z: number, out: V3): V3 {
  out[0] = m[0] * x + m[4] * y + m[8] * z;
  out[1] = m[1] * x + m[5] * y + m[9] * z;
  out[2] = m[2] * x + m[6] * y + m[10] * z;
  return out;
}

/** Inverse d'une matrice rigide (rotation × échelle uniforme ou non, + translation) par la formule générale. */
export function m4Invert(o: M4, m: M4): M4 | null {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return o;
}

/** Hachage 32 bits d'une chaîne (FNV-1a + mélange). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Aléa déterministe (mulberry32) : même graine, même suite. */
export class Rand {
  private s: number;
  constructor(seed: string | number) {
    this.s = hash32(String(seed)) || 1;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.min(list.length - 1, Math.floor(this.next() * list.length))];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** Couleur #rrggbb éclaircie (k > 0) ou assombrie (k < 0). */
export function shade(hex: string, k: number): string {
  const n = parseHex(hex);
  if (n === null) return hex;
  const f = (c: number) => Math.round(k >= 0 ? c + (255 - c) * k : c * (1 + k));
  const r = f((n >> 16) & 255), g = f((n >> 8) & 255), b = f(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/** Mélange de deux couleurs #rrggbb. */
export function mixColor(a: string, b: string, t: number): string {
  const x = parseHex(a), y = parseHex(b);
  if (x === null || y === null) return a;
  const c = (s: number) => Math.round(((x >> s) & 255) * (1 - t) + ((y >> s) & 255) * t);
  return `#${((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, "0")}`;
}

export function parseHex(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  return parseInt(s, 16);
}
