/**
 * Cœur sans DOM de `sonic-object-detector` : miroir, maintien (`hold-ms`), clés de sortie plates
 * (meilleur objet, comptes par étiquette) et attribut `map`.
 */
import { assignPath, evalMap, type CompiledMap } from "../../shared/ml/map-expr";
import type { RawDetection } from "./landmarkers";

export type ObjectOutput = { label: string; score: number; x: number; y: number; w: number; h: number; cx: number; cy: number };

export type ObjectsOutput = {
  present: 0 | 1;
  count: number;
  /** Meilleur objet (score le plus haut) : mêmes clés que `objects.0`. */
  label: string;
  score: number;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  /** Nombre d'objets par étiquette (clé = étiquette en minuscules, caractères non alphanumériques → `_`). */
  labels: Record<string, number>;
  objects: ObjectOutput[];
  [derived: string]: unknown;
};

export type DetectorCoreOptions = { holdMs: number; mirror: boolean; map?: CompiledMap | null };

const NEUTRAL = { label: "", score: 0, x: 0, y: 0, w: 0, h: 0, cx: 0.5, cy: 0.5 };

export function labelKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "objet";
}

export class DetectorCore {
  private opts: DetectorCoreOptions;
  private last: ObjectsOutput | null = null;
  private lastSeen = -Infinity;

  constructor(opts: DetectorCoreOptions) {
    this.opts = { ...opts };
  }

  configure(opts: Partial<DetectorCoreOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  reset(): void {
    this.last = null;
    this.lastSeen = -Infinity;
  }

  update(raw: RawDetection[], now: number): ObjectsOutput {
    if (raw.length === 0 && this.last && now - this.lastSeen <= this.opts.holdMs) return this.last;

    const objects: ObjectOutput[] = raw.map((d) => {
      const x = this.opts.mirror ? 1 - (d.x + d.w) : d.x;
      return { label: d.label, score: d.score, x, y: d.y, w: d.w, h: d.h, cx: x + d.w / 2, cy: d.y + d.h / 2 };
    });
    const labels: Record<string, number> = {};
    for (const o of objects) {
      const k = labelKey(o.label);
      labels[k] = (labels[k] ?? 0) + 1;
    }
    const best = objects[0] ?? NEUTRAL;
    const output: ObjectsOutput = { present: objects.length ? 1 : 0, count: objects.length, ...best, labels, objects };
    if (objects.length) {
      this.lastSeen = now;
    }
    if (this.opts.map && this.opts.map.ok) {
      for (const [key, value] of Object.entries(evalMap(this.opts.map, output))) assignPath(output, key, value);
    }
    this.last = objects.length ? output : null;
    return output;
  }
}
