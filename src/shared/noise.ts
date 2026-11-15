/**
 * Bruits déterministes (gradient de Perlin amélioré, 2D et 3D) et fBm. Les mêmes fonctions servent à la géométrie
 * (CPU) ; le shader a son propre bruit, de même allure.
 */

const P = new Uint8Array(512);
(() => {
  // permutation fixe (graine 1337, mélange de Fisher-Yates sur un LCG) : identique partout
  const p = Array.from({ length: 256 }, (_, i) => i);
  let s = 1337;
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) P[i] = p[i & 255];
})();

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function grad3(h: number, x: number, y: number, z: number) {
  const k = h & 15;
  const u = k < 8 ? x : y;
  const v = k < 4 ? y : k === 12 || k === 14 ? x : z;
  return ((k & 1) === 0 ? u : -u) + ((k & 2) === 0 ? v : -v);
}

/** Bruit 3D ∈ [-1, 1] environ. */
export function noise3(x: number, y: number, z: number): number {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
  const u = fade(x), v = fade(y), w = fade(z);
  const A = P[X] + Y, AA = P[A] + Z, AB = P[A + 1] + Z, B = P[X + 1] + Y, BA = P[B] + Z, BB = P[B + 1] + Z;
  return lerp(
    lerp(lerp(grad3(P[AA], x, y, z), grad3(P[BA], x - 1, y, z), u), lerp(grad3(P[AB], x, y - 1, z), grad3(P[BB], x - 1, y - 1, z), u), v),
    lerp(lerp(grad3(P[AA + 1], x, y, z - 1), grad3(P[BA + 1], x - 1, y, z - 1), u), lerp(grad3(P[AB + 1], x, y - 1, z - 1), grad3(P[BB + 1], x - 1, y - 1, z - 1), u), v),
    w,
  );
}

export function noise2(x: number, y: number): number {
  return noise3(x, y, 0.5);
}

/** Bruit fractal : `octaves` couches, chaque couche × `lacunarity` en fréquence et × `gain` en amplitude. Normalisé ∈ [-1, 1]. */
export function fbm3(x: number, y: number, z: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let a = 1, f = 1, s = 0, n = 0;
  for (let i = 0; i < octaves; i++) {
    s += a * noise3(x * f + i * 17.1, y * f - i * 9.3, z * f + i * 3.7);
    n += a;
    a *= gain;
    f *= lacunarity;
  }
  return s / n;
}
export const fbm2 = (x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5) => fbm3(x, y, 0.37, octaves, lacunarity, gain);

/** Crêtes (1 - |bruit|)² : arêtes de montagnes, strates. ∈ [0, 1]. */
export function ridge2(x: number, y: number, octaves = 4): number {
  let a = 0.5, f = 1, s = 0, n = 0;
  for (let i = 0; i < octaves; i++) {
    const r = 1 - Math.abs(noise3(x * f + i * 31.7, y * f + i * 11.1, 0.21));
    s += a * r * r;
    n += a;
    a *= 0.5;
    f *= 2;
  }
  return s / n;
}

/** fBm à domaine déformé (Inigo Quilez) : formes de relief moins « bruit ». */
export function warped2(x: number, y: number, warp = 0.8, octaves = 4): number {
  const qx = fbm2(x + 1.7, y + 9.2, 3);
  const qy = fbm2(x + 8.3, y + 2.8, 3);
  return fbm2(x + warp * qx, y + warp * qy, octaves);
}
