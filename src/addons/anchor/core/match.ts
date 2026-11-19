import { DESC_WORDS } from "./features";

export type Matches = {
  /** Paires (index requête, index référence). */
  q: Uint32Array;
  r: Uint32Array;
  /** Distance de Hamming de chaque paire. */
  d: Uint16Array;
  n: number;
};

export function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

export type MatchOptions = {
  /** Distance maximale (sur 256 bits). */
  maxDistance?: number;
  /** Test de Lowe : meilleure < ratio × deuxième. */
  ratio?: number;
};

/**
 * Appariement par force brute (Hamming) avec test de ratio. Un point de référence n'est gardé
 * qu'une fois, avec sa meilleure requête.
 */
export function matchDescriptors(
  q: Uint32Array, nq: number, r: Uint32Array, nr: number, opts: MatchOptions = {},
): Matches {
  const maxD = opts.maxDistance ?? 64;
  const ratio = opts.ratio ?? 0.8;
  const bestQ = new Int32Array(nr).fill(-1);
  const bestQD = new Uint16Array(nr).fill(0xffff);
  for (let i = 0; i < nq; i++) {
    const qi = i * DESC_WORDS;
    let b1 = 0xffff, b2 = 0xffff, j1 = -1;
    for (let j = 0; j < nr; j++) {
      const rj = j * DESC_WORDS;
      let d = 0;
      for (let k = 0; k < DESC_WORDS; k++) {
        d += popcount32(q[qi + k] ^ r[rj + k]);
        if (d >= b2) break;
      }
      if (d < b1) { b2 = b1; b1 = d; j1 = j; }
      else if (d < b2) b2 = d;
    }
    if (j1 < 0 || b1 > maxD || b1 >= ratio * b2) continue;
    if (b1 < bestQD[j1]) { bestQD[j1] = b1; bestQ[j1] = i; }
  }
  const qa: number[] = [], ra: number[] = [], da: number[] = [];
  for (let j = 0; j < nr; j++) if (bestQ[j] >= 0) { qa.push(bestQ[j]); ra.push(j); da.push(bestQD[j]); }
  return { q: Uint32Array.from(qa), r: Uint32Array.from(ra), d: Uint16Array.from(da), n: qa.length };
}
