import { encodeRow, type Dataset, type Feature, type Row, type TargetInfo } from "./data";
import { Net, softmaxAt } from "./net";
import type { Metrics } from "./metrics";

export const MODEL_FORMAT = "sonic-model/1";
export const MAX_MODEL_NUMBERS = 2_000_000;

/** Modèle sérialisable (JSON) : tout ce qu'il faut pour prédire une ligne, sans les données d'entraînement. */
export type Model = {
  format: typeof MODEL_FORMAT;
  task: "regression" | "classification";
  features: Feature[];
  target: TargetInfo;
  dims: number[];
  /** Poids de chaque couche (entrée × sortie, rangés par entrée), puis biais. */
  weights: number[][];
  biases: number[][];
  metrics: Metrics | null;
};

const round = (n: number) => Number(n.toPrecision(7));

export function toModel(net: Net, ds: Dataset, metrics: Metrics | null): Model {
  return {
    format: MODEL_FORMAT, task: ds.target.task, features: ds.features, target: ds.target, dims: net.dims.slice(),
    weights: net.W.map((w) => Array.from(w, round)), biases: net.b.map((b) => Array.from(b, round)), metrics,
  };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Valide un modèle venu de l'extérieur (DataProvider, fichier) ; retourne le réseau, ou lève une erreur. */
export function loadModel(raw: unknown): { model: Model; net: Net } {
  const m = raw as Model | null;
  if (!m || typeof m !== "object" || m.format !== MODEL_FORMAT) throw new Error("format de modèle inconnu");
  if (m.task !== "regression" && m.task !== "classification") throw new Error("tâche inconnue");
  if (!Array.isArray(m.features) || !m.features.length || m.features.length > 200) throw new Error("variables invalides");
  let width = 0;
  for (const f of m.features) {
    if (!f || typeof f.name !== "string") throw new Error("variable invalide");
    if (f.kind === "num") {
      if (!isNum(f.mean) || !isNum(f.std) || f.std <= 0) throw new Error(`variable numérique invalide : ${f.name}`);
      width++;
    } else if (f.kind === "cat") {
      if (!Array.isArray(f.values) || !f.values.length || f.values.length > 100 || f.values.some((v) => typeof v !== "string")) throw new Error(`variable catégorielle invalide : ${f.name}`);
      width += f.values.length;
    } else throw new Error(`type de variable inconnu : ${(f as { name: string }).name}`);
  }
  const t = m.target;
  if (!t || typeof t.name !== "string") throw new Error("cible invalide");
  const k = m.task === "classification" ? t.classes?.length ?? 0 : 1;
  if (m.task === "classification" && (k < 2 || k > 50 || t.classes!.some((c) => typeof c !== "string"))) throw new Error("classes invalides");
  if (m.task === "regression" && (!isNum(t.mean) || !isNum(t.std))) throw new Error("cible numérique invalide");
  const d = m.dims;
  if (!Array.isArray(d) || d.length < 2 || d.length > 4 || d.some((x) => !Number.isInteger(x) || x < 1 || x > 4096)) throw new Error("architecture invalide");
  if (d[0] !== width || d[d.length - 1] !== k) throw new Error("architecture incohérente avec les variables");
  if (!Array.isArray(m.weights) || !Array.isArray(m.biases) || m.weights.length !== d.length - 1 || m.biases.length !== d.length - 1) throw new Error("poids invalides");
  let total = 0;
  const net = new Net(d, 1);
  for (let l = 0; l < d.length - 1; l++) {
    const w = m.weights[l], b = m.biases[l];
    if (!Array.isArray(w) || !Array.isArray(b) || w.length !== d[l] * d[l + 1] || b.length !== d[l + 1]) throw new Error("taille de poids invalide");
    total += w.length + b.length;
    if (total > MAX_MODEL_NUMBERS) throw new Error("modèle trop gros");
    if (!w.every(isNum) || !b.every(isNum)) throw new Error("poids non numériques");
    net.W[l] = Float64Array.from(w);
    net.b[l] = Float64Array.from(b);
  }
  return { model: m, net };
}

export type Prediction =
  | { task: "regression"; value: number; missing: number }
  | { task: "classification"; label: string; confidence: number; probabilities: Record<string, number>; missing: number };

/** Prédit une ligne `{ colonne: valeur }`. Valeurs manquantes ou inconnues : `missing` les compte. */
export function predictRow(model: Model, net: Net, row: Row): Prediction {
  const x = new Float64Array(net.dims[0]);
  const missing = encodeRow(model.features, row, x, 0);
  const out = net.predictRaw(x, [0]);
  if (model.task === "regression") return { task: "regression", value: out[0] * model.target.std! + model.target.mean!, missing };
  const classes = model.target.classes!;
  const p = softmaxAt(out, 0, classes.length);
  const best = p.indexOf(Math.max(...p));
  return { task: "classification", label: classes[best], confidence: p[best], probabilities: Object.fromEntries(classes.map((c, i) => [c, round(p[i])])), missing };
}
