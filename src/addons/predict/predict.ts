import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import type { Row } from "./data";
import type { Metrics } from "./metrics";
import { loadModel, predictRow, type Model, type Prediction } from "./model";
import type { Net } from "./net";

export const MAX_BATCH = 5000;

export type PredictState = {
  status: "empty" | "ready" | "error";
  error: string | null;
  task: "regression" | "classification" | null;
  target: string;
  /** Variables attendues en entrée, avec leur type. */
  inputs: { name: string; kind: "num" | "cat"; values?: string[] }[];
  metrics: Metrics | null;
  /** Prédiction de l'entrée courante (objet) ; absente tant qu'aucune entrée n'est arrivée. */
  prediction: Prediction | null;
  /** Prédictions d'un tableau d'entrées (limité à 5 000 lignes). */
  predictions: Prediction[];
};

const EMPTY: PredictState = { status: "empty", error: null, task: null, target: "", inputs: [], metrics: null, prediction: null, predictions: [] };

/**
 * Utilise un modèle entraîné par `sonic-train` (`model-from` : DP du modèle JSON). Entrée `input-from` :
 * un objet `{ colonne: valeur }` (un formulaire, des curseurs) ou un tableau de lignes. Les prédictions
 * sont recalculées à chaque changement du modèle ou de l'entrée et écrites dans `out-data-provider`.
 */
@customElement("sonic-predict")
export class SonicPredict extends LitElement {
  @property({ type: String, attribute: "model-from" }) modelFrom = "";
  @property({ type: String, attribute: "input-from" }) inputFrom = "";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  private model: Model | null = null;
  private net: Net | null = null;
  private input: unknown = undefined;
  private loadError: string | null = null;
  private state: PredictState = { ...EMPTY };
  private unsubs: (() => void)[] = [];

  createRenderRoot(): HTMLElement | ShadowRoot { return this; }

  connectedCallback(): void { super.connectedCallback(); this.style.display = "none"; this.listen(); this.compute(); }

  disconnectedCallback(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("modelFrom") || c.has("inputFrom")) this.listen();
  }

  private listen(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.modelFrom) {
      this.unsubs.push(listenDp(this.modelFrom, (v) => {
        this.model = null;
        this.net = null;
        this.loadError = null;
        if (v && typeof v === "object") {
          try { ({ model: this.model, net: this.net } = loadModel(v)); } catch (e) { this.loadError = e instanceof Error ? e.message : "modèle invalide"; }
        }
        this.compute();
      }));
    }
    if (this.inputFrom) this.unsubs.push(listenDp(this.inputFrom, (v) => { this.input = v; this.compute(); }));
  }

  private compute(): void {
    const m = this.model, net = this.net;
    if (!m || !net) {
      this.state = { ...EMPTY, status: this.loadError ? "error" : "empty", error: this.loadError };
    } else {
      let prediction: Prediction | null = null;
      let predictions: Prediction[] = [];
      let error: string | null = null;
      const v = this.input;
      try {
        if (Array.isArray(v)) {
          if (v.length > MAX_BATCH) error = `plus de ${MAX_BATCH} lignes : seules les premières sont prédites`;
          predictions = v.slice(0, MAX_BATCH).filter((r) => r && typeof r === "object").map((r) => predictRow(m, net, r as Row));
        } else if (v && typeof v === "object") {
          prediction = predictRow(m, net, v as Row);
        }
      } catch (e) {
        error = e instanceof Error ? e.message : "prédiction impossible";
      }
      this.state = {
        status: "ready", error, task: m.task, target: m.target.name, metrics: m.metrics, prediction, predictions,
        inputs: m.features.map((f) => (f.kind === "num" ? { name: f.name, kind: "num" } : { name: f.name, kind: "cat", values: f.values })),
      };
    }
    if (this.outDataProvider) set(this.outDataProvider, this.state);
    this.dispatchEvent(new CustomEvent("predict-state", { detail: this.state, bubbles: true, composed: true }));
  }

  getState(): PredictState { return this.state; }
}
