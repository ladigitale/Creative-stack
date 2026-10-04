/**
 * Similarité entre vecteurs (embeddings). Fonctions pures, sans dépendance :
 * utilisables en TypeScript et exposées à JSONata (`$cosine`, `$rankBySimilarity`).
 */

function isVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

/** Similarité cosinus dans [-1, 1] ; `null` si les vecteurs sont absents ou incompatibles. */
export function cosine(a: unknown, b: unknown): number | null {
  if (!isVector(a) || !isVector(b) || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return null;
  return dot / Math.sqrt(na * nb);
}

export type Ranked<T> = T & { _score: number };

/**
 * Classe `items` par similarité entre leur vecteur (`vectors[i]`, aligné sur
 * `items`) et `query`. Les éléments sans vecteur sont ignorés.
 */
export function rankBySimilarity<T>(
  items: readonly T[] | null | undefined,
  vectors: readonly (readonly number[] | null)[] | null | undefined,
  query: readonly number[] | null | undefined,
  topN = 10,
  minScore = -1,
): Ranked<T>[] {
  if (!Array.isArray(items) || !Array.isArray(vectors) || !isVector(query))
    return [];
  const scored: Ranked<T>[] = [];
  items.forEach((item, i) => {
    const score = cosine(vectors[i], query);
    if (score === null || score < minScore) return;
    const base =
      item && typeof item === "object" ? item : ({ value: item } as unknown as T);
    scored.push({ ...(base as T), _score: Math.round(score * 10_000) / 10_000 });
  });
  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, Math.max(0, topN));
}
