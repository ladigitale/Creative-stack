/**
 * Aléa déterministe à graine hiérarchique.
 *
 * `new Rng("12").fork("maisons").fork("3")` donne toujours la même suite, quel que soit l'ordre dans lequel les autres
 * sous-éléments ont tiré leurs nombres : changer un paramètre d'une maison ne rebat pas les cartes du reste de la scène.
 */

/** Hachage 32 bits d'une chaîne (FNV-1a + mélange final). */
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

export class Rng {
  readonly key: string;
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: string | number = 1) {
    this.key = String(seed);
    const h = hash32(this.key);
    // sfc32, état dérivé de la clé
    this.s0 = h;
    this.s1 = hash32(this.key + "/a");
    this.s2 = hash32(this.key + "/b");
    this.s3 = 1;
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Sous-générateur indépendant, stable pour une clé donnée. */
  fork(key: string | number): Rng {
    return new Rng(`${this.key}/${key}`);
  }

  /** [0, 1[ */
  next(): number {
    const t = (((this.s0 + this.s1) | 0) + this.s3) | 0;
    this.s3 = (this.s3 + 1) | 0;
    this.s0 = this.s1 ^ (this.s1 >>> 9);
    this.s1 = (this.s2 + (this.s2 << 3)) | 0;
    this.s2 = (this.s2 << 21) | (this.s2 >>> 11);
    this.s2 = (this.s2 + t) | 0;
    return (t >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)];
  }
  /** Choix pondéré : `[[valeur, poids], …]`. */
  weighted<T>(list: readonly (readonly [T, number])[]): T {
    const total = list.reduce((s, [, w]) => s + Math.max(0, w), 0);
    let r = this.next() * total;
    for (const [v, w] of list) {
      r -= Math.max(0, w);
      if (r <= 0) return v;
    }
    return list[list.length - 1][0];
  }
  /** Gaussienne (Box-Muller), moyenne 0, écart-type 1. */
  normal(): number {
    const u = 1 - this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  /** Variation relative : `x * (1 ± amount)`. */
  vary(x: number, amount: number): number {
    return x * (1 + this.range(-amount, amount));
  }
}
