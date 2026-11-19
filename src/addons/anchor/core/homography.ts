/**
 * Homographie plane 3×3 (ligne par ligne, h[8] = 1 après normalisation) : DLT normalisée,
 * RANSAC adaptatif, raffinement aux moindres carrés sur les points retenus.
 */

export type Mat3 = Float64Array;
export type Pt = { x: number; y: number };

export function apply(h: Mat3, x: number, y: number): Pt | null {
  const w = h[6] * x + h[7] * y + h[8];
  if (!(Math.abs(w) > 1e-12)) return null;
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

export function multiply(a: Mat3, b: Mat3): Mat3 {
  const o = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return o;
}

export function invert(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-15)) return null;
  const o = new Float64Array([
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ]);
  for (let k = 0; k < 9; k++) o[k] /= det;
  return o;
}

function normalize(h: Mat3): Mat3 | null {
  if (!(Math.abs(h[8]) > 1e-12)) return null;
  const s = h[8];
  for (let k = 0; k < 9; k++) h[k] /= s;
  return h;
}

/** Résout A x = b (n×n, élimination de Gauss avec pivot partiel). */
export function solve(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const M = A.slice(), v = b.slice();
  for (let c = 0; c < n; c++) {
    let p = c, best = Math.abs(M[c * n + c]);
    for (let r = c + 1; r < n; r++) {
      const a = Math.abs(M[r * n + c]);
      if (a > best) { best = a; p = r; }
    }
    if (best < 1e-12) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[p * n + k]; M[p * n + k] = t; }
      const t = v[c]; v[c] = v[p]; v[p] = t;
    }
    const d = M[c * n + c];
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      v[r] -= f * v[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = v[r];
    for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
    x[r] = s / M[r * n + r];
  }
  return x;
}

/** Normalisation de Hartley : centre à l'origine, distance moyenne √2. */
function hartley(xs: ArrayLike<number>, ys: ArrayLike<number>, idx: ArrayLike<number>): Mat3 {
  const n = idx.length;
  let cx = 0, cy = 0;
  for (let k = 0; k < n; k++) { cx += xs[idx[k]]; cy += ys[idx[k]]; }
  cx /= n; cy /= n;
  let d = 0;
  for (let k = 0; k < n; k++) d += Math.hypot(xs[idx[k]] - cx, ys[idx[k]] - cy);
  const s = d > 1e-9 ? (Math.SQRT2 * n) / d : 1;
  return new Float64Array([s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1]);
}

/**
 * Homographie src → dst au sens des moindres carrés (≥ 4 points, indices `idx`).
 * Équations normales sur les points normalisés, h33 = 1.
 */
export function fitHomography(
  sx: ArrayLike<number>, sy: ArrayLike<number>, dx: ArrayLike<number>, dy: ArrayLike<number>, idx: ArrayLike<number>,
): Mat3 | null {
  const n = idx.length;
  if (n < 4) return null;
  const Ts = hartley(sx, sy, idx), Td = hartley(dx, dy, idx);
  const AtA = new Float64Array(64), Atb = new Float64Array(8);
  const row = new Float64Array(8);
  const acc = (rhs: number) => {
    for (let i = 0; i < 8; i++) {
      const ri = row[i];
      if (!ri) continue;
      Atb[i] += ri * rhs;
      for (let j = 0; j < 8; j++) AtA[i * 8 + j] += ri * row[j];
    }
  };
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    const x = Ts[0] * sx[i] + Ts[2], y = Ts[4] * sy[i] + Ts[5];
    const u = Td[0] * dx[i] + Td[2], v = Td[4] * dy[i] + Td[5];
    row.set([x, y, 1, 0, 0, 0, -u * x, -u * y]); acc(u);
    row.set([0, 0, 0, x, y, 1, -v * x, -v * y]); acc(v);
  }
  const h = solve(AtA, Atb, 8);
  if (!h) return null;
  const Hn = new Float64Array([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]);
  const TdInv = invert(Td);
  if (!TdInv) return null;
  return normalize(multiply(multiply(TdInv, Hn), Ts));
}

export type RansacOptions = {
  /** Erreur de reprojection maximale (pixels de l'image d'arrivée). */
  threshold?: number;
  maxIterations?: number;
  confidence?: number;
  /** Rejette une hypothèse (cohérence géométrique, a priori de gravité…). */
  accept?: (h: Mat3) => boolean;
  /** Aléa (0..1) ; déterministe dans les tests. */
  random?: () => number;
};

export type RansacResult = { h: Mat3; inliers: Uint8Array; count: number; error: number };

function area2(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** RANSAC à 4 points, itérations adaptatives, raffinement final sur les points retenus. */
export function ransacHomography(
  sx: ArrayLike<number>, sy: ArrayLike<number>, dx: ArrayLike<number>, dy: ArrayLike<number>, n: number,
  opts: RansacOptions = {},
): RansacResult | null {
  if (n < 4) return null;
  const thr = opts.threshold ?? 4;
  const thr2 = thr * thr;
  const conf = opts.confidence ?? 0.995;
  let maxIt = opts.maxIterations ?? 600;
  const rnd = opts.random ?? Math.random;
  const accept = opts.accept;

  const count = (h: Mat3, mask: Uint8Array | null): [number, number] => {
    let c = 0, e = 0;
    for (let i = 0; i < n; i++) {
      const w = h[6] * sx[i] + h[7] * sy[i] + h[8];
      if (!(w > 1e-9)) { if (mask) mask[i] = 0; continue; }
      const ex = (h[0] * sx[i] + h[1] * sy[i] + h[2]) / w - dx[i];
      const ey = (h[3] * sx[i] + h[4] * sy[i] + h[5]) / w - dy[i];
      const d2 = ex * ex + ey * ey;
      const ok = d2 < thr2;
      if (mask) mask[i] = ok ? 1 : 0;
      if (ok) { c++; e += d2; }
    }
    return [c, e];
  };

  let best: Mat3 | null = null, bestCount = 0, bestErr = Infinity;
  const pick = new Int32Array(4);
  const minArea = 1e-3;
  let span = 1;
  for (let i = 0; i < n; i++) span = Math.max(span, Math.abs(sx[i]), Math.abs(sy[i]));
  for (let it = 0; it < maxIt; it++) {
    for (let k = 0; k < 4; k++) {
      let j: number;
      do { j = Math.floor(rnd() * n); } while (pick.subarray(0, k).includes(j));
      pick[k] = j;
    }
    // Échantillon dégénéré : trois points alignés.
    const [a, b, c, d] = pick;
    const lim = minArea * span * span;
    if (Math.abs(area2(sx[a], sy[a], sx[b], sy[b], sx[c], sy[c])) < lim
      || Math.abs(area2(sx[a], sy[a], sx[b], sy[b], sx[d], sy[d])) < lim
      || Math.abs(area2(sx[a], sy[a], sx[c], sy[c], sx[d], sy[d])) < lim
      || Math.abs(area2(sx[b], sy[b], sx[c], sy[c], sx[d], sy[d])) < lim) continue;
    const h = fitHomography(sx, sy, dx, dy, pick);
    if (!h || (accept && !accept(h))) continue;
    const [cnt, err] = count(h, null);
    if (cnt > bestCount || (cnt === bestCount && err < bestErr)) {
      best = h; bestCount = cnt; bestErr = err;
      const w = cnt / n;
      const denom = Math.log(1 - Math.pow(w, 4));
      if (denom < 0) maxIt = Math.min(maxIt, Math.ceil(Math.log(1 - conf) / denom));
    }
  }
  if (!best || bestCount < 4) return null;
  const mask = new Uint8Array(n);
  count(best, mask);
  // Raffinement : deux passes de moindres carrés sur les points retenus.
  for (let pass = 0; pass < 2; pass++) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (mask[i]) idx.push(i);
    const h = fitHomography(sx, sy, dx, dy, idx);
    if (!h || (accept && !accept(h))) break;
    const m2 = new Uint8Array(n);
    const [cnt, err] = count(h, m2);
    if (cnt < bestCount) break;
    best = h; bestCount = cnt; bestErr = err; mask.set(m2);
  }
  return { h: best, inliers: mask, count: bestCount, error: Math.sqrt(bestErr / Math.max(1, bestCount)) };
}

/** Le quadrilatère (dans l'ordre) est-il convexe et orienté positivement (même sens qu'à l'origine) ? */
export function convexQuad(p: Pt[], sign = 1): boolean {
  if (p.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
    if (area2(a.x, a.y, b.x, b.y, c.x, c.y) * sign <= 0) return false;
  }
  return true;
}

export function quadArea(p: Pt[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Homographie qui envoie le carré unité (0,0)(1,0)(1,1)(0,1) sur les 4 coins donnés. */
export function squareToQuad(q: Pt[]): Mat3 | null {
  return fitHomography([0, 1, 1, 0], [0, 0, 1, 1], q.map((p) => p.x), q.map((p) => p.y), [0, 1, 2, 3]);
}

/** Matrice CSS `matrix3d` équivalente (contenu w×h placé en 0,0, `transform-origin: 0 0`). */
export function toCssMatrix3d(h: Mat3): string {
  const m = [h[0], h[3], 0, h[6], h[1], h[4], 0, h[7], 0, 0, 1, 0, h[2], h[5], 0, h[8]];
  return `matrix3d(${m.map((v) => (Math.abs(v) < 1e-12 ? 0 : +v.toPrecision(8))).join(",")})`;
}
