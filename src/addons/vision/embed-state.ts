/**
 * Cœur sans DOM de `sonic-image-embedder` : vecteur normalisé, lissage dans le temps, maintien (`hold-ms`),
 * similarité cosinus avec un vecteur de référence et attribut `map`.
 */
import { assignPath, evalMap, type CompiledMap } from "../../shared/ml/map-expr";
import { cosine } from "../../shared/similarity";
import type { MpResult } from "./mp-engine";

export type EmbedOutput = {
  present: 0 | 1;
  /** Dimension du vecteur (0 sans image analysée). */
  dim: number;
  /** Vecteur unitaire (norme 2 = 1), arrondi à 4 décimales. */
  vector: number[];
  /** Norme du vecteur brut du modèle, avant normalisation. */
  norm: number;
  /** Similarité cosinus avec `reference` (-1..1) ; 0 sans référence ou si les dimensions diffèrent. */
  similarity: number;
  [derived: string]: unknown;
};

export type EmbedCoreOptions = {
  /** 0 = aucun lissage ; 1 = très lent. */
  smooth: number;
  holdMs: number;
  map?: CompiledMap | null;
  /** Vecteur de comparaison ; `null` : aucun. */
  reference?: number[] | null;
};

/** Premier vecteur flottant valide de la tête demandée d'un résultat MediaPipe, sinon `null`. */
export function embeddingFromMediaPipe(result: MpResult, head = 0): number[] | null {
  const list = result.embeddings ?? [];
  const e = list.find((x) => (x.headIndex ?? 0) === head) ?? (head === 0 ? list[0] : undefined);
  const v = e?.floatEmbedding;
  if (!Array.isArray(v) || v.length === 0) return null;
  return v.every((n) => typeof n === "number" && Number.isFinite(n)) ? v : null;
}

/** Vecteur d'une valeur de DataProvider : un tableau de nombres, ou un objet `{ vector: [...] }` (sortie d'un embedder). */
export function vectorOf(value: unknown): number[] | null {
  const v = Array.isArray(value) ? value : (value as { vector?: unknown } | null | undefined)?.vector;
  if (!Array.isArray(v) || v.length === 0) return null;
  return v.every((n) => typeof n === "number" && Number.isFinite(n)) ? (v as number[]) : null;
}

export function l2normalize(v: number[]): { vec: number[]; norm: number } {
  let s = 0;
  for (const n of v) s += n * n;
  const norm = Math.sqrt(s);
  if (norm === 0) return { vec: v.slice(), norm: 0 };
  return { vec: v.map((n) => n / norm), norm };
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

const EMPTY: EmbedOutput = { present: 0, dim: 0, vector: [], norm: 0, similarity: 0 };

export class EmbedderCore {
  private opts: EmbedCoreOptions;
  private smoothed: number[] | null = null;
  private norm = 0;
  private lastSeen = -Infinity;
  private present: 0 | 1 = 0;

  constructor(opts: EmbedCoreOptions) {
    this.opts = { ...opts };
  }

  configure(opts: Partial<EmbedCoreOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  reset(): void {
    this.smoothed = null;
    this.norm = 0;
    this.lastSeen = -Infinity;
    this.present = 0;
  }

  update(raw: number[] | null, now: number): EmbedOutput {
    if (raw && raw.length > 0) {
      const { vec, norm } = l2normalize(raw);
      const prev = this.smoothed;
      const keep = Math.max(0, Math.min(0.95, this.opts.smooth * 0.9));
      if (prev && prev.length === vec.length && keep > 0) {
        const mixed = vec.map((n, i) => n * (1 - keep) + prev[i] * keep);
        this.smoothed = l2normalize(mixed).vec;
      } else {
        this.smoothed = vec;
      }
      this.norm = norm;
      this.present = 1;
      this.lastSeen = now;
    } else if (this.present === 1 && now - this.lastSeen > this.opts.holdMs) {
      this.present = 0;
      this.smoothed = null;
      this.norm = 0;
    }
    const vector = this.smoothed ? this.smoothed.map(round4) : [];
    const out: EmbedOutput = this.present === 1 && this.smoothed
      ? {
          present: 1,
          dim: vector.length,
          vector,
          norm: round4(this.norm),
          similarity: round4(cosine(this.smoothed, this.opts.reference ?? null) ?? 0),
        }
      : { ...EMPTY, vector: [] };
    if (this.opts.map && this.opts.map.ok) {
      for (const [key, value] of Object.entries(evalMap(this.opts.map, out))) assignPath(out, key, value);
    }
    return out;
  }
}
