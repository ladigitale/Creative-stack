import { softmaxAt, type Net } from "./net";
import type { Dataset, Task } from "./data";

export type RegressionMetrics = { task: "regression"; r2: number; rmse: number; mae: number; baselineRmse: number; n: number };
export type ClassificationMetrics = {
  task: "classification";
  accuracy: number;
  baselineAccuracy: number;
  macroF1: number;
  classes: string[];
  /** confusion[réelle][prédite] */
  confusion: number[][];
  n: number;
};
export type Metrics = RegressionMetrics | ClassificationMetrics;

export function predictAll(net: Net, X: Float64Array, idx: ArrayLike<number>, ds: Pick<Dataset, "target">): number[] {
  const out = net.predictRaw(X, idx);
  const t = ds.target;
  if (t.task === "regression") return Array.from({ length: idx.length }, (_, n) => out[n] * (t.std ?? 1) + (t.mean ?? 0));
  const k = t.classes!.length;
  return Array.from({ length: idx.length }, (_, n) => {
    const p = softmaxAt(out, n * k, k);
    return p.indexOf(Math.max(...p));
  });
}

/** Évalue sur `test`, la ligne de base étant calculée sur `train` (moyenne ou classe majoritaire). */
export function evaluate(net: Net, ds: Dataset, train: number[], test: number[]): Metrics {
  const t = ds.target;
  const pred = predictAll(net, ds.X, test, ds);
  if (t.task === "regression") {
    const truth = test.map((i) => ds.y[i] * (t.std ?? 1) + (t.mean ?? 0));
    const trainMean = train.reduce((s, i) => s + ds.y[i], 0) / train.length * (t.std ?? 1) + (t.mean ?? 0);
    const mean = truth.reduce((a, b) => a + b, 0) / truth.length;
    let se = 0, ae = 0, tot = 0, base = 0;
    truth.forEach((v, i) => { se += (v - pred[i]) ** 2; ae += Math.abs(v - pred[i]); tot += (v - mean) ** 2; base += (v - trainMean) ** 2; });
    return { task: "regression", r2: tot > 0 ? 1 - se / tot : 0, rmse: Math.sqrt(se / truth.length), mae: ae / truth.length, baselineRmse: Math.sqrt(base / truth.length), n: truth.length };
  }
  const k = t.classes!.length;
  const confusion = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  let ok = 0;
  test.forEach((i, n) => { const c = ds.y[i]; confusion[c][pred[n]]++; if (c === pred[n]) ok++; });
  const counts = new Array<number>(k).fill(0);
  for (const i of train) counts[ds.y[i]]++;
  const major = counts.indexOf(Math.max(...counts));
  const baseOk = test.filter((i) => ds.y[i] === major).length;
  let f1s = 0, present = 0;
  for (let c = 0; c < k; c++) {
    const tp = confusion[c][c];
    const fp = confusion.reduce((s, row, r) => s + (r === c ? 0 : row[c]), 0);
    const fn = confusion[c].reduce((s, v, p) => s + (p === c ? 0 : v), 0);
    if (tp + fn === 0) continue;
    present++;
    f1s += tp + fp + fn === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
  }
  return { task: "classification", accuracy: ok / test.length, baselineAccuracy: baseOk / test.length, macroF1: present ? f1s / present : 0, classes: t.classes!, confusion, n: test.length };
}

/** Score à maximiser pour l'importance : R² ou exactitude. */
const score = (m: Metrics) => (m.task === "regression" ? m.r2 : m.accuracy);

/**
 * Importance par permutation : baisse du score sur le jeu de test quand on mélange les lignes d'une variable
 * (toutes ses colonnes encodées ensemble). Retourne des parts normalisées (somme 1 si au moins une variable compte).
 */
export function permutationImportance(net: Net, ds: Dataset, train: number[], test: number[], seedRng: () => number, repeats = 3): { name: string; importance: number }[] {
  const sub = test.length > 2000 ? test.slice(0, 2000) : test;
  const base = score(evaluate(net, ds, train, sub));
  const X = ds.X.slice();
  let col = 0;
  const raw: { name: string; drop: number }[] = [];
  for (const f of ds.features) {
    const w = f.kind === "num" ? 1 : f.values.length;
    let drop = 0;
    const orig = sub.map((i) => Array.from({ length: w }, (_, c) => ds.X[i * ds.dim + col + c]));
    for (let r = 0; r < repeats; r++) {
      const perm = Array.from({ length: sub.length }, (_, i) => i);
      for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(seedRng() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
      sub.forEach((i, n) => { for (let c = 0; c < w; c++) X[i * ds.dim + col + c] = orig[perm[n]][c]; });
      drop += base - score(evaluate(net, { ...ds, X }, train, sub));
    }
    sub.forEach((i, n) => { for (let c = 0; c < w; c++) X[i * ds.dim + col + c] = orig[n][c]; });
    raw.push({ name: f.name, drop: Math.max(0, drop / repeats) });
    col += w;
  }
  const total = raw.reduce((s, r) => s + r.drop, 0);
  return raw.map((r) => ({ name: r.name, importance: total > 0 ? r.drop / total : 0 })).sort((a, b) => b.importance - a.importance);
}

export type { Task };
