import { describe, expect, expectTypeOf, it } from "vitest";
import {
  HF_CALL_OPTION_SCHEMAS,
  HfOptionsError,
  hfCallOptionsJsonSchema,
  validateCallOptions,
} from "./hf-schema";
import { HF_TASKS, type HfCallOptions, type HfItemOutput, type HfSingleInput } from "./types";
import { defineHuggingFaceModels } from "./hf-config";

describe("validateCallOptions (entrées non fiables : SDUI, attributs)", () => {
  it("accepte des options valides", () => {
    expect(
      validateCallOptions("feature-extraction", { pooling: "mean", normalize: true }),
    ).toEqual({ pooling: "mean", normalize: true });
  });

  it("refuse une clé inconnue en listant les clés autorisées", () => {
    expect(() => validateCallOptions("feature-extraction", { top_k: 3 })).toThrow(
      /option "top_k" inconnue.*pooling, normalize/,
    );
  });

  it("vérifie les énumérations, types et bornes", () => {
    expect(() => validateCallOptions("feature-extraction", { pooling: "max" })).toThrow(
      HfOptionsError,
    );
    expect(() => validateCallOptions("translation", { max_new_tokens: "12" })).toThrow(
      /nombre attendu/,
    );
    expect(() => validateCallOptions("translation", { max_new_tokens: 100_000 })).toThrow(
      /maximum 1024/,
    );
    expect(() => validateCallOptions("translation", { num_beams: 2.5 })).toThrow(/entier/);
  });

  it("argument positionnel replié dans les options (candidate_labels)", () => {
    expect(
      validateCallOptions("zero-shot-classification", {
        candidate_labels: ["jeune public", "humour"],
        multi_label: true,
      }),
    ).toBeTruthy();
    expect(() =>
      validateCallOptions("zero-shot-classification", { candidate_labels: [1, 2] }),
    ).toThrow();
  });

  it("chaque tâche prise en charge a un schéma", () => {
    for (const task of HF_TASKS) expect(HF_CALL_OPTION_SCHEMAS[task]).toBeDefined();
  });

  it("produit un JSON Schema pour le catalogue MCP", () => {
    const schema = hfCallOptionsJsonSchema("feature-extraction");
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        pooling: { enum: ["none", "mean", "cls", "first_token", "eos", "last_token"] },
        normalize: { type: "boolean" },
      },
    });
    expect(hfCallOptionsJsonSchema("translation").properties).toMatchObject({
      max_new_tokens: { type: "integer", minimum: 1, maximum: 1024 },
    });
  });
});

describe("types dérivés de Transformers.js", () => {
  it("entrées", () => {
    expectTypeOf<HfSingleInput<"feature-extraction">>().toEqualTypeOf<string>();
    expectTypeOf<HfSingleInput<"image-classification">>().toEqualTypeOf<string | Blob>();
  });

  it("options d'appel : uniquement sérialisables, typées par tâche", () => {
    expectTypeOf<HfCallOptions<"feature-extraction">>().toHaveProperty("pooling");
    expectTypeOf<HfCallOptions<"zero-shot-classification">>().toHaveProperty(
      "candidate_labels",
    );
    // Les options non sérialisables (streamer, logits_processor…) sont exclues.
    expectTypeOf<HfCallOptions<"translation">>().not.toHaveProperty("streamer");
    expectTypeOf<HfCallOptions<"translation">>().toHaveProperty("max_new_tokens");
  });

  it("sorties par élément", () => {
    expectTypeOf<HfItemOutput<"feature-extraction", { pooling: "mean" }>>().toEqualTypeOf<
      number[]
    >();
    expectTypeOf<HfItemOutput<"feature-extraction", object>>().toEqualTypeOf<number[][]>();
    expectTypeOf<HfItemOutput<"translation">>().toEqualTypeOf<
      { translation_text: string }[]
    >();
    expectTypeOf<HfItemOutput<"zero-shot-classification">>().toEqualTypeOf<{
      sequence: string;
      labels: string[];
      scores: number[];
    }>();
  });

  it("defineHuggingFaceModels : defaults vérifiés selon la tâche", () => {
    defineHuggingFaceModels({
      ok: {
        task: "feature-extraction",
        repo: "r",
        revision: "sha",
        defaults: { pooling: "mean" },
      },
    });
    defineHuggingFaceModels({
      ko: {
        task: "feature-extraction",
        repo: "r",
        revision: "sha",
        // @ts-expect-error top_k n'existe pas pour feature-extraction
        defaults: { top_k: 3 },
      },
    });
    defineHuggingFaceModels({
      // @ts-expect-error revision obligatoire
      ko: { task: "translation", repo: "r" },
    });
    expect(true).toBe(true);
  });
});
