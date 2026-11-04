/**
 * Tampon circulaire d'images horodatées, avec les deux façons de retrouver « la bonne » image :
 * par identité (`seq`, exact : image analysée par un tracker) ou par date (`at`, retard fixe).
 * Indépendant du DOM : la valeur stockée est opaque (un canvas pour `sonic-frame-sync`).
 */
export type RingSlot<T> = { seq: number; at: number; value: T };

export class FrameRing<T> {
  private items: RingSlot<T>[] = [];

  constructor(public capacity: number) {}

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }

  /**
   * Ajoute une image. Quand le tampon est plein, la plus ancienne image qui n'est pas
   * `pinnedSeq` (celle qu'on est en train d'afficher) est retirée et sa valeur est
   * donnée à `fill` pour être réutilisée (évite d'allouer un canvas par image).
   */
  push(seq: number, at: number, fill: (recycled: T | null) => T, pinnedSeq: number | null = null): RingSlot<T> {
    let recycled: T | null = null;
    const cap = Math.max(1, Math.round(this.capacity));
    while (this.items.length >= cap) {
      const i = this.items.findIndex((s) => s.seq !== pinnedSeq);
      if (i < 0) break;
      const [gone] = this.items.splice(i, 1);
      recycled = recycled === null ? gone.value : recycled;
    }
    const slot = { seq, at, value: fill(recycled) };
    this.items.push(slot);
    return slot;
  }

  newest(): RingSlot<T> | null {
    return this.items.length ? this.items[this.items.length - 1] : null;
  }

  oldest(): RingSlot<T> | null {
    return this.items.length ? this.items[0] : null;
  }

  /** Image la plus récente dont `seq` ≤ `target` ; à défaut la plus ancienne gardée. */
  bySeq(target: number): RingSlot<T> | null {
    let found: RingSlot<T> | null = null;
    for (const s of this.items) {
      if (s.seq <= target) found = s;
      else break;
    }
    return found ?? this.oldest();
  }

  /** Image la plus récente prise au plus tard à `time` (ms) ; à défaut la plus ancienne gardée. */
  byTime(time: number): RingSlot<T> | null {
    let found: RingSlot<T> | null = null;
    for (const s of this.items) {
      if (s.at <= time) found = s;
      else break;
    }
    return found ?? this.oldest();
  }
}
