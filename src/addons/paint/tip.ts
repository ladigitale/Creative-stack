import { flatten, parsePath } from "../vector/svgpath";

/**
 * Pointe de pinceau personnalisée : un chemin SVG ramené à une boîte unité centrée sur l'origine
 * (côté le plus long = 1). Dessinée à l'échelle du diamètre de l'empreinte.
 */
export type TipGeometry = {
  /** Chemin d'origine. */
  d: string;
  /** Centre de la boîte d'origine, et facteur pour que le côté le plus long vaille 1. */
  cx: number;
  cy: number;
  k: number;
};

const cache = new Map<string, TipGeometry | null>();

/** Géométrie d'une pointe, ou `null` si le chemin est illisible ou dégénéré. */
export function tipGeometry(d: string): TipGeometry | null {
  if (cache.has(d)) return cache.get(d) ?? null;
  if (cache.size > 64) cache.clear();
  let out: TipGeometry | null = null;
  const segs = parsePath(d);
  if (segs) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const { ring } of flatten(segs, 0.05)) {
      for (const [x, y] of ring) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    const side = Math.max(x1 - x0, y1 - y0);
    if (Number.isFinite(side) && side > 1e-9) out = { d, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, k: 1 / side };
  }
  cache.set(d, out);
  return out;
}

/** Attribut SVG `transform` qui place la pointe : centre (x, y), diamètre, rotation (radians), aplatissement. */
export function tipTransform(g: TipGeometry, x: number, y: number, size: number, rot: number, squash = 1): string {
  const f = (n: number) => Number(n.toPrecision(7));
  const deg = (rot * 180) / Math.PI;
  const s = size * g.k;
  return `translate(${f(x)} ${f(y)})${deg ? ` rotate(${f(deg)})` : ""} scale(${f(s * squash)} ${f(s)}) translate(${f(-g.cx)} ${f(-g.cy)})`;
}

/** Dessine la pointe sur un contexte 2D (couleur de remplissage déjà posée). */
export function drawTip(ctx: CanvasRenderingContext2D, path: Path2D, g: TipGeometry, x: number, y: number, size: number, rot: number, squash = 1): void {
  ctx.save();
  ctx.translate(x, y);
  if (rot) ctx.rotate(rot);
  const s = size * g.k;
  ctx.scale(s * squash, s);
  ctx.translate(-g.cx, -g.cy);
  ctx.fill(path, "nonzero");
  ctx.restore();
}

/** Chemin `d` d'une valeur de DataProvider : chaîne, `{ d }` (forme de `sonic-vector-library`) ou `{ shape: { d } }`. */
export function tipFromValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.d === "string") return o.d;
    if (o.shape && typeof (o.shape as Record<string, unknown>).d === "string") return (o.shape as { d: string }).d;
  }
  return "";
}
