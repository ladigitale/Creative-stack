import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import { safeMediaUrl } from "../../shared/media/urls";
import type { SonicFrameConsumerHost, SonicFrameSource, SonicMediaRef } from "../../shared/mediaRef";
import { BRUSH_DEFAULTS, History, Stabilizer, StampWalker, blendOp, place, rng, sanitizeBrush, type BrushSettings, type Pt } from "./brush";
import { drawTip, tipFromValue, tipGeometry } from "./tip";

const MAX_SIDE = 4096;
const MAX_PIXELS = 16_000_000;

export type PaintState = {
  status: "ready" | "error";
  error: string | null;
  width: number;
  height: number;
  strokes: number;
  drawing: boolean;
  canUndo: boolean;
  canRedo: boolean;
  tool: string;
  color: string;
  size: number;
  /** Dernier enregistrement (`control.save`) : à brancher sur `sonic-media-download source="…last"`. */
  last: { url: string; mime: string; width: number; height: number; size: number } | null;
};

/**
 * Toile de peinture en temps réel : pinceau doux à espacement régulier, gomme, pression du stylet,
 * lissage du tracé, annuler / rétablir. La toile est une source d'images : `sonic-shader channel0="#id"`
 * la lit à chaque trait (peindre pour déformer, éclairer ou faire couler une image).
 *
 * Réglages par attributs ou en direct par `brush-from` (DP `{ color, size, hardness, opacity, tool… }`) ;
 * commandes par `control` (compteurs : `undo`, `redo`, `clear`, `save`). `in-data-provider` charge une
 * image de départ. État dans `out-data-provider`.
 */
@customElement("sonic-paint")
export class SonicPaint extends LitElement implements SonicFrameSource, SonicFrameConsumerHost {
  static styles = css`
    :host { display: block; position: relative; line-height: 0; touch-action: none; }
    :host([hidden-preview]) { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; overflow: hidden; }
    canvas { display: block; width: 100%; height: auto; cursor: crosshair; touch-action: none; }
  `;

  @property({ type: Number }) width = 1024;
  @property({ type: Number }) height = 1024;
  /** Couleur de fond, ou `transparent`. */
  @property({ type: String }) background = "#ffffff";
  @property({ type: String }) color = BRUSH_DEFAULTS.color;
  @property({ type: Number }) size = BRUSH_DEFAULTS.size;
  @property({ type: Number }) hardness = BRUSH_DEFAULTS.hardness;
  @property({ type: Number }) opacity = BRUSH_DEFAULTS.opacity;
  @property({ type: Number }) spacing = BRUSH_DEFAULTS.spacing;
  @property({ type: Number }) smoothing = BRUSH_DEFAULTS.smoothing;
  @property({ type: String }) tool = BRUSH_DEFAULTS.tool;
  @property({ type: Boolean }) pressure = true;
  /** Pointe personnalisée : chemin SVG `d`. Vide : disque doux. */
  @property({ type: String }) tip = "";
  @property({ type: Number }) angle = 0;
  @property({ type: Boolean, attribute: "angle-follow" }) angleFollow = false;
  @property({ type: Number, attribute: "angle-jitter" }) angleJitter = 0;
  @property({ type: Number, attribute: "size-jitter" }) sizeJitter = 0;
  @property({ type: Number }) scatter = 0;
  @property({ type: Number }) roundness = 1;
  /** Mode de fusion du trait : normal, multiply, screen, overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light, difference, exclusion, hue, saturation, color, luminosity. */
  @property({ type: String }) blend = "normal";
  /** DP d'une forme (chaîne `d`, `{ d }` ou forme de `sonic-vector-library`) utilisée comme pointe. */
  @property({ type: String, attribute: "tip-from" }) tipFrom = "";
  /** DP de réglages en direct. */
  @property({ type: String, attribute: "brush-from" }) brushFrom = "";
  @property({ type: String }) control = "";
  @property({ type: String, attribute: "in-data-provider" }) inDataProvider = "";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";
  @property({ type: Number, attribute: "undo-levels" }) undoLevels = 20;
  @property({ type: Boolean }) readonly = false;
  @property({ type: Boolean, attribute: "hidden-preview" }) hiddenPreview = false;

  @query("canvas") private canvasEl!: HTMLCanvasElement;

  private seq = 0;
  private consumers = new Set<object>();
  private strokes = 0;
  private drawing = false;
  private pointer: number | null = null;
  private live: Record<string, unknown> = {};
  private stab = new Stabilizer();
  private walker = new StampWalker();
  private draw = rng(1);
  private tipPaths = new Map<string, Path2D>();
  private history = new History<ImageData>(20);
  private dabs = new Map<string, HTMLCanvasElement>();
  private triggers = new Map<string, CounterTrigger>();
  private unsubs: (() => void)[] = [];
  private last: PaintState["last"] = null;
  private error: string | null = null;
  private loadToken = 0;
  /** Trait en mode de fusion : image de la toile au début du trait, et calque du trait seul. */
  private blendBase: HTMLCanvasElement | null = null;
  private blendLayer: HTMLCanvasElement | null = null;
  private blendMode: GlobalCompositeOperation = "source-over";

  get frameSeq(): number { return this.seq; }
  getFrameCanvas(): HTMLCanvasElement | null { return this.canvasEl ?? null; }
  registerFrameConsumer(token: object = {}): void { this.consumers.add(token); }
  unregisterFrameConsumer(token: object = {}): void { this.consumers.delete(token); }

  /** Réglages effectifs : attributs puis réglages en direct. */
  brush(): BrushSettings {
    const base = sanitizeBrush({ ...BRUSH_DEFAULTS }, { size: this.size, hardness: this.hardness, opacity: this.opacity, spacing: this.spacing, smoothing: this.smoothing, color: this.color, tool: this.tool, pressure: this.pressure, tip: this.tip, angle: this.angle, angleFollow: this.angleFollow, angleJitter: this.angleJitter, sizeJitter: this.sizeJitter, scatter: this.scatter, roundness: this.roundness, blend: this.blend });
    return sanitizeBrush(base, this.live);
  }

  private dims(): { w: number; h: number } {
    let w = Math.round(Math.max(16, Math.min(MAX_SIDE, Number(this.width) || 1024)));
    let h = Math.round(Math.max(16, Math.min(MAX_SIDE, Number(this.height) || 1024)));
    if (w * h > MAX_PIXELS) { const k = Math.sqrt(MAX_PIXELS / (w * h)); w = Math.floor(w * k); h = Math.floor(h * k); }
    return { w, h };
  }

  private ctx(): CanvasRenderingContext2D | null {
    return this.canvasEl?.getContext("2d", { willReadFrequently: false }) ?? null;
  }

  render() {
    const { w, h } = this.dims();
    return html`<canvas width=${w} height=${h} part="canvas"
      @pointerdown=${this.onDown} @pointermove=${this.onMove} @pointerup=${this.onUp} @pointercancel=${this.onUp} @lostpointercapture=${this.onUp}></canvas>`;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
  }

  disconnectedCallback(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.last) URL.revokeObjectURL(this.last.url);
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    this.fillBackground();
    this.publish();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("width") || c.has("height") || c.has("background")) {
      if (this.canvasEl && (c.has("width") || c.has("height")) && !c.has("background")) this.fillBackground();
      else if (c.has("background") && this.strokes === 0) this.fillBackground();
    }
    if (c.has("control") || c.has("brushFrom") || c.has("tipFrom") || c.has("inDataProvider")) this.listen();
    if (c.has("tool") || c.has("color") || c.has("size")) this.publish();
    if (c.has("undoLevels")) this.history = new History<ImageData>(Math.max(0, Math.min(100, this.undoLevels)));
  }

  /* ------------------------------------------------------------ DataProviders */

  private trigger(name: string): CounterTrigger {
    let t = this.triggers.get(name);
    if (!t) this.triggers.set(name, (t = new CounterTrigger()));
    return t;
  }

  private listen(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.triggers.clear();
    if (this.brushFrom) this.unsubs.push(listenDp(this.brushFrom, (v) => { this.live = { ...(v && typeof v === "object" ? (v as Record<string, unknown>) : {}), ...(this.live.tip !== undefined && this.tipFrom ? { tip: this.live.tip } : {}) }; this.publish(); }));
    if (this.tipFrom) this.unsubs.push(listenDp(this.tipFrom, (v) => { this.live = { ...this.live, tip: tipFromValue(v) }; this.publish(); }));
    if (this.control) {
      this.unsubs.push(listenDp(this.control, (v) => {
        if (!v || typeof v !== "object") return;
        const c = v as Record<string, unknown>;
        for (const cmd of ["undo", "redo", "clear", "save"] as const) {
          if (cmd in c && this.trigger(cmd).feed(c[cmd])) this[cmd]();
        }
      }));
    }
    if (this.inDataProvider) this.unsubs.push(listenDp(this.inDataProvider, (v) => void this.loadBase(v)));
  }

  private async loadBase(v: unknown): Promise<void> {
    const ref = typeof v === "string" ? ({ url: v } as SonicMediaRef) : (v as SonicMediaRef | null);
    const url = ref?.blobUrl ?? ref?.url;
    if (!url) return;
    if (!safeMediaUrl(url, "image")) { this.error = "origine d'image refusée"; this.publish(); return; }
    const token = ++this.loadToken;
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = url;
      await img.decode();
      if (token !== this.loadToken || !this.canvasEl) return;
      this.pushHistory();
      this.fillBackground();
      const ctx = this.ctx();
      if (!ctx) return;
      const { w, h } = this.dims();
      const k = Math.min(w / img.naturalWidth, h / img.naturalHeight);
      const dw = img.naturalWidth * k, dh = img.naturalHeight * k;
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      this.error = null;
      this.touch();
    } catch {
      this.error = "image illisible";
      this.publish();
    }
  }

  /* ------------------------------------------------------------ dessin */

  private fillBackground(): void {
    const ctx = this.ctx();
    if (!ctx) return;
    const { w, h } = this.dims();
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);
    if (this.background && this.background !== "transparent") {
      const b = sanitizeBrush({ ...BRUSH_DEFAULTS }, { color: this.background }).color;
      ctx.fillStyle = b;
      ctx.fillRect(0, 0, w, h);
    }
    this.touch();
  }

  private touch(): void {
    this.seq++;
    this.publish();
  }

  /** Empreinte (cercle à bord progressif) pré-dessinée, mise en cache par diamètre, dureté et couleur. */
  private dab(diameter: number, hardness: number, color: string): HTMLCanvasElement {
    const d = Math.max(2, Math.ceil(diameter));
    const key = `${d}|${hardness.toFixed(2)}|${color}`;
    const hit = this.dabs.get(key);
    if (hit) return hit;
    if (this.dabs.size > 64) this.dabs.clear();
    const c = document.createElement("canvas");
    c.width = c.height = d;
    const g = c.getContext("2d");
    if (g) {
      const r = d / 2;
      const grad = g.createRadialGradient(r, r, 0, r, r, r);
      grad.addColorStop(0, color);
      grad.addColorStop(Math.min(0.999, Math.max(0, hardness)), color);
      // Fin du dégradé : même teinte, alpha nul (évite le halo gris d'un fondu vers « transparent » noir).
      grad.addColorStop(1, withAlpha0(g, color));
      g.fillStyle = grad;
      g.fillRect(0, 0, d, d);
    }
    this.dabs.set(key, c);
    return c;
  }

  private stamp(pt: Pt, b: BrushSettings): void {
    const ctx = this.blendLayer ? this.blendLayer.getContext("2d") : this.ctx();
    if (!ctx) return;
    const pl = place(pt, b, this.draw);
    const erase = b.tool === "erase";
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.globalAlpha = b.opacity;
    const geo = b.tip ? tipGeometry(b.tip) : null;
    if (geo) {
      let path = this.tipPaths.get(b.tip);
      if (!path) {
        if (this.tipPaths.size > 16) this.tipPaths.clear();
        this.tipPaths.set(b.tip, (path = new Path2D(b.tip)));
      }
      ctx.fillStyle = erase ? "#000000" : b.color;
      drawTip(ctx, path, geo, pl.x, pl.y, pl.size, pl.rot, pl.squash);
    } else {
      const dab = this.dab(pl.size, b.hardness, erase ? "#000000" : b.color);
      ctx.save();
      ctx.translate(pl.x, pl.y);
      if (pl.rot) ctx.rotate(pl.rot);
      ctx.drawImage(dab, (-pl.size * pl.squash) / 2, -pl.size / 2, pl.size * pl.squash, pl.size);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * Trait en mode de fusion : les empreintes vont sur un calque à part (elles s'y superposent normalement),
   * puis la toile = image du début du trait + calque fusionné. Ainsi le trait ne se fusionne pas avec lui-même.
   */
  private beginBlend(b: BrushSettings): void {
    this.endBlend();
    if (b.tool === "erase" || b.blend === "normal" || !this.canvasEl) return;
    const { w, h } = this.dims();
    const mk = () => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const base = mk(), layer = mk();
    base.getContext("2d")?.drawImage(this.canvasEl, 0, 0);
    this.blendBase = base;
    this.blendLayer = layer;
    this.blendMode = blendOp(b.blend);
  }

  private composeBlend(): void {
    const ctx = this.ctx();
    if (!ctx || !this.blendBase || !this.blendLayer) return;
    const { w, h } = this.dims();
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(this.blendBase, 0, 0);
    ctx.globalCompositeOperation = this.blendMode;
    ctx.drawImage(this.blendLayer, 0, 0, w, h);
    ctx.restore();
  }

  private endBlend(): void {
    this.blendBase = null;
    this.blendLayer = null;
  }

  private toCanvas(e: PointerEvent): Pt {
    const r = this.canvasEl.getBoundingClientRect();
    const { w, h } = this.dims();
    const p = e.pointerType === "pen" ? (e.pressure > 0 ? e.pressure : 0.5) : 1;
    return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * w, y: ((e.clientY - r.top) / Math.max(1, r.height)) * h, p };
  }

  private pushHistory(): void {
    const ctx = this.ctx();
    if (!ctx || this.undoLevels <= 0) return;
    const { w, h } = this.dims();
    this.history.push(ctx.getImageData(0, 0, w, h), w * h);
  }

  private onDown = (e: PointerEvent): void => {
    if (this.readonly || this.pointer !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
    this.pointer = e.pointerId;
    try { this.canvasEl.setPointerCapture(e.pointerId); } catch { /* pointeur synthétique */ }
    e.preventDefault();
    this.pushHistory();
    this.drawing = true;
    this.stab.reset();
    this.walker.reset();
    this.draw = rng((Math.random() * 4294967296) >>> 0);
    const b = this.brush();
    this.beginBlend(b);
    const pt = this.stab.feed(this.toCanvas(e), b.smoothing);
    for (const s of this.walker.walk(pt, b)) this.stamp(s, b);
    this.composeBlend();
    this.touch();
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.drawing || e.pointerId !== this.pointer) return;
    const b = this.brush();
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) {
      const pt = this.stab.feed(this.toCanvas(ev), b.smoothing);
      for (const s of this.walker.walk(pt, b)) this.stamp(s, b);
    }
    this.composeBlend();
    this.touch();
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.drawing || (e.pointerId !== undefined && e.pointerId !== this.pointer)) return;
    const b = this.brush();
    // Le lissage laisse la pointe en retard : on la ramène sur le pointeur pour finir le trait.
    if (e.type === "pointerup" && b.smoothing > 0) {
      const target = this.toCanvas(e);
      for (let i = 0; i < 8; i++) {
        const pt = this.stab.feed(target, b.smoothing);
        for (const s of this.walker.walk(pt, b)) this.stamp(s, b);
      }
    }
    this.composeBlend();
    this.endBlend();
    try { this.canvasEl.releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
    this.pointer = null;
    this.drawing = false;
    this.strokes++;
    this.touch();
  };

  /* ------------------------------------------------------------ commandes */

  undo(): void {
    const ctx = this.ctx();
    if (!ctx) return;
    const { w, h } = this.dims();
    const prev = this.history.undo(ctx.getImageData(0, 0, w, h), w * h);
    if (prev) { ctx.putImageData(prev, 0, 0); this.strokes = Math.max(0, this.strokes - 1); this.touch(); }
  }

  redo(): void {
    const ctx = this.ctx();
    if (!ctx) return;
    const { w, h } = this.dims();
    const next = this.history.redo(ctx.getImageData(0, 0, w, h), w * h);
    if (next) { ctx.putImageData(next, 0, 0); this.strokes++; this.touch(); }
  }

  clear(): void {
    this.pushHistory();
    this.fillBackground();
  }

  /** Enregistre l'image courante en PNG (URL `blob:`) dans `last`. */
  save(): void {
    this.canvasEl?.toBlob((blob) => {
      if (!blob) return;
      if (this.last) URL.revokeObjectURL(this.last.url);
      const { w, h } = this.dims();
      this.last = { url: URL.createObjectURL(blob), mime: "image/png", width: w, height: h, size: blob.size };
      this.publish();
    }, "image/png");
  }

  getState(): PaintState {
    const { w, h } = this.dims();
    const b = this.brush();
    return { status: this.error ? "error" : "ready", error: this.error, width: w, height: h, strokes: this.strokes, drawing: this.drawing, canUndo: this.history.canUndo, canRedo: this.history.canRedo, tool: b.tool, color: b.color, size: b.size, last: this.last };
  }

  private publish(): void {
    const s = this.getState();
    if (this.outDataProvider) set(this.outDataProvider, s);
    this.dispatchEvent(new CustomEvent("paint-state", { detail: s, bubbles: true, composed: true }));
  }
}

/** La même couleur, alpha nul : `rgba(r,g,b,0)` (via le canvas, qui sait lire n'importe quelle couleur CSS). */
function withAlpha0(g: CanvasRenderingContext2D, color: string): string {
  g.fillStyle = "#000";
  g.fillStyle = color;
  const v = String(g.fillStyle);
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
  if (m) return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},0)`;
  const r = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
  return r ? `rgba(${r[1]},${r[2]},${r[3]},0)` : "rgba(0,0,0,0)";
}
