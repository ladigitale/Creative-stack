/**
 * Helpers JSONata purs pour sonic-store (PRNG, matrix, set immuable…).
 * `$random` / `$now` volontairement absents — rejouabilité.
 */
import type { Expression } from "jsonata";
import { mondeParams, mondePlace, mondeRemove } from "../../shared/monde/edit";
import { registerAlgoHelpers } from "../../shared/algo/jsonata";

/**
 * mulberry32 → { value: 0..1, seed } : l'état avance d'une constante (période 2^32), la valeur est son mélange.
 * Même suite que les tirages de `$shuffled`, `$pick`, `$bag`, `$roll` (src/shared/algo/rng.ts).
 * (Avant, la graine suivante était la sortie mélangée : un hash itéré qui pouvait boucler au bout de quelques
 * dizaines de milliers de tirages.)
 */
export function rand(seed: unknown): { value: number; seed: number } {
  const next = (((Number(seed) || 0) >>> 0) + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, seed: next };
}

export function randInt(seed: unknown, n: unknown): { value: number; seed: number } {
  const r = rand(seed);
  const max = Math.max(1, Math.floor(Number(n) || 1));
  return { value: Math.floor(r.value * max), seed: r.seed };
}

export function clamp(value: unknown, min: unknown, max: unknown): number {
  const v = Number(value);
  const a = Number(min);
  const b = Number(max);
  return Math.min(b, Math.max(a, v));
}

export function range(n: unknown): number[] {
  const len = Math.max(0, Math.min(10_000, Math.floor(Number(n) || 0)));
  return Array.from({ length: len }, (_, i) => i);
}

/** Set immuable par chemin dot (`a.b.0.c`). */
export function immutableSet(
  obj: unknown,
  path: unknown,
  value: unknown,
): unknown {
  const parts = String(path ?? "")
    .split(".")
    .filter(Boolean);
  if (!parts.length) return value;
  const clone = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.slice();
    if (v && typeof v === "object") return { ...(v as Record<string, unknown>) };
    return v;
  };
  const root = clone(obj ?? {});
  let cur: any = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cur[key];
    cur[key] = clone(next ?? (/^\d+$/.test(parts[i + 1]) ? [] : {}));
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

export function matrix(w: unknown, h: unknown, fill: unknown = 0): number[][] {
  const width = Math.max(0, Math.min(256, Math.floor(Number(w) || 0)));
  const height = Math.max(0, Math.min(256, Math.floor(Number(h) || 0)));
  const f = Number(fill) || 0;
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => f),
  );
}

/** Rotation 90° horaire d’une matrice 2D. */
export function rotate(mat: unknown): number[][] {
  if (!Array.isArray(mat) || !mat.length) return [];
  const rows = mat as unknown[][];
  const h = rows.length;
  const w = Array.isArray(rows[0]) ? rows[0].length : 0;
  const out: number[][] = Array.from({ length: w }, () =>
    Array.from({ length: h }, () => 0),
  );
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    if (!Array.isArray(row)) continue;
    for (let x = 0; x < w; x++) {
      out[x][h - 1 - y] = Number(row[x]) || 0;
    }
  }
  return out;
}

export function registerInteractiveHelpers(expression: Expression): void {
  expression.registerFunction("rand", rand);
  expression.registerFunction("randInt", randInt);
  expression.registerFunction("clamp", clamp);
  expression.registerFunction("range", range);
  expression.registerFunction("set", immutableSet);
  expression.registerFunction("matrix", matrix);
  expression.registerFunction("rotate", rotate);
  // algorithmes de jeu (grilles, chemins, génération, hasard à graine, interpolation…) : algo.md
  registerAlgoHelpers(expression);
  // édition d'un monde (format monde de sonic-3d / sonic-2d)
  expression.registerFunction("mondePlace", mondePlace);
  expression.registerFunction("mondeRemove", mondeRemove);
  expression.registerFunction("mondeParams", mondeParams);
  // lit le monde complet : chargé à la première utilisation (réducteur asynchrone, prévoir budget-ms ≈ 200)
  expression.registerFunction("mondeAdd", async (monde: unknown, entry: unknown, at?: unknown) => (await import("../../shared/monde/edit-add")).mondeAdd(monde, entry, at));
  expression.registerFunction("mondeTurn", async (monde: unknown, name: unknown, deg?: unknown, src?: unknown) => (await import("../../shared/monde/edit-add")).mondeTurn(monde, name, deg, src));
}
