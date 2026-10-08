/**
 * Fonctions JSONata ajoutées par la creative-stack (portées de Concorde visual-stack) :
 * `$cosine(a, b)`, `$rankBySimilarity(items, vectors, query, topN?, minScore?)`, `$mediaUrl(ref)`.
 *
 * Concorde 5.x n'offre pas de point d'extension pour les fonctions de `sonic-jsonata`.
 * Deux usages :
 *  - `registerCreativeJsonataHelpers(expr)` sur une expression qu'on compile soi-même ;
 *  - l'alias de build `jsonata` → `@supersoniks/creative-stack/jsonata` (voir `jsonata-shim.ts`),
 *    qui les ajoute à toutes les expressions, y compris celles de `sonic-jsonata`.
 */
import type { Expression } from "jsonata";
import { toMediaUrl } from "./mediaRef";
import { cosine, rankBySimilarity } from "./similarity";

export function registerCreativeJsonataHelpers(expression: Expression): Expression {
  expression.registerFunction("cosine", (a: unknown, b: unknown) => cosine(a, b));
  expression.registerFunction(
    "rankBySimilarity",
    (items: unknown, vectors: unknown, query: unknown, topN: unknown = 10, minScore: unknown = -1) =>
      rankBySimilarity(
        items as unknown[],
        vectors as number[][],
        query as number[],
        Number(topN),
        Number(minScore),
      ),
  );
  expression.registerFunction("mediaUrl", (value: unknown) => toMediaUrl(value));
  return expression;
}
