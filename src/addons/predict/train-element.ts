import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import { detectTask, type Row } from "./data";
import type { Metrics } from "./metrics";
import type { Model } from "./model";
import { rowsOf } from "./rows";
import { Trainer, type Progress } from "./train";

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
};

const EMPTY: TrainState = {
  status: "empty", error: null, rows: 0, columns: [], target: "", task: null, epoch: 0, epochs: 0, progress: 0, curve: [], metrics: null,
  importance: [], confusion: [], ignored: [], features: [], droppedRows: 0, model: null,
};

/**
 * Entraîne un modèle de prédiction dans le navigateur à partir de lignes (tableau, ou texte CSV d'un
 * `sonic-file-open`). Régression ou classification détectée d'après la colonne cible (`target`, par
 * défaut la dernière). Modèle linéaire ou petit réseau (`hidden-units` neurones). Découpage entraînement / test,
 * courbe d'apprentissage, métriques comparées à une ligne de base, importance des variables.
 * `control` : `{ train: n, stop: n }` (compteurs). Le modèle (JSON) va dans `model-data-provider`
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

  createRenderRoot(): HTMLElement | ShadowRoot { return this; }

  connectedCallback(): void { super.connectedCallback(); this.style.display = "none"; this.listen(); this.publish(); }

  disconnectedCallback(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    clearTimeout(this.timer);
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("dataProvider") || c.has("control")) this.listen();
    else if (c.has("target") || c.has("task")) this.refresh();
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
        if ("train" in c && this.trigger("train").feed(c.train)) this.start();
        if ("stop" in c && this.trigger("stop").feed(c.stop)) this.stop();
      }));
    }
  }

  private load(v: unknown): void {
    this.stop(false);
    this.trainer = null;
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

  private targetName(): string {
    return this.target && this.columns.includes(this.target) ? this.target : this.columns[this.columns.length - 1] ?? "";
  }

  /** Remet l'état « prêt » (données chargées, pas d'entraînement en cours). */
  private refresh(): void {
    if (this.state.status === "training") return;
    const target = this.targetName();
    let task: TrainState["task"] = null;
    if (target && this.rows.length) task = this.task === "auto" ? detectTask(this.rows, target) : this.task;
    this.state = {
      ...EMPTY,
      status: this.loadError ? "error" : this.rows.length ? "ready" : "empty",
      error: this.loadError, rows: this.rows.length, columns: this.columns, target, task,
    };
    this.publish();
  }

  /** Lance l'entraînement (une époque par tranche de ~12 ms pour rester fluide). */
  start(): void {
    if (this.state.status === "training") return;
    if (!this.rows.length) { this.fail(this.loadError ?? "aucune donnée"); return; }
    try {
      this.trainer = new Trainer(this.rows, {
        target: this.targetName(), task: this.task, features: this.features ? this.features.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        kind: this.kind, hidden: this.hiddenUnits, epochs: this.epochs, learningRate: this.learningRate, testSplit: this.testSplit, seed: this.seed,
      });
    } catch (e) {
      this.fail(e instanceof Error ? e.message : "entraînement impossible");
      return;
    }
    const t = this.trainer;
    this.state = {
      ...EMPTY, status: "training", rows: this.rows.length, columns: this.columns, target: t.ds.target.name, task: t.ds.target.task,
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

  private fail(msg: string): void {
    clearTimeout(this.timer);
    this.state = { ...this.state, status: "error", error: msg };
    this.publish();
  }

  getState(): TrainState { return this.state; }

  private publish(): void {
    if (this.outDataProvider) set(this.outDataProvider, this.state);
    this.dispatchEvent(new CustomEvent("train-state", { detail: this.state, bubbles: true, composed: true }));
  }
}

const toCurve = (p: Progress) => ({ epoch: p.epoch, train: p.trainLoss, test: p.testLoss });
