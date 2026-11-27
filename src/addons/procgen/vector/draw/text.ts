/**
 * Texte en dessin vectoriel : la police à traits de procgen, tracée en contours pleins (même dessin qu'en 3D).
 */
import { layoutText } from "../../core/font";
import { strokeOutlines } from "../../geom/text";
import { type Affine, type Paint, Pen } from "../shape";
import type { Kit } from "./kit";

export type TextBox = {
  /** Centre du bloc de texte (coordonnées locales du repère `m`, y vers le haut). */
  cx: number;
  cy: number;
  /** Hauteur de capitale voulue ; réduite pour tenir dans maxW × maxH. */
  height: number;
  maxW?: number;
  maxH?: number;
  weight?: number;
  leading?: number;
};

/** Chemin du texte (vide si rien à tracer). */
export function textPen(m: Affine, text: string, b: TextBox): Pen | null {
  if (!text) return null;
  const weight = b.weight ?? 0.11;
  const lay = layoutText(text, { weight, leading: b.leading });
  if (!lay.polys.length) return null;
  const fw = lay.width + weight * 2, fh = lay.height + weight * 2;
  let c = b.height;
  if (b.maxW && fw * c > b.maxW) c = b.maxW / fw;
  if (b.maxH && fh * c > b.maxH) c = b.maxH / fh;
  const oy = (lay.height - 1) / 2 - 0.5;
  // repère retourné (objet vu de l'autre côté) : le texte reste lisible
  const sx = m[0] * m[3] - m[1] * m[2] < 0 ? -1 : 1;
  const polys = lay.polys.map((pl) => pl.map(([x, y]) => [b.cx + sx * x * c, b.cy + (y + oy) * c] as [number, number]));
  const pen = new Pen(m);
  for (const ring of strokeOutlines(polys, weight * c)) pen.poly(ring);
  return pen;
}

/** Trace un texte plein (sans contour) dans le repère `m`. */
export function drawText(kit: Kit, m: Affine, text: string, b: TextBox, paint: Paint, alpha = 1) {
  const pen = textPen(m, text, b);
  if (pen) kit.em.add(pen, paint, { stroke: null, ...(alpha < 1 ? { alpha } : {}) });
}
