/**
 * Configuration applicative : moteur figé, liste blanche de modèles (alias),
 * valeurs par défaut. Rien de tout cela n'est réglable depuis un descripteur
 * SDUI : seules les options d'appel le sont (voir `schema.ts`).
 */
import type {
  HfCallOptions,
  HfDevice,
  HfExact,
  HfLoadOptions,
  HfTask,
} from "./types";
import type { HfEngine } from "./hf-engine";

/* ------------------------------------------------------------------ */
/* Modèles                                                             */
/* ------------------------------------------------------------------ */

export type HfModelDefinition<T extends HfTask = HfTask> = {
  task: T;
  /** Dépôt Hugging Face (ou chemin sous `remoteHost`), ex. `Xenova/opus-mt-fr-en`. */
  repo: string;
  /** Révision figée : sha de commit de préférence, jamais une branche mouvante en production. */
  revision: string;
  /** Options de chargement passées à `pipeline()` (dtype, session_options, config…). */
  options?: HfLoadOptions;
  /** Exécutions autorisées, par ordre de préférence. Défaut : `["webgpu", "wasm"]`. */
  devices?: readonly HfDevice[];
  /** Taille déclarée (octets), utilisée si le serveur ne la donne pas. */
  sizeBytes?: number;
  license?: string;
  /** Libellé et description montrés dans l'UI de consentement. */
  label?: string;
  description?: string;
  /** Options d'appel par défaut, typées selon `task`. */
  defaults?: HfCallOptions<T>;
};

/** Union discriminée par `task` : `defaults` est vérifié selon la tâche du modèle. */
export type HfAnyModelDefinition = {
  [T in HfTask]: HfModelDefinition<T>;
}[HfTask];

export type HfModels = { readonly [alias: string]: HfAnyModelDefinition };

/** Déclare la liste blanche en gardant les littéraux (alias, tâches) pour le typage. */
type ModelCheck<D> = D extends { task: infer T extends HfTask }
  ? HfModelDefinition<T> & {
      [P in Exclude<keyof D, keyof HfModelDefinition<T>>]: never;
    } & (D extends { defaults: infer X }
        ? { defaults: HfExact<X, HfCallOptions<T>> }
        : unknown)
  : HfAnyModelDefinition;

export function defineHuggingFaceModels<const M extends HfModels>(
  models: M & { readonly [K in keyof M]: ModelCheck<M[K]> },
): M {
  return models;
}

/* ------------------------------------------------------------------ */
/* Politiques                                                          */
/* ------------------------------------------------------------------ */

/** Quand télécharger / charger le modèle. */
export const HF_LOAD_POLICIES = [
  "auto",
  "idle",
  "visible",
  "first-use",
  "consent",
  "manual",
] as const;
export type HfLoadPolicy = (typeof HF_LOAD_POLICIES)[number];

/** Quand calculer. */
export const HF_TRIGGERS = ["mutation", "demand"] as const;
export type HfTrigger = (typeof HF_TRIGGERS)[number];

export type HfDefaults = {
  load: HfLoadPolicy;
  trigger: HfTrigger;
  /** Anti-rebond (ms) du mode `mutation`. */
  debounceMs: number;
  /** Au-delà, les politiques automatiques basculent en `consent`. */
  consentAboveMB: number;
  /** Plafond de taille pour autoriser l'exécution CPU (WASM) quand WebGPU manque. */
  allowWasmUpToMB: number;
  /** Délai de garde d'un calcul. */
  timeoutMs: number;
  /** Nombre max d'éléments dans une entrée liste. */
  maxItems: number;
  /** Longueur max d'un texte (tronqué au-delà). */
  maxChars: number;
  /** Demander `navigator.storage.persist()` après le premier téléchargement. */
  persist: boolean;
  /** Plafond (octets) du cache IndexedDB des résultats. */
  resultsCacheBytes: number;
};

export const HF_DEFAULTS: HfDefaults = {
  load: "first-use",
  trigger: "mutation",
  debounceMs: 50,
  consentAboveMB: 30,
  allowWasmUpToMB: 50,
  timeoutMs: 60_000,
  maxItems: 2_000,
  maxChars: 2_000,
  persist: false,
  resultsCacheBytes: 20 * 1024 * 1024,
};

/* ------------------------------------------------------------------ */
/* Moteur (Transformers.js)                                            */
/* ------------------------------------------------------------------ */

export type HfRuntime =
  /**
   * Worker « blob » qui importe Transformers.js depuis une URL à version
   * exacte (CDN Supersoniks conseillé). Rien n'est ajouté au bundle.
   * CSP : `worker-src blob:`, `script-src <cdn>`, `wasm-unsafe-eval`.
   */
  | {
      source: "cdn";
      /** URL du module, ex. `https://cdn…/vendor/hf-transformers/4.3.0/transformers.min.js`. */
      url: string;
      /** Version exacte (sert de clé de cache). */
      version: string;
      /** Binaires ONNX Runtime ; défaut : même dossier que `url`. */
      wasmPaths?: string | { mjs: string; wasm: string };
    }
  /**
   * Worker construit par l'application avec son bundler (dépendance npm
   * `@huggingface/transformers` installée, version exacte), qui appelle
   * `serveHuggingFaceWorker(transformers)`.
   */
  | {
      source: "worker";
      createWorker: () => Worker;
      version: string;
      wasmPaths?: string | { mjs: string; wasm: string };
    }
  /** Moteur fourni tel quel (tests, transport maison). */
  | { source: "engine"; engine: HfEngine; version: string };

export type HuggingFaceConfig<M extends HfModels = HfModels> = {
  runtime: HfRuntime;
  models: M;
  /** Hôte des modèles. Défaut : le Hub Hugging Face. Conseillé : CDN Supersoniks. */
  remoteHost?: string;
  /** Gabarit de chemin sous `remoteHost`. Défaut Transformers.js : `{model}/resolve/{revision}/`. */
  remotePathTemplate?: string;
  defaults?: Partial<HfDefaults>;
  logLevel?: "error" | "warning" | "info" | "debug";
};

type ResolvedConfig = Omit<HuggingFaceConfig, "defaults"> & {
  defaults: HfDefaults;
};

let current: ResolvedConfig | null = null;
const listeners = new Set<(config: ResolvedConfig) => void>();

/** Enregistre la configuration (une fois, au démarrage de l'application). */
export function setHuggingFaceConfig(config: HuggingFaceConfig): void {
  current = { ...config, defaults: { ...HF_DEFAULTS, ...config.defaults } };
  for (const listener of listeners) listener(current);
}

export function getHuggingFaceConfig(): ResolvedConfig | null {
  return current;
}

/** Appelé quand la configuration change (les composants déjà connectés redémarrent). */
export function onHuggingFaceConfig(
  listener: (config: ResolvedConfig) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests uniquement. */
export function resetHuggingFaceConfig(): void {
  current = null;
}

export type { ResolvedConfig as HfResolvedConfig };
