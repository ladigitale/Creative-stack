import { blendOp } from "../paint/brush";
import { drawTip, tipGeometry } from "../paint/tip";
import { intersects, type Multi } from "../vector/geometry";
import { stampsOf, type Stamp } from "./stamps";
import { clipToView } from "../vector/cull";
import { sanitizeBlend, strokePath, toScreen, visibleRect, type Stroke, type StrokeBrush, type View } from "./model";

/** Surface de dessin : contexte en pixels logiques (la mise à l'échelle écran est déjà dans le contexte). */
export type Surface = { ctx: CanvasRenderingContext2D; w: number; h: number; view: View };

/** Toile hors écran : `<canvas>` dans la page, OffscreenCanvas dans un worker (rendu en arrière-plan). */
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
function makeCanvas(): AnyCanvas {
  return typeof document !== "undefined" ? document.createElement("canvas") : new OffscreenCanvas(1, 1);
}
const ctx2d = (c: AnyCanvas) => c.getContext("2d") as CanvasRenderingContext2D | null;

const dabCache = new Map<string, AnyCanvas>();
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
function dab(px: number, hardness: number, color: string): AnyCanvas {
  const d = Math.max(8, Math.min(256, 2 ** Math.ceil(Math.log2(Math.max(2, px)))));
  const key = `${d}|${hardness.toFixed(2)}|${color}`;
  const hit = dabCache.get(key);
  if (hit) return hit;
  if (dabCache.size > 96) dabCache.clear();
  const c = makeCanvas();
  c.width = c.height = d;
  const g = ctx2d(c);
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

/**
 * Sous ce diamètre à l'écran (px), une empreinte est posée à cette taille minimale avec une opacité réduite à
 * proportion de sa surface : un trait fin pâlit en dézoomant au lieu de disparaître d'un coup ou de grainer.
 */
export const MIN_STAMP_PX = 1;

/**
 * Empreinte (monde) sur une surface : pointe personnalisée tracée en vectoriel, sinon disque doux.
 * `k` : facteur d'opacité (empreintes regroupées par le niveau de détail).
 */
export function drawStamp(s: Surface, b: StrokeBrush, st: Stamp, k = 1): void {
  const { ctx, view, w, h } = s;
  const [sx, sy] = toScreen(view, st.x, st.y, w, h);
  let px = st.size * view.zoom;
  const rot = st.rot + (view.rotation || 0);
  let alpha = b.opacity * k;
  if (px < MIN_STAMP_PX) {
    // Surface conservée : (px / MIN)² de l'opacité, sur une empreinte de taille MIN.
    alpha *= (px / MIN_STAMP_PX) ** 2;
    px = MIN_STAMP_PX;
  }
  if (alpha < 1 / 512 || sx < -px - 2 || sy < -px - 2 || sx > w + px + 2 || sy > h + px + 2) return;
  ctx.globalAlpha = Math.min(1, alpha);
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
  if (!v) stampCache.set(st, (v = stampsOf(st.brush, st.seed, strokePath(st))));
  return v;
}

/** Opération canvas d'un mode de fusion (`normal` → `source-over`). */
export function compositeOf(blend: string | undefined): GlobalCompositeOperation {
  return blendOp(sanitizeBlend(blend));
}

const scratchByCanvas = new WeakMap<object, AnyCanvas>();
const STROKE_SCRATCH = {};

/** Tampon de même taille que la surface, vidé, avec la même transformation (empreintes d'un trait à fusionner). */
/** Rectangle en pixels du canvas : x, y, largeur, hauteur. */
export type PxRect = [number, number, number, number];

export function scratchFor(s: Surface, key: object = s.ctx.canvas, rect?: PxRect): Surface | null {
  const target = s.ctx.canvas;
  let c = scratchByCanvas.get(key);
  if (!c) scratchByCanvas.set(key, (c = makeCanvas()));
  if (c.width !== target.width || c.height !== target.height) { c.width = target.width; c.height = target.height; }
  const ctx = ctx2d(c);
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Seule la zone du trait est vidée (puis posée) : le coût suit la taille du trait, pas celle de la toile.
  if (rect) ctx.clearRect(rect[0], rect[1], rect[2], rect[3]);
  else ctx.clearRect(0, 0, c.width, c.height);
  ctx.setTransform(s.ctx.getTransform());
  return { ctx, w: s.w, h: s.h, view: s.view };
}

/** Couleur d'un masque de gomme d'opacité `a` (ôtée de ce qui est dessous). */
export const maskColor = (a: number): string => (a >= 0.999 ? "#000" : `rgba(0,0,0,${Math.max(0, Math.min(1, a)).toFixed(4)})`);

/** Ôte d'une surface un tampon (pixels de la surface), à hauteur de `alpha` : aperçu et rendu de la gomme. */
export function punch(s: Surface, buf: CanvasImageSource, alpha: number, rect?: PxRect): void {
  const { ctx } = s;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.globalCompositeOperation = "destination-out";
  if (rect) ctx.drawImage(buf, rect[0], rect[1], rect[2], rect[3], rect[0], rect[1], rect[2], rect[3]);
  else ctx.drawImage(buf, 0, 0);
  ctx.restore();
}

/** Vide un disque (monde : centre x, y, rayon r) d'une surface : jonction de passes dans le tampon du geste. */
export function clearDisc(s: Surface, x: number, y: number, r: number): void {
  const { ctx, view, w, h } = s;
  const [sx, sy] = toScreen(view, x, y, w, h);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(sx, sy, Math.max(0, r * view.zoom), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Pose un tampon (pixels de la surface) sur la surface avec un mode de fusion. */
export function blitBlend(s: Surface, buf: CanvasImageSource, blend: string | undefined, alpha = 1, rect?: PxRect): void {
  const { ctx } = s;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.globalCompositeOperation = compositeOf(blend);
  if (rect) ctx.drawImage(buf, rect[0], rect[1], rect[2], rect[3], rect[0], rect[1], rect[2], rect[3]);
  else ctx.drawImage(buf, 0, 0);
  ctx.restore();
}

/**
 * Rectangle (pixels du canvas) couvert par un trait : sa boîte du monde passée à l'écran (rotation comprise),
 * élargie de 2 px et bornée à la toile. `null` : hors de la toile.
 */
export function strokeRect(s: Surface, st: Stroke): PxRect | null {
  const { view, w, h, ctx } = s;
  // Marge en plus de la boîte : pointes non rondes (diagonale) et taille variable peuvent en dépasser.
  const pad = (st.brush.size || 0) * (0.25 + 0.5 * (st.brush.sizeJitter || 0));
  const b = { x: st.bbox.x - pad, y: st.bbox.y - pad, w: st.bbox.w + 2 * pad, h: st.bbox.h + 2 * pad };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [wx, wy] of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]) {
    const [sx, sy] = toScreen(view, wx, wy, w, h);
    x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
  }
  const m = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
  const kx = m && Number.isFinite(m.a) ? m.a : 1, ky = m && Number.isFinite(m.d) ? m.d : 1, ox = m && Number.isFinite(m.e) ? m.e : 0, oy = m && Number.isFinite(m.f) ? m.f : 0;
  const cw = ctx.canvas?.width ?? Infinity, ch = ctx.canvas?.height ?? Infinity;
  const X0 = Math.max(0, Math.floor(x0 * kx + ox - 2)), Y0 = Math.max(0, Math.floor(y0 * ky + oy - 2));
  const X1 = Math.min(cw, Math.ceil(x1 * kx + ox + 2)), Y1 = Math.min(ch, Math.ceil(y1 * ky + oy + 2));
  if (!(X1 > X0 && Y1 > Y0)) return null;
  return [X0, Y0, X1 - X0, Y1 - Y0];
}

/**
 * Dessine un trait. L'opacité est celle du trait entier (comme dans les logiciels de dessin) : ses empreintes
 * sont réunies à pleine force dans un tampon, sans se fusionner entre elles, puis le tampon est posé sur ce qui
 * est dessous avec l'opacité et le mode du trait — des empreintes qui se chevauchent ne foncent pas le trait.
 * Gomme en empreintes : le tampon est ôté de ce qui est dessous, à hauteur de l'opacité.
 */
export function drawStroke(s: Surface, st: Stroke): void {
  const a = st.brush.opacity;
  const blend = st.brush.blend;
  if (st.flat || st.mask || (!st.erase && (!blend || blend === "normal") && a >= 0.999)) return paintStroke(s, st);
  // Une seule empreinte (touche posée) : rien ne se chevauche dans le trait, elle se pose directement avec son
  // opacité et son mode, sans tampon intermédiaire (même rendu, bien plus rapide pour des milliers de touches).
  if (!st.erase && strokeStamps(st).length === 1) {
    s.ctx.save();
    s.ctx.globalCompositeOperation = compositeOf(blend);
    paintStroke(s, st);
    s.ctx.restore();
    return;
  }
  // Trait minuscule à l'écran (dézoom) : pas de tampon. Ses empreintes se posent directement, avec l'opacité qui,
  // cumulée sur leur recouvrement (≈ m empreintes par point), redonne l'opacité du trait. Invisible à cette taille,
  // et c'est l'essentiel du coût d'un dézoom sur un dessin de milliers de traits.
  const px = st.brush.size * s.view.zoom;
  if (!st.erase && px < LOD_PX && !(st.brush.scatter > 0)) {
    const m = Math.max(1, Math.max(px, MIN_STAMP_PX) / Math.max(0.5, (st.brush.spacing || 0.1) * px));
    const per = 1 - Math.pow(1 - Math.min(0.999, a), 1 / m);
    s.ctx.save();
    s.ctx.globalCompositeOperation = compositeOf(blend);
    paintStroke(s, { ...st, brush: { ...st.brush, opacity: per } });
    s.ctx.restore();
    return;
  }
  // Tampon limité à la zone du trait (la vider et la poser coûte sa taille, pas celle de la toile).
  const rect = strokeRect(s, st);
  if (!rect) return;
  // Un seul tampon pour toutes les toiles de même taille (couche, couche de rechange, export…).
  const buf = scratchFor(s, STROKE_SCRATCH, rect);
  if (!buf) return;
  paintStroke(buf, { ...st, brush: { ...st.brush, opacity: 1 } });
  if (st.erase) punch(s, buf.ctx.canvas, a, rect);
  else blitBlend(s, buf.ctx.canvas, blend, a, rect);
}

function paintStroke(s: Surface, st: Stroke): void {
  if (st.flat) {
    for (const r of st.flat) fillMulti(s, r.shape, r.color, r.blend ? blendOp(r.blend) : "source-over", !r.blend && r.rgba[3] >= 0.999);
    return;
  }
  if (st.mask) return fillMulti(s, st.mask, maskColor(st.brush.opacity), "destination-out");
  const stamps = strokeStamps(st);
  const zoom = s.view.zoom;
  // Niveau de détail : quand les empreintes sont petites à l'écran, au plus une par demi-pixel le long du trait.
  // Les empreintes sautées sont comptées dans l'opacité de la suivante (1 − (1 − a)^n), même densité à l'œil.
  if (stamps.length > 2 && st.brush.size * zoom < LOD_PX && !(st.brush.scatter > 0)) {
    const gap = 0.5 / zoom;
    let lx = stamps[0].x, ly = stamps[0].y, n = 0;
    const a = Math.max(1e-3, Math.min(1, st.brush.opacity));
    for (let i = 0; i < stamps.length; i++) {
      const p = stamps[i];
      n++;
      if (i > 0 && i < stamps.length - 1 && Math.hypot(p.x - lx, p.y - ly) < gap) continue;
      const k = n > 1 ? (1 - (1 - a) ** n) / a : 1;
      drawStamp(s, st.brush, p, k);
      lx = p.x; ly = p.y; n = 0;
    }
    return;
  }
  for (const stamp of stamps) drawStamp(s, st.brush, stamp);
}

/** Diamètre à l'écran (px) sous lequel les empreintes d'un trait sont regroupées (niveau de détail). */
export const LOD_PX = 3;

/**
 * Polygones du monde remplis en pair-impair. Les sommets passent à l'écran en double précision côté JS
 * (pas de transformation du contexte : le canvas calcule en simple précision, faux aux zooms extrêmes).
 */
/**
 * Remplit une forme. `seal` (régions opaques sans fusion) : le contour est aussi tracé de la même couleur sur
 * ~1 px. Deux régions voisines remplies séparément laissent sinon passer le fond par l'anticrénelage de leur
 * bord commun (un liseré clair, très visible quand la couche est agrandie pendant un zoom).
 */
function fillMulti(s: Surface, shape: Multi, color: string, op: GlobalCompositeOperation, seal = false): void {
  const { ctx, view, w, h } = s;
  // Découpe à la vue (outil de clipping de l'addon vector) : aux forts zooms, pas de coordonnées gigantesques.
  let m = shape;
  try { m = clipToView(shape, visibleRect(view, w, h), 2 / view.zoom); } catch { /* forme laissée entière */ }
  const path = new Path2D();
  for (const poly of m) {
    for (const ring of poly) {
      if (ring.length < 3) continue;
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = toScreen(view, ring[i][0], ring[i][1], w, h);
        if (i) path.lineTo(x, y); else path.moveTo(x, y);
      }
      path.closePath();
    }
  }
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = op;
  ctx.fillStyle = color;
  ctx.fill(path, "evenodd");
  if (seal) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.9;
    ctx.lineJoin = "round";
    ctx.stroke(path);
  }
  ctx.restore();
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
