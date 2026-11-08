import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger, num } from "../../shared/media/control";
import { detectTask, type Row } from "./data";
import type { Metrics } from "./metrics";
import type { Model } from "./model";
import { rowsOf } from "./rows";
import { LIMITS, Trainer, type Progress } from "./train";

/** Réglages effectifs d'entraînement (attributs, puis `control`, puis `params` : le dernier l'emporte). */
export type TrainSettings = {
  /** Cible demandée (vide : dernière colonne). La cible retenue est `state.target`. */
  target: string;
  /** Variables demandées (vide : toutes les autres colonnes). Celles retenues sont `state.features`. */
  features: string[];
  task: "auto" | "regression" | "classification";
  kind: "mlp" | "linear";
  hiddenUnits: number;
  epochs: number;
  learningRate: number;
  testSplit: number;
  seed: number;
};

const TASKS = ["auto", "regression", "classification"] as const;
const KINDS = ["mlp", "linear"] as const;
const DEFAULTS: TrainSettings = { target: "", features: [], task: "auto", kind: "mlp", hiddenUnits: 16, epochs: 150, learningRate: 0.02, testSplit: 0.2, seed: 1 };

export type TrainState = {
  status: "empty" | "ready" | "training" | "done" | "error";
  error: string | null;
  rows: number;
  columns: string[];
  target: string;
  task: "regression" | "classification" | null;
  epoch: number;
  epochs: number;
  progress: number;
  /** Une ligne par époque `{ epoch, train, test }` : de quoi tracer la courbe d'apprentissage avec `sonic-plot`. */
  curve: { epoch: number; train: number; test: number }[];
  metrics: Metrics | null;
  /** Importance des variables, du plus au moins utile. */
  importance: { name: string; importance: number }[];
  /** Matrice de confusion à plat `{ reel, predit, n }` (classification) : pour une `heatmap`. */
  confusion: { reel: string; predit: string; n: number }[];
  ignored: { name: string; reason: string }[];
  features: string[];
  droppedRows: number;
  model: Model | null;
  /** Réglages effectifs : ceux de l'entraînement en cours ou terminé, sinon ceux du prochain. */
  settings: TrainSettings;
};

const EMPTY: TrainState = {
  status: "empty", error: null, rows: 0, columns: [], target: "", task: null, epoch: 0, epochs: 0, progress: 0, curve: [], metrics: null,
  importance: [], confusion: [], ignored: [], features: [], droppedRows: 0, model: null, settings: { ...DEFAULTS },
};

/**
 * Entraîne un modèle de prédiction dans le navigateur à partir de lignes (tableau, ou texte CSV d'un
 * `sonic-file-open`). Régression ou classification détectée d'après la colonne cible (`target`, par
 * défaut la dernière). Modèle linéaire ou petit réseau (`hidden-units` neurones). Découpage entraînement / test,
 * courbe d'apprentissage, métriques comparées à une ligne de base, importance des variables.
 * `control` : `{ train: n, stop: n }` (compteurs). Réglages `target, features, task, kind, hiddenUnits,
 * epochs, learningRate, testSplit, seed` en attributs, ou par DataProvider dans `control` et `params`
 * (lus au lancement de l'entraînement). Le modèle (JSON) va dans `model-data-provider`
 * et sert à `sonic-predict`. Rien ne quitte le navigateur.
 */
@customElement("sonic-train")
export class SonicTrain extends LitElement {
  @property({ type: String, attribute: "data-provider" }) dataProvider = "";
  @property({ type: String }) target = "";
  @property({ type: String }) task: "auto" | "regression" | "classification" = "auto";
  /** Variables à utiliser, séparées par des virgules (défaut : toutes les autres colonnes). */
  @property({ type: String }) features = "";
  @property({ type: String }) kind: "mlp" | "linear" = "mlp";
  @property({ type: Number, attribute: "hidden-units" }) hiddenUnits = 16;
  @property({ type: Number }) epochs = 150;
  @property({ type: Number, attribute: "learning-rate" }) learningRate = 0.02;
  @property({ type: Number, attribute: "test-split" }) testSplit = 0.2;
  @property({ type: Number }) seed = 1;
  /** Entraîne dès que les données arrivent ou changent. */
  @property({ type: Boolean, attribute: "auto-train" }) autoTrain = false;
  @property({ type: String }) control = "";
  /** DP de réglages : `{ target, features, task, kind, hiddenUnits, epochs, learningRate, testSplit, seed }`. */
  @property({ type: String }) params = "";
  @property({ type: String, attribute: "model-data-provider" }) modelDataProvider = "";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  private rows: Row[] = [];
  private columns: string[] = [];
  private loadError: string | null = null;
  private trainer: Trainer | null = null;
  private timer = 0;
  private state: TrainState = { ...EMPTY };
  private triggers = new Map<string, CounterTrigger>();
  private unsubs: (() => void)[] = [];
  private fromControl: Partial<TrainSettings> = {};
  private fromParams: Partial<TrainSettings> = {};

  createRenderRoot(): HTMLElement | ShadowRoot { return this; }

  connectedCallback(): void { super.connectedCallback(); this.style.display = "none"; this.listen(); this.publish(); }

  disconnectedCallback(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    clearTimeout(this.timer);
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("dataProvider") || c.has("control") || c.has("params")) this.listen();
    else if (c.has("target") || c.has("task")) this.refresh();
    else if (["features", "kind", "hiddenUnits", "epochs", "learningRate", "testSplit", "seed"].some((k) => c.has(k))) this.settingsChanged();
  }

  private trigger(name: string): CounterTrigger {
    let t = this.triggers.get(name);
    if (!t) this.triggers.set(name, (t = new CounterTrigger()));
    return t;
  }

  private listen(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.triggers.clear();
    if (this.dataProvider) this.unsubs.push(listenDp(this.dataProvider, (v) => this.load(v)));
    if (this.control) {
      this.unsubs.push(listenDp(this.control, (v) => {
        if (!v || typeof v !== "object") return;
        const c = v as Record<string, unknown>;
        const next = readTrainSettings(c);
        const changed = !sameSettings(next, this.fromControl);
        this.fromControl = next;
        if (changed) this.settingsChanged();
        if ("train" in c && this.trigger("train").feed(c.train)) this.start();
        if ("stop" in c && this.trigger("stop").feed(c.stop)) this.stop();
      }));
    }
    if (this.params) {
      this.unsubs.push(listenDp(this.params, (v) => {
        const next = readTrainSettings(v);
        if (sameSettings(next, this.fromParams)) return;
        this.fromParams = next;
        this.settingsChanged();
      }));
    }
  }

  private load(v: unknown): void {
    // De nouvelles données (ou la même, republiée) abandonnent l'entraînement en cours.
    clearTimeout(this.timer);
    this.trainer = null;
    if (this.state.status === "training") this.state = { ...this.state, status: "ready" };
    try {
      const { rows, columns } = rowsOf(v);
      this.rows = rows;
      this.columns = columns;
      this.loadError = null;
    } catch (e) {
      this.rows = [];
      this.columns = [];
      this.loadError = e instanceof Error ? e.message : "données illisibles";
    }
    this.refresh();
    if (this.autoTrain && this.rows.length && !this.loadError) this.start();
  }

  /**
   * Pas de réentraînement : les réglages servent au prochain lancement. L'état « prêt » se met à jour
   * (cible, tâche) ; un entraînement en cours ou terminé garde son état et les réglages qu'il a utilisés.
   */
  private settingsChanged(): void {
    if (this.state.status === "training" || this.state.status === "done") return;
    this.refresh();
  }

  /** Réglages effectifs, bornés. */
  settings(): TrainSettings {
    const attrs: Partial<TrainSettings> = {
      target: this.target, task: this.task, kind: this.kind, hiddenUnits: this.hiddenUnits, epochs: this.epochs,
      learningRate: this.learningRate, testSplit: this.testSplit, seed: this.seed, features: splitList(this.features),
    };
    const s = { ...attrs, ...this.fromControl, ...this.fromParams };
    return {
      target: typeof s.target === "string" ? s.target.trim() : "",
      features: Array.isArray(s.features) ? s.features : [],
      task: (TASKS as readonly string[]).includes(s.task as string) ? s.task! : "auto",
      kind: s.kind === "linear" ? "linear" : "mlp",
      hiddenUnits: Math.round(clamp(s.hiddenUnits, LIMITS.hidden, DEFAULTS.hiddenUnits)),
      epochs: Math.round(clamp(s.epochs, LIMITS.epochs, DEFAULTS.epochs)),
      learningRate: clamp(s.learningRate, LIMITS.lr, DEFAULTS.learningRate),
      testSplit: clamp(s.testSplit, LIMITS.testSplit, DEFAULTS.testSplit),
      seed: Number.isFinite(Number(s.seed)) ? Math.floor(Number(s.seed)) : DEFAULTS.seed,
    };
  }

  private targetName(s = this.settings()): string {
    return s.target && this.columns.includes(s.target) ? s.target : this.columns[this.columns.length - 1] ?? "";
  }

  /** Remet l'état « prêt » (données chargées, pas d'entraînement en cours). */
  private refresh(): void {
    if (this.state.status === "training") return;
    const settings = this.settings();
    const target = this.targetName(settings);
    let task: TrainState["task"] = null;
    if (target && this.rows.length) task = settings.task === "auto" ? detectTask(this.rows, target) : settings.task;
    this.state = {
      ...EMPTY,
      status: this.loadError ? "error" : this.rows.length ? "ready" : "empty",
      error: this.loadError, rows: this.rows.length, columns: this.columns, target, task, settings,
    };
    this.publish();
  }

  /** Lance l'entraînement (une époque par tranche de ~12 ms pour rester fluide). */
  start(): void {
    if (this.state.status === "training") return;
    const settings = this.settings();
    if (!this.rows.length) { this.fail(this.loadError ?? "aucune donnée", settings); return; }
    try {
      this.trainer = new Trainer(this.rows, {
        target: this.targetName(settings), task: settings.task, features: settings.features.length ? settings.features : undefined,
        kind: settings.kind, hidden: settings.hiddenUnits, epochs: settings.epochs, learningRate: settings.learningRate,
        testSplit: settings.testSplit, seed: settings.seed,
      });
    } catch (e) {
      this.fail(e instanceof Error ? e.message : "entraînement impossible", settings);
      return;
    }
    const t = this.trainer;
    this.state = {
      ...EMPTY, status: "training", settings, rows: this.rows.length, columns: this.columns, target: t.ds.target.name, task: t.ds.target.task,
      epochs: t.epochs, ignored: t.ds.ignored, features: t.ds.features.map((f) => f.name), droppedRows: t.ds.droppedRows,
    };
    this.publish();
    this.tick(t);
  }

  private tick(t: Trainer): void {
    this.timer = window.setTimeout(() => {
      if (t !== this.trainer || this.state.status !== "training") return;
      const t0 = performance.now();
      try {
        while (!t.done && performance.now() - t0 < 12) t.step();
      } catch (e) {
        this.fail(e instanceof Error ? e.message : "entraînement interrompu");
        return;
      }
      this.state = { ...this.state, epoch: t.epoch, progress: t.epoch / t.epochs, curve: t.curve.map(toCurve) };
      if (t.done) this.finish(t);
      else { this.publish(); this.tick(t); }
    }, 0);
  }

  private finish(t: Trainer): void {
    try {
      const metrics = t.metrics();
      const model = t.model(metrics);
      const classes = t.ds.target.classes;
      this.state = {
        ...this.state, status: "done", progress: 1, metrics, importance: t.importance(), model,
        confusion: metrics.task === "classification" && classes ? metrics.confusion.flatMap((row, i) => row.map((n, j) => ({ reel: classes[i], predit: classes[j], n }))) : [],
      };
      if (this.modelDataProvider) set(this.modelDataProvider, model);
    } catch (e) {
      this.fail(e instanceof Error ? e.message : "évaluation impossible");
      return;
    }
    this.publish();
  }

  /** Interrompt l'entraînement ; le modèle à l'époque atteinte est évalué et publié. */
  stop(finish = true): void {
    clearTimeout(this.timer);
    const t = this.trainer;
    if (finish && t && this.state.status === "training") {
      t.stopped = true;
      if (t.epoch > 0) this.finish(t);
      else this.refresh();
    }
  }

  private fail(msg: string, settings?: TrainSettings): void {
    clearTimeout(this.timer);
    this.state = { ...this.state, status: "error", error: msg, ...(settings ? { settings } : {}) };
    this.publish();
  }

  getState(): TrainState { return this.state; }

  private publish(): void {
    if (this.outDataProvider) set(this.outDataProvider, this.state);
    this.dispatchEvent(new CustomEvent("train-state", { detail: this.state, bubbles: true, composed: true }));
  }
}

const toCurve = (p: Progress) => ({ epoch: p.epoch, train: p.trainLoss, test: p.testLoss });

/** Réglages présents dans une valeur de DataProvider (clés camelCase ou en tirets). */
export function readTrainSettings(v: unknown): Partial<TrainSettings> {
  const p = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const o: Partial<TrainSettings> = {};
  if (typeof p.target === "string") o.target = p.target.trim();
  const f = p.features;
  if (typeof f === "string") o.features = splitList(f);
  else if (Array.isArray(f)) o.features = f.filter((x) => typeof x === "string" || typeof x === "number").map((x) => String(x).trim()).filter(Boolean);
  if ((TASKS as readonly unknown[]).includes(p.task)) o.task = p.task as TrainSettings["task"];
  if ((KINDS as readonly unknown[]).includes(p.kind)) o.kind = p.kind as TrainSettings["kind"];
  const n = (key: "hiddenUnits" | "epochs" | "learningRate" | "testSplit" | "seed", alt: string, lim: readonly [number, number], int: boolean) => {
    const x = num(p[key] ?? p[alt], lim[0], lim[1]);
    if (x !== undefined) o[key] = int ? Math.round(x) : x;
  };
  n("hiddenUnits", "hidden-units", LIMITS.hidden, true);
  n("epochs", "epochs", LIMITS.epochs, true);
  n("learningRate", "learning-rate", LIMITS.lr, false);
  n("testSplit", "test-split", LIMITS.testSplit, false);
  n("seed", "seed", [-2147483648, 2147483647], true);
  return o;
}

function sameSettings(a: Partial<TrainSettings>, b: Partial<TrainSettings>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const splitList = (s: string): string[] => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

const clamp = (v: unknown, [lo, hi]: readonly [number, number], d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
