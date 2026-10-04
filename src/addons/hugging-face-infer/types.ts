/**
 * Types de `sonic-hugging-face-infer`, dérivés des types publiés par
 * Transformers.js (`@huggingface/transformers`).
 *
 * Rien n'est recopié à la main : entrées, options d'appel et sorties sont
 * calculées à partir des signatures des pipelines de la version figée de la
 * bibliothèque. Une montée de version qui change une signature fait échouer la
 * compilation ici (et dans `schema.ts`), pas en production.
 *
 * Uniquement des `import type` : ce fichier n'ajoute aucun octet au bundle.
 */
import type {
  AllTasks,
  DataType,
  DeviceType,
  PretrainedModelOptions,
  RawImage,
  Tensor,
} from "@huggingface/transformers";

/* ------------------------------------------------------------------ */
/* Tâches prises en charge                                             */
/* ------------------------------------------------------------------ */

/**
 * Tâches autorisées. Volontairement sans LLM libre (`text-generation`,
 * `summarization`, `text2text-generation`, `text-to-audio`) : trop lourd /
 * peu fiable dans un navigateur. `image-to-text` (légende) est autorisé :
 * modèles vision→texte courts et bornés (`max_new_tokens`).
 */
export const HF_TASKS = [
  "feature-extraction",
  "text-classification",
  "zero-shot-classification",
  "translation",
  "token-classification",
  "fill-mask",
  "question-answering",
  "image-classification",
  "zero-shot-image-classification",
  "object-detection",
  "zero-shot-object-detection",
  "image-feature-extraction",
  "image-segmentation",
  "depth-estimation",
  "background-removal",
  "image-to-text",
  "audio-classification",
  "automatic-speech-recognition",
] as const satisfies readonly (keyof AllTasks)[];

export type HfTask = (typeof HF_TASKS)[number];

/**
 * Arguments positionnels supplémentaires (entre l'entrée et les options) que
 * certains pipelines exigent. Côté Concorde, ils sont passés dans les options
 * d'appel sous ce nom, puis replacés à la bonne position par le worker.
 */
export const HF_POSITIONAL_ARGS = {
  "zero-shot-classification": "candidate_labels",
  "zero-shot-image-classification": "candidate_labels",
  "zero-shot-object-detection": "candidate_labels",
  "question-answering": "context",
} as const satisfies Partial<Record<HfTask, string>>;

type PositionalTask = keyof typeof HF_POSITIONAL_ARGS;

/** Famille de l'entrée, utile pour la validation à l'exécution. */
export const HF_TASK_INPUT_KIND = {
  "feature-extraction": "text",
  "text-classification": "text",
  "zero-shot-classification": "text",
  translation: "text",
  "token-classification": "text",
  "fill-mask": "text",
  "question-answering": "text",
  "image-classification": "image",
  "zero-shot-image-classification": "image",
  "object-detection": "image",
  "zero-shot-object-detection": "image",
  "image-feature-extraction": "image",
  "image-segmentation": "image",
  "depth-estimation": "image",
  "background-removal": "image",
  "image-to-text": "image",
  "audio-classification": "audio",
  "automatic-speech-recognition": "audio",
} as const satisfies Record<HfTask, "text" | "image" | "audio">;

export type HfInputKind = (typeof HF_TASK_INPUT_KIND)[HfTask];

/* ------------------------------------------------------------------ */
/* Utilitaires de types                                                */
/* ------------------------------------------------------------------ */

type IsAny<T> = 0 extends 1 & T ? true : false;

/** Appelle (au niveau des types) un pipeline générique avec des arguments donnés. */
type CallWith<F, A extends unknown[]> = F extends (...args: A) => infer R
  ? R
  : never;

/**
 * Retire la variante « lot » d'une union `X | X[]` renvoyée par les pipelines
 * (qui acceptent une entrée seule ou un tableau).
 */
type DropBatch<M, All> = M extends readonly (infer E)[]
  ? [E] extends [All]
    ? never
    : M
  : M;
type Single<R> = DropBatch<R, R>;

/** Retire les signatures d'index (`[key: string]: unknown`). */
type RemoveIndex<T> = {
  [K in keyof T as string extends K
    ? never
    : number extends K
      ? never
      : symbol extends K
        ? never
        : K]: T[K];
};

type JsonPrimitive = string | number | boolean | null | undefined;

/**
 * Vrai si la valeur peut traverser `postMessage` ET être stockée dans un
 * DataProvider sans perte : primitives, tableaux et objets simples. Les classes
 * (Tensor, streamers, caches…) portent des méthodes et sont exclues ; `any`
 * aussi (non typable, donc non validable).
 */
type IsJsonSafe<V> =
  IsAny<V> extends true
    ? false
    : false extends (V extends unknown ? IsJsonSafeOne<V> : never)
      ? false
      : true;

type IsJsonSafeOne<V> = [V] extends [JsonPrimitive]
      ? true
      : [V] extends [readonly (infer E)[]]
        ? IsJsonSafe<E>
        : [V] extends [object]
          ? [V] extends [(...args: never[]) => unknown]
            ? false
            : HasMethod<V> extends true
              ? false
              : AllJsonSafe<V>
          : false;

type HasMethod<V> = true extends {
  [K in keyof V]-?: NonNullable<V[K]> extends (...args: never[]) => unknown
    ? true
    : false;
}[keyof V]
  ? true
  : false;

type AllJsonSafe<V> = false extends {
  [K in keyof V]-?: IsJsonSafe<Exclude<V[K], undefined>>;
}[keyof V]
  ? false
  : true;

/** Ne garde que les options sérialisables. */
export type JsonSafeOptions<O> = {
  [K in keyof RemoveIndex<O> as IsJsonSafe<
    Exclude<RemoveIndex<O>[K], undefined>
  > extends true
    ? K
    : never]?: Exclude<RemoveIndex<O>[K], undefined>;
};

/**
 * Refuse les clés en trop même quand `C` est inféré (paramètre générique) :
 * les clés absentes de `O` deviennent `never`.
 */
export type HfExact<C, O> = {
  [K in keyof C]: K extends keyof O ? C[K] : never;
};

/* ------------------------------------------------------------------ */
/* Pipelines                                                           */
/* ------------------------------------------------------------------ */

type Pipe<T extends HfTask> = AllTasks[T];
type PipeParams<T extends HfTask> = Parameters<Pipe<T>>;

/** Types d'entrée transférables vers un worker (pas de canvas, pas de RawImage). */
type Transferable = string | Blob | Float32Array | Float64Array;

/**
 * Entrée d'UN élément pour une tâche (texte, URL/Blob d'image, audio),
 * dérivée du premier paramètre du pipeline.
 */
export type HfSingleInput<T extends HfTask> = Extract<
  Single<PipeParams<T>[0]>,
  Transferable
>;

/** Dernier paramètre (options) du pipeline, brut. */
type RawCallOptions<T extends HfTask> = T extends PositionalTask
  ? NonNullable<PipeParams<T>[2]>
  : NonNullable<PipeParams<T>[1]>;

/** Argument positionnel supplémentaire, replié dans les options. */
type PositionalOptions<T extends HfTask> = T extends PositionalTask
  ? {
      [K in (typeof HF_POSITIONAL_ARGS)[T]]: Extract<
        PipeParams<T>[1],
        string | readonly string[]
      >;
    }
  : unknown;

/**
 * Options d'appel d'une tâche : options sérialisables du pipeline, plus
 * l'argument positionnel éventuel (`candidate_labels`, `context`).
 */
export type HfCallOptions<T extends HfTask> = JsonSafeOptions<
  RawCallOptions<T>
> &
  Partial<PositionalOptions<T>>;

/** Options d'appel nécessaires (l'argument positionnel est requis au moment de l'appel). */
export type HfRequiredCallKeys<T extends HfTask> = T extends PositionalTask
  ? (typeof HF_POSITIONAL_ARGS)[T]
  : never;

/* ------------------------------------------------------------------ */
/* Sorties                                                             */
/* ------------------------------------------------------------------ */

/** Tableaux imbriqués de nombres, forme `tolist()` d'un Tensor. */
export type HfNumberTree = number | HfNumberTree[];

/** Image produite par un pipeline, transportée hors du worker. */
export type HfSerializedImage = {
  width: number;
  height: number;
  channels: number;
  /** PNG encodé dans le worker (`RawImage.toBlob()`). */
  blob: Blob;
  /**
   * ObjectURL créé côté main thread à la publication (`attachMediaUrls`).
   * Chaînable vers `sonic-shader` / `sonic-webgpu` / `sonic-jsonata` (`$mediaUrl`) sans colle JS.
   */
  url?: string;
};

/** Conversion des valeurs non sérialisables (Tensor, RawImage) en données simples. */
export type HfSerialized<V> = V extends Tensor
  ? HfNumberTree
  : V extends RawImage
    ? HfSerializedImage
    : V extends readonly (infer E)[]
      ? HfSerialized<E>[]
      : V extends Blob
        ? V
        : V extends object
          ? { [K in keyof V]: HfSerialized<V[K]> }
          : V;

/** Sortie brute du pipeline pour UNE entrée, avec des options données. */
type RawItemOutput<T extends HfTask, O> = Single<
  Awaited<
    T extends PositionalTask
      ? CallWith<Pipe<T>, [HfSingleInput<T>, PipeParams<T>[1], O]>
      : CallWith<Pipe<T>, [HfSingleInput<T>, O]>
  >
>;

/**
 * Un embedding : vecteur quand un `pooling` est demandé, matrice
 * jetons × dimensions sinon (défaut de Transformers.js : `pooling: "none"`).
 */
export type HfEmbedding<O> = O extends { pooling: infer P }
  ? [P] extends ["none" | undefined]
    ? number[][]
    : number[]
  : number[][];

/**
 * Sortie pour UNE entrée. `feature-extraction` et `image-feature-extraction`
 * renvoient un Tensor : il est aplati pour l'élément (première dimension
 * « lot » retirée).
 */
export type HfItemOutput<T extends HfTask, O = HfCallOptions<T>> =
  T extends "feature-extraction"
    ? HfEmbedding<O>
    : T extends "image-feature-extraction"
      ? number[]
      : HfSerialized<RawItemOutput<T, O>>;

/**
 * Sortie publiée : un résultat pour une entrée seule, une liste ALIGNÉE sur
 * l'entrée (avec `null` pour les éléments inexploitables) pour une liste.
 */
export type HfOutput<T extends HfTask, O, Many extends boolean> =
  Many extends true ? (HfItemOutput<T, O> | null)[] : HfItemOutput<T, O>;

/* ------------------------------------------------------------------ */
/* Options de chargement (côté application uniquement)                 */
/* ------------------------------------------------------------------ */

/** Exécution demandée. `webgpu` et `wasm` sont les seuls pertinents dans un navigateur. */
export type HfDevice = Extract<DeviceType, "webgpu" | "wasm">;
export type HfDataType = DataType;

/**
 * Options passées à `pipeline(task, repo, options)`, dérivées de
 * `PretrainedModelOptions`. `progress_callback` est géré par Concorde,
 * `revision` est obligatoire au niveau du modèle, `device` est remplacé par
 * la liste ordonnée `devices`, `cache_dir` / `local_files_only` n'ont pas de
 * sens dans un navigateur.
 */
export type HfLoadOptions = Omit<
  PretrainedModelOptions,
  | "progress_callback"
  | "revision"
  | "device"
  | "cache_dir"
  | "local_files_only"
>;
