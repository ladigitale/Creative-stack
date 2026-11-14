/**
 * Worker de rendu de la couche (empaqueté par scripts/build-sketch-worker.mjs dans layer-worker-source.ts).
 * Garde sa copie des traits (`set` : liste entière, `append` : traits ajoutés au-dessus) et rend une vue sur
 * demande (`render`) dans un OffscreenCanvas, renvoyée en ImageBitmap. Une demande plus récente abandonne celle
 * en cours (le rendu cède la main toutes les ~25 ms pour lire les messages).
 */
import { drawStroke, type Surface } from "./render";
import { GLRenderer } from "./gl-render";
import { intersects } from "../vector/geometry";
import { visibleRect, type Stroke, type View } from "./model";

export type LayerMsg =
  | { type: "set"; rev: number; strokes: Stroke[] }
  | { type: "append"; rev: number; strokes: Stroke[] }
  | { type: "render"; id: number; rev: number; len: number; view: View; w: number; h: number; dpr: number; bg: string | null; gl?: boolean };

export type LayerReply = { id: number; rev: number; len: number; view: View; w: number; h: number; dpr: number; bitmap?: ImageBitmap; error?: string; ms: number; engine?: "gl" | "2d" };

type Scope = { onmessage: ((e: MessageEvent<LayerMsg>) => void) | null; postMessage: (m: unknown, t?: Transferable[]) => void };
const scope = self as unknown as Scope;

let strokes: Stroke[] = [];
let rev = -1;
let latest = 0;
let canvas: OffscreenCanvas | null = null;
/** Moteur WebGL2 (carte graphique) ; `false` : indisponible ou en échec, rendu 2D. */
let glr: GLRenderer | null | false = null;
let glCanvas: OffscreenCanvas | null = null;

const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

async function render(m: Extract<LayerMsg, { type: "render" }>): Promise<void> {
  const t0 = performance.now();
  const base = { id: m.id, rev: m.rev, len: m.len, view: m.view, w: m.w, h: m.h, dpr: m.dpr };
  if (m.rev !== rev || m.len > strokes.length) { scope.postMessage({ ...base, error: "désynchronisé", ms: 0 }); return; }
  const list = strokes.slice(0, m.len);
  if (m.gl !== false && glr !== false) {
    try {
      if (!glr) {
        glCanvas = new OffscreenCanvas(1, 1);
        glr = GLRenderer.create(glCanvas) ?? false;
      }
      if (glr) {
        const done = await glr.render(list, m.view, m.w, m.h, m.dpr, m.bg, async () => { await yieldNow(); return latest === m.id; });
        if (latest !== m.id) return;
        if (done) {
          const bitmap = glCanvas!.transferToImageBitmap();
          scope.postMessage({ ...base, bitmap, ms: performance.now() - t0, engine: "gl" }, [bitmap]);
          return;
        }
        if (glr.lost) glr = false;
      }
    } catch (err) {
      // Moteur GL en échec (shader refusé, contexte perdu…) : rendu 2D pour la suite.
      console.warn("sonic-sketch : rendu WebGL indisponible", err);
      glr = false;
    }
  }
  const W = Math.max(1, Math.round(m.w * m.dpr)), H = Math.max(1, Math.round(m.h * m.dpr));
  if (!canvas) canvas = new OffscreenCanvas(W, H);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D | null;
  if (!ctx) { scope.postMessage({ ...base, error: "pas de contexte 2d", ms: 0 }); return; }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
  if (m.bg) { ctx.fillStyle = m.bg; ctx.fillRect(0, 0, m.w, m.h); }
  const s: Surface = { ctx, w: m.w, h: m.h, view: m.view };
  const rect = visibleRect(m.view, m.w, m.h);
  let slice = performance.now();
  for (let i = 0; i < list.length; i++) {
    const st = list[i];
    if (!intersects(st.bbox, rect) || Math.max(st.bbox.w, st.bbox.h) * m.view.zoom < 0.4) continue;
    drawStroke(s, st);
    if (performance.now() - slice > 25) {
      await yieldNow();
      if (latest !== m.id) return;
      slice = performance.now();
    }
  }
  const bitmap = canvas.transferToImageBitmap();
  scope.postMessage({ ...base, bitmap, ms: performance.now() - t0, engine: "2d" }, [bitmap]);
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === "set") { strokes = m.strokes; rev = m.rev; return; }
  if (m.type === "append") { if (m.rev === rev) strokes = strokes.concat(m.strokes); return; }
  latest = m.id;
  render(m).catch((err) => scope.postMessage({ id: m.id, rev: m.rev, len: m.len, view: m.view, w: m.w, h: m.h, dpr: m.dpr, error: err instanceof Error ? err.message : String(err), ms: 0 }));
};
