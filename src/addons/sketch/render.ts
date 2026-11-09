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
  const rot = st.rot + (view.rotation || 0);
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
    drawTip(ctx, path, geo, sx, sy, px, rot, st.squash);
  } else {
    const d = dab(px, b.hardness, b.color);
    ctx.save();
    ctx.translate(sx, sy);
    if (rot) ctx.rotate(rot);
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

export function drawStroke(s: Surface, st: Stroke): void {
  for (const stamp of strokeStamps(st)) drawStamp(s, st.brush, stamp);
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
