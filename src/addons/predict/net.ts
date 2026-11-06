import { rng } from "../paint/brush";
import type { Task } from "./data";

/**
 * Réseau dense minimal : `dims` = [entrée, (cachée,)… sortie]. Sans couche cachée c'est une régression
 * linéaire (1 sortie) ou logistique multinomiale (K sorties). ReLU cachée ; MSE ou entropie croisée softmax.
 */
export class Net {
  readonly dims: number[];
  W: Float64Array[] = [];
  b: Float64Array[] = [];

  constructor(dims: number[], seed = 1) {
    this.dims = dims;
    const r = rng(seed);
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r());
    for (let l = 0; l + 1 < dims.length; l++) {
      const [i, o] = [dims[l], dims[l + 1]];
      const w = new Float64Array(i * o);
      const s = Math.sqrt((l + 2 < dims.length ? 2 : 1) / i);
      for (let k = 0; k < w.length; k++) w[k] = gauss() * s;
      this.W.push(w);
      this.b.push(new Float64Array(o));
    }
  }

  /** Sorties brutes (logits ou valeur) de `rows` lignes de `X` à partir de `offsets`. */
  forwardAll(X: Float64Array, idx: ArrayLike<number>): Float64Array[] {
    const layers = this.W.length;
    const acts: Float64Array[] = [];
    let prev: Float64Array | null = null;
    for (let l = 0; l < layers; l++) {
      const [din, dout] = [this.dims[l], this.dims[l + 1]];
      const out = new Float64Array(idx.length * dout);
      for (let n = 0; n < idx.length; n++) {
        const base = n * dout;
        for (let o = 0; o < dout; o++) out[base + o] = this.b[l][o];
        for (let i = 0; i < din; i++) {
          const a = l === 0 ? X[idx[n] * din + i] : prev![n * din + i];
          if (a === 0) continue;
          const wr = i * dout;
          for (let o = 0; o < dout; o++) out[base + o] += a * this.W[l][wr + o];
        }
        if (l < layers - 1) for (let o = 0; o < dout; o++) if (out[base + o] < 0) out[base + o] = 0;
      }
      acts.push(out);
      prev = out;
    }
    return acts;
  }

  predictRaw(X: Float64Array, idx: ArrayLike<number>): Float64Array {
    const acts = this.forwardAll(X, idx);
    return acts[acts.length - 1];
  }

  /** Perte moyenne (MSE/2 ou entropie croisée) sur `idx`. */
  loss(X: Float64Array, y: Float64Array, idx: ArrayLike<number>, task: Task): number {
    if (!idx.length) return 0;
    const out = this.predictRaw(X, idx);
    const k = this.dims[this.dims.length - 1];
    let s = 0;
    for (let n = 0; n < idx.length; n++) {
      if (task === "regression") s += 0.5 * (out[n] - y[idx[n]]) ** 2;
      else s -= Math.log(Math.max(softmaxAt(out, n * k, k)[y[idx[n]]], 1e-12));
    }
    return s / idx.length;
  }
}

export function softmaxAt(out: Float64Array, base: number, k: number): number[] {
  let m = -Infinity;
  for (let i = 0; i < k; i++) m = Math.max(m, out[base + i]);
  const e: number[] = [];
  let z = 0;
  for (let i = 0; i < k; i++) { const v = Math.exp(out[base + i] - m); e.push(v); z += v; }
  return e.map((v) => v / z);
}

export type TrainConfig = { task: Task; lr: number; weightDecay: number; batch: number; seed: number };

/** Optimiseur Adam, avancé une époque à la fois. */
export class Adam {
  private mW: Float64Array[];
  private vW: Float64Array[];
  private mB: Float64Array[];
  private vB: Float64Array[];
  private t = 0;
  private r: () => number;

  constructor(readonly net: Net, readonly cfg: TrainConfig) {
    this.mW = net.W.map((w) => new Float64Array(w.length));
    this.vW = net.W.map((w) => new Float64Array(w.length));
    this.mB = net.b.map((b) => new Float64Array(b.length));
    this.vB = net.b.map((b) => new Float64Array(b.length));
    this.r = rng(cfg.seed * 7919 + 13);
  }

  /** Une époque sur les lignes `train` (mélangées). Retourne la perte moyenne d'entraînement. */
  epoch(X: Float64Array, y: Float64Array, train: number[]): number {
    const order = train.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(this.r() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let total = 0;
    for (let s = 0; s < order.length; s += this.cfg.batch) {
      const idx = order.slice(s, s + this.cfg.batch);
      total += this.step(X, y, idx) * idx.length;
    }
    return total / Math.max(1, order.length);
  }

  private step(X: Float64Array, y: Float64Array, idx: number[]): number {
    const net = this.net, layers = net.W.length, B = idx.length;
    const acts = net.forwardAll(X, idx);
    const k = net.dims[layers];
    let delta: Float64Array = new Float64Array(B * k);
    let loss = 0;
    const out = acts[layers - 1];
    for (let n = 0; n < B; n++) {
      if (this.cfg.task === "regression") {
        const e = out[n] - y[idx[n]];
        delta[n] = e / B;
        loss += 0.5 * e * e;
      } else {
        const p = softmaxAt(out, n * k, k);
        for (let c = 0; c < k; c++) delta[n * k + c] = (p[c] - (c === y[idx[n]] ? 1 : 0)) / B;
        loss -= Math.log(Math.max(p[y[idx[n]]], 1e-12));
      }
    }
    this.t++;
    for (let l = layers - 1; l >= 0; l--) {
      const [din, dout] = [net.dims[l], net.dims[l + 1]];
      const gW = new Float64Array(din * dout);
      const gB = new Float64Array(dout);
      for (let n = 0; n < B; n++) {
        for (let o = 0; o < dout; o++) gB[o] += delta[n * dout + o];
        for (let i = 0; i < din; i++) {
          const a = l === 0 ? X[idx[n] * din + i] : acts[l - 1][n * din + i];
          if (a === 0) continue;
          for (let o = 0; o < dout; o++) gW[i * dout + o] += a * delta[n * dout + o];
        }
      }
      let next: Float64Array | null = null;
      if (l > 0) {
        next = new Float64Array(B * din);
        for (let n = 0; n < B; n++) {
          for (let i = 0; i < din; i++) {
            if (acts[l - 1][n * din + i] <= 0) continue;
            let s = 0;
            for (let o = 0; o < dout; o++) s += delta[n * dout + o] * net.W[l][i * dout + o];
            next[n * din + i] = s;
          }
        }
      }
      this.update(net.W[l], gW, this.mW[l], this.vW[l], true);
      this.update(net.b[l], gB, this.mB[l], this.vB[l], false);
      if (next) delta = next;
    }
    return loss / B;
  }

  private update(p: Float64Array, g: Float64Array, m: Float64Array, v: Float64Array, decay: boolean): void {
    const [b1, b2, eps] = [0.9, 0.999, 1e-8];
    const c1 = 1 - b1 ** this.t, c2 = 1 - b2 ** this.t;
    for (let i = 0; i < p.length; i++) {
      const gi = g[i] + (decay ? this.cfg.weightDecay * p[i] : 0);
      m[i] = b1 * m[i] + (1 - b1) * gi;
      v[i] = b2 * v[i] + (1 - b2) * gi * gi;
      p[i] -= (this.cfg.lr * (m[i] / c1)) / (Math.sqrt(v[i] / c2) + eps);
    }
  }
}
