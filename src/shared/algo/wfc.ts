/**
 * Wave Function Collapse, modèle « tuiles simples appris d'un exemple » : les voisinages permis (4 directions) et les
 * fréquences viennent d'une petite grille modèle ; la sortie n'emploie que des voisinages vus dans l'exemple.
 * Domaines en masques 32 bits (32 tuiles au plus), propagation par pile, cellule de plus faible entropie d'abord,
 * nouvel essai (graine suivante) en cas de contradiction. Cases imposées : `fixed` (lignes, `?` = libre).
 */
import { MinHeap } from "./heap";
import { Rng } from "./rng";

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

export interface WfcOptions {
  periodic?: boolean;
  /** L'exemple boucle sur ses bords (voisinages appris aussi à travers les bords). */
  wrapSample?: boolean;
  fixed?: string[];
  tries?: number;
}

export function wfc(sample: string[], w: number, h: number, rng: Rng, o: WfcOptions = {}): string[] | null {
  const sh = sample.length, sw = Math.max(...sample.map((r) => [...r].length));
  const rows = sample.map((r) => [...r]);
  const tiles: string[] = [];
  const idx = new Map<string, number>();
  const freq: number[] = [];
  for (const r of rows)
    for (const c of r) {
      let i = idx.get(c);
      if (i === undefined) {
        i = tiles.length;
        if (i >= 32) throw new Error("wfc : 32 tuiles différentes au plus dans l'exemple");
        idx.set(c, i);
        tiles.push(c);
        freq.push(0);
      }
      freq[i]++;
    }
  const T = tiles.length;
  if (!T) throw new Error("wfc : exemple vide");
  // compat[d][t] = masque des tuiles permises dans la direction d à côté de t
  const compat = [0, 1, 2, 3].map(() => new Uint32Array(T));
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < rows[y].length; x++) {
      const t = idx.get(rows[y][x])!;
      for (let d = 0; d < 4; d++) {
        let nx = x + DX[d], ny = y + DY[d];
        if (o.wrapSample) {
          nx = (nx + sw) % sw;
          ny = (ny + sh) % sh;
        }
        if (ny < 0 || ny >= sh || nx < 0 || nx >= rows[ny].length) continue;
        compat[d][t] |= 1 << idx.get(rows[ny][nx])!;
      }
    }
  const full = T === 32 ? 0xffffffff : (1 << T) - 1;
  const logw = freq.map((f) => Math.log(f));
  const n = w * h;
  const tries = Math.max(1, Math.min(20, o.tries ?? 8));
  const popcount = (m: number) => {
    m -= (m >>> 1) & 0x55555555;
    m = (m & 0x33333333) + ((m >>> 2) & 0x33333333);
    return (((m + (m >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  };
  for (let attempt = 0; attempt < tries; attempt++) {
    const dom = new Uint32Array(n).fill(full >>> 0);
    // sommes des poids (et poids × log) des tuiles encore possibles, tenues à jour : entropie en O(1) par case
    let fw = 0, fwl = 0;
    for (let t = 0; t < T; t++) {
      fw += freq[t];
      fwl += freq[t] * logw[t];
    }
    const sumW = new Float64Array(n).fill(fw);
    const sumWL = new Float64Array(n).fill(fwl);
    const count = new Uint8Array(n).fill(T);
    const noise = new Float64Array(n);
    for (let k = 0; k < n; k++) noise[k] = rng.next() * 1e-6;
    const stack: number[] = [];
    const entropy = (k: number) => Math.log(sumW[k]) - sumWL[k] / sumW[k] + noise[k];
    // tas des cases à décider (entrées périmées ignorées au retrait)
    const heap = new MinHeap(n * 2);
    let ok = true;
    const restrict = (k: number, m: number): boolean => {
      const nm = (dom[k] & m) >>> 0;
      if (nm === dom[k]) return true;
      for (let gone = (dom[k] & ~nm) >>> 0; gone; gone &= gone - 1) {
        const t = 31 - Math.clz32(gone & -gone);
        sumW[k] -= freq[t];
        sumWL[k] -= freq[t] * logw[t];
      }
      dom[k] = nm;
      count[k] = popcount(nm);
      if (!nm) return false;
      if (count[k] > 1) heap.push(k, entropy(k));
      stack.push(k);
      return true;
    };
    const propagate = (): boolean => {
      while (stack.length) {
        const k = stack.pop()!;
        const x = k % w, y = (k - x) / w;
        for (let d = 0; d < 4; d++) {
          let nx = x + DX[d], ny = y + DY[d];
          if (o.periodic) {
            nx = (nx + w) % w;
            ny = (ny + h) % h;
          } else if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          let allowed = 0;
          let m = dom[k];
          while (m) {
            const t = 31 - Math.clz32(m & -m);
            allowed |= compat[d][t];
            m &= m - 1;
          }
          if (!restrict(ny * w + nx, allowed >>> 0)) return false;
        }
      }
      return true;
    };
    if (o.fixed) {
      o.fixed.forEach((row, y) =>
        [...row].forEach((c, x) => {
          if (!ok || y >= h || x >= w || c === "?") return;
          const t = idx.get(c);
          if (t === undefined) ok = false;
          else ok = restrict(y * w + x, 1 << t);
        }),
      );
      ok = ok && propagate();
      if (!ok) return null; // contradiction dans les cases imposées : inutile de réessayer
    }
    for (let k = 0; k < n; k++) if (count[k] > 1) heap.push(k, entropy(k));
    while (ok) {
      // cellule non fixée de plus faible entropie (pondérée), départagée au hasard
      let best = -1;
      while (heap.size) {
        const p = heap.peekPriority();
        const k = heap.pop();
        if (count[k] > 1 && Math.abs(p - entropy(k)) < 1e-12) {
          best = k;
          break;
        }
      }
      if (best < 0) break;
      // tirage pondéré par la fréquence
      let m = dom[best], total = 0;
      for (let mm = m; mm; mm &= mm - 1) total += freq[31 - Math.clz32(mm & -mm)];
      let r = rng.next() * total, pick = 0;
      for (; m; m &= m - 1) {
        pick = 31 - Math.clz32(m & -m);
        r -= freq[pick];
        if (r < 0) break;
      }
      ok = restrict(best, 1 << pick) && propagate();
    }
    if (ok) {
      const out: string[] = [];
      for (let y = 0; y < h; y++) {
        let s = "";
        for (let x = 0; x < w; x++) s += tiles[31 - Math.clz32(dom[y * w + x])];
        out.push(s);
      }
      return out;
    }
  }
  return null;
}
