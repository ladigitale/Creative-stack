/**
 * Normalisation et validation des entrées, AVANT tout téléchargement ou calcul.
 *
 * Règles :
 * - absente / vide → `empty` (pas d'erreur, rien n'est chargé) ;
 * - mauvais type → `invalid` avec un message précis, pas de coercition silencieuse ;
 * - liste partiellement valide → les éléments inexploitables deviennent `null`
 *   à leur position (la sortie reste alignée sur l'entrée) ;
 * - trop grosse → `invalid` (`too-large`) ; texte trop long → tronqué + averti.
 */
import type { HfInputKind } from "./types";

/** Chemins pointés séparés par `+` (`"label + edito.sub_title"`), liste de chemins, ou fonction. */
export type HfTextExtractor<Item = unknown> =
  | string
  | readonly string[]
  | ((item: Item) => string | null | undefined);

export type HfNormalizeOptions = {
  kind: HfInputKind;
  text?: HfTextExtractor;
  maxItems: number;
  maxChars: number;
};

export type HfNormalizedInput =
  | { kind: "empty" }
  | { kind: "invalid"; code: "invalid-input" | "too-large"; message: string }
  | {
      kind: "ok";
      /** L'entrée était une liste : la sortie sera une liste alignée. */
      many: boolean;
      /** Longueur de l'entrée d'origine. */
      length: number;
      /** Charges utiles valides, dans l'ordre. */
      payloads: unknown[];
      /** Position d'origine de chaque charge utile valide. */
      positions: number[];
      skipped: number;
      truncated: number;
      warnings: string[];
    };

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Blob) return "Blob";
  if (ArrayBuffer.isView(value)) return value.constructor.name;
  return typeof value;
}

/** Compile un extracteur de texte (chemins pointés) une fois pour toutes. */
export function compileTextExtractor(
  text: HfTextExtractor | undefined,
): ((item: unknown) => string | null) | null {
  if (text === undefined || text === null || text === "") return null;
  if (typeof text === "function") {
    return (item) => {
      const value = text(item);
      return typeof value === "string" ? value : null;
    };
  }
  const paths = (typeof text === "string" ? text.split("+") : [...text])
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.split("."));
  if (!paths.length) return null;

  const read = (value: unknown, parts: string[]): string[] => {
    if (value === null || value === undefined) return [];
    if (!parts.length) {
      if (typeof value === "string") return value.trim() ? [value.trim()] : [];
      if (typeof value === "number") return [String(value)];
      if (Array.isArray(value)) return value.flatMap((v) => read(v, []));
      return [];
    }
    if (Array.isArray(value)) return value.flatMap((v) => read(v, parts));
    if (typeof value !== "object") return [];
    const [head, ...rest] = parts;
    return read((value as Record<string, unknown>)[head], rest);
  };

  return (item) => {
    const parts = paths
      .map((p) => read(item, p).join(", "))
      .filter((s) => s.length > 0);
    return parts.length ? parts.join(" — ") : null;
  };
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object" && !(value instanceof Blob) && !ArrayBuffer.isView(value))
    return Object.keys(value as object).length === 0;
  return false;
}

type ItemResult = { ok: true; payload: unknown; truncated: boolean } | { ok: false; reason: string };

function normalizeItem(
  item: unknown,
  options: HfNormalizeOptions,
  extract: ((item: unknown) => string | null) | null,
): ItemResult {
  switch (options.kind) {
    case "text": {
      let text: string | null = null;
      if (typeof item === "string") text = item.trim();
      else if (item && typeof item === "object" && !Array.isArray(item)) {
        if (!extract)
          return {
            ok: false,
            reason: "objet reçu sans `options.text` pour en extraire le texte",
          };
        text = extract(item);
      } else {
        return { ok: false, reason: `texte attendu, reçu ${describe(item)}` };
      }
      if (!text) return { ok: false, reason: "texte vide" };
      if (text.length > options.maxChars)
        return { ok: true, payload: text.slice(0, options.maxChars), truncated: true };
      return { ok: true, payload: text, truncated: false };
    }
    case "image": {
      if (typeof item === "string" && item.trim())
        return { ok: true, payload: item.trim(), truncated: false };
      if (item instanceof Blob) return { ok: true, payload: item, truncated: false };
      return {
        ok: false,
        reason: `image attendue (URL, data URL ou Blob), reçu ${describe(item)}`,
      };
    }
    case "audio": {
      if (item instanceof Float32Array || item instanceof Float64Array)
        return { ok: true, payload: item, truncated: false };
      if (typeof item === "string" && item.trim())
        return { ok: true, payload: item.trim(), truncated: false };
      return {
        ok: false,
        reason: `audio attendu (Float32Array, Float64Array ou URL), reçu ${describe(item)}`,
      };
    }
  }
}

export function normalizeInput(
  value: unknown,
  options: HfNormalizeOptions,
): HfNormalizedInput {
  if (isEmptyValue(value)) return { kind: "empty" };
  const extract = compileTextExtractor(options.text);
  const many = Array.isArray(value);
  const items = many ? (value as unknown[]) : [value];

  if (items.length > options.maxItems) {
    return {
      kind: "invalid",
      code: "too-large",
      message: `Entrée trop grosse : ${items.length} éléments (maximum ${options.maxItems}).`,
    };
  }

  const payloads: unknown[] = [];
  const positions: number[] = [];
  const reasons: string[] = [];
  let truncated = 0;
  items.forEach((item, index) => {
    const result = normalizeItem(item, options, extract);
    if (result.ok) {
      payloads.push(result.payload);
      positions.push(index);
      if (result.truncated) truncated++;
    } else {
      reasons.push(many ? `[${index}] ${result.reason}` : result.reason);
    }
  });

  if (!payloads.length) {
    return {
      kind: "invalid",
      code: "invalid-input",
      message: `Entrée invalide : ${reasons.slice(0, 3).join(" ; ")}${reasons.length > 3 ? ` (+${reasons.length - 3})` : ""}.`,
    };
  }

  const warnings: string[] = [];
  if (truncated)
    warnings.push(`${truncated} texte(s) tronqué(s) à ${options.maxChars} caractères.`);
  if (reasons.length)
    warnings.push(
      `${reasons.length} élément(s) ignoré(s) : ${reasons.slice(0, 3).join(" ; ")}.`,
    );

  return {
    kind: "ok",
    many,
    length: items.length,
    payloads,
    positions,
    skipped: items.length - payloads.length,
    truncated,
    warnings,
  };
}

/** Replace les résultats à leur position d'origine (`null` pour les éléments ignorés). */
export function realign<T>(
  input: Extract<HfNormalizedInput, { kind: "ok" }>,
  results: T[],
): (T | null)[] {
  const out: (T | null)[] = new Array(input.length).fill(null);
  input.positions.forEach((position, i) => {
    out[position] = results[i] ?? null;
  });
  return out;
}
