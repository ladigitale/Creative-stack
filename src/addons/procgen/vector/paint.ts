/**
 * Résolution d'une forme en consignes de peinture selon le style vectoriel (partagée par le rendu Canvas et l'export
 * SVG) : couleur de fond, opacité, mode de fusion, contour (encre ou matière assombrie), hachures, trame.
 */
import type { Shape } from "./shape";
import { type Inks, type VectorStyle, objectInks } from "./vstyle";

export type Painted = {
  fill: string | null;
  alpha: number;
  blend: "normal" | "multiply" | "screen";
  stroke: string | null;
  /** Épaisseur du contour en pixels écran (avant facteur de zoom). */
  strokePx: number;
  /** Hachures : 0 aucune, 1 simples, 2 croisées (gravure) ; trame de points (affiche). */
  hatch: 0 | 1 | 2;
  dots: boolean;
  /** Halo : dégradé radial de la couleur vers la transparence. */
  halo?: boolean;
};

export class Painter {
  private palCache = new WeakMap<object, Record<string, string>>();
  private cache = new WeakMap<Shape, Painted>();
  constructor(readonly vs: VectorStyle, readonly inks: Inks) {}

  private pal(s: Shape) {
    if (!s.pal) return undefined;
    let r = this.palCache.get(s.pal);
    if (!r) this.palCache.set(s.pal, (r = objectInks(this.vs, s.pal) ?? {}));
    return r;
  }

  paint(s: Shape): Painted {
    const hit = this.cache.get(s);
    if (hit) return hit;
    const vs = this.vs, inks = this.inks;
    const depth = s.depth ?? 0;
    const tone = s.tone ?? 0;
    const pal = this.pal(s);
    let out: Painted;
    if (s.kind === "shadow") {
      const grav = vs.hatch > 0;
      out = { fill: grav ? null : inks.color("shadow", 0, depth * 0.6), alpha: (s.alpha ?? 1) * (grav ? 0.9 : vs.shadows) * (1 - depth * 0.45), blend: "multiply", stroke: null, strokePx: 0, hatch: grav ? 2 : 0, dots: vs.halftone > 0 && vs.name === "affiche" };
    } else if (s.kind === "line") {
      const base = (vs.outline || 1.2) * vs.interior * 1.5;
      out = { fill: null, alpha: (s.alpha ?? 1) * (1 - depth * 0.3), blend: "normal", stroke: inks.color(s.stroke ?? "ink", tone, depth, pal), strokePx: Math.max(0.45, base * (s.width ?? 0.5)), hatch: 0, dots: false };
    } else if (s.kind === "halo") {
      out = { fill: inks.color(s.fill, tone, 0, pal), alpha: s.alpha ?? 1, blend: inks.night > 0.3 ? "screen" : "normal", stroke: null, strokePx: 0, hatch: 0, dots: false, halo: true };
    } else if (s.kind === "glow") {
      out = { fill: inks.color(s.fill, tone, depth * 0.4, pal), alpha: s.alpha ?? 1, blend: inks.night > 0.3 && (s.alpha ?? 1) < 1 ? "screen" : "normal", stroke: null, strokePx: 0, hatch: 0, dots: false };
    } else {
      const fill = s.fill === "none" ? null : inks.color(s.fill, tone, depth, pal);
      let stroke: string | null = null;
      let px = 0;
      if (vs.outline > 0 && s.stroke) {
        stroke = vs.outlineColor === "ink" ? inks.color("ink", 0, depth * 0.75) : inks.color(s.fill, tone - 2, depth, pal);
        px = vs.outline * (s.width ?? 1) * (1 - depth * 0.35);
      }
      out = { fill, alpha: s.alpha ?? 1, blend: "normal", stroke, strokePx: px, hatch: vs.hatch > 0 && tone < 0 ? (tone <= -2 ? 2 : 1) : 0, dots: vs.halftone > 0 && tone < 0 };
    }
    this.cache.set(s, out);
    return out;
  }
}

/** Facteur d'épaisseur des traits selon l'échelle (px par mètre) : les traits s'affinent au loin, s'épaississent de près, sans excès. */
export const strokeScale = (pxPerM: number) => Math.max(0.55, Math.min(2.6, (pxPerM / 28) ** 0.4));
