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
  Doc, MAX_POINTS_PER_STROKE, MAX_ZOOM, MIN_ZOOM, compactStroke, contentBBox, fitView, makeBrush, sanitizeView, strokeBBox, strokeHit, strokeMargin,
  toWorld, visibleRect, sanitizeBlend, DEFAULT_VIEW, type BlendMode, type Stroke, type View,
} from "./model";
import { blitBlend, drawStamp, drawStrokes, scratchFor, type Surface } from "./render";
import { StrokeStamper } from "./stamps";
import { ROTATE_STEP, ViewGestures, invert, multiply, viewMatrix } from "../../shared/view2d";
import { isSolid, shapeHit, solidRadius, strokeOutline } from "./merge";
import { MAX_FLAT_VERTICES, eraseFlat, flatBBox, flatVertices, paintFlat, type Backdrop } from "./flat";
import { parseColor, toCss, type Rgba } from "./flat-color";
import { multiBBox } from "../vector";

const MAX_SIDE = 4096;

export type SketchState = {
  status: "ready" | "error";
  error: string | null;
  zoom: number;
  x: number;
  y: number;
  /** Rotation de la vue (radians). */
  rotation: number;
  strokes: number;
  /** Points de tous les traits (après simplification), et ceux du dernier trait avant / après. */
  points: number;
  lastStroke: { before: number; after: number };
  /** Régions d'aplat (une par couleur et par carte), couleurs distinctes, cartes, masques de gomme, aplatissements. */
  regions: number;
  colors: number;
  flats: number;
  masks: number;
  flattened: number;
  drawing: boolean;
  canUndo: boolean;
  canRedo: boolean;
  tool: string;
  color: string;
  size: number;
  blend: BlendMode;
  /** Dernière couleur prélevée à la pipette (`tool="pick"` ou Alt + clic), même absente de la palette. */
  picked: string | null;
  bbox: { x: number; y: number; w: number; h: number } | null;
  /** Dernier export (`control.save` / `savePng`) : à brancher sur `sonic-media-download source="…last"`. */
  last: { url: string; mime: string; width: number; height: number; size: number } | null;
};

/**
 * Toile de dessin vectoriel à zoom infini. Les traits sont gardés en coordonnées du monde (points, pression,
 * pinceau, graine) et redessinés nets à chaque zoom ; export SVG.
 *
 * Navigation (la même que `sonic-paint navigable`) : molette = zoom sous le curseur (Ctrl + molette /
 * pincement du pavé aussi), glisser avec Espace, bouton du milieu ou `tool="hand"` = déplacer, deux doigts =
 * déplacer, zoomer et tourner ; clavier + − 0, R / Maj+R (tourner de 15°). Pinceau : tout
 * ce que sait faire `sonic-paint` (pointes personnalisées par `tip` / `tip-from`, angle, dispersion…).
 * `tool="pick"` (ou Alt + clic) est une pipette : la couleur vue sous le point, même née d'une fusion, devient
 * celle du pinceau (écrite aussi dans `brush-from`). `tool="erase"` est une vraie gomme (trou exact dans les aplats, masque sur les traits non aplatis). Commandes par `control` (compteurs) : `undo`, `redo`, `clear`,
 * `save` (SVG), `savePng`, `fit`, `reset`, `zoomIn`, `zoomOut`, `rotateLeft`, `rotateRight`, `straighten`.
 * Vue pilotée par `view-from` ({x, y, zoom, rotation}).
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
  /** `paint`, `erase` (vraie gomme), `pick` (pipette) ou `hand` (déplacer la vue). */
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
  /** DP de la vue `{ x, y, zoom, rotation }` (écrit la vue quand elle diffère de l'actuelle). */
  @property({ type: String, attribute: "view-from" }) viewFrom = "";
  @property({ type: String }) control = "";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";
  @property({ type: Boolean }) readonly = false;
  /**
   * Tolérance de simplification des traits terminés, en pixels d'écran au moment du tracé (0 : aucune).
   * Les points à moins de cette distance de la courbe simplifiée sont retirés (pression comprise).
   */
  @property({ type: Number }) simplify = 0.35;
  /**
   * Aplatissement à chaque fin de geste : un trait plein (net, sans pointe ni variation ; opacité et mode de
   * fusion permis) est découpé dans la carte d'aplats du dessus. Sous le trait, chaque région prend la vraie
   * couleur calculée ; ce qui est entièrement recouvert disparaît ; les régions de même couleur sont unies.
   * Les autres traits (doux, pointes) restent en empreintes. `flatten="false"` garde chaque trait tel quel.
   */
  @property({ type: Boolean }) flatten = true;
  /** Ancien nom de `flatten` (faux : pas d'aplatissement). */
  @property({ type: Boolean }) merge = true;
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
  private pointer: number | null = null;
  private nav = new ViewGestures({
    view: () => this.view,
    setView: (v, settled) => this.setView(v, settled),
    size: () => this.dims(),
    zoomRange: () => [MIN_ZOOM, MAX_ZOOM],
    fit: () => this.fit(),
  });
  private mode: "none" | "draw" | "erase" | "pan" | "pick" = "none";
  /** Dernière couleur prélevée à la pipette (#rrggbb). */
  private picked: string | null = null;
  private stroke: Stroke | null = null;
  private stamper: StrokeStamper | null = null;
  /** Empreintes du trait en cours quand il a un mode de fusion (fusionnées à l'affichage). */
  private liveBuf: Surface | null = null;
  private readonly liveKey = {};
  private erased = new Set<number>();
  private space = false;
  private hover = false;
  private triggers = new Map<string, CounterTrigger>();
  private unsubs: (() => void)[] = [];
  private last: SketchState["last"] = null;
  private error: string | null = null;
  private lastCompaction = { before: 0, after: 0 };
  private flattened = 0;
  /** Le trait en cours est une gomme (aperçu en trou, appliquée au lever). */
  private erasing = false;
  private eraseBuf: HTMLCanvasElement | null = null;

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
    return t === "erase" || t === "hand" || t === "pick" ? t : "paint";
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
        if (next.x === this.view.x && next.y === this.view.y && next.zoom === this.view.zoom && next.rotation === this.view.rotation) return;
        this.setView(next);
      }));
    }
    if (this.control) {
      this.unsubs.push(listenDp(this.control, (v) => {
        if (!v || typeof v !== "object") return;
        const c = v as Record<string, unknown>;
        for (const cmd of ["undo", "redo", "clear", "save", "savePng", "fit", "reset", "zoomIn", "zoomOut", "rotateLeft", "rotateRight", "straighten"] as const) {
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
    let layer: HTMLCanvasElement = this.ensureLayer();
    // Gomme en cours : la couche est montrée trouée par le tracé de la gomme.
    if (this.erasing && this.liveBuf) layer = this.holed(layer, this.liveBuf.ctx.canvas);
    // Couche dessinée pour layerView, montrée dans la vue courante (déplacée, zoomée, tournée) le temps du geste.
    const t = multiply(viewMatrix(this.view, w, h), invert(viewMatrix(this.layerView, w, h)));
    ctx.transform(t[0], t[1], t[2], t[3], t[4], t[5]);
    ctx.drawImage(layer, 0, 0, w, h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Trait en cours avec fusion : la vue n'a pas bougé depuis son début (sinon il est abandonné).
    if (this.liveBuf && this.stroke && !this.erasing) blitBlend({ ctx, w, h, view: this.view }, this.liveBuf.ctx.canvas, this.stroke.brush.blend);
    this.seq++;
  }

  private backgroundColor(): string {
    if (!this.background || this.background === "transparent") return "";
    return sanitizeBrush({ ...BRUSH_DEFAULTS }, { color: this.background }).color;
  }

  private gestureActive(): boolean {
    return this.mode === "pan" || this.nav.active;
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
    this.nav.wheel(e, this.local(e));
  };

  private onSpace = (e: KeyboardEvent): void => {
    if (e.code !== "Space") return;
    if (e.type === "keydown" && !this.hover && this.shadowRoot?.activeElement !== this.canvasEl) return;
    if (e.type === "keydown") e.preventDefault();
    this.space = e.type === "keydown";
  };

  private onKey = (e: KeyboardEvent): void => {
    if (this.nav.key(e)) { /* vue */ }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
    else return;
    e.preventDefault();
  };

  private onDown = (e: PointerEvent): void => {
    if (this.readonly) return;
    this.canvasEl.focus({ preventScroll: true });
    const p = this.local(e);
    try { this.canvasEl.setPointerCapture(e.pointerId); } catch { /* pointeur synthétique */ }
    e.preventDefault();
    const tool = this.currentTool();
    const pan = e.button === 1 || this.space || tool === "hand";
    const r = this.nav.down(e.pointerId, p, this.pointer === null && pan);
    if (r === "pinch") {
      // Un second doigt : c'est un geste de vue, le trait commencé est abandonné.
      this.cancelStroke();
      this.mode = "none";
      this.pointer = null;
      return;
    }
    if (this.pointer !== null || this.nav.count > 1) return;
    if (r === "pan") {
      this.mode = "pan";
      this.pointer = e.pointerId;
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0) { this.nav.up(e.pointerId); return; }
    this.pointer = e.pointerId;
    if (tool === "pick" || (e.altKey && tool === "paint")) {
      this.mode = "pick";
      this.pick(p, false);
      return;
    }
    this.startStroke(p, e, tool === "erase");
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.local(e);
    if (this.nav.move(e.pointerId, p)) return;
    if (e.pointerId !== this.pointer) return;
    if (this.mode === "pick") { this.pick(p, false); return; }
    if (this.mode === "draw") {
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
      for (const ev of events.length ? events : [e]) this.extendStroke(this.local(ev), ev);
      this.compose();
    }
  };

  private onUp = (e: PointerEvent): void => {
    this.nav.up(e.pointerId);
    try { this.canvasEl.releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
    if (e.pointerId !== this.pointer) return;
    if (this.mode === "draw") this.endStroke(e);
    else if (this.mode === "pick") this.pick(this.local(e), e.type === "pointerup");
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

  private startStroke(p: { x: number; y: number }, e: PointerEvent, erase = false): void {
    const lv = this.layerView, v = this.view;
    if (this.layerDirty || lv.x !== v.x || lv.y !== v.y || lv.zoom !== v.zoom || lv.rotation !== v.rotation) this.renderLayer();
    this.erasing = erase;
    // Gomme : disque net de la taille du pinceau, tracé dans un tampon qui troue l'aperçu.
    const b = erase
      ? { ...this.brush(), hardness: 1, opacity: 1, tip: "", scatter: 0, sizeJitter: 0, roundness: 1, angleJitter: 0, color: "#000000" }
      : this.brush();
    const brush = makeBrush(b, this.worldSize(b), erase ? "normal" : this.currentBlend());
    const seed = (Math.random() * 4294967296) >>> 0;
    this.stroke = { id: this.doc.nextId++, brush, pts: [], seed, bbox: { x: 0, y: 0, w: 0, h: 0 } };
    this.stamper = new StrokeStamper(brush, seed);
    this.liveBuf = null;
    if (brush.blend || erase) {
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
    const erasing = this.erasing;
    this.stroke = null;
    this.stamper = null;
    this.liveBuf = null;
    this.erasing = false;
    if (!st || !st.pts.length) return;
    if (erasing) return this.endErase(st);
    const raw = st.pts.length / 3;
    const tol = Math.max(0, Math.min(8, Number(this.simplify) || 0));
    if (tol > 0) st.pts = compactStroke(st.pts, tol / this.layerView.zoom, st.brush.pressure ? 0.04 : Infinity);
    this.lastCompaction = { before: raw, after: st.pts.length / 3 };
    st.bbox = strokeBBox(st.pts, strokeMargin(st.brush));
    if (this.flatten && this.merge && this.flattenStroke(st, tol)) {
      this.error = null;
      this.invalidate();
      return;
    }
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

  /** Couleur CSS → Rgba (formes non reconnues : passage par le canvas, qui normalise les noms de couleurs). */
  private rgbaOf(css: string): Rgba | null {
    const direct = parseColor(css);
    if (direct) return direct;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#000000";
    ctx.fillStyle = css;
    return parseColor(String(ctx.fillStyle));
  }

  /** Ce qu'il y a sous une carte au rang `index` : le fond s'il n'y a rien dessous, sinon inconnu. */
  private backdropAt(index: number): Backdrop {
    if (index > 0) return { known: false };
    const bg = this.backgroundColor();
    return { known: true, color: bg ? this.rgbaOf(bg) : null };
  }

  /** Tolérance des contours (monde) pour un trait de rayon r tracé au zoom courant. */
  private outlineTol(tolPx: number, r: number): number {
    return Math.min(Math.max(tolPx, 0.25) / this.layerView.zoom, 0.08 * r);
  }

  /**
   * Aplatit un trait plein terminé dans la carte du dessus (créée au besoin), en une étape d'annulation.
   * Faux si le trait ne s'aplatit pas (pas plein, couleur illisible, découpage impossible, carte trop lourde).
   */
  private flattenStroke(st: Stroke, tolPx: number): boolean {
    if (!isSolid(st.brush, st.pts)) return false;
    const src = this.rgbaOf(st.brush.color);
    const r = solidRadius(st.brush, st.pts);
    if (!src || !(r > 0)) return false;
    const strokes = this.doc.strokes;
    try {
      const outline = strokeOutline(st.pts, r, this.outlineTol(tolPx, r));
      if (!outline.length) return false;
      // Carte cible : la plus haute dont rien au-dessus (trait en empreintes, masque de gomme) ne touche le trait.
      // Peindre dedans ne change pas l'ordre visible, et le trait se fusionne avec les aplats déjà là au lieu
      // d'ouvrir une nouvelle carte qui ne se recollerait jamais avec l'ancienne.
      const ob = multiBBox(outline);
      const touches = (b: { x: number; y: number; w: number; h: number }) => b.x <= ob.x + ob.w && b.x + b.w >= ob.x && b.y <= ob.y + ob.h && b.y + b.h >= ob.y;
      let index = strokes.length;
      for (let i = strokes.length - 1; i >= 0; i--) {
        if (strokes[i].flat) { index = i; break; }
        if (touches(strokes[i].bbox)) break;
      }
      const top = index < strokes.length ? strokes[index] : null;
      const onTop = !!top;
      const regions = paintFlat(top ? top.flat! : [], outline, src, st.brush.opacity, st.brush.blend ?? "normal", this.backdropAt(index));
      if (flatVertices(regions) > MAX_FLAT_VERTICES) return false;
      const brush = { ...st.brush, blend: undefined, opacity: 1, pressure: false };
      const item: Stroke = { id: onTop ? top!.id : st.id, brush, pts: [], seed: st.seed, flat: regions, bbox: flatBBox(regions) };
      this.doc.replace([...strokes.slice(0, index), ...(regions.length ? [item] : []), ...strokes.slice(index + (onTop ? 1 : 0))]);
      this.flattened++;
      return true;
    } catch {
      return false; // découpage impossible : le trait reste en empreintes
    }
  }

  /**
   * Gomme (au lever) : sa forme est retirée de toutes les cartes d'aplats ; si elle touche des traits non aplatis,
   * un masque est posé au-dessus pour les trouer aussi. Une étape d'annulation.
   */
  private endErase(st: Stroke): void {
    const r = st.brush.size / 2;
    const tolPx = Math.max(0, Math.min(8, Number(this.simplify) || 0));
    let outline;
    try {
      outline = strokeOutline(st.pts, r, this.outlineTol(tolPx, r));
    } catch {
      this.error = "gomme : découpage impossible";
      this.invalidate();
      return;
    }
    if (!outline.length) { this.invalidate(); return; }
    const eb = multiBBox(outline);
    const touches = (b: { x: number; y: number; w: number; h: number }) => b.x <= eb.x + eb.w && b.x + b.w >= eb.x && b.y <= eb.y + eb.h && b.y + b.h >= eb.y;
    const after: Stroke[] = [];
    let changed = false, needMask = false;
    for (const s of this.doc.strokes) {
      if (s.flat) {
        if (!touches(s.bbox)) { after.push(s); continue; }
        const regions = eraseFlat(s.flat, outline);
        changed = true;
        if (regions.length) after.push({ ...s, flat: regions, bbox: flatBBox(regions) });
      } else {
        after.push(s);
        if (!s.mask && touches(s.bbox)) needMask = true;
      }
    }
    if (needMask) after.push({ id: st.id, brush: st.brush, pts: [], seed: st.seed, mask: outline, bbox: eb });
    if (changed || needMask) this.doc.replace(after);
    this.error = null;
    this.invalidate();
  }

  /** Couche trouée par le tampon de la gomme (aperçu pendant le geste). */
  private holed(layer: HTMLCanvasElement, hole: HTMLCanvasElement): HTMLCanvasElement {
    const c = (this.eraseBuf ??= document.createElement("canvas"));
    if (c.width !== layer.width || c.height !== layer.height) { c.width = layer.width; c.height = layer.height; }
    const x = c.getContext("2d");
    if (!x) return layer;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalCompositeOperation = "copy";
    x.drawImage(layer, 0, 0);
    x.globalCompositeOperation = "destination-out";
    x.drawImage(hole, 0, 0);
    x.globalCompositeOperation = "source-over";
    return c;
  }

  /* ------------------------------------------------------------ pipette */

  /**
   * Couleur vue au point d'écran (sx, sy), en #rrggbb. Lue dans le modèle quand c'est sûr : le point tombe dans
   * une région d'aplat opaque sans fusion différée (couleur exacte, y compris une couleur née d'une fusion),
   * ou sur le fond à travers un trou de gomme ou hors de tout. Sinon (traits en empreintes, couleurs
   * transparentes, fusions différées) : le pixel affiché, qui est le résultat visible.
   */
  colorAt(sx: number, sy: number): string | null {
    const { w, h, dpr } = this.dims();
    const [x, y] = toWorld(this.view, sx, sy, w, h);
    const tol = 0.5 / this.view.zoom;
    const bg = () => { const c = this.backgroundColor(); const v = c ? this.rgbaOf(c) : null; return v && v[3] >= 0.999 ? toCss(v) : null; };
    const strokes = this.doc.strokes;
    let fromModel: string | null | undefined;
    for (let i = strokes.length - 1; i >= 0 && fromModel === undefined; i--) {
      const s = strokes[i], b = s.bbox;
      if (x < b.x - tol || x > b.x + b.w + tol || y < b.y - tol || y > b.y + b.h + tol) continue;
      if (s.mask) { if (shapeHit(s.mask, x, y, 0)) fromModel = bg(); continue; }
      if (s.flat) {
        const hits = s.flat.filter((g) => shapeHit(g.shape, x, y, tol));
        if (!hits.length) continue;
        // Sur une frontière (moins d'un demi-pixel), plusieurs régions : la valeur affichée tranchera.
        const g = hits.length === 1 && shapeHit(hits[0].shape, x, y, 0) ? hits[0] : null;
        fromModel = g && g.rgba[3] >= 0.999 && !g.blend ? toCss(g.rgba) : null;
        continue;
      }
      if (strokeHit(s, x, y, tol)) fromModel = null;
    }
    if (fromModel === undefined) fromModel = bg();
    if (fromModel) return fromModel;
    const ctx = this.canvasEl?.getContext("2d");
    if (!ctx) return null;
    try {
      const px = Math.max(0, Math.min(this.canvasEl.width - 1, Math.floor(sx * dpr)));
      const py = Math.max(0, Math.min(this.canvasEl.height - 1, Math.floor(sy * dpr)));
      const d = ctx.getImageData(px, py, 1, 1).data;
      return toCss([d[0] / 255, d[1] / 255, d[2] / 255, 1]);
    } catch {
      return null;
    }
  }

  /**
   * Pipette : la couleur sous le point devient la couleur du pinceau (aussi écrite dans `brush-from`, pour que
   * la palette et les nuanciers la montrent). Au lever, l'outil revient au pinceau si la pipette était choisie
   * par `brush-from`.
   */
  private pick(p: { x: number; y: number }, done: boolean): void {
    const c = this.colorAt(p.x, p.y);
    if (c) {
      this.picked = c;
      this.live = { ...this.live, color: c };
      if (this.brushFrom) set(`${this.brushFrom}.color`, c);
      this.dispatchEvent(new CustomEvent("sketch-pick", { detail: { color: c, done }, bubbles: true, composed: true }));
    }
    if (done && this.brushFrom && this.live.tool === "pick") {
      this.live = { ...this.live, tool: "paint" };
      set(`${this.brushFrom}.tool`, "paint");
    }
    this.publish();
  }

  /** Statistiques des aplats publiées dans l'état. */
  private flatStats(): { regions: number; colors: number; flats: number; masks: number; flattened: number } {
    let regions = 0, flats = 0, masks = 0;
    const colors = new Set<string>();
    for (const s of this.doc.strokes) {
      if (s.mask) masks++;
      if (!s.flat) continue;
      flats++;
      regions += s.flat.length;
      for (const r of s.flat) colors.add(r.color);
    }
    return { regions, colors: colors.size, flats, masks, flattened: this.flattened };
  }

  /** Abandonne le trait en cours (un second doigt arrive : c'est un geste de vue). */
  private cancelStroke(): void {
    this.erasing = false;
    if (!this.stroke) return;
    this.stroke = null;
    this.stamper = null;
    this.liveBuf = null;
    this.layerDirty = true;
  }

  /* ------------------------------------------------------------ commandes */

  undo(): void { if (this.doc.undo()) this.invalidate(); }
  redo(): void { if (this.doc.redo()) this.invalidate(); }
  clear(): void { this.doc.clear(); this.invalidate(); }

  fit(): void {
    const { w, h } = this.dims();
    this.setView(fitView(contentBBox(this.doc.strokes), w, h, 0.08, this.view.rotation), true);
  }

  reset(): void { this.setView({ ...DEFAULT_VIEW }, true); }

  zoomIn(): void { this.nav.zoomBy(1.6); }
  zoomOut(): void { this.nav.zoomBy(1 / 1.6); }
  rotateLeft(): void { this.nav.rotateBy(-ROTATE_STEP); }
  rotateRight(): void { this.nav.rotateBy(ROTATE_STEP); }
  straighten(): void { this.nav.straighten(); }

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
      status: this.error ? "error" : "ready", error: this.error, zoom: this.view.zoom, x: this.view.x, y: this.view.y, rotation: this.view.rotation,
      strokes: this.doc.strokes.length, points: this.doc.totalPoints, lastStroke: { ...this.lastCompaction }, ...this.flatStats(), drawing: this.mode === "draw", canUndo: this.doc.canUndo, canRedo: this.doc.canRedo,
      tool: this.currentTool(), color: b.color, picked: this.picked, size: b.size, blend: this.currentBlend(), bbox: contentBBox(this.doc.strokes), last: this.last,
    };
  }

  private publish(): void {
    const s = this.getState();
    if (this.outDataProvider) set(this.outDataProvider, s);
    this.dispatchEvent(new CustomEvent("sketch-state", { detail: s, bubbles: true, composed: true }));
  }
}
