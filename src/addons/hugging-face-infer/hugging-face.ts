/**
 * API publique de l'inférence Hugging Face dans Concorde.
 *
 * ```ts
 * import { configureHuggingFace, defineHuggingFaceModels } from "@supersoniks/creative-stack/hugging-face-infer";
 *
 * export const hf = configureHuggingFace({
 *   runtime: { source: "cdn", version: "4.3.0", url: "https://cdn…/hf-transformers/4.3.0/transformers.min.js" },
 *   models: defineHuggingFaceModels({
 *     "multilingual-mini": {
 *       task: "feature-extraction",
 *       repo: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
 *       revision: "<sha>",
 *       options: { dtype: "q8" },
 *       defaults: { pooling: "mean", normalize: true },
 *     },
 *   }),
 * });
 *
 * hf.infer({ model: "multilingual-mini", input: events, text: (e) => e.label, output: eventVectors });
 * ```
 *
 * Ce module ne contient pas Transformers.js (uniquement des `import type`).
 */
import type { DataProviderKey } from "@supersoniks/concorde/core/utils/dataProviderKey";
import {
  setHuggingFaceConfig,
  type HfLoadPolicy,
  type HfModels,
  type HfTrigger,
  type HuggingFaceConfig,
} from "./hf-config";
import {
  createHfInferController,
  type HfInferHandle,
  type HfInferStatus,
} from "./hf-controller";
import { normalizeInput, realign, type HfTextExtractor } from "./hf-input";
import {
  getHuggingFaceRegistry,
  HfError,
  type HfModelState,
  type HuggingFaceRegistry,
} from "./hf-registry";
import { clearResults } from "./hf-cache";
import type { HF_CALL_OPTION_SCHEMAS } from "./hf-schema";
import {
  HF_POSITIONAL_ARGS,
  HF_TASK_INPUT_KIND,
  type HfCallOptions,
  type HfExact,
  type HfOutput,
  type HfSingleInput,
  type HfTask,
} from "./types";

/* ------------------------------------------------------------------ */
/* Types liés à la liste blanche                                       */
/* ------------------------------------------------------------------ */

export type HfAlias<M extends HfModels> = Extract<keyof M, string>;
export type HfTaskOf<M extends HfModels, A extends HfAlias<M>> = M[A]["task"];
type DefaultsOf<M extends HfModels, A extends HfAlias<M>> = M[A] extends {
  defaults: infer D;
}
  ? D
  : unknown;

/** Options effectives = défauts du modèle, surchargés par ceux de l'appel. */
export type HfMergedOptions<D, C> = Omit<D, keyof C> & C;

/** Entrée acceptée pour une tâche : un élément, une liste, ou (texte) des objets + `text`. */
export type HfAcceptedInput<T extends HfTask> =
  | HfSingleInput<T>
  | readonly HfSingleInput<T>[]
  | (T extends HfTask
      ? (typeof HF_TASK_INPUT_KIND)[T] extends "text"
        ? object | readonly object[]
        : never
      : never)
  | null
  | undefined;

/**
 * Clés d'options d'une tâche, lues sur la table de schémas (identique aux
 * clés de `HfCallOptions<T>`, garanti à la compilation par `hf-schema.ts`) :
 * beaucoup moins coûteux à évaluer pour le compilateur.
 */
type HfCallKeys<T extends HfTask> = Record<
  keyof (typeof HF_CALL_OPTION_SCHEMAS)[T],
  unknown
>;

type ItemOf<In> = In extends readonly (infer E)[] ? E : In;
type IsMany<In> = [NonNullable<In>] extends [readonly unknown[]] ? true : false;

/** Sortie publiée pour un alias, des options d'appel et un type d'entrée. */
export type HfResult<
  M extends HfModels,
  A extends HfAlias<M>,
  C,
  In,
> = HfOutput<HfTaskOf<M, A>, HfMergedOptions<DefaultsOf<M, A>, C>, IsMany<In>>;

export type HfInferOptions<
  M extends HfModels,
  A extends HfAlias<M>,
  In,
  C,
> = {
  model: A;
  input: DataProviderKey<In> | string;
  output: DataProviderKey<HfResult<M, A, C, In> | null> | string;
  status?: DataProviderKey<HfInferStatus | null> | string;
  triggerProvider?: DataProviderKey<unknown> | string;
  consentProvider?: DataProviderKey<unknown> | string;
  /** Pour une entrée faite d'objets : chemins (`"label + edito.sub_title"`) ou fonction typée. */
  text?: HfTextExtractor<NonNullable<ItemOf<In>>>;
  /** Options d'appel de la tâche du modèle (surchargent `defaults`). */
  call?: HfExact<C, HfCallKeys<HfTaskOf<M, A>>>;
  load?: HfLoadPolicy;
  trigger?: HfTrigger;
  debounceMs?: number;
  emptyValue?: HfResult<M, A, C, In> | null;
  onInvalid?: "keep" | "clear";
  maxItems?: number;
  maxChars?: number;
  timeoutMs?: number;
  persistResults?: boolean;
  resultsTtlMs?: number;
};

export type HuggingFace<M extends HfModels> = {
  readonly models: M;
  /** Relie des DataProviders à un modèle (équivalent TypeScript de l'élément). */
  infer<
    A extends HfAlias<M>,
    In extends HfAcceptedInput<HfTaskOf<M, A>>,
    const C extends HfCallOptions<HfTaskOf<M, A>> = Record<never, never>,
  >(
    options: HfInferOptions<M, A, In, C>,
  ): HfInferHandle;
  /**
   * Calcul ponctuel (sans DataProvider). À utiliser comme `compute` de
   * `derive()` pour des dérivations à plusieurs entrées.
   * Résout `null` si l'entrée est vide.
   */
  run<
    A extends HfAlias<M>,
    In extends HfAcceptedInput<HfTaskOf<M, A>>,
    const C extends HfCallOptions<HfTaskOf<M, A>> = Record<never, never>,
  >(
    model: A,
    input: In,
    call?: HfExact<C, HfCallKeys<HfTaskOf<M, A>>>,
    options?: {
      text?: HfTextExtractor<NonNullable<ItemOf<In>>>;
      load?: HfLoadPolicy;
      timeoutMs?: number;
    },
  ): Promise<HfResult<M, A, C, In> | null>;
  /** Charge un modèle maintenant (préchargement, politique `manual`). */
  load(model: HfAlias<M>): Promise<void>;
  state(model: HfAlias<M>): HfModelState;
  subscribe(model: HfAlias<M>, listener: (state: HfModelState) => void): () => void;
  accept(model: HfAlias<M>): void;
  decline(model: HfAlias<M>): void;
  revokeConsent(model: HfAlias<M>): void;
  /** Supprime un modèle du cache du navigateur. */
  clearModel(model: HfAlias<M>): Promise<void>;
  /** Supprime tous les modèles, le WASM et les résultats mémorisés. */
  clearAll(): Promise<void>;
  readonly registry: HuggingFaceRegistry;
};

/* ------------------------------------------------------------------ */
/* Mise en place                                                       */
/* ------------------------------------------------------------------ */

/**
 * Configure l'inférence pour la page (à appeler une fois, au démarrage).
 * Rend une API typée par la liste blanche de modèles.
 */
export function configureHuggingFace<const M extends HfModels>(
  config: HuggingFaceConfig<M>,
): HuggingFace<M> {
  setHuggingFaceConfig(config);
  const registry = getHuggingFaceRegistry()!;

  return {
    models: config.models,
    registry,

    infer(options) {
      return createHfInferController(
        {
          ...options,
          input: options.input as DataProviderKey<unknown> | string,
          output: options.output as DataProviderKey<unknown> | string,
          text: options.text as HfTextExtractor | undefined,
          call: options.call as Record<string, unknown> | undefined,
          untrusted: false,
        },
        registry,
      );
    },

    async run(alias, value, callOptions, options = {}) {
      const model = registry.model(alias);
      const defaults = registry.resolvedConfig.defaults;
      const input = normalizeInput(value, {
        kind: HF_TASK_INPUT_KIND[model.task],
        text: options.text as HfTextExtractor | undefined,
        maxItems: defaults.maxItems,
        maxChars: defaults.maxChars,
      });
      if (input.kind === "empty") return null;
      if (input.kind === "invalid") throw new HfError("runtime", input.message);
      const call = { ...(model.defaults ?? {}), ...(callOptions ?? {}) } as Record<
        string,
        unknown
      >;
      const positional = (HF_POSITIONAL_ARGS as Partial<Record<HfTask, string>>)[
        model.task
      ];
      await registry.ensureLoaded(alias, options.load ?? "first-use");
      const results = await registry.run(
        {
          alias,
          inputs: input.payloads,
          call,
          positional,
          batch:
            model.task === "feature-extraction" &&
            !!call.pooling &&
            call.pooling !== "none",
        },
        options.timeoutMs ?? defaults.timeoutMs,
      );
      return (input.many ? realign(input, results) : results[0]) as never;
    },

    load: (alias) => registry.ensureLoaded(alias, "manual"),
    state: (alias) => registry.state(alias),
    subscribe: (alias, listener) => registry.subscribe(alias, listener),
    accept: (alias) => registry.accept(alias),
    decline: (alias) => registry.decline(alias),
    revokeConsent: (alias) => registry.revokeConsent(alias),
    clearModel: (alias) => registry.clearModel(alias),
    async clearAll() {
      await registry.clearAll();
      await clearResults();
    },
  };
}

export { defineHuggingFaceModels, HF_DEFAULTS } from "./hf-config";
export type {
  HfDefaults,
  HfLoadPolicy,
  HfModelDefinition,
  HfModels,
  HfRuntime,
  HfTrigger,
  HuggingFaceConfig,
} from "./hf-config";
export type { HfInferHandle, HfInferState, HfInferStatus } from "./hf-controller";
export type { HfModelPhase, HfModelState } from "./hf-registry";
export { HfError } from "./hf-registry";
export type { HfEngine } from "./hf-engine";
export { HfWorkerEngine, HfEngineError } from "./hf-engine";
export { hfCallOptionsJsonSchema, validateCallOptions, HF_CALL_OPTION_SCHEMAS } from "./hf-schema";
export { HF_TASKS } from "./types";
export type {
  HfCallOptions,
  HfEmbedding,
  HfItemOutput,
  HfOutput,
  HfSingleInput,
  HfTask,
} from "./types";
export { cosine, rankBySimilarity } from "../../shared/similarity";
