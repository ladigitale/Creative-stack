/**
 * Tas binaire minimal sur tableaux typés (clé entière, priorité flottante), sans allocation par élément.
 * Utilisé par A*, Dijkstra et les cartes de distances. Les doublons sont permis : le consommateur ignore une clé déjà
 * fermée (« lazy deletion »), ce qui est plus rapide qu'un decrease-key sur des grilles.
 */
export class MinHeap {
  private keys: Int32Array;
  private prio: Float64Array;
  size = 0;

  constructor(capacity = 256) {
    this.keys = new Int32Array(Math.max(4, capacity));
    this.prio = new Float64Array(Math.max(4, capacity));
  }

  clear(): void {
    this.size = 0;
  }

  push(key: number, p: number): void {
    if (this.size === this.keys.length) {
      const k = new Int32Array(this.keys.length * 2);
      k.set(this.keys);
      this.keys = k;
      const q = new Float64Array(this.prio.length * 2);
      q.set(this.prio);
      this.prio = q;
    }
    const keys = this.keys, prio = this.prio;
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (prio[parent] <= p) break;
      keys[i] = keys[parent];
      prio[i] = prio[parent];
      i = parent;
    }
    keys[i] = key;
    prio[i] = p;
  }

  /** Priorité de la tête (Infinity si vide). */
  peekPriority(): number {
    return this.size ? this.prio[0] : Infinity;
  }

  /** Retire et rend la clé de plus petite priorité (-1 si vide). */
  pop(): number {
    if (!this.size) return -1;
    const keys = this.keys, prio = this.prio;
    const top = keys[0];
    const n = --this.size;
    if (n > 0) {
      const k = keys[n], p = prio[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && prio[r] < prio[l] ? r : l;
        if (prio[m] >= p) break;
        keys[i] = keys[m];
        prio[i] = prio[m];
        i = m;
      }
      keys[i] = k;
      prio[i] = p;
    }
    return top;
  }
}
