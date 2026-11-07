/**
 * Grille de navigation (cellules de 0,5 m) issue des emprises, de l'eau et des pentes, et recherche de chemin A*
 * (8 voisins, heuristique octile) avec lissage par visibilité.
 */
export class NavGrid {
  readonly cell: number;
  readonly nx: number;
  readonly nz: number;
  readonly ox: number;
  readonly oz: number;
  readonly blocked: Uint8Array;

  constructor(w: number, d: number, cell = 0.5) {
    this.cell = cell;
    this.nx = Math.max(2, Math.ceil(w / cell));
    this.nz = Math.max(2, Math.ceil(d / cell));
    this.ox = -w / 2;
    this.oz = -d / 2;
    this.blocked = new Uint8Array(this.nx * this.nz);
  }
  toCell(x: number, z: number): [number, number] {
    return [Math.floor((x - this.ox) / this.cell), Math.floor((z - this.oz) / this.cell)];
  }
  center(i: number, j: number): [number, number] {
    return [this.ox + (i + 0.5) * this.cell, this.oz + (j + 0.5) * this.cell];
  }
  inside(i: number, j: number) {
    return i >= 0 && j >= 0 && i < this.nx && j < this.nz;
  }
  isBlocked(i: number, j: number) {
    return !this.inside(i, j) || this.blocked[j * this.nx + i] === 1;
  }
  free(x: number, z: number) {
    const [i, j] = this.toCell(x, z);
    return !this.isBlocked(i, j);
  }
  /** Bloque une boîte orientée (centre, demi-côtés, lacet), avec une marge (rayon de l'agent). */
  blockBox(cx: number, cz: number, hx: number, hz: number, yaw: number, margin = 0.3) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const R = Math.hypot(hx, hz) + margin;
    const [i0, j0] = this.toCell(cx - R, cz - R);
    const [i1, j1] = this.toCell(cx + R, cz + R);
    for (let j = Math.max(0, j0); j <= Math.min(this.nz - 1, j1); j++)
      for (let i = Math.max(0, i0); i <= Math.min(this.nx - 1, i1); i++) {
        const [x, z] = this.center(i, j);
        const dx = x - cx, dz = z - cz;
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        if (Math.abs(lx) <= hx + margin && Math.abs(lz) <= hz + margin) this.blocked[j * this.nx + i] = 1;
      }
  }
  /** Cellule libre la plus proche (spirale). */
  nearestFree(x: number, z: number): [number, number] | null {
    const [ci, cj] = this.toCell(x, z);
    for (let r = 0; r < 40; r++)
      for (let j = cj - r; j <= cj + r; j++)
        for (let i = ci - r; i <= ci + r; i++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
          if (!this.isBlocked(i, j)) return [i, j];
        }
    return null;
  }

  private los(a: [number, number], b: [number, number]): boolean {
    const [x0, z0] = this.center(a[0], a[1]);
    const [x1, z1] = this.center(b[0], b[1]);
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (this.cell * 0.5));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      if (!this.free(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return false;
    }
    return true;
  }

  /** Chemin (points monde x, z) de `from` à `to`, ou `null` s'il n'existe pas. */
  path(from: [number, number], to: [number, number], maxNodes = 20000): [number, number][] | null {
    const s = this.nearestFree(from[0], from[1]);
    const g = this.nearestFree(to[0], to[1]);
    if (!s || !g) return null;
    const W = this.nx;
    const key = (i: number, j: number) => j * W + i;
    const gScore = new Float32Array(this.nx * this.nz).fill(Infinity);
    const came = new Int32Array(this.nx * this.nz).fill(-1);
    const closed = new Uint8Array(this.nx * this.nz);
    const heap: [number, number][] = [];
    const push = (k: number, f: number) => {
      heap.push([f, k]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    const h = (i: number, j: number) => {
      const dx = Math.abs(i - g[0]), dz = Math.abs(j - g[1]);
      return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz);
    };
    const sk = key(s[0], s[1]);
    gScore[sk] = 0;
    push(sk, h(s[0], s[1]));
    let found = false;
    let n = 0;
    while (heap.length && n++ < maxNodes) {
      const [, k] = pop();
      if (closed[k]) continue;
      closed[k] = 1;
      const i = k % W, j = (k / W) | 0;
      if (i === g[0] && j === g[1]) {
        found = true;
        break;
      }
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = i + di, nj = j + dj;
          if (this.isBlocked(ni, nj)) continue;
          if (di && dj && (this.isBlocked(i + di, j) || this.isBlocked(i, j + dj))) continue;
          const nk = key(ni, nj);
          const c = gScore[k] + (di && dj ? Math.SQRT2 : 1);
          if (c < gScore[nk]) {
            gScore[nk] = c;
            came[nk] = k;
            push(nk, c + h(ni, nj));
          }
        }
    }
    if (!found) return null;
    const cells: [number, number][] = [];
    for (let k = key(g[0], g[1]); k >= 0; k = came[k]) cells.push([k % W, (k / W) | 0]);
    cells.reverse();
    // lissage : on garde un point dès que la ligne de vue est rompue
    const out: [number, number][] = [this.center(cells[0][0], cells[0][1])];
    let anchor = cells[0];
    for (let i = 2; i < cells.length; i++) {
      if (!this.los(anchor, cells[i])) {
        anchor = cells[i - 1];
        out.push(this.center(anchor[0], anchor[1]));
      }
    }
    out.push(to);
    out[0] = from;
    return out;
  }
}
