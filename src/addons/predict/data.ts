import { rng } from "../paint/brush";

export const MAX_CARDINALITY = 30;
export const MAX_CLASSES = 20;
export const MAX_FEATURES_ENCODED = 400;

export type NumFeature = { name: string; kind: "num"; mean: number; std: number };
export type CatFeature = { name: string; kind: "cat"; values: string[] };
export type Feature = NumFeature | CatFeature;

export type Task = "regression" | "classification";

export type TargetInfo = { name: string; task: Task; mean?: number; std?: number; classes?: string[] };

export type Dataset = {
  features: Feature[];
  target: TargetInfo;
  /** Colonnes ignorées et pourquoi. */
  ignored: { name: string; reason: string }[];
  /** Matrice encodée (ligne par ligne), cible (valeur standardisée, ou indice de classe). */
  X: Float64Array;
  y: Float64Array;
  n: number;
  dim: number;
  droppedRows: number;
};

export type Row = Record<string, unknown>;

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

export function toNumber(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v !== "string") return NaN;
  const s = v.trim().replace(/\s/g, "").replace(/%$/, "");
  if (!s || !/^[-+]?(\d+([.,]\d*)?|[.,]\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
  return Number(s.replace(",", "."));
}

export const catKey = (v: unknown): string => String(typeof v === "string" ? v.trim() : v);

/** Colonnes numériques si au moins 90 % des valeurs non vides se lisent comme des nombres. */
function numericShare(rows: Row[], col: string): { share: number; filled: number } {
  let ok = 0, filled = 0;
  for (const r of rows) {
    const v = r[col];
    if (isEmpty(v)) continue;
    filled++;
    if (Number.isFinite(toNumber(v))) ok++;
  }
  return { share: filled ? ok / filled : 0, filled };
}

export type PrepareOptions = { target: string; task?: Task | "auto"; features?: string[] };

/** Choisit le type de tâche d'après la colonne cible. */
export function detectTask(rows: Row[], target: string): Task {
  const { share } = numericShare(rows, target);
  if (share < 0.95) return "classification";
  const uniq = new Set<number>();
  let integers = true;
  for (const r of rows) {
    const x = toNumber(r[target]);
    if (!Number.isFinite(x)) continue;
    uniq.add(x);
    if (!Number.isInteger(x)) integers = false;
  }
  // Quelques valeurs entières (0/1, 1..5) : des classes ; sinon une quantité.
  return uniq.size <= 10 && integers ? "classification" : "regression";
}

/** Types, encodage et standardisation. Lève une erreur compréhensible si les données sont inutilisables. */
export function prepare(rows: Row[], opts: PrepareOptions): Dataset {
  if (!rows.length) throw new Error("aucune ligne");
  const all = new Set<string>();
  for (const r of rows.slice(0, 200)) for (const k of Object.keys(r)) all.add(k);
  if (!all.has(opts.target)) throw new Error(`colonne cible introuvable : ${opts.target}`);
  const task: Task = opts.task && opts.task !== "auto" ? opts.task : detectTask(rows, opts.target);

  const kept = rows.filter((r) => !isEmpty(r[opts.target]) && (task === "classification" || Number.isFinite(toNumber(r[opts.target]))));
  const droppedRows = rows.length - kept.length;
  if (kept.length < 10) throw new Error("au moins 10 lignes avec une cible valide sont nécessaires");

  const target: TargetInfo = { name: opts.target, task };
  const y = new Float64Array(kept.length);
  if (task === "regression") {
    const vals = kept.map((r) => toNumber(r[opts.target]));
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
    target.mean = mean;
    target.std = std;
    vals.forEach((v, i) => (y[i] = (v - mean) / std));
  } else {
    const counts = new Map<string, number>();
    for (const r of kept) counts.set(catKey(r[opts.target]), (counts.get(catKey(r[opts.target])) ?? 0) + 1);
    const classes = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
    if (classes.length < 2) throw new Error("la cible n'a qu'une seule valeur");
    if (classes.length > MAX_CLASSES) throw new Error(`trop de classes (${classes.length} > ${MAX_CLASSES}) : choisir une cible numérique ou regrouper`);
    target.classes = classes;
    const idx = new Map(classes.map((c, i) => [c, i]));
    kept.forEach((r, i) => (y[i] = idx.get(catKey(r[opts.target]))!));
  }

  const ignored: Dataset["ignored"] = [];
  const features: Feature[] = [];
  const wanted = opts.features?.length ? opts.features : [...all].filter((c) => c !== opts.target);
  for (const col of wanted) {
    if (col === opts.target) continue;
    if (!all.has(col)) { ignored.push({ name: col, reason: "introuvable" }); continue; }
    const { share, filled } = numericShare(kept, col);
    if (filled < kept.length * 0.2) { ignored.push({ name: col, reason: "presque vide" }); continue; }
    if (share >= 0.9) {
      const vals = kept.map((r) => toNumber(r[col])).filter(Number.isFinite);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
      if (!(std > 1e-12)) { ignored.push({ name: col, reason: "constante" }); continue; }
      features.push({ name: col, kind: "num", mean, std });
    } else {
      const counts = new Map<string, number>();
      for (const r of kept) if (!isEmpty(r[col])) counts.set(catKey(r[col]), (counts.get(catKey(r[col])) ?? 0) + 1);
      if (counts.size < 2) { ignored.push({ name: col, reason: "constante" }); continue; }
      if (counts.size > MAX_CARDINALITY) { ignored.push({ name: col, reason: `trop de valeurs distinctes (${counts.size}) : identifiant ou texte libre` }); continue; }
      features.push({ name: col, kind: "cat", values: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k) });
    }
  }
  let dim = features.reduce((s, f) => s + (f.kind === "num" ? 1 : f.values.length), 0);
  if (!features.length) throw new Error("aucune colonne exploitable pour prédire");
  if (dim > MAX_FEATURES_ENCODED) throw new Error(`trop de variables après encodage (${dim} > ${MAX_FEATURES_ENCODED})`);

  const X = new Float64Array(kept.length * dim);
  kept.forEach((r, i) => encodeRow(features, r, X, i * dim));
  return { features, target, ignored, X, y, n: kept.length, dim, droppedRows };
}

export function featureWidth(f: Feature): number {
  return f.kind === "num" ? 1 : f.values.length;
}

/** Encode une ligne dans `out` à partir de `offset` : numériques standardisés (manquant = moyenne), catégories en one-hot (inconnue = zéros). */
export function encodeRow(features: Feature[], r: Row, out: Float64Array, offset: number): number {
  let o = offset, missing = 0;
  for (const f of features) {
    if (f.kind === "num") {
      const x = toNumber(r[f.name]);
      if (Number.isFinite(x)) out[o] = (x - f.mean) / f.std;
      else { out[o] = 0; missing++; }
      o++;
    } else {
      const k = isEmpty(r[f.name]) ? null : catKey(r[f.name]);
      const j = k === null ? -1 : f.values.indexOf(k);
      for (let v = 0; v < f.values.length; v++) out[o + v] = v === j ? 1 : 0;
      if (j < 0) missing++;
      o += f.values.length;
    }
  }
  return missing;
}

/** Découpage entraînement / test reproductible. */
export function split(n: number, testShare: number, seed: number): { train: number[]; test: number[] } {
  const idx = Array.from({ length: n }, (_, i) => i);
  const r = rng(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const nt = Math.max(1, Math.min(n - 2, Math.round(n * Math.max(0.05, Math.min(0.5, testShare)))));
  return { test: idx.slice(0, nt), train: idx.slice(nt) };
}
