/**
 * Cœur sans DOM de `sonic-object-detector` : miroir, maintien (`hold-ms`), clés de sortie plates
 * (meilleur objet, comptes par étiquette) et attribut `map`.
 */
import { assignPath, evalMap, type CompiledMap } from "../../shared/ml/map-expr";
import { Smoother } from "../../shared/ml/one-euro";
import { IdTracker } from "../../shared/ml/tracking";
import type { RawDetection } from "./landmarkers";

export type ObjectOutput = {
  label: string;
  score: number;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  /** Avec `track` : identité de l'objet entre images (1, 2, 3… jamais réutilisée). */
  id?: number;
  /** Avec `track` : durée (ms) depuis la première apparition de cet `id`. */
  ageMs?: number;
};

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
  /** Avec `track` : `id` et `ageMs` du meilleur objet. */
  id?: number;
  ageMs?: number;
  /** Avec `track` : `id` des objets, dans l'ordre de `objects`. */
  ids?: number[];
  /** Nombre d'objets par étiquette (clé = étiquette en minuscules, caractères non alphanumériques → `_`). */
  labels: Record<string, number>;
  objects: ObjectOutput[];
  [derived: string]: unknown;
};

export type DetectorCoreOptions = {
  holdMs: number;
  mirror: boolean;
  map?: CompiledMap | null;
  /** Donne une identité (`id`) à chaque objet entre images et lisse sa boîte avec `smooth`. */
  track?: boolean;
  /** Recouvrement minimal (IoU) pour reconnaître un objet d'une image à l'autre. */
  trackIou?: number;
  /** Un objet disparu garde son `id` pendant cette durée (ms). */
  trackMaxAgeMs?: number;
  /** Lissage One Euro de la boîte d'un objet suivi, 0 (aucun) à 1. */
  smooth?: number;
};

const NEUTRAL = { label: "", score: 0, x: 0, y: 0, w: 0, h: 0, cx: 0.5, cy: 0.5 };

export function labelKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "objet";
}

export class DetectorCore {
  private opts: DetectorCoreOptions;
  private last: ObjectsOutput | null = null;
  private lastSeen = -Infinity;
  private ids = new IdTracker();
  private smoothers = new Map<number, Smoother>();

  constructor(opts: DetectorCoreOptions) {
    this.opts = { ...opts };
    this.configure({});
  }

  configure(opts: Partial<DetectorCoreOptions>): void {
    this.opts = { ...this.opts, ...opts };
    this.ids.configure({
      ...(this.opts.trackIou !== undefined ? { iou: this.opts.trackIou } : {}),
      ...(this.opts.trackMaxAgeMs !== undefined ? { maxAgeMs: this.opts.trackMaxAgeMs } : {}),
    });
  }

  reset(): void {
    this.last = null;
    this.lastSeen = -Infinity;
    this.ids.reset();
    this.smoothers.clear();
  }

  update(raw: RawDetection[], now: number): ObjectsOutput {
    if (raw.length === 0 && this.last && now - this.lastSeen <= this.opts.holdMs) return this.last;

    const objects: ObjectOutput[] = raw.map((d) => {
      const x = this.opts.mirror ? 1 - (d.x + d.w) : d.x;
      return { label: d.label, score: d.score, x, y: d.y, w: d.w, h: d.h, cx: x + d.w / 2, cy: d.y + d.h / 2 };
    });
    if (this.opts.track) this.identify(objects, now);
    else if (this.smoothers.size) this.smoothers.clear();
    const labels: Record<string, number> = {};
    for (const o of objects) {
      const k = labelKey(o.label);
      labels[k] = (labels[k] ?? 0) + 1;
    }
    const best = objects[0] ?? NEUTRAL;
    const output: ObjectsOutput = { present: objects.length ? 1 : 0, count: objects.length, ...best, labels, objects };
    if (this.opts.track) output.ids = objects.map((o) => o.id as number);
    if (objects.length) {
      this.lastSeen = now;
    }
    if (this.opts.map && this.opts.map.ok) {
      for (const [key, value] of Object.entries(evalMap(this.opts.map, output))) assignPath(output, key, value);
    }
    this.last = objects.length ? output : null;
    return output;
  }

  /** `id`, `ageMs` et boîte lissée (par identité) de chaque objet. Les identités éteintes libèrent leur lissage. */
  private identify(objects: ObjectOutput[], now: number): void {
    const found = this.ids.update(objects, now);
    const smooth = this.opts.smooth ?? 0;
    objects.forEach((o, i) => {
      o.id = found[i].id;
      o.ageMs = found[i].ageMs;
      if (!(smooth > 0)) return;
      let sm = this.smoothers.get(o.id);
      if (!sm) this.smoothers.set(o.id, (sm = new Smoother(smooth)));
      else sm.smooth = smooth;
      o.x = sm.apply("x", o.x, now);
      o.y = sm.apply("y", o.y, now);
      o.w = sm.apply("w", o.w, now);
      o.h = sm.apply("h", o.h, now);
      o.cx = o.x + o.w / 2;
      o.cy = o.y + o.h / 2;
    });
    const alive = this.ids.alive();
    for (const id of [...this.smoothers.keys()]) if (!alive.has(id)) this.smoothers.delete(id);
  }
}
