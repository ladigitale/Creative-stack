import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import { safeMediaUrl } from "../../shared/media/urls";
import { isFrameSource, type SonicFrameConsumerHost, type SonicFrameSource, type SonicMediaRef } from "../../shared/mediaRef";
import { BRUSH_DEFAULTS, History, Stabilizer, StampWalker, blendOp, place, rng, sanitizeBrush, type BrushSettings, type Pt } from "./brush";
import { drawTip, tipFromValue, tipGeometry } from "./tip";
import { ROTATE_STEP, ViewGestures, fitBox, invert, multiply, sanitizeView2D, screenToWorld, viewMatrix, type View2D } from "../../shared/view2d";
import { ViewSync } from "../../shared/view-sync";
import { pickColorAt, readCanvasPixel, type Pixel } from "../../shared/pick";
import { PalmGuard, VelocityPressure, pressureCurve, readPen, sanitizeTouchMode } from "../../shared/pen";

/** Zoom de la vue d'une toile navigable (pixels d'écran par pixel de toile). */
const NAV_MIN_ZOOM = 0.01;
const NAV_MAX_ZOOM = 64;

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
  /** Dernière couleur prélevée à la pipette (`tool="pick"` ou Alt + clic), calques compris. */
  picked: string | null;
  /** Dernier enregistrement (`control.save`) : à brancher sur `sonic-media-download source="…last"`. */
  last: { url: string; mime: string; width: number; height: number; size: number } | null;
  /** Toile navigable : vue (centre en pixels de toile, zoom, rotation en radians). Sinon zoom 1, rotation 0. */
  x: number;
  y: number;
  zoom: number;
  rotation: number;
  /** Toile navigable : taille de la fenêtre en pixels CSS (0 sinon). */
  viewWidth: number;
  viewHeight: number;
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
    :host([navigable]) { height: 100%; min-height: 160px; overflow: hidden; }
    :host([navigable]) canvas { height: 100%; outline: none; }
    :host([navigable]) canvas.pan { cursor: grab; }
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
  /** Stylets (voir sonic-sketch) : bout gomme, bouton latéral, orientation, doigt, courbe et simulation de pression. */
  @property({ type: String, attribute: "pen-eraser" }) penEraser = "erase";
  @property({ type: String, attribute: "pen-barrel" }) penBarrel = "pick";
  @property({ type: String, attribute: "pen-tilt" }) penTilt = "angle";
  @property({ type: String, attribute: "touch" }) touchMode = "auto";
  @property({ type: Number, attribute: "pressure-curve" }) pressureGamma = 1;
  @property({ type: Number, attribute: "pressure-min" }) pressureMin = 0;
  @property({ type: Boolean, attribute: "simulate-pressure" }) simulatePressure = false;
  private palm = new PalmGuard("auto");
  private velocity = new VelocityPressure();
  /** Réglages imposés par le stylet le temps d'un trait (bout gomme, orientation). */
  private penOverride: Partial<BrushSettings> | null = null;
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
  /**
   * Sources d'images à fondre dans la toile à la commande `stamp` (sélecteurs `#id` séparés par des virgules,
   * du dessous vers le dessus) : un calque `sonic-sketch` posé au-dessus, un `sonic-shader`, une scène
   * `sonic-2d` / `sonic-3d`… Chacune est peinte telle qu'elle apparaît à l'écran, à sa place sous la toile.
   */
  @property({ type: String, attribute: "stamp-from" }) stampFrom = "";
  @property({ type: String }) control = "";
  @property({ type: String, attribute: "in-data-provider" }) inDataProvider = "";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";
  @property({ type: Number, attribute: "undo-levels" }) undoLevels = 20;
  @property({ type: Boolean }) readonly = false;
  @property({ type: Boolean, attribute: "hidden-preview" }) hiddenPreview = false;
  /**
   * Toile navigable : l'élément devient une fenêtre (sa taille CSS) sur l'image width × height, avec la même
   * navigation que `sonic-sketch` — molette, Espace / bouton du milieu / outil main pour déplacer, deux doigts
   * pour déplacer, zoomer et tourner, clavier + − 0 R. Pixels nets au zoom avant.
   */
  @property({ type: Boolean, reflect: true }) navigable = false;
  /** DP de la vue `{ x, y, zoom, rotation }` (toile navigable). */
  @property({ type: String, attribute: "view-from" }) viewFrom = "";
  /** DP de vue partagée `{ x, y, zoom, rotation }`, lu et écrit : des toiles superposées restent alignées. */
  @property({ type: String, attribute: "view-sync" }) viewSync = "";
  private sync: ViewSync | null = null;

  @query("canvas") private canvasEl!: HTMLCanvasElement;

  private seq = 0;
  private picking = false;
  private picked: string | null = null;
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

  /* ---- toile navigable : image hors écran + vue */
  private buf: HTMLCanvasElement | null = null;
  private view: View2D = { x: 512, y: 512, zoom: 1, rotation: 0 };
  /** Vue cadrée automatiquement (tant que personne n'a navigué). */
  private autoFit = true;
  private disp = { w: 0, h: 0, dpr: 1 };
  private ro: ResizeObserver | null = null;
  private presentRaf = 0;
  private space = false;
  private hover = false;
  private panning: number | null = null;
  private checker: CanvasPattern | null = null;
  private nav = new ViewGestures({
    view: () => this.view,
    setView: (v) => this.setView(v),
    size: () => ({ w: this.disp.w || 1, h: this.disp.h || 1 }),
    zoomRange: () => [NAV_MIN_ZOOM, NAV_MAX_ZOOM],
    fit: () => this.fit(),
  });

  /** Image peinte : la toile elle-même, ou l'image hors écran d'une toile navigable. */
  private image(): HTMLCanvasElement | null {
    if (!this.navigable) return this.canvasEl ?? null;
    const { w, h } = this.dims();
    if (!this.buf) this.buf = document.createElement("canvas");
    if (this.buf.width !== w || this.buf.height !== h) { this.buf.width = w; this.buf.height = h; }
    return this.buf;
  }

  get frameSeq(): number { return this.seq; }
  getFrameCanvas(): HTMLCanvasElement | null { return this.image(); }
  registerFrameConsumer(token: object = {}): void { this.consumers.add(token); }
  unregisterFrameConsumer(token: object = {}): void { this.consumers.delete(token); }

  /** Réglages effectifs : attributs puis réglages en direct. */
  brush(): BrushSettings {
    const base = sanitizeBrush({ ...BRUSH_DEFAULTS }, { size: this.size, hardness: this.hardness, opacity: this.opacity, spacing: this.spacing, smoothing: this.smoothing, color: this.color, tool: this.tool, pressure: this.pressure, tip: this.tip, angle: this.angle, angleFollow: this.angleFollow, angleJitter: this.angleJitter, sizeJitter: this.sizeJitter, scatter: this.scatter, roundness: this.roundness, blend: this.blend });
    const b = sanitizeBrush(base, this.live);
    return this.penOverride ? { ...b, ...this.penOverride, angle: (b.angle + (this.penOverride.angle ?? 0)) % 360 } : b;
  }

  private dims(): { w: number; h: number } {
    let w = Math.round(Math.max(16, Math.min(MAX_SIDE, Number(this.width) || 1024)));
    let h = Math.round(Math.max(16, Math.min(MAX_SIDE, Number(this.height) || 1024)));
    if (w * h > MAX_PIXELS) { const k = Math.sqrt(MAX_PIXELS / (w * h)); w = Math.floor(w * k); h = Math.floor(h * k); }
    return { w, h };
  }

  private ctx(): CanvasRenderingContext2D | null {
    return this.image()?.getContext("2d", { willReadFrequently: false }) ?? null;
  }

  render() {
    if (this.navigable) {
      return html`<canvas part="canvas" tabindex="0" class=${this.panning !== null || this.space || this.toolName() === "hand" ? "pan" : ""}
        @pointerdown=${this.onDown} @pointermove=${this.onMove} @pointerup=${this.onUp} @pointercancel=${this.onUp} @lostpointercapture=${this.onUp}
        @pointerenter=${() => (this.hover = true)} @pointerleave=${() => (this.hover = false)}
        @keydown=${this.onKey} @contextmenu=${(e: Event) => e.preventDefault()}></canvas>`;
    }
    const { w, h } = this.dims();
    return html`<canvas width=${w} height=${h} part="canvas"
      @pointerdown=${this.onDown} @pointermove=${this.onMove} @pointerup=${this.onUp} @pointercancel=${this.onUp} @lostpointercapture=${this.onUp}></canvas>`;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    window.addEventListener("keydown", this.onSpace);
    window.addEventListener("keyup", this.onSpace);
  }

  disconnectedCallback(): void {
    window.removeEventListener("keydown", this.onSpace);
    window.removeEventListener("keyup", this.onSpace);
    this.ro?.disconnect();
    this.ro = null;
    cancelAnimationFrame(this.presentRaf);
    this.stopStrokeWatch();
    window.removeEventListener("pointerup", this.onHeldUp, true);
    window.removeEventListener("pointercancel", this.onHeldUp, true);
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.last) URL.revokeObjectURL(this.last.url);
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    this.fillBackground();
    if (this.navigable) this.setupDisplay();
    this.publish();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("navigable") && c.get("navigable") !== undefined) {
      // Passage navigable ↔ simple : l'image est recopiée sur la nouvelle surface.
      const from = this.navigable ? (this.renderRoot.querySelector("canvas") as HTMLCanvasElement | null) : this.buf;
      if (this.navigable) { this.setupDisplay(); }
      const to = this.image();
      if (from && to && from !== to) to.getContext("2d")?.drawImage(from, 0, 0);
    }
    if ((c.has("width") || c.has("height")) && this.navigable && this.autoFit) this.fit();
    if (c.has("width") || c.has("height") || c.has("background")) {
      if (this.canvasEl && (c.has("width") || c.has("height")) && !c.has("background")) this.fillBackground();
      else if (c.has("background") && this.strokes === 0) this.fillBackground();
    }
    if (c.has("control") || c.has("brushFrom") || c.has("tipFrom") || c.has("inDataProvider") || c.has("viewFrom") || c.has("viewSync")) this.listen();
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
        if ("stamp" in c && this.trigger("stamp").feed(c.stamp)) this.stampSources();
        for (const cmd of ["undo", "redo", "clear", "save", "fit", "reset", "zoomIn", "zoomOut", "rotateLeft", "rotateRight", "straighten"] as const) {
          if (cmd in c && this.trigger(cmd).feed(c[cmd])) this[cmd]();
        }
      }));
    }
    if (this.inDataProvider) this.unsubs.push(listenDp(this.inDataProvider, (v) => void this.loadBase(v)));
    this.sync = this.viewSync ? new ViewSync(this.viewSync) : null;
    if (this.sync) {
      this.unsubs.push(this.sync.listen((v) => {
        if (!this.navigable) return;
        const next = sanitizeView2D(v, this.view, NAV_MIN_ZOOM, NAV_MAX_ZOOM);
        const c = this.view;
        // Vue bornée par cette toile (zoom) : réécrite pour que les autres calques l'adoptent.
        if (next.x === c.x && next.y === c.y && next.zoom === c.zoom && next.rotation === c.rotation) { this.sync?.write(next); return; }
        this.setView(next);
      }));
    }
    if (this.viewFrom) {
      this.unsubs.push(listenDp(this.viewFrom, (v) => {
        if (!this.navigable) return;
        const next = sanitizeView2D(v, this.view, NAV_MIN_ZOOM, NAV_MAX_ZOOM);
        const c = this.view;
        if (next.x === c.x && next.y === c.y && next.zoom === c.zoom && next.rotation === c.rotation) return;
        this.setView(next);
      }));
    }
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
      if (token !== this.loadToken || !this.image()) return;
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
    this.schedulePresent();
    this.publish();
  }

  /* ------------------------------------------------------------ toile navigable : affichage */

  private setupDisplay(): void {
    const canvas = this.renderRoot.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas || !this.navigable) return;
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.ro?.disconnect();
    if (typeof ResizeObserver === "function") {
      this.ro = new ResizeObserver(() => this.measure());
      this.ro.observe(canvas);
    }
    this.measure();
  }

  private measure(): void {
    const canvas = this.canvasEl;
    if (!canvas || !this.navigable) return;
    const r = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, (typeof devicePixelRatio === "number" && devicePixelRatio) || 1));
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (w === this.disp.w && h === this.disp.h && dpr === this.disp.dpr) return;
    this.disp = { w, h, dpr };
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (this.autoFit) this.fit(); else this.present();
    this.publish();
  }

  private schedulePresent(): void {
    if (!this.navigable || this.presentRaf) return;
    this.presentRaf = requestAnimationFrame(() => { this.presentRaf = 0; this.present(); });
  }

  /** Dessine l'image dans la fenêtre selon la vue : damier sous la transparence, pixels nets au zoom avant. */
  private present(): void {
    const canvas = this.canvasEl, img = this.image();
    const g = canvas?.getContext("2d");
    if (!canvas || !img || !g || !this.navigable) return;
    const { w, h, dpr } = this.disp;
    const { w: iw, h: ih } = this.dims();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    const m = viewMatrix(this.view, w, h);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.save();
    g.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    g.beginPath();
    g.rect(0, 0, iw, ih);
    g.restore();
    g.save();
    g.clip();
    if (!this.checker) {
      const c = document.createElement("canvas");
      c.width = c.height = 16;
      const cg = c.getContext("2d");
      if (cg) { cg.fillStyle = "#f2f2f4"; cg.fillRect(0, 0, 16, 16); cg.fillStyle = "#d8d8de"; cg.fillRect(0, 0, 8, 8); cg.fillRect(8, 8, 8, 8); }
      this.checker = g.createPattern(c, "repeat");
    }
    if (this.checker) { g.fillStyle = this.checker; g.fillRect(0, 0, w, h); }
    g.restore();
    g.save();
    g.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    g.imageSmoothingEnabled = this.view.zoom < 1;
    g.drawImage(img, 0, 0);
    g.lineWidth = 1 / this.view.zoom;
    g.strokeStyle = "rgba(0,0,0,.25)";
    g.strokeRect(0, 0, iw, ih);
    g.restore();
  }

  private setView(v: View2D, auto = false): void {
    this.view = v;
    if (this.navigable) this.sync?.write(v);
    this.autoFit = auto;
    this.schedulePresent();
    this.publish();
  }

  private toolName(): string {
    const t = typeof this.live.tool === "string" ? this.live.tool : this.tool;
    return t === "hand" || t === "erase" || t === "pick" ? t : "paint";
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvasEl.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onWheel = (e: WheelEvent): void => {
    if (!this.navigable) return;
    e.preventDefault();
    this.nav.wheel(e, this.local(e));
  };

  private onSpace = (e: KeyboardEvent): void => {
    if (!this.navigable || e.code !== "Space") return;
    if (e.type === "keydown" && !this.hover && this.shadowRoot?.activeElement !== this.canvasEl) return;
    if (e.type === "keydown") e.preventDefault();
    const was = this.space;
    this.space = e.type === "keydown";
    if (was !== this.space) this.requestUpdate();
  };

  private onKey = (e: KeyboardEvent): void => {
    if (this.nav.key(e)) { e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); }
  };

  /** Cadre toute l'image dans la fenêtre (rotation conservée). */
  fit(): void {
    if (!this.navigable) return;
    const { w, h } = this.dims();
    const v = fitBox({ x: 0, y: 0, w, h }, this.disp.w || w, this.disp.h || h, this.view.rotation, NAV_MIN_ZOOM, NAV_MAX_ZOOM, 0.04);
    if (v) this.setView(v, true);
  }

  /** Image entière, droite. */
  reset(): void {
    if (!this.navigable) return;
    this.view = { ...this.view, rotation: 0 };
    this.fit();
  }

  zoomIn(): void { if (this.navigable) this.nav.zoomBy(1.6); }
  zoomOut(): void { if (this.navigable) this.nav.zoomBy(1 / 1.6); }
  rotateLeft(): void { if (this.navigable) this.nav.rotateBy(-ROTATE_STEP); }
  rotateRight(): void { if (this.navigable) this.nav.rotateBy(ROTATE_STEP); }
  straighten(): void { if (this.navigable) this.nav.straighten(); }

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
    const img = this.image();
    if (b.tool === "erase" || b.blend === "normal" || !img) return;
    const { w, h } = this.dims();
    const mk = () => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const base = mk(), layer = mk();
    base.getContext("2d")?.drawImage(img, 0, 0);
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

  /**
   * Position du pointeur en pixels de toile. `offsetX/Y` sont exprimés dans le repère propre de la toile,
   * transformations CSS comprises : la toile peut être tournée, mise à l'échelle ou retournée par un parent
   * (sonic-stage) sans fausser le tracé. Repli sur le rectangle englobant si la cible n'est pas la toile.
   */
  private toCanvas(e: PointerEvent): Pt {
    const { w, h } = this.dims();
    const p = this.pressureOf(e);
    if (this.navigable) {
      const l = this.local(e);
      const [x, y] = screenToWorld(this.view, l.x, l.y, this.disp.w || 1, this.disp.h || 1);
      return { x, y, p };
    }
    const cw = this.canvasEl.offsetWidth, ch = this.canvasEl.offsetHeight;
    if (e.target === this.canvasEl && cw > 0 && ch > 0 && Number.isFinite(e.offsetX) && Number.isFinite(e.offsetY)) {
      return { x: (e.offsetX / cw) * w, y: (e.offsetY / ch) * h, p };
    }
    const r = this.canvasEl.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * w, y: ((e.clientY - r.top) / Math.max(1, r.height)) * h, p };
  }

  private pressureOf(e: PointerEvent): number {
    if (e.pointerType === "pen") return pressureCurve(e.pressure > 0 ? e.pressure : 0.5, this.pressureGamma, this.pressureMin);
    if (!this.simulatePressure) return 1;
    return pressureCurve(this.velocity.feed(e.clientX, e.clientY, e.timeStamp || performance.now()), this.pressureGamma, this.pressureMin);
  }

  /** Stylet au début d'un trait : bout gomme et orientation (rotation, sinon direction de l'inclinaison). */
  private penStart(e: PointerEvent): void {
    const pen = readPen(e);
    const o: Partial<BrushSettings> = {};
    if (pen.eraser && this.penEraser !== "none") o.tool = "erase";
    if (this.penTilt !== "none") {
      const a = pen.twist !== null ? pen.twist : pen.hasTilt ? (pen.azimuth * 180) / Math.PI : null;
      if (a !== null) o.angle = a - (this.navigable ? ((this.view.rotation || 0) * 180) / Math.PI : 0);
    }
    this.penOverride = Object.keys(o).length ? o : null;
    this.velocity.reset();
  }

  /** Bouton latéral du stylet en pipette, ou doigt à ignorer (paume) hors toile navigable. */
  private penBarrelPicks(e: PointerEvent): boolean {
    return readPen(e).barrel && this.penBarrel === "pick";
  }

  /* ------------------------------------------------------------ deux doigts : le trait cède la place au geste */

  /** Doigts encore posés après un trait abandonné : la toile ne peint plus tant qu'il en reste. */
  private heldTouches = new Set<number>();

  /** Un autre doigt touche l'écran pendant un trait au doigt : c'est un geste (déplacer, zoomer, tourner). */
  private onOtherDown = (e: PointerEvent): void => {
    if (e.pointerType !== "touch" || e.pointerId === this.pointer || !this.drawing || this.pointerType !== "touch") return;
    this.abortStroke(e.pointerId);
  };

  private onHeldUp = (e: PointerEvent): void => {
    this.heldTouches.delete(e.pointerId);
    if (this.heldTouches.size) return;
    window.removeEventListener("pointerup", this.onHeldUp, true);
    window.removeEventListener("pointercancel", this.onHeldUp, true);
  };

  /** Annule le trait en cours (toile remise comme avant le trait) et attend que tous les doigts se lèvent. */
  private abortStroke(otherId: number): void {
    const ctx = this.ctx();
    const before = this.undoLevels > 0 ? this.history.dropLast() : null;
    if (ctx && before) ctx.putImageData(before, 0, 0);
    this.endBlend();
    if (this.pointer !== null) {
      try { this.canvasEl.releasePointerCapture(this.pointer); } catch { /* déjà relâché */ }
      this.heldTouches.add(this.pointer);
    }
    this.heldTouches.add(otherId);
    window.addEventListener("pointerup", this.onHeldUp, true);
    window.addEventListener("pointercancel", this.onHeldUp, true);
    this.stopStrokeWatch();
    this.pointer = null;
    this.drawing = false;
    this.penOverride = null;
    this.touch();
  }

  private pointerType = "";

  private startStrokeWatch(): void {
    window.addEventListener("pointerdown", this.onOtherDown, true);
  }

  private stopStrokeWatch(): void {
    window.removeEventListener("pointerdown", this.onOtherDown, true);
  }

  private pushHistory(): void {
    const ctx = this.ctx();
    if (!ctx || this.undoLevels <= 0) return;
    const { w, h } = this.dims();
    this.history.push(ctx.getImageData(0, 0, w, h), w * h);
  }

  private onDown = (e: PointerEvent): void => {
    if (this.navigable) { this.onNavDown(e); return; }
    if (this.readonly || this.pointer !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
    this.palm.mode = sanitizeTouchMode(this.touchMode);
    this.palm.note(e);
    // Paume posée pendant qu'on dessine au stylet : ignorée (toile fixe, rien à déplacer).
    if (this.palm.navigates(e)) return;
    if (e.pointerType === "touch" && this.heldTouches.size) {
      this.heldTouches.add(e.pointerId);
      return;
    }
    this.pointer = e.pointerId;
    this.pointerType = e.pointerType;
    if (this.wantsPick(e) || this.penBarrelPicks(e)) {
      try { this.canvasEl.setPointerCapture(e.pointerId); } catch { /* pointeur synthétique */ }
      e.preventDefault();
      this.startPick(e);
      return;
    }
    this.startStrokeWatch();
    try { this.canvasEl.setPointerCapture(e.pointerId); } catch { /* pointeur synthétique */ }
    e.preventDefault();
    this.beginStroke(e);
  };

  /** Toile navigable : un doigt / la souris peint, deux doigts, Espace, le bouton du milieu ou la main naviguent. */
  private onNavDown(e: PointerEvent): void {
    this.canvasEl.focus({ preventScroll: true });
    try { this.canvasEl.setPointerCapture(e.pointerId); } catch { /* pointeur synthétique */ }
    e.preventDefault();
    this.palm.mode = sanitizeTouchMode(this.touchMode);
    this.palm.note(e);
    const barrel = readPen(e).barrel;
    const pan = e.button === 1 || this.space || this.toolName() === "hand" || this.readonly || (barrel && this.penBarrel === "pan") || this.palm.navigates(e);
    const r = this.nav.down(e.pointerId, this.local(e), this.pointer === null && pan);
    if (r === "pinch") {
      if (this.drawing) this.cancelStroke();
      this.pointer = null;
      this.panning = null;
      return;
    }
    if (this.pointer !== null || this.panning !== null || this.nav.count > 1) return;
    if (r === "pan") { this.panning = e.pointerId; this.requestUpdate(); return; }
    if (e.pointerType === "mouse" && e.button !== 0) { this.nav.up(e.pointerId); return; }
    this.pointer = e.pointerId;
    this.pointerType = e.pointerType;
    if (this.wantsPick(e) || this.penBarrelPicks(e)) { this.startPick(e); return; }
    this.beginStroke(e);
  }

  /** Abandonne le trait en cours : la toile revient comme avant le trait. */
  private cancelStroke(): void {
    const ctx = this.ctx();
    const before = this.undoLevels > 0 ? this.history.dropLast() : null;
    if (ctx && before) ctx.putImageData(before, 0, 0);
    this.endBlend();
    this.drawing = false;
    this.penOverride = null;
    this.touch();
  }

  private beginStroke(e: PointerEvent): void {
    this.penStart(e);
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
  }

  private onMove = (e: PointerEvent): void => {
    if (this.navigable && this.nav.move(e.pointerId, this.local(e))) return;
    if (this.picking && e.pointerId === this.pointer) { this.pick(e, false); return; }
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
    if (this.picking && e.pointerId === this.pointer) {
      if (this.navigable) this.nav.up(e.pointerId);
      try { this.canvasEl.releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
      this.picking = false;
      this.pointer = null;
      this.pick(e, e.type === "pointerup");
      return;
    }
    if (this.navigable) {
      this.nav.up(e.pointerId);
      if (this.panning === e.pointerId) {
        this.panning = null;
        try { this.canvasEl.releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
        this.requestUpdate();
        return;
      }
      if (e.pointerId !== this.pointer) {
        try { this.canvasEl.releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
        return;
      }
      if (!this.drawing) { this.pointer = null; return; }
    }
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
    this.stopStrokeWatch();
    try { this.canvasEl.releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
    this.pointer = null;
    this.drawing = false;
    this.penOverride = null;
    this.strokes++;
    this.touch();
  };

  /* ------------------------------------------------------------ pipette */

  private wantsPick(e: PointerEvent): boolean {
    const t = this.toolName();
    return t === "pick" || (e.altKey && t === "paint");
  }

  private startPick(e: PointerEvent): void {
    this.picking = true;
    this.pick(e, false);
  }

  /** Point du viewport → pixel de l'image (vue de la toile navigable, ou mise à l'échelle CSS). */
  private imagePoint(clientX: number, clientY: number): [number, number] | null {
    const c = this.canvasEl;
    if (!c) return null;
    const r = c.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    const { w, h } = this.dims();
    if (this.navigable) return screenToWorld(this.view, clientX - r.left, clientY - r.top, this.disp.w || 1, this.disp.h || 1);
    return [((clientX - r.left) / r.width) * w, ((clientY - r.top) / r.height) * h];
  }

  /**
   * Contrat `FrameToClient` (`shared/frame-geometry`) : pixels de l'image (`getFrameCanvas()`) → viewport.
   * Toile navigable : à travers la vue ; sinon la mise à l'échelle CSS du canvas.
   */
  frameToClient(): number[] | null {
    const c = this.canvasEl;
    if (!c) return null;
    const r = c.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    if (this.navigable) {
      const m = viewMatrix(this.view, this.disp.w || 1, this.disp.h || 1);
      return [m[0], m[1], m[2], m[3], m[4] + r.left, m[5] + r.top];
    }
    const { w, h } = this.dims();
    return [r.width / w, 0, 0, r.height / h, r.left, r.top];
  }

  /** Contrat `PickSource` (`shared/pick`) : le pixel de l'image sous le point (transparent hors de l'image). */
  pickAt(clientX: number, clientY: number): { pixel: Pixel } | null {
    const c = this.canvasEl, img = this.image();
    if (!c || !img) return null;
    const r = c.getBoundingClientRect();
    if (clientX < r.left || clientX >= r.right || clientY < r.top || clientY >= r.bottom) return null;
    const p = this.imagePoint(clientX, clientY);
    if (!p) return null;
    return { pixel: readCanvasPixel(img, p[0], p[1]) ?? [0, 0, 0, 0] };
  }

  /**
   * Pipette : la couleur vue sous le point (calques au-dessus et en dessous compris : `sonic-sketch`, shaders,
   * scènes…) devient celle du pinceau, écrite aussi dans `brush-from`. Au lever, l'outil revient au pinceau
   * si la pipette venait de `brush-from`.
   */
  private pick(e: { clientX: number; clientY: number }, done: boolean): void {
    const c = pickColorAt(e.clientX, e.clientY);
    if (c) {
      this.picked = c;
      this.live = { ...this.live, color: c };
      if (this.brushFrom) set(`${this.brushFrom}.color`, c);
      this.dispatchEvent(new CustomEvent("paint-pick", { detail: { color: c, done }, bubbles: true, composed: true }));
    }
    if (done && this.brushFrom && this.live.tool === "pick") {
      this.live = { ...this.live, tool: "paint" };
      set(`${this.brushFrom}.tool`, "paint");
    }
    this.publish();
  }

  /* ------------------------------------------------------------ commandes */

  /**
   * Fond dans la toile les sources de `stamp-from`, telles qu'elles apparaissent à l'écran par-dessus elle
   * (aplatir un calque vectoriel, capturer une image de shader ou de scène). Une étape d'annulation.
   */
  stampSources(): void {
    const ctx = this.ctx(), c = this.canvasEl;
    if (!ctx || !c || !this.stampFrom) return;
    const cr = c.getBoundingClientRect();
    if (!(cr.width > 0 && cr.height > 0)) return;
    const { w, h } = this.dims();
    // Viewport → image : inverse de la vue (toile navigable) ou de la mise à l'échelle CSS.
    const m = this.navigable
      ? multiply(invert(viewMatrix(this.view, this.disp.w || 1, this.disp.h || 1)), [1, 0, 0, 1, -cr.left, -cr.top])
      : [w / cr.width, 0, 0, h / cr.height, (-cr.left * w) / cr.width, (-cr.top * h) / cr.height];
    const root = this.getRootNode() as Document | ShadowRoot;
    const sources: { canvas: HTMLCanvasElement; r: DOMRect }[] = [];
    for (const sel of this.stampFrom.split(",").map((x) => x.trim()).filter(Boolean)) {
      let el: Element | null = null;
      try { el = root.querySelector(sel) ?? document.querySelector(sel); } catch { el = null; }
      if (!el || el === this || !isFrameSource(el)) continue;
      const canvas = el.getFrameCanvas();
      if (!canvas) continue;
      const r = canvas.isConnected ? canvas.getBoundingClientRect() : el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) sources.push({ canvas, r });
    }
    if (!sources.length) return;
    this.pushHistory();
    ctx.save();
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    for (const { canvas, r } of sources) {
      try { ctx.drawImage(canvas, r.left, r.top, r.width, r.height); } catch { /* source illisible */ }
    }
    ctx.restore();
    this.strokes++;
    this.touch();
  }

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
    this.image()?.toBlob((blob) => {
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
    return { status: this.error ? "error" : "ready", error: this.error, width: w, height: h, strokes: this.strokes, drawing: this.drawing, canUndo: this.history.canUndo, canRedo: this.history.canRedo, tool: this.toolName() === "hand" || this.toolName() === "pick" ? this.toolName() : b.tool, color: b.color, picked: this.picked, size: b.size, last: this.last, x: this.navigable ? this.view.x : w / 2, y: this.navigable ? this.view.y : h / 2, zoom: this.navigable ? this.view.zoom : 1, rotation: this.navigable ? this.view.rotation : 0, viewWidth: this.navigable ? this.disp.w : 0, viewHeight: this.navigable ? this.disp.h : 0 };
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
