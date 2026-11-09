import { drawTip, tipGeometry } from "../paint/tip";
import { intersects } from "../vector/geometry";
import { stampsOf, type Stamp } from "./stamps";
import { toScreen, type Stroke, type StrokeBrush, type View } from "./model";

/** Surface de dessin : contexte en pixels logiques (la mise à l'échelle écran est déjà dans le contexte). */
export type Surface = { ctx: CanvasRenderingContext2D; w: number; h: number; view: View };

const dabCache = new Map<string, HTMLCanvasElement>();
const pathCache = new Map<string, Path2D>();
const stampCache = new WeakMap<Stroke, Stamp[]>();

function alpha0(g: CanvasRenderingContext2D, color: string): string {
  g.fillStyle = "#000";
  g.fillStyle = color;
  const v = String(g.fillStyle);
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
  if (m) return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},0)`;
  const r = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
  return r ? `rgba(${r[1]},${r[2]},${r[3]},0)` : "rgba(0,0,0,0)";
}

/** Disque doux pré-dessiné à une résolution en puissance de deux (agrandi ou réduit à l'usage). */
function dab(px: number, hardness: number, color: string): HTMLCanvasElement {
  const d = Math.max(8, Math.min(256, 2 ** Math.ceil(Math.log2(Math.max(2, px)))));
  const key = `${d}|${hardness.toFixed(2)}|${color}`;
  const hit = dabCache.get(key);
  if (hit) return hit;
  if (dabCache.size > 96) dabCache.clear();
  const c = document.createElement("canvas");
  c.width = c.height = d;
  const g = c.getContext("2d");
  if (g) {
    const r = d / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, color);
    grad.addColorStop(Math.min(0.999, Math.max(0, hardness)), color);
    grad.addColorStop(1, alpha0(g, color));
    g.fillStyle = grad;
    g.fillRect(0, 0, d, d);
  }
  dabCache.set(key, c);
  return c;
}

/** Empreinte (monde) sur une surface : pointe personnalisée tracée en vectoriel, sinon disque doux. */
export function drawStamp(s: Surface, b: StrokeBrush, st: Stamp): void {
  const { ctx, view, w, h } = s;
  const [sx, sy] = toScreen(view, st.x, st.y, w, h);
  const px = st.size * view.zoom;
  if (px < 0.3 || sx < -px - 2 || sy < -px - 2 || sx > w + px + 2 || sy > h + px + 2) return;
  ctx.globalAlpha = b.opacity;
  const geo = b.tip ? tipGeometry(b.tip) : null;
  if (geo) {
    let path = pathCache.get(b.tip);
    if (!path) {
      if (pathCache.size > 32) pathCache.clear();
      pathCache.set(b.tip, (path = new Path2D(b.tip)));
    }
    ctx.fillStyle = b.color;
    drawTip(ctx, path, geo, sx, sy, px, st.rot, st.squash);
  } else {
    const d = dab(px, b.hardness, b.color);
    ctx.save();
    ctx.translate(sx, sy);
    if (st.rot) ctx.rotate(st.rot);
    ctx.drawImage(d, (-px * st.squash) / 2, -px / 2, px * st.squash, px);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

/** Les empreintes d'un trait, régénérées à l'identique à partir de ses points et de sa graine (mises en cache). */
export function strokeStamps(st: Stroke): Stamp[] {
  let v = stampCache.get(st);
  if (!v) stampCache.set(st, (v = stampsOf(st.brush, st.seed, st.pts)));
  return v;
}

/** Opération canvas d'un mode de fusion (`normal` → `source-over`). */
export function compositeOf(blend: string | undefined): GlobalCompositeOperation {
  return !blend || blend === "normal" ? "source-over" : (blend as GlobalCompositeOperation);
}

const scratchByCanvas = new WeakMap<object, HTMLCanvasElement>();

/** Tampon de même taille que la surface, vidé, avec la même transformation (empreintes d'un trait à fusionner). */
export function scratchFor(s: Surface, key: object = s.ctx.canvas): Surface | null {
  const target = s.ctx.canvas;
  let c = scratchByCanvas.get(key);
  if (!c) scratchByCanvas.set(key, (c = document.createElement("canvas")));
  if (c.width !== target.width || c.height !== target.height) { c.width = target.width; c.height = target.height; }
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.setTransform(s.ctx.getTransform());
  return { ctx, w: s.w, h: s.h, view: s.view };
}

/** Pose un tampon (pixels de la surface) sur la surface avec un mode de fusion. */
export function blitBlend(s: Surface, buf: CanvasImageSource, blend: string | undefined): void {
  const { ctx } = s;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = compositeOf(blend);
  ctx.drawImage(buf, 0, 0);
  ctx.restore();
}

/**
 * Dessine un trait. Avec un mode de fusion, ses empreintes sont d'abord réunies dans un tampon (normalement,
 * pour qu'elles ne se fusionnent pas entre elles) puis le tampon est fusionné avec ce qui est dessous.
 */
export function drawStroke(s: Surface, st: Stroke): void {
  const blend = st.brush.blend;
  if (!blend || blend === "normal") {
    for (const stamp of strokeStamps(st)) drawStamp(s, st.brush, stamp);
    return;
  }
  const buf = scratchFor(s);
  if (!buf) return;
  for (const stamp of strokeStamps(st)) drawStamp(buf, st.brush, stamp);
  blitBlend(s, buf.ctx.canvas, blend);
}

/** Dessine les traits dont la boîte coupe `viewRect`, dans l'ordre. Retourne leur nombre. */
export function drawStrokes(s: Surface, strokes: Stroke[], viewRect: { x: number; y: number; w: number; h: number }): number {
  let n = 0;
  for (const st of strokes) {
    if (!intersects(st.bbox, viewRect)) continue;
    // Invisible sous le demi-pixel : pas la peine de générer ses empreintes.
    if (Math.max(st.bbox.w, st.bbox.h) * s.view.zoom < 0.4) continue;
    drawStroke(s, st);
    n++;
  }
  return n;
}
