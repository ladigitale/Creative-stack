/**
 * Grille de hachage spatiale sur le plan xz, sans bord : boîtes alignées (décor, instances) et points (copies d'un
 * émetteur). Aucune dépendance au rendu ni au DOM.
 */

export type Aabb = {
  /** Instance nommée, ou vide pour le décor. */
  name: string;
  /** Étiquettes visées par un `mask` : nom de l'instance, modèle de base, famille, étiquettes du prefab, `decor`. */
  tags: readonly string[];
  lo: [number, number, number];
  hi: [number, number, number];
};

const key = (i: number, j: number) => i * 73856093 ^ j * 19349663;

/** Boîtes indexées par cellule (une boîte couvre toutes les cellules de son emprise). */
/** Ce que les simulations interrogent : boîtes dont l'emprise touche un rectangle xz. */
export interface BoxQuery {
  query(x0: number, z0: number, x1: number, z1: number, fn: (b: Aabb, id: number) => void): void;
}

/** Deux grilles vues comme une seule (identifiants de la seconde décalés d'un million). */
export class GridPair implements BoxQuery {
  constructor(
    readonly a: BoxGrid,
    readonly b: BoxGrid,
  ) {}
  query(x0: number, z0: number, x1: number, z1: number, fn: (b: Aabb, id: number) => void) {
    this.a.query(x0, z0, x1, z1, fn);
    this.b.query(x0, z0, x1, z1, (box, id) => fn(box, id + 1_000_000));
  }
}

export class BoxGrid implements BoxQuery {
  readonly cell: number;
  private cells = new Map<number, number[]>();
  boxes: Aabb[] = [];
  private mark: Uint32Array = new Uint32Array(0);
  private stamp = 0;

  constructor(cell = 2) {
    this.cell = cell > 0 ? cell : 2;
  }

  clear() {
    this.cells.clear();
    this.boxes = [];
  }

  add(b: Aabb) {
    const id = this.boxes.length;
    this.boxes.push(b);
    const c = this.cell;
    const i0 = Math.floor(b.lo[0] / c), i1 = Math.floor(b.hi[0] / c);
    const j0 = Math.floor(b.lo[2] / c), j1 = Math.floor(b.hi[2] / c);
    // une boîte immense (sol, plafond) ne remplit pas des milliers de cellules : elle est testée à part
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 400) {
      const big = this.cells.get(-1) ?? [];
      big.push(id);
      this.cells.set(-1, big);
      return;
    }
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const k = key(i, j);
        const l = this.cells.get(k);
        if (l) l.push(id);
        else this.cells.set(k, [id]);
      }
  }

  /** Boîtes dont l'emprise touche le rectangle xz donné (chacune une seule fois). */
  query(x0: number, z0: number, x1: number, z1: number, fn: (b: Aabb, id: number) => void) {
    if (this.mark.length < this.boxes.length) this.mark = new Uint32Array(Math.max(64, this.boxes.length * 2));
    const s = ++this.stamp;
    const visit = (l: number[] | undefined) => {
      if (!l) return;
      for (const id of l) {
        if (this.mark[id] === s) continue;
        this.mark[id] = s;
        fn(this.boxes[id], id);
      }
    };
    visit(this.cells.get(-1));
    const c = this.cell;
    const i0 = Math.floor(Math.min(x0, x1) / c), i1 = Math.floor(Math.max(x0, x1) / c);
    const j0 = Math.floor(Math.min(z0, z1) / c), j1 = Math.floor(Math.max(z0, z1) / c);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 256) {
      // segment très long : toutes les boîtes
      for (let id = 0; id < this.boxes.length; id++) visit([id]);
      return;
    }
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) visit(this.cells.get(key(i, j)));
  }
}

/** Points (indices de copies) par cellule, reconstruits à chaque pas : voisinage d'une nuée. */
export class PointGrid {
  readonly cell: number;
  private head = new Map<number, number>();
  private next: Int32Array = new Int32Array(0);

  constructor(cell: number) {
    this.cell = cell > 0 ? cell : 1;
  }

  rebuild(x: Float32Array, z: Float32Array, n: number) {
    this.head.clear();
    if (this.next.length < n) this.next = new Int32Array(Math.max(16, n));
    const c = this.cell;
    for (let k = 0; k < n; k++) {
      const h = key(Math.floor(x[k] / c), Math.floor(z[k] / c));
      const first = this.head.get(h);
      this.next[k] = first === undefined ? -1 : first;
      this.head.set(h, k);
    }
  }

  /** Indices des points des 9 cellules autour de (x, z), au plus `max` (s'arrête dès que `fn` rend `false`). */
  near(x: number, z: number, fn: (k: number) => boolean) {
    const c = this.cell;
    const i = Math.floor(x / c), j = Math.floor(z / c);
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++) {
        let k = this.head.get(key(i + di, j + dj));
        while (k !== undefined && k >= 0) {
          if (!fn(k)) return;
          k = this.next[k];
        }
      }
  }
}

/**
 * Segment `p0 → p1` élargi d'un rayon `r` contre une boîte : fraction du trajet au contact (0 à 1) et normale de la
 * face touchée, ou `null`. Méthode des tranches sur la boîte grossie de `r` (sphère balayée approchée).
 */
export function sweepBox(
  p0: readonly number[],
  p1: readonly number[],
  r: number,
  b: Aabb,
): { t: number; n: [number, number, number] } | null {
  let t0 = 0, t1 = 1;
  let axis = -1, sign = 0;
  for (let a = 0; a < 3; a++) {
    const lo = b.lo[a] - r, hi = b.hi[a] + r;
    const d = p1[a] - p0[a];
    if (Math.abs(d) < 1e-9) {
      if (p0[a] < lo || p0[a] > hi) return null;
      continue;
    }
    let ta = (lo - p0[a]) / d, tb = (hi - p0[a]) / d;
    let s = -1;
    if (ta > tb) {
      const t = ta;
      ta = tb;
      tb = t;
      s = 1;
    }
    if (ta > t0) {
      t0 = ta;
      axis = a;
      sign = s;
    }
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }
  // départ déjà dedans : contact immédiat, normale vers l'arrière du trajet
  if (axis < 0) {
    const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    let best = 0;
    for (let a = 1; a < 3; a++) if (Math.abs(d[a]) > Math.abs(d[best])) best = a;
    const n: [number, number, number] = [0, 0, 0];
    n[best] = d[best] > 0 ? -1 : 1;
    return { t: 0, n };
  }
  const n: [number, number, number] = [0, 0, 0];
  n[axis] = sign;
  return { t: t0, n };
}
