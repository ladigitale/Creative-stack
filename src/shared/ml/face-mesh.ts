/**
 * Géométrie du maillage de visage (468 points MediaPipe) pour `sonic-face-mesh` : fondu des bords, tampons de
 * sommets, correspondance des couleurs. Aucune dépendance au DOM (testable sous node).
 * Coordonnées d'entrée normalisées 0..1, origine en haut à gauche.
 */
import { FACE_TRIANGLES, FACE_UV } from "./face-mesh-data";
import type { Point } from "./hands";

export const FACE_VERTEX_COUNT = 468;

/** Contour ovale du visage (même ordre que MediaPipe FACE_LANDMARKS_FACE_OVAL). */
export const FACE_OVAL: readonly number[] = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172,
  58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

/** Points où l'on mesure la couleur de peau : joues, front, arête du nez. */
export const COLOR_POINTS: readonly number[] = [50, 280, 205, 425, 117, 346, 151, 9];

const featherCache = new Map<number, Float32Array>();

/**
 * Poids de fondu par sommet : 0 sur le contour, 1 à `rings` triangles ou plus à l'intérieur (distance dans le
 * graphe du maillage, lissée). Sert à estomper les bords pour que le visage greffé se fonde dans l'image.
 */
export function featherWeights(rings: number): Float32Array {
  const r = Math.max(1, Math.min(30, Math.round(rings) || 1));
  const cached = featherCache.get(r);
  if (cached) return cached;
  const n = FACE_VERTEX_COUNT;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < FACE_TRIANGLES.length; i += 3) {
    const a = FACE_TRIANGLES[i];
    const b = FACE_TRIANGLES[i + 1];
    const c = FACE_TRIANGLES[i + 2];
    adj[a].push(b, c);
    adj[b].push(a, c);
    adj[c].push(a, b);
  }
  const dist = new Int32Array(n).fill(-1);
  const queue: number[] = [];
  for (const v of FACE_OVAL) {
    dist[v] = 0;
    queue.push(v);
  }
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head];
    for (const w of adj[v]) {
      if (dist[w] === -1) {
        dist[w] = dist[v] + 1;
        queue.push(w);
      }
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = dist[i] < 0 ? 1 : Math.min(1, dist[i] / r);
    out[i] = t * t * (3 - 2 * t); // smoothstep
  }
  featherCache.set(r, out);
  return out;
}

/** Une liste de points est utilisable si elle contient au moins les 468 points du maillage. */
export function validLandmarks(lm: unknown): lm is Point[] {
  if (!Array.isArray(lm) || lm.length < FACE_VERTEX_COUNT) return false;
  const p = lm[0] as Point | undefined;
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** Positions en espace de découpe (-1..1, y vers le haut) à partir des points normalisés. */
export function fillPositions(out: Float32Array, lm: Point[]): void {
  for (let i = 0; i < FACE_VERTEX_COUNT; i++) {
    out[i * 2] = lm[i].x * 2 - 1;
    out[i * 2 + 1] = 1 - lm[i].y * 2;
  }
}

/** Coordonnées de texture prises sur les points d'un autre visage (échange, portrait) ; `flip` : image retournée. */
export function fillUvFromLandmarks(out: Float32Array, lm: Point[], flip: boolean): void {
  for (let i = 0; i < FACE_VERTEX_COUNT; i++) {
    out[i * 2] = flip ? 1 - lm[i].x : lm[i].x;
    out[i * 2 + 1] = lm[i].y;
  }
}

/** Coordonnées de texture du modèle canonique (texture dessinée à plat sur le visage). */
export function fillUvCanonical(out: Float32Array): void {
  out.set(FACE_UV.subarray(0, FACE_VERTEX_COUNT * 2));
}

export type Rgb = [number, number, number];

/** Moyenne RGB (0..1) de pixels RGBA autour de points normalisés (fenêtre de `radius` pixels de chaque côté). */
export function sampleMean(data: Uint8ClampedArray | Uint8Array, width: number, height: number, pts: Array<{ x: number; y: number }>, radius = 1): Rgb | null {
  if (width < 1 || height < 1 || data.length < width * height * 4) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const cx = Math.round(p.x * (width - 1));
    const cy = Math.round(p.y * (height - 1));
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const o = (y * width + x) * 4;
        r += data[o];
        g += data[o + 1];
        b += data[o + 2];
        n++;
      }
    }
  }
  return n ? [r / (n * 255), g / (n * 255), b / (n * 255)] : null;
}

/**
 * Gain par canal qui ramène la couleur de la texture vers celle de la peau cible ; `strength` 0 (aucune
 * correction) à 1 (complète). Borné pour éviter les teintes aberrantes.
 */
export function colorGain(source: Rgb | null, target: Rgb | null, strength: number): Rgb {
  if (!source || !target) return [1, 1, 1];
  const s = Math.max(0, Math.min(1, strength));
  const g = (a: number, b: number) => {
    const ratio = Math.max(0.5, Math.min(2, (b + 0.02) / (a + 0.02)));
    return 1 + (ratio - 1) * s;
  };
  return [g(source[0], target[0]), g(source[1], target[1]), g(source[2], target[2])];
}

/** Lissage exponentiel des gains (évite le scintillement) ; `k` 0..1 = part de la nouvelle valeur. */
export function blendGain(prev: Rgb, next: Rgb, k: number): Rgb {
  const a = Math.max(0, Math.min(1, k));
  return [prev[0] + (next[0] - prev[0]) * a, prev[1] + (next[1] - prev[1]) * a, prev[2] + (next[2] - prev[2]) * a];
}

/** Pour l'échange : le visage i prend la texture du visage `pairOf(i, count)`, ou -1 s'il n'y a pas de partenaire. */
export function swapPartner(index: number, count: number): number {
  if (count < 2) return -1;
  return index % 2 === 0 ? (index + 1 < count ? index + 1 : -1) : index - 1;
}

/** Index de sommets du maillage (sans copie à chaque trame). */
export const FACE_INDICES: Uint16Array = FACE_TRIANGLES;
