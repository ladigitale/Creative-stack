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
  | { id: number; type: "clear"; model?: HfModelRef }
  | { id: number; type: "sam-load"; model: HfModelRef; devices: HfDevice[] }
  | { id: number; type: "sam-encode"; alias: string; image: HfSamImage }
  | { id: number; type: "sam-decode"; alias: string; points: HfSamPoint[]; box: HfSamBox | null }
  | { id: number; type: "sam-dispose"; alias: string };

/** Image RGBA envoyée au worker (au plus 1024 px de côté, le modèle travaille à cette taille). */
export type HfSamImage = { width: number; height: number; data: Uint8ClampedArray };
/** Invite : point en px de l'image encodée ; `label` 1 = sur l'objet, 0 = hors de l'objet. */
export type HfSamPoint = { x: number; y: number; label: 0 | 1 };
export type HfSamBox = { x0: number; y0: number; x1: number; y1: number };
export type HfSamEncodeResult = { width: number; height: number; encodeMs: number };
export type HfSamDecodeResult = {
  width: number;
  height: number;
  /** 0/1 par pixel, ligne par ligne. */
  mask: Uint8Array;
  /** Score IoU estimé du masque retenu, et de chaque proposition. */
  score: number;
  scores: number[];
  index: number;
  decodeMs: number;
};

export type HfWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: HfErrorCode; message: string } }
  | { type: "progress"; alias: string; progress: HfProgress }
  /** Le worker n'a pas pu démarrer (moteur introuvable, CSP…). */
  | { type: "fatal"; message: string };
