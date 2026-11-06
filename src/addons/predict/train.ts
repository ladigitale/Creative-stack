import { rng } from "../paint/brush";
import { prepare, split, type Dataset, type PrepareOptions, type Row } from "./data";
import { evaluate, permutationImportance, type Metrics } from "./metrics";
import { toModel, type Model } from "./model";
import { Adam, Net } from "./net";

export type TrainOptions = PrepareOptions & {
  /** `linear` (sans couche cachée) ou `mlp`. */
  kind?: "linear" | "mlp";
  hidden?: number;
  epochs?: number;
  learningRate?: number;
  weightDecay?: number;
  testSplit?: number;
  seed?: number;
};

export const LIMITS = { epochs: [1, 2000], hidden: [1, 128], lr: [1e-4, 1], testSplit: [0.05, 0.5] } as const;
const clamp = (v: number, [lo, hi]: readonly [number, number] | readonly number[], d: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);

export type Progress = { epoch: number; epochs: number; trainLoss: number; testLoss: number };

/**
 * Entraînement pas à pas : `step()` avance d'une époque, de sorte que l'interface reste réactive.
 * Garde la courbe d'apprentissage ; `finish()` donne métriques, importance des variables et modèle.
 */
export class Trainer {
  readonly ds: Dataset;
  readonly net: Net;
  readonly train: number[];
  readonly test: number[];
  readonly epochs: number;
  readonly curve: Progress[] = [];
  readonly kind: "linear" | "mlp";
  private opt: Adam;
  private seed: number;
  epoch = 0;
  stopped = false;

  constructor(rows: Row[], o: TrainOptions) {
    this.ds = prepare(rows, o);
    this.seed = Number.isFinite(o.seed) ? Math.floor(o.seed!) : 1;
    const { train, test } = split(this.ds.n, clamp(o.testSplit ?? 0.2, LIMITS.testSplit, 0.2), this.seed);
    this.train = train;
    this.test = test;
    this.kind = o.kind === "linear" ? "linear" : "mlp";
    this.epochs = Math.round(clamp(o.epochs ?? 150, LIMITS.epochs, 150));
    const out = this.ds.target.task === "regression" ? 1 : this.ds.target.classes!.length;
    const hidden = Math.round(clamp(o.hidden ?? 16, LIMITS.hidden, 16));
    this.net = new Net(this.kind === "linear" ? [this.ds.dim, out] : [this.ds.dim, hidden, out], this.seed);
    this.opt = new Adam(this.net, {
      task: this.ds.target.task, lr: clamp(o.learningRate ?? 0.02, LIMITS.lr, 0.02), weightDecay: clamp(o.weightDecay ?? 1e-4, [0, 1], 1e-4),
      batch: train.length <= 2000 ? train.length : 256, seed: this.seed,
    });
  }

  get done(): boolean { return this.stopped || this.epoch >= this.epochs; }

  step(): Progress {
    const trainLoss = this.opt.epoch(this.ds.X, this.ds.y, this.train);
    this.epoch++;
    const p = { epoch: this.epoch, epochs: this.epochs, trainLoss, testLoss: this.net.loss(this.ds.X, this.ds.y, this.test, this.ds.target.task) };
    this.curve.push(p);
    return p;
  }

  metrics(): Metrics {
    return evaluate(this.net, this.ds, this.train, this.test);
  }

  importance(): { name: string; importance: number }[] {
    return permutationImportance(this.net, this.ds, this.train, this.test, rng(this.seed + 99));
  }

  model(metrics: Metrics | null = this.metrics()): Model {
    return toModel(this.net, this.ds, metrics);
  }
}
