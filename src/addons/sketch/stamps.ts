/**
 * Génération d'empreintes pour le dessin vectoriel : le moteur du pinceau raster (espacement régulier,
 * variations déterministes) travaillé dans un espace normalisé (diamètre = UNIT) pour que ses planchers
 * en pixels n'aient aucun effet, quelle que soit l'échelle du monde (de 1e-6 à 1e6).
 */
import { BRUSH_DEFAULTS, StampWalker, place, rng, type BrushSettings } from "../paint/brush";
import type { StrokeBrush } from "./model";

export const UNIT = 100;

/** Empreinte placée, en unités du monde. */
export type Stamp = { x: number; y: number; size: number; rot: number; squash: number };

export function stampSettings(b: StrokeBrush): BrushSettings {
  return { ...BRUSH_DEFAULTS, ...b, size: UNIT, tool: "paint", smoothing: 0 };
}

export class StrokeStamper {
  private walker = new StampWalker();
  private k: number;
  private b: BrushSettings;
  private r: () => number;

  constructor(brush: StrokeBrush, seed: number) {
    this.k = UNIT / Math.max(brush.size, 1e-300);
    this.b = stampSettings(brush);
    this.r = rng(seed);
  }

  /** Empreintes à poser en allant jusqu'au point (monde). */
  feed(x: number, y: number, p: number): Stamp[] {
    const k = this.k;
    return this.walker.walk({ x: x * k, y: y * k, p }, this.b, 4000).map((s) => {
      const pl = place(s, this.b, this.r);
      return { x: pl.x / k, y: pl.y / k, size: pl.size / k, rot: pl.rot, squash: pl.squash };
    });
  }
}

/** Toutes les empreintes d'un trait (mêmes appels que pendant le tracé : rendu identique). */
export function stampsOf(brush: StrokeBrush, seed: number, pts: number[]): Stamp[] {
  const st = new StrokeStamper(brush, seed);
  const out: Stamp[] = [];
  for (let i = 0; i < pts.length; i += 3) for (const s of st.feed(pts[i], pts[i + 1], pts[i + 2])) out.push(s);
  return out;
}
