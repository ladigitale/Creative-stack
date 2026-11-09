import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import type { SonicFrameConsumerHost, SonicFrameSource } from "../../shared/mediaRef";
import { BRUSH_DEFAULTS, Stabilizer, sanitizeBrush, type BrushSettings } from "../paint/brush";
import { tipFromValue } from "../paint/tip";
import { exportSvg } from "./export";
import {
  Doc, MAX_POINTS_PER_STROKE, compactStroke, contentBBox, fitView, makeBrush, panBy, sanitizeView, strokeBBox, strokeHit, strokeMargin,
  toWorld, visibleRect, zoomAt, sanitizeBlend, DEFAULT_VIEW, type BlendMode, type Stroke, type View,
} from "./model";
import { blitBlend, drawStamp, drawStrokes, scratchFor, type Surface } from "./render";
import { StrokeStamper } from "./stamps";

const MAX_SIDE = 4096;

export type SketchState = {
  status: "ready" | "error";
  error: string | null;
  zoom: number;
  x: number;
  y: number;
  strokes: number;
  /** Points de tous les traits (après simplification), et ceux du dernier trait avant / après. */
  points: number;
  lastStroke: { before: number; after: number };
  drawing: boolean;
  canUndo: boolean;
  canRedo: boolean;
  tool: string;
  color: string;
  size: number;
  blend: BlendMode;
  bbox: { x: number; y: number; w: number; h: number } | null;
  /** Dernier export (`control.save` / `savePng`) : à brancher sur `sonic-media-download source="…last"`. */
  last: { url: string; mime: string; width: number; height: number; size: number } | null;
};

/**
 * Toile de dessin vectoriel à zoom infini. Les traits sont gardés en coordonnées du monde (points, pression,
 * pinceau, graine) et redessinés nets à chaque zoom ; export SVG.
 *
 * Navigation : molette = zoom sous le curseur (Ctrl + molette / pincement tactile aussi), glisser avec
 * Espace, bouton du milieu ou `tool="hand"` = déplacer, deux doigts = zoom et déplacement. Pinceau : tout
 * ce que sait faire `sonic-paint` (pointes personnalisées par `tip` / `tip-from`, angle, dispersion…).
 * `tool="erase"` efface les traits touchés. Commandes par `control` (compteurs) : `undo`, `redo`, `clear`,
 * `save` (SVG), `savePng`, `fit`, `reset`, `zoomIn`, `zoomOut`. Vue pilotée par `view-from` ({x, y, zoom}).
 */
@customElement("sonic-sketch")
export class SonicSketch extends LitElement implements SonicFrameSource, SonicFrameConsumerHost {
  static styles = css`
    :host { display: block; position: relative; line-height: 0; touch-action: none; }
    :host([hidden-preview]) { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; overflow: hidden; }
    canvas { display: block; width: 100%; height: auto; touch-action: none; outline: none; }
  `;

  @property({ type: Number }) width = 800;
  @property({ type: Number }) height = 600;
  @property({ type: String }) background = "#ffffff";
  @property({ type: String }) color = BRUSH_DEFAULTS.color;
  /** Diamètre du pinceau : en pixels d'écran (`size-space="screen"`, défaut) ou en unités du monde. */
  @property({ type: Number }) size = BRUSH_DEFAULTS.size;
  @property({ type: String, attribute: "size-space" }) sizeSpace: "screen" | "world" = "screen";
  @property({ type: Number }) hardness = 1;
  @property({ type: Number }) opacity = BRUSH_DEFAULTS.opacity;
  @property({ type: Number }) spacing = BRUSH_DEFAULTS.spacing;
  @property({ type: Number }) smoothing = 0.3;
  /** `paint`, `erase` (efface les traits touchés) ou `hand` (déplacer la vue). */
  @property({ type: String }) tool = "paint";
  @property({ type: Boolean }) pressure = true;
  @property({ type: String }) tip = "";
  @property({ type: Number }) angle = 0;
  @property({ type: Boolean, attribute: "angle-follow" }) angleFollow = false;
  @property({ type: Number, attribute: "angle-jitter" }) angleJitter = 0;
  @property({ type: Number, attribute: "size-jitter" }) sizeJitter = 0;
  @property({ type: Number }) scatter = 0;
  @property({ type: Number }) roundness = 1;
  /** Mode de fusion des nouveaux traits (`normal`, `multiply`, `screen`, `overlay`… noms CSS `mix-blend-mode`). */
  @property({ type: String }) blend: string = "normal";
  @property({ type: String, attribute: "tip-from" }) tipFrom = "";
  @property({ type: String, attribute: "brush-from" }) brushFrom = "";
  /** DP de la vue `{ x, y, zoom }` (écrit la vue quand elle diffère de l'actuelle). */
  @property({ type: String, attribute: "view-from" }) viewFrom = "";
  @property({ type: String }) control = "";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";
  @property({ type: Boolean }) readonly = false;
  /**
   * Tolérance de simplification des traits terminés, en pixels d'écran au moment du tracé (0 : aucune).
   * Les points à moins de cette distance de la courbe simplifiée sont retirés (pression comprise).
   */
  @property({ type: Number }) simplify = 0.35;
  @property({ type: Boolean, attribute: "hidden-preview" }) hiddenPreview = false;

  @query("canvas") private canvasEl!: HTMLCanvasElement;

  private doc = new Doc();
  private view: View = { ...DEFAULT_VIEW };
  /** Vue pour laquelle `layer` est dessinée. */
  private layerView: View = { ...DEFAULT_VIEW };
  private layer: HTMLCanvasElement | null = null;
  private layerDirty = true;
  private raf = 0;
  private settle = 0;
  private seq = 0;
  private consumers = new Set<object>();
  private live: Record<string, unknown> = {};
  private stab = new Stabilizer();
  private pointers = new Map<number, { x: number; y: number }>();
  private pointer: number | null = null;
  private gesture: { d: number; cx: number; cy: number } | null = null;
  private mode: "none" | "draw" | "erase" | "pan" = "none";
  private stroke: Stroke | null = null;
  private stamper: StrokeStamper | null = null;
  /** Empreintes du trait en cours quand il a un mode de fusion (fusionnées à l'affichage). */
  private liveBuf: Surface | null = null;
  private readonly liveKey = {};
  private erased = new Set<number>();
  private panLast = { x: 0, y: 0 };
  private space = false;
  private hover = false;
  private triggers = new Map<string, CounterTrigger>();
  private unsubs: (() => void)[] = [];
  private last: SketchState["last"] = null;
  private error: string | null = null;
  private lastCompaction = { before: 0, after: 0 };

  get frameSeq(): number { return this.seq; }
  getFrameCanvas(): HTMLCanvasElement | null { return this.canvasEl ?? null; }
  registerFrameConsumer(token: object = {}): void { this.consumers.add(token); }
  unregisterFrameConsumer(token: object = {}): void { this.consumers.delete(token); }

  /** Réglages effectifs : attributs puis réglages en direct. */
  brush(): BrushSettings {
    const base = sanitizeBrush({ ...BRUSH_DEFAULTS }, { size: this.size, hardness: this.hardness, opacity: this.opacity, spacing: this.spacing, smoothing: this.smoothing, color: this.color, pressure: this.pressure, tip: this.tip, angle: this.angle, angleFollow: this.angleFollow, angleJitter: this.angleJitter, sizeJitter: this.sizeJitter, scatter: this.scatter, roundness: this.roundness });
    return sanitizeBrush(base, this.live);
  }

  /** Mode de fusion effectif : réglage en direct, sinon attribut. */
  currentBlend(): BlendMode {
    return sanitizeBlend(this.live.blend, sanitizeBlend(this.blend));
  }

  private currentTool(): string {
    const t = typeof this.live.tool === "string" ? (this.live.tool as string) : this.tool;
    return t === "erase" || t === "hand" ? t : "paint";
  }

  private dims(): { w: number; h: number; dpr: number } {
    const w = Math.round(Math.max(16, Math.min(MAX_SIDE, Number(this.width) || 800)));
    const h = Math.round(Math.max(16, Math.min(MAX_SIDE, Number(this.height) || 600)));
    const dpr = Math.max(1, Math.min(2, (typeof devicePixelRatio === "number" && devicePixelRatio) || 1));
    return { w, h, dpr };
  }

  render() {
    const { w, h, dpr } = this.dims();
    return html`<canvas width=${Math.round(w * dpr)} height=${Math.round(h * dpr)} part="canvas" tabindex="0"
      @pointerdown=${this.onDown} @pointermove=${this.onMove} @pointerup=${this.onUp} @pointercancel=${this.onUp}
      @lostpointercapture=${this.onUp} @pointerenter=${() => (this.hover = true)} @pointerleave=${() => (this.hover = false)}
      @keydown=${this.onKey} @contextmenu=${(e: Event) => e.preventDefault()}></canvas>`;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    window.addEventListener("keydown", this.onSpace);
    window.addEventListener("keyup", this.onSpace);
  }

  disconnectedCallback(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    window.removeEventListener("keydown", this.onSpace);
    window.removeEventListener("keyup", this.onSpace);
    cancelAnimationFrame(this.raf);
    clearTimeout(this.settle);
    if (this.last) URL.revokeObjectURL(this.last.url);
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    this.canvasEl.addEventListener("wheel", this.onWheel, { passive: false });
    this.layerDirty = true;
    this.compose();
    this.publish();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("control") || c.has("brushFrom") || c.has("tipFrom") || c.has("viewFrom")) this.listen();
    if (c.has("width") || c.has("height")) { this.layer = null; this.layerDirty = true; this.compose(); }
    if (c.has("background")) this.compose();
    if (c.has("tool") || c.has("color") || c.has("size")) this.publish();
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
    if (this.viewFrom) {
      this.unsubs.push(listenDp(this.viewFrom, (v) => {
        const next = sanitizeView(v, this.view);
        if (next.x === this.view.x && next.y === this.view.y && next.zoom === this.view.zoom) return;
        this.setView(next);
      }));
    }
    if (this.control) {
      this.unsubs.push(listenDp(this.control, (v) => {
        if (!v || typeof v !== "object") return;
        const c = v as Record<string, unknown>;
        for (const cmd of ["undo", "redo", "clear", "save", "savePng", "fit", "reset", "zoomIn", "zoomOut"] as const) {
          if (cmd in c && this.trigger(cmd).feed(c[cmd])) this[cmd]();
        }
      }));
    }
  }

  /* ------------------------------------------------------------ rendu */

  private ensureLayer(): HTMLCanvasElement {
    const { w, h, dpr } = this.dims();
    if (!this.layer || this.layer.width !== Math.round(w * dpr) || this.layer.height !== Math.round(h * dpr)) {
      this.layer = document.createElement("canvas");
      this.layer.width = Math.round(w * dpr);
      this.layer.height = Math.round(h * dpr);
      this.layerDirty = true;
    }
    return this.layer;
  }

  private layerSurface(): Surface | null {
    const layer = this.ensureLayer();
    const ctx = layer.getContext("2d");
    if (!ctx) return null;
    const { w, h, dpr } = this.dims();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h, view: this.layerView };
  }

  /** Redessine entièrement la couche pour la vue courante. */
  private renderLayer(): void {
    this.layerView = { ...this.view };
    const s = this.layerSurface();
    if (!s) return;
    s.ctx.clearRect(0, 0, s.w, s.h);
    // Le fond est aussi dans la couche : les modes de fusion le voient sous les traits.
    const bg = this.backgroundColor();
    if (bg) { s.ctx.fillStyle = bg; s.ctx.fillRect(0, 0, s.w, s.h); }
    drawStrokes(s, this.doc.strokes, visibleRect(this.layerView, s.w, s.h));
    this.layerDirty = false;
  }

  /** Fond + couche (transformée vers la vue courante pendant un geste) sur la toile visible. */
  private compose(): void {
    const canvas = this.canvasEl;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { w, h, dpr } = this.dims();
    if (this.layerDirty && !this.gestureActive()) this.renderLayer();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const bg = this.backgroundColor();
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
    }
    const layer = this.ensureLayer();
    const lv = this.layerView, v = this.view;
    const k = v.zoom / lv.zoom;
    const tx = w / 2 - (w / 2) * k + (lv.x - v.x) * v.zoom;
    const ty = h / 2 - (h / 2) * k + (lv.y - v.y) * v.zoom;
    ctx.drawImage(layer, tx, ty, w * k, h * k);
    // Trait en cours avec fusion : la vue n'a pas bougé depuis son début (sinon il est abandonné).
    if (this.liveBuf && this.stroke) blitBlend({ ctx, w, h, view: v }, this.liveBuf.ctx.canvas, this.stroke.brush.blend);
    this.seq++;
  }

  private backgroundColor(): string {
    if (!this.background || this.background === "transparent") return "";
    return sanitizeBrush({ ...BRUSH_DEFAULTS }, { color: this.background }).color;
  }

  private gestureActive(): boolean {
    return this.mode === "pan" || this.gesture !== null;
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.compose(); });
  }

  /** Après un geste de vue : redessine nettement une fois la vue stable. */
  private settleLater(): void {
    clearTimeout(this.settle);
    this.settle = window.setTimeout(() => {
      if (this.gestureActive()) return this.settleLater();
      this.layerDirty = true;
      this.compose();
      this.publish();
    }, 90);
  }

  private setView(v: View, immediate = false): void {
    this.view = v;
    if (immediate) { this.layerDirty = true; this.compose(); } else { this.schedule(); this.settleLater(); }
    this.publish();
  }

  private invalidate(): void {
    this.layerDirty = true;
    this.compose();
    this.publish();
  }

  /* ------------------------------------------------------------ entrées */

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvasEl.getBoundingClientRect();
    const { w, h } = this.dims();
    return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * w, y: ((e.clientY - r.top) / Math.max(1, r.height)) * h };
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const { w, h } = this.dims();
    const p = this.local(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    const k = e.ctrlKey ? 0.01 : 0.0018;
    const factor = Math.exp(-Math.max(-300, Math.min(300, e.deltaY * unit)) * k);
    this.setView(zoomAt(this.view, factor, p.x, p.y, w, h));
  };

  private onSpace = (e: KeyboardEvent): void => {
    if (e.code !== "Space") return;
    if (e.type === "keydown" && !this.hover && this.shadowRoot?.activeElement !== this.canvasEl) return;
    if (e.type === "keydown") e.preventDefault();
    this.space = e.type === "keydown";
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "+" || e.key === "=") this.zoomIn();
    else if (e.key === "-") this.zoomOut();
    else if (e.key === "0") this.fit();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
    else return;
    e.preventDefault();
  };

  private pinchState(): { d: number; cx: number; cy: number } {
    const [a, b] = [...this.pointers.values()];
    return { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }

  private onDown = (e: PointerEvent): void => {
    if (this.readonly) return;
    this.canvasEl.focus({ preventScroll: true });
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    try { this.canvasEl.setPointerCapture(e.pointerId); } catch { /* pointeur synthétique */ }
    e.preventDefault();
    if (this.pointers.size === 2) {
      this.cancelStroke();
      this.mode = "none";
      this.pointer = null;
      this.gesture = this.pinchState();
      return;
    }
    if (this.pointers.size > 2 || this.pointer !== null) return;
    this.pointer = e.pointerId;
    const tool = this.currentTool();
    if (e.button === 1 || this.space || tool === "hand") {
      this.mode = "pan";
      this.panLast = p;
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0) { this.pointer = null; return; }
    if (tool === "erase") {
      this.mode = "erase";
      this.erased = new Set();
      this.eraseAt(p);
      return;
    }
    this.startStroke(p, e);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    const { w, h } = this.dims();
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.gesture && this.pointers.size >= 2) {
      const g = this.pinchState();
      let v = panBy(this.view, g.cx - this.gesture.cx, g.cy - this.gesture.cy);
      v = zoomAt(v, g.d / this.gesture.d, g.cx, g.cy, w, h);
      this.gesture = g;
      this.setView(v);
      return;
    }
    if (e.pointerId !== this.pointer) return;
    if (this.mode === "pan") {
      this.setView(panBy(this.view, p.x - this.panLast.x, p.y - this.panLast.y));
      this.panLast = p;
    } else if (this.mode === "erase") {
      this.eraseAt(p);
    } else if (this.mode === "draw") {
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
      for (const ev of events.length ? events : [e]) this.extendStroke(this.local(ev), ev);
      this.compose();
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    const wasGesture = this.gesture !== null;
    this.pointers.delete(e.pointerId);
    try { this.canvasEl.releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
    if (wasGesture) {
      if (this.pointers.size < 2) this.gesture = null;
      this.settleLater();
      return;
    }
    if (e.pointerId !== this.pointer) return;
    if (this.mode === "draw") this.endStroke(e);
    else if (this.mode === "erase") this.endErase();
    else if (this.mode === "pan") this.settleLater();
    this.pointer = null;
    this.mode = "none";
    this.publish();
  };

  /* ------------------------------------------------------------ traits */

  /** Diamètre du pinceau en unités du monde. */
  private worldSize(b: BrushSettings): number {
    return this.sizeSpace === "world" ? b.size : b.size / this.view.zoom;
  }

  private pressureOf(e: PointerEvent): number {
    return e.pointerType === "pen" ? (e.pressure > 0 ? e.pressure : 0.5) : 1;
  }

  private startStroke(p: { x: number; y: number }, e: PointerEvent): void {
    const lv = this.layerView, v = this.view;
    if (this.layerDirty || lv.x !== v.x || lv.y !== v.y || lv.zoom !== v.zoom) this.renderLayer();
    const b = this.brush();
    const brush = makeBrush(b, this.worldSize(b), this.currentBlend());
    const seed = (Math.random() * 4294967296) >>> 0;
    this.stroke = { id: this.doc.nextId++, brush, pts: [], seed, bbox: { x: 0, y: 0, w: 0, h: 0 } };
    this.stamper = new StrokeStamper(brush, seed);
    this.liveBuf = null;
    if (brush.blend) {
      const s = this.layerSurface();
      this.liveBuf = s ? scratchFor(s, this.liveKey) : null;
    }
    this.stab.reset();
    this.mode = "draw";
    this.extendStroke(p, e);
    this.compose();
    this.publish();
  }

  private extendStroke(p: { x: number; y: number }, e: PointerEvent): void {
    const st = this.stroke, stamper = this.stamper;
    if (!st || !stamper) return;
    if (st.pts.length >= MAX_POINTS_PER_STROKE * 3) return;
    const b = this.brush();
    const s = this.stab.feed({ x: p.x, y: p.y, p: this.pressureOf(e) }, b.smoothing);
    this.addPoint(s.x, s.y, s.p);
  }

  private addPoint(sx: number, sy: number, pr: number): void {
    const st = this.stroke, stamper = this.stamper;
    if (!st || !stamper) return;
    const { w, h } = this.dims();
    const [x, y] = toWorld(this.view, sx, sy, w, h);
    const n = st.pts.length;
    if (n >= 3 && st.pts[n - 3] === x && st.pts[n - 2] === y) return;
    st.pts.push(x, y, pr);
    const surface = this.liveBuf ?? this.layerSurface();
    if (!surface) return;
    surface.view = this.layerView;
    for (const stamp of stamper.feed(x, y, pr)) drawStamp(surface, st.brush, stamp);
  }

  private endStroke(e: PointerEvent): void {
    const st = this.stroke;
    if (st && e.type === "pointerup") {
      const b = this.brush();
      if (b.smoothing > 0) {
        const target = this.local(e);
        for (let i = 0; i < 8; i++) {
          const s = this.stab.feed({ x: target.x, y: target.y, p: this.pressureOf(e) }, b.smoothing);
          this.addPoint(s.x, s.y, s.p);
        }
      }
    }
    const live = this.liveBuf;
    this.stroke = null;
    this.stamper = null;
    this.liveBuf = null;
    if (!st || !st.pts.length) return;
    const raw = st.pts.length / 3;
    const tol = Math.max(0, Math.min(8, Number(this.simplify) || 0));
    if (tol > 0) st.pts = compactStroke(st.pts, tol / this.layerView.zoom, st.brush.pressure ? 0.04 : Infinity);
    this.lastCompaction = { before: raw, after: st.pts.length / 3 };
    st.bbox = strokeBBox(st.pts, strokeMargin(st.brush));
    if (!this.doc.add(st)) {
      this.error = "limite de traits ou de points atteinte";
      this.invalidate();
      return;
    }
    this.error = null;
    // Trait fusionné : ses empreintes, réunies dans le tampon, sont posées sur la couche avec leur mode.
    if (live) { const s = this.layerSurface(); if (s) blitBlend(s, live.ctx.canvas, st.brush.blend); }
    this.compose();
  }

  /** Abandonne le trait en cours (un second doigt arrive : c'est un geste de vue). */
  private cancelStroke(): void {
    if (!this.stroke) { if (this.mode === "erase") this.endErase(); return; }
    this.stroke = null;
    this.stamper = null;
    this.liveBuf = null;
    this.layerDirty = true;
  }

  private eraseAt(p: { x: number; y: number }): void {
    const { w, h } = this.dims();
    const b = this.brush();
    const [x, y] = toWorld(this.view, p.x, p.y, w, h);
    const r = this.worldSize(b) / 2;
    let hit = false;
    for (const s of this.doc.strokes) {
      if (!this.erased.has(s.id) && strokeHit(s, x, y, r)) { this.erased.add(s.id); hit = true; }
    }
    if (hit) {
      // Aperçu immédiat : la couche est redessinée sans les traits touchés.
      this.layerView = { ...this.view };
      const s = this.layerSurface();
      if (s) {
        s.ctx.clearRect(0, 0, s.w, s.h);
        drawStrokes(s, this.doc.strokes.filter((st) => !this.erased.has(st.id)), visibleRect(this.view, s.w, s.h));
        this.layerDirty = false;
      }
      this.compose();
    }
  }

  private endErase(): void {
    if (this.erased.size) this.doc.remove(this.erased);
    this.erased = new Set();
    this.invalidate();
  }

  /* ------------------------------------------------------------ commandes */

  undo(): void { if (this.doc.undo()) this.invalidate(); }
  redo(): void { if (this.doc.redo()) this.invalidate(); }
  clear(): void { this.doc.clear(); this.invalidate(); }

  fit(): void {
    const { w, h } = this.dims();
    this.setView(fitView(contentBBox(this.doc.strokes), w, h), true);
  }

  reset(): void { this.setView({ ...DEFAULT_VIEW }, true); }

  zoomIn(): void { const { w, h } = this.dims(); this.setView(zoomAt(this.view, 1.6, w / 2, h / 2, w, h), true); }
  zoomOut(): void { const { w, h } = this.dims(); this.setView(zoomAt(this.view, 1 / 1.6, w / 2, h / 2, w, h), true); }

  /** Document SVG du dessin (tout le contenu), ou `null` en cas d'erreur (`error` renseignée). */
  toSvg(): string | null {
    try {
      const svg = exportSvg(this.doc.strokes, { background: this.background });
      this.error = null;
      return svg;
    } catch (err) {
      this.error = err instanceof Error ? err.message : "export impossible";
      this.publish();
      return null;
    }
  }

  private setLast(blob: Blob, width: number, height: number): void {
    if (this.last) URL.revokeObjectURL(this.last.url);
    this.last = { url: URL.createObjectURL(blob), mime: blob.type, width, height, size: blob.size };
    this.publish();
  }

  /** Enregistre le dessin en SVG (URL `blob:`) dans `last`. */
  save(): void {
    const svg = this.toSvg();
    if (svg === null) return;
    const b = contentBBox(this.doc.strokes);
    this.setLast(new Blob([svg], { type: "image/svg+xml" }), Math.round(b?.w ?? 0), Math.round(b?.h ?? 0));
  }

  /** Enregistre la vue courante en PNG dans `last`. */
  savePng(): void {
    this.canvasEl?.toBlob((blob) => { if (blob) this.setLast(blob, this.canvasEl.width, this.canvasEl.height); }, "image/png");
  }

  getState(): SketchState {
    const b = this.brush();
    return {
      status: this.error ? "error" : "ready", error: this.error, zoom: this.view.zoom, x: this.view.x, y: this.view.y,
      strokes: this.doc.strokes.length, points: this.doc.totalPoints, lastStroke: { ...this.lastCompaction }, drawing: this.mode === "draw", canUndo: this.doc.canUndo, canRedo: this.doc.canRedo,
      tool: this.currentTool(), color: b.color, size: b.size, blend: this.currentBlend(), bbox: contentBBox(this.doc.strokes), last: this.last,
    };
  }

  private publish(): void {
    const s = this.getState();
    if (this.outDataProvider) set(this.outDataProvider, s);
    this.dispatchEvent(new CustomEvent("sketch-state", { detail: s, bubbles: true, composed: true }));
  }
}
