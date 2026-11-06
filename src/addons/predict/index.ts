/** Addon predict : entraîner un modèle de prédiction dans le navigateur, puis l'utiliser. */
export { SonicTrain, type TrainState } from "./train-element";
export { SonicPredict, type PredictState } from "./predict";
export { Trainer, type TrainOptions } from "./train";
export { loadModel, predictRow, toModel, MODEL_FORMAT, type Model, type Prediction } from "./model";
export { parseCsv } from "./csv";
export { prepare, detectTask, split, type Dataset, type Feature } from "./data";
export { evaluate, permutationImportance, type Metrics } from "./metrics";
