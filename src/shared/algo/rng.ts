/**
 * Générateur mulberry32 (état 32 bits avancé d'une constante, sortie mélangée) : même graine → même suite, période
 * 2^32. Les fonctions publiques rendent la graine suivante pour que l'état la garde.
 *
 * Pas la même suite que `$rand` de sonic-store : celui-ci repart de sa sortie (hash itéré), ce qui peut boucler après
 * quelques dizaines de milliers de tirages — trop court pour une marche aléatoire ou une grande caverne.
 */
/** Tirage séquentiel : `rng.next()` ∈ [0, 1), `rng.seed` = graine à rendre à l'état. */
export class Rng {
  seed: number;
  constructor(seed: unknown) {
    this.seed = toSeed(seed);
  }
  next(): number {
    this.seed = (this.seed + 0x6d2b79f5) >>> 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * Math.max(1, Math.floor(n)));
  }
  range(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
}

/** Graine depuis un nombre ou une chaîne (FNV-1a). */
export function toSeed(seed: unknown): number {
  if (typeof seed === "string") {
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
    return h >>> 0;
  }
  const n = Number(seed);
  return Number.isFinite(n) ? n >>> 0 : 0;
}
