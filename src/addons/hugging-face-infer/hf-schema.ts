/**
 * Schémas des options d'appel, par tâche.
 *
 * Ces schémas servent à valider à l'exécution ce qu'un descripteur SDUI (ou
 * un attribut HTML) passe dans `options.call`, et à documenter le catalogue
 * MCP (`hfCallOptionsJsonSchema`).
 *
 * Ils ne peuvent pas diverger des types de Transformers.js :
 * - chaque tâche doit lister TOUTES les options sérialisables de son pipeline
 *   (clé manquante = erreur de compilation) ;
 * - une clé qui n'existe pas dans le pipeline est refusée ;
 * - tout ce qu'un schéma accepte doit être une valeur valide du type de
 *   l'option (sinon erreur de compilation « schema-trop-large »).
 *
 * Les bornes (`maximum`, `maxItems`…) protègent le poste : un descripteur
 * SDUI ne peut pas demander 10 000 jetons ou 200 faisceaux.
 */
import type { HfCallOptions, HfTask } from "./types";

/* ------------------------------------------------------------------ */
/* Langage de schéma (sous-ensemble JSON Schema)                        */
/* ------------------------------------------------------------------ */

export type HfValueSchema =
  | { readonly type: "boolean" }
  | {
      readonly type: "number";
      readonly integer?: boolean;
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | { readonly type: "string"; readonly maxLength?: number }
  | { readonly type: "null" }
  | { readonly enum: readonly (string | number | boolean)[] }
  | {
      readonly type: "array";
      readonly items: HfValueSchema;
      readonly maxItems?: number;
    }
  | {
      readonly type: "tuple";
      readonly prefixItems: readonly HfValueSchema[];
    }
  | { readonly anyOf: readonly HfValueSchema[] };

/** Valeurs acceptées par un schéma (niveau types). */
export type HfSchemaValue<S> = S extends { type: "boolean" }
  ? boolean
  : S extends { type: "number" }
    ? number
    : S extends { type: "string" }
      ? string
      : S extends { type: "null" }
        ? null
        : S extends { enum: readonly (infer E)[] }
          ? E
          : S extends { type: "array"; items: infer I }
            ? HfSchemaValue<I>[]
            : S extends { type: "tuple"; prefixItems: infer P }
              ? { -readonly [K in keyof P]: HfSchemaValue<P[K]> }
              : S extends { anyOf: readonly (infer A)[] }
                ? HfSchemaValue<A>
                : never;

type SchemaTable = {
  readonly [T in HfTask]: {
    readonly [K in keyof HfCallOptions<T>]-?: HfValueSchema;
  };
};

/**
 * Vérifie que chaque schéma est « sûr » : ce qu'il accepte est assignable au
 * type de l'option dans Transformers.js.
 */
type Sound<S extends SchemaTable> = {
  readonly [T in HfTask]: {
    readonly [K in keyof HfCallOptions<T>]-?: K extends keyof S[T]
      ? HfSchemaValue<S[T][K]> extends Exclude<HfCallOptions<T>[K], undefined>
        ? S[T][K]
        : { "schema-trop-large": K; accepte: HfSchemaValue<S[T][K]> }
      : never;
  };
};

function defineCallSchemas<const S extends SchemaTable>(
  schemas: S & Sound<S>,
): S {
  return schemas;
}

/* ------------------------------------------------------------------ */
/* Briques partagées                                                   */
/* ------------------------------------------------------------------ */

const bool = { type: "boolean" } as const;
const num = (minimum?: number, maximum?: number) =>
  ({ type: "number", minimum, maximum }) as const;
const int = (minimum?: number, maximum?: number) =>
  ({ type: "number", integer: true, minimum, maximum }) as const;
const str = (maxLength = 500) => ({ type: "string", maxLength }) as const;
const intList = (maxItems = 256) =>
  ({ type: "array", items: int(0), maxItems }) as const;
const intMatrix = (maxItems = 64) =>
  ({ type: "array", items: intList(), maxItems }) as const;
const labelList = { type: "array", items: str(200), maxItems: 50 } as const;
const labels = { anyOf: [str(200), labelList] } as const;
const topK = { anyOf: [int(1, 50), { type: "null" }] } as const;

/**
 * Paramètres de génération (`GenerationConfig`) sérialisables, communs à
 * `translation`, `image-to-text` et `automatic-speech-recognition`. Bornés
 * pour rester raisonnables dans un navigateur.
 */
const generation = {
  max_length: int(1, 1024),
  max_new_tokens: int(1, 1024),
  min_length: int(0, 1024),
  min_new_tokens: int(0, 1024),
  early_stopping: { anyOf: [bool, { enum: ["never"] }] },
  max_time: num(0, 120),
  do_sample: bool,
  num_beams: int(1, 8),
  num_beam_groups: int(1, 8),
  penalty_alpha: num(0, 1),
  use_cache: bool,
  temperature: num(0, 5),
  top_k: int(0, 200),
  top_p: num(0, 1),
  typical_p: num(0, 1),
  epsilon_cutoff: num(0, 1),
  eta_cutoff: num(0, 1),
  diversity_penalty: num(0, 10),
  repetition_penalty: num(0, 10),
  encoder_repetition_penalty: num(0, 10),
  length_penalty: num(-10, 10),
  no_repeat_ngram_size: int(0, 32),
  bad_words_ids: intMatrix(),
  force_words_ids: {
    anyOf: [
      intMatrix(),
      { type: "array", items: intMatrix(), maxItems: 64 },
    ],
  },
  renormalize_logits: bool,
  forced_bos_token_id: int(0),
  forced_eos_token_id: { anyOf: [int(0), intList()] },
  remove_invalid_values: bool,
  exponential_decay_length_penalty: {
    type: "tuple",
    prefixItems: [int(0), num()],
  },
  suppress_tokens: intList(),
  begin_suppress_tokens: intList(),
  forced_decoder_ids: {
    type: "array",
    items: { type: "tuple", prefixItems: [int(0), int(0)] },
    maxItems: 64,
  },
  guidance_scale: num(0, 50),
  num_return_sequences: int(1, 8),
  output_attentions: bool,
  output_hidden_states: bool,
  output_scores: bool,
  return_dict_in_generate: bool,
  pad_token_id: int(0),
  bos_token_id: int(0),
  eos_token_id: { anyOf: [int(0), intList()] },
  encoder_no_repeat_ngram_size: int(0, 32),
  decoder_start_token_id: int(0),
} as const;

/* ------------------------------------------------------------------ */
/* Table par tâche                                                     */
/* ------------------------------------------------------------------ */

export const HF_CALL_OPTION_SCHEMAS = defineCallSchemas({
  "feature-extraction": {
    pooling: {
      enum: ["none", "mean", "cls", "first_token", "eos", "last_token"],
    },
    normalize: bool,
    quantize: bool,
    precision: { enum: ["binary", "ubinary"] },
  },
  "text-classification": { top_k: topK },
  "zero-shot-classification": {
    candidate_labels: labels,
    hypothesis_template: str(300),
    multi_label: bool,
  },
  translation: generation,
  "token-classification": {
    ignore_labels: { type: "array", items: str(100), maxItems: 50 },
    aggregation_strategy: { enum: ["none", "simple"] },
  },
  "fill-mask": { top_k: int(1, 50) },
  "question-answering": {
    context: { anyOf: [str(20_000), { type: "array", items: str(20_000), maxItems: 20 }] },
    top_k: int(1, 20),
  },
  "image-classification": { top_k: topK },
  "zero-shot-image-classification": {
    candidate_labels: labelList,
    hypothesis_template: str(300),
  },
  "object-detection": { threshold: num(0, 1), percentage: bool },
  "zero-shot-object-detection": {
    candidate_labels: labelList,
    threshold: num(0, 1),
    top_k: int(1, 100),
    percentage: bool,
  },
  "image-feature-extraction": { pool: bool },
  "image-segmentation": {
    threshold: num(0, 1),
    mask_threshold: num(0, 1),
    overlap_mask_area_threshold: num(0, 1),
    subtask: { anyOf: [str(50), { type: "null" }] },
    label_ids_to_fuse: intList(),
    target_sizes: intMatrix(),
  },
  "depth-estimation": {},
  "background-removal": {},
  "image-to-text": generation,
  "audio-classification": { top_k: int(1, 50) },
  "automatic-speech-recognition": {
    ...generation,
    return_timestamps: { anyOf: [bool, { enum: ["word"] }] },
    chunk_length_s: num(0, 60),
    stride_length_s: num(0, 30),
    force_full_sequences: bool,
    language: str(40),
    task: { enum: ["transcribe", "translate"] },
    num_frames: int(0),
  },
});

/* ------------------------------------------------------------------ */
/* Validation à l'exécution                                            */
/* ------------------------------------------------------------------ */

export class HfOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HfOptionsError";
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function check(
  schema: HfValueSchema,
  value: unknown,
  path: string,
): string | null {
  if ("anyOf" in schema) {
    const errors = schema.anyOf.map((s) => check(s, value, path));
    return errors.some((e) => e === null) ? null : errors[0];
  }
  if ("enum" in schema) {
    return schema.enum.includes(value as never)
      ? null
      : `${path} : valeur ${JSON.stringify(value)} non autorisée (attendu : ${schema.enum
          .map((v) => JSON.stringify(v))
          .join(" | ")}).`;
  }
  switch (schema.type) {
    case "boolean":
      return typeof value === "boolean"
        ? null
        : `${path} : booléen attendu, reçu ${describe(value)}.`;
    case "null":
      return value === null ? null : `${path} : null attendu.`;
    case "string":
      if (typeof value !== "string")
        return `${path} : texte attendu, reçu ${describe(value)}.`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        return `${path} : texte trop long (${value.length} > ${schema.maxLength}).`;
      return null;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        return `${path} : nombre attendu, reçu ${describe(value)}.`;
      if (schema.integer && !Number.isInteger(value))
        return `${path} : entier attendu.`;
      if (schema.minimum !== undefined && value < schema.minimum)
        return `${path} : minimum ${schema.minimum}.`;
      if (schema.maximum !== undefined && value > schema.maximum)
        return `${path} : maximum ${schema.maximum}.`;
      return null;
    case "array": {
      if (!Array.isArray(value))
        return `${path} : liste attendue, reçu ${describe(value)}.`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems)
        return `${path} : trop d'éléments (${value.length} > ${schema.maxItems}).`;
      for (let i = 0; i < value.length; i++) {
        const err = check(schema.items, value[i], `${path}[${i}]`);
        if (err) return err;
      }
      return null;
    }
    case "tuple": {
      if (!Array.isArray(value) || value.length !== schema.prefixItems.length)
        return `${path} : liste de ${schema.prefixItems.length} éléments attendue.`;
      for (let i = 0; i < value.length; i++) {
        const err = check(schema.prefixItems[i], value[i], `${path}[${i}]`);
        if (err) return err;
      }
      return null;
    }
  }
}

/**
 * Valide des options d'appel venues de l'extérieur (SDUI, attribut HTML).
 * Clés inconnues refusées, types et bornes vérifiés.
 */
export function validateCallOptions<T extends HfTask>(
  task: T,
  options: unknown,
): HfCallOptions<T> {
  if (options === undefined || options === null) return {} as HfCallOptions<T>;
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new HfOptionsError(
      `[sonic-hugging-face-infer] options.call : objet attendu, reçu ${describe(options)}.`,
    );
  }
  const table = HF_CALL_OPTION_SCHEMAS[task] as Record<string, HfValueSchema>;
  for (const [key, value] of Object.entries(options)) {
    const schema = table[key];
    if (!schema) {
      const allowed = Object.keys(table);
      throw new HfOptionsError(
        `[sonic-hugging-face-infer] option "${key}" inconnue pour la tâche "${task}"` +
          (allowed.length ? ` (autorisées : ${allowed.join(", ")}).` : " (aucune option)."),
      );
    }
    if (value === undefined) continue;
    const err = check(schema, value, `options.call.${key}`);
    if (err) throw new HfOptionsError(`[sonic-hugging-face-infer] ${err}`);
  }
  return options as HfCallOptions<T>;
}

/** JSON Schema (draft 2020-12) des options d'appel d'une tâche, pour le catalogue MCP. */
export function hfCallOptionsJsonSchema(task: HfTask): Record<string, unknown> {
  const toJson = (s: HfValueSchema): Record<string, unknown> => {
    if ("anyOf" in s) return { anyOf: s.anyOf.map(toJson) };
    if ("enum" in s) return { enum: [...s.enum] };
    switch (s.type) {
      case "number": {
        const out: Record<string, unknown> = {
          type: s.integer ? "integer" : "number",
        };
        if (s.minimum !== undefined) out.minimum = s.minimum;
        if (s.maximum !== undefined) out.maximum = s.maximum;
        return out;
      }
      case "string":
        return s.maxLength !== undefined
          ? { type: "string", maxLength: s.maxLength }
          : { type: "string" };
      case "array":
        return s.maxItems !== undefined
          ? { type: "array", items: toJson(s.items), maxItems: s.maxItems }
          : { type: "array", items: toJson(s.items) };
      case "tuple":
        return {
          type: "array",
          prefixItems: s.prefixItems.map(toJson),
          minItems: s.prefixItems.length,
          maxItems: s.prefixItems.length,
        };
      default:
        return { type: s.type };
    }
  };
  const table = HF_CALL_OPTION_SCHEMAS[task] as Record<string, HfValueSchema>;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      Object.entries(table).map(([k, v]) => [k, toJson(v)]),
    ),
  };
}
