/**
 * Protocole entre le thread principal et le worker qui exécute Transformers.js.
 * Uniquement des données sérialisables (structured clone).
 */
import type { HfDevice, HfLoadOptions, HfTask } from "./types";

export type HfWorkerEnv = {
  /** Hôte des modèles (CDN Supersoniks, ou le Hub par défaut). */
  remoteHost?: string;
  remotePathTemplate?: string;
  /** Clé du cache navigateur (Cache API) des modèles et du WASM. */
  cacheKey: string;
  /** Emplacement des binaires ONNX Runtime (`.wasm` / `.mjs`) de la version figée. */
  wasmPaths?: string | { mjs: string; wasm: string };
  logLevel?: "error" | "warning" | "info" | "debug";
};

export type HfModelRef = {
  alias: string;
  task: HfTask;
  repo: string;
  revision: string;
  options: HfLoadOptions;
};

export type HfInspectResult = {
  /** Taille totale à télécharger (octets) si le serveur la donne. */
  totalBytes: number | null;
  cached: boolean;
};

export type HfLoadResult = {
  backend: HfDevice;
  loadMs: number;
};

export type HfProgress = {
  file?: string;
  loadedBytes: number;
  totalBytes: number;
  percent: number;
};

export type HfRunRequest = {
  alias: string;
  /** Entrées valides uniquement (le thread principal réaligne ensuite). */
  inputs: unknown[];
  call: Record<string, unknown>;
  /** Nom de l'argument positionnel à extraire de `call` (`candidate_labels`, `context`). */
  positional?: string;
  /** Regrouper les entrées en un seul appel (embeddings de textes). */
  batch: boolean;
};

export type HfErrorCode =
  | "unsupported"
  | "network"
  | "quota"
  | "timeout"
  | "not-allowed"
  | "runtime"
  | "declined";

export type HfWorkerRequest =
  | { id: number; type: "configure"; env: HfWorkerEnv }
  | { id: number; type: "inspect"; model: HfModelRef }
  | { id: number; type: "load"; model: HfModelRef; devices: HfDevice[] }
  | { id: number; type: "run"; request: HfRunRequest }
  | { id: number; type: "clear"; model?: HfModelRef };

export type HfWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: HfErrorCode; message: string } }
  | { type: "progress"; alias: string; progress: HfProgress }
  /** Le worker n'a pas pu démarrer (moteur introuvable, CSP…). */
  | { type: "fatal"; message: string };
