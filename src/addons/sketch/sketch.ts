import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp, plain } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import type { SonicFrameConsumerHost, SonicFrameSource } from "../../shared/mediaRef";
import { BRUSH_DEFAULTS, Stabilizer, Trembler, sanitizeBrush, type BrushSettings } from "../paint/brush";
import { tipFromValue } from "../paint/tip";
import { exportSvg } from "./export";
import {
  Doc, MAX_POINTS_PER_STROKE, MAX_ZOOM, MIN_ZOOM, compactStroke, contentBBox, fitView, makeBrush, sanitizeView, strokeBBox, strokeHit, strokeMargin,
  toScreen, toWorld, visibleRect, sanitizeBlend, DEFAULT_VIEW, type BlendMode, type Stroke, type View,
} from "./model";
import { blitBlend, drawStamp, drawStrokes, scratchFor, type Surface } from "./render";
import { StrokeStamper } from "./stamps";
import { ROTATE_STEP, ViewGestures, invert, multiply, viewMatrix } from "../../shared/view2d";
import { isSolid, shapeHit, solidRadius, strokeOutline } from "./merge";
import { FLAT_EDITS, MAX_FLAT_VERTICES, deleteFlat, editFlat, eraseFlat, flatBBox, flatVertices, paintFlat, recolorFlat, type Backdrop, type FlatEdit, type Region } from "./flat";
import { allRegions, regionAt, selectionInfo, similarRegions, type SelectionInfo } from "./select";
import { deriveColor, parseColor, type Rgba } from "./flat-color";
import {
  CURRENT, IdbBackend, cleanName, isDrawingId, listDrawings, newDrawingId, readCurrent, readStrokes, readView, writeCurrent, writeStrokes,
  type DrawingBackend, type DrawingMeta, type DrawingRecord,
} from "./store";
import { ViewSync } from "../../shared/view-sync";
import { pickColorAt, readCanvasPixel, type Pixel } from "../../shared/pick";
import { multiArea, multiBBox, pathToMulti, simplifyMulti, type Multi, type Pt } from "../vector";
import { applyAffine } from "../../shared/frame-geometry";

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
  /** Dernier import de formes (`import-from`) : `{ layers, regions, ms }` ou `{ error }`. */
  imported: { layers: number; regions: number; ms: number } | { error: string } | null;
  /** Régions d'aplat sélectionnées (`tool="select"` / `"select-color"`) : nombre, couleurs, boîte, aire. */
  selection: SelectionInfo;
  bbox: { x: number; y: number; w: number; h: number } | null;
  /** Dernier export (`control.save` / `savePng`) : à brancher sur `sonic-media-download source="…last"`. */
  last: { url: string; mime: string; width: number; height: number; size: number } | null;
  /** Retouche de la sélection en aperçu (`control.edit`) : opération, aperçu affiché, erreur. */
  edit: { op: FlatEdit | null; preview: boolean; error: string | null };
  /** Carnet (`persist`) : état, dessin ouvert, dessins enregistrés (vignette = URL `blob:`), le plus récent d'abord. */
  library: {
    enabled: boolean;
    status: "off" | "loading" | "saving" | "saved" | "error";
    id: string | null;
    name: string;
    drawings: { id: string; name: string; created: number; updated: number; strokes: number; thumb: string; current: boolean }[];
  };
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
 * celle du pinceau (écrite aussi dans `brush-from`). `tool="select"` sélectionne la région d'aplat sous le point (Maj :
 * ajouter / retirer), `tool="select-color"` toutes les régions de cette couleur (`tolerance`, `contiguous`) ;
 * une couleur choisie ensuite (`brush-from.color`) recolore la sélection, Suppr la retire, Échap la vide.
 * `tool="erase"` est une vraie gomme (trou exact dans les aplats, masque sur les traits non aplatis). Commandes par `control` (compteurs) : `undo`, `redo`, `clear`,
 * `save` (SVG), `savePng`, `fit`, `reset`, `zoomIn`, `zoomOut`, `rotateLeft`, `rotateRight`, `straighten`.
 * Vue pilotée par `view-from` ({x, y, zoom, rotation}).
 */
@customElement("sonic-sketch")
export class SonicSketch extends LitElement implements SonicFrameSource, SonicFrameConsumerHost {
  static styles = css`
    :host { display: block; position: relative; line-height: 0; touch-action: none; }
    :host([hidden-preview]) { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; overflow: hidden; }
    canvas { display: block; width: 100%; height: auto; touch-action: none; outline: none; }
    canvas.overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
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
  /** Tremblement du tracé 0..1 (contours vivants ; voir `BrushSettings.tremble`). Aussi en direct dans `brush-from`. */
  @property({ type: Number }) tremble = 0;
  /**
   * `paint`, `erase` (vraie gomme), `pick` (pipette), `select` (régions d'aplat au clic), `select-color` (régions
   * d'une couleur) ou `hand` (déplacer la vue).
   */
  @property({ type: String }) tool = "paint";
  /** Sélection par couleur : écart de couleur accepté (OKLab ×100 ; 0 = couleur exacte, ~2 à peine visible). */
  @property({ type: Number }) tolerance = 0;
  /** Sélection par couleur : seulement les régions reliées à celle cliquée (sinon tout le dessin). */
  @property({ type: Boolean }) contiguous = false;
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
  /**
   * Import de formes : DP d'état de `sonic-vectorize` (`paths[{color, d}]`, `width`, `height`, `frame`). Les
   * couches deviennent des aplats (une étape d'annulation) à la commande `import` (DP `control`) ou, avec
   * `import-auto`, à chaque nouveau résultat. Pour retravailler en vectoriel une esquisse pixel, une photo
   * ou l'image d'un shader générateur.
   */
  @property({ type: String, attribute: "import-from" }) importFrom = "";
  @property({ type: Boolean, attribute: "import-auto" }) importAuto = false;
  /**
   * Placement : `screen` (là où la source apparaît à l'écran : calque pixel ou shader posé sur le dessin),
   * `view` (ajusté dans la vue courante), `auto` (défaut : `screen` si la source était visible sur la toile).
   */
  @property({ type: String, attribute: "import-place" }) importPlace: "auto" | "screen" | "view" = "auto";
  /**
   * Couleurs ignorées à l'import, séparées par des virgules ; `background` (défaut) = la couleur de fond de
   * la toile (le papier vectorisé ne devient pas une forme) ; vide = tout garder.
   */
  @property({ type: String, attribute: "import-skip" }) importSkip = "background";
  /**
   * Recoloration à l'import : DP d'une palette (liste, chaîne « #a, #b » ou état de `sonic-palette` `{colors}`).
   * Les couleurs distinctes de la source, de la plus étendue à la plus rare, prennent tour à tour les couleurs
   * de la palette. Pour poser les formes d'un shader générateur (couleurs arbitraires) dans l'harmonie du dessin.
   */
  @property({ type: String, attribute: "import-colors-from" }) importColorsFrom = "";
  /** DP de vue partagée `{ x, y, zoom, rotation }`, lu et écrit : des toiles superposées restent alignées. */
  @property({ type: String, attribute: "view-sync" }) viewSync = "";
  private sync: ViewSync | null = null;
  private importRuns = -1;
  private importState: unknown = null;
  /** Dernier import : `{ layers, regions, ms }`, ou `{ error }`. */
  private imported: { layers: number; regions: number; ms: number } | { error: string } | null = null;
  @property({ type: String }) control = "";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";
  @property({ type: Boolean }) readonly = false;
  /**
   * Tolérance de simplification des traits terminés, en pixels d'écran au moment du tracé (0 : aucune).
   * Les points à moins de cette distance de la courbe simplifiée sont retirés (pression comprise).
   */
  @property({ type: Number }) simplify = 0.35;
  /**
   * Export PNG (`savePng`) : `export-scale` multiplie la résolution (1 à 8 ; les traits sont redessinés nets à
   * cette taille, ce n'est pas un agrandissement) ; `export-area` = `view` (la vue courante, défaut) ou
   * `content` (tout le dessin, cadré). Aussi en direct dans le DP `control` : `{ savePng: n, exportScale, exportArea }`.
   */
  @property({ type: Number, attribute: "export-scale" }) exportScale = 1;
  @property({ type: String, attribute: "export-area" }) exportArea: "view" | "content" = "view";
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
  /**
   * Carnet de dessins local (IndexedDB) : espace de noms sous lequel les dessins sont rangés (vide : aucune
   * persistance). Le dessin ouvert est réenregistré peu après chaque changement et rouvert au chargement.
   * Commandes du DP `control` : `newDrawing`, `openDrawing` (+ `drawingId`), `duplicateDrawing`,
   * `deleteDrawing` (+ `drawingId`, défaut : le dessin ouvert), `renameDrawing` (+ `drawingName`).
   */
  @property({ type: String }) persist = "";
  /** Stockage du carnet (remplaçable pour les tests). */
  static drawingBackend: DrawingBackend = new IdbBackend();

  @query("canvas") private canvasEl!: HTMLCanvasElement;
  @query("canvas.overlay") private overlayEl!: HTMLCanvasElement;

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
  private mode: "none" | "draw" | "erase" | "pan" | "pick" | "select" = "none";
  /** Régions d'aplat sélectionnées (par référence : une région remplacée sort de la sélection). */
  private selected = new Set<Region>();
  private selectStart: { x: number; y: number } | null = null;
  /** Dernière couleur prélevée à la pipette (#rrggbb). */
  private picked: string | null = null;
  private stroke: Stroke | null = null;
  private stamper: StrokeStamper | null = null;
  private trembler = new Trembler(0);
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
  /** Retouche en aperçu : traits calculés (non enregistrés), régions issues, liste de départ. */
  private pending: { strokes: Stroke[]; fresh: Set<Region>; base: Stroke[]; len: number } | null = null;
  private liveEdit: { op?: unknown; amount?: unknown; colors?: unknown } = {};
  private editSig = "";
  private editTimer = 0;
  private editError: string | null = null;
  private selVersion = 0;
  /** Carnet. */
  private libStatus: SketchState["library"]["status"] = "off";
  private drawingId: string | null = null;
  private drawingName = "";
  private drawingCreated = 0;
  private drawings: DrawingMeta[] = [];
  private thumbUrls = new Map<Blob, string>();
  private savedRef: { ref: Stroke[] | null; len: number } = { ref: null, len: 0 };
  private saveTimer = 0;
  private libToken = 0;

  get frameSeq(): number { return this.seq; }
  getFrameCanvas(): HTMLCanvasElement | null { return this.canvasEl ?? null; }
  registerFrameConsumer(token: object = {}): void { this.consumers.add(token); }
  unregisterFrameConsumer(token: object = {}): void { this.consumers.delete(token); }

  /** Réglages effectifs : attributs puis réglages en direct. */
  brush(): BrushSettings {
    const base = sanitizeBrush({ ...BRUSH_DEFAULTS }, { size: this.size, hardness: this.hardness, opacity: this.opacity, spacing: this.spacing, smoothing: this.smoothing, color: this.color, pressure: this.pressure, tip: this.tip, angle: this.angle, angleFollow: this.angleFollow, angleJitter: this.angleJitter, sizeJitter: this.sizeJitter, scatter: this.scatter, roundness: this.roundness, tremble: this.tremble });
    return sanitizeBrush(base, this.live);
  }

  /**
   * Précision du tracé : tolérance de simplification (px d'écran, 0..8) ; `simplify` de `brush-from` en direct,
   * sinon l'attribut. 0 = chaque point gardé (tracé le plus fidèle), plus haut = tracé plus épuré.
   */
  simplifyPx(): number {
    const v = Number(this.live.simplify);
    const raw = this.live.simplify !== undefined && this.live.simplify !== "" && Number.isFinite(v) ? v : Number(this.simplify);
    return Math.max(0, Math.min(8, raw || 0));
  }

  /** Mode de fusion effectif : réglage en direct, sinon attribut. */
  currentBlend(): BlendMode {
    return sanitizeBlend(this.live.blend, sanitizeBlend(this.blend));
  }

  private currentTool(): string {
    const t = typeof this.live.tool === "string" ? (this.live.tool as string) : this.tool;
    return t === "erase" || t === "hand" || t === "pick" || t === "select" || t === "select-color" ? t : "paint";
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
      @keydown=${this.onKey} @contextmenu=${(e: Event) => e.preventDefault()}></canvas><canvas class="overlay" aria-hidden="true"
      width=${Math.round(w * dpr)} height=${Math.round(h * dpr)}></canvas>`;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    window.addEventListener("keydown", this.onSpace);
    window.addEventListener("keyup", this.onSpace);
    window.addEventListener("pagehide", this.flushSave);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  disconnectedCallback(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    window.removeEventListener("keydown", this.onSpace);
    window.removeEventListener("keyup", this.onSpace);
    cancelAnimationFrame(this.raf);
    clearTimeout(this.settle);
    clearTimeout(this.editTimer);
    window.removeEventListener("pagehide", this.flushSave);
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.saveTimer) this.flushSave();
    if (this.last) URL.revokeObjectURL(this.last.url);
    for (const u of this.thumbUrls.values()) URL.revokeObjectURL(u);
    this.thumbUrls.clear();
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    this.canvasEl.addEventListener("wheel", this.onWheel, { passive: false });
    this.layerDirty = true;
    this.compose();
    this.publish();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("control") || c.has("brushFrom") || c.has("tipFrom") || c.has("viewFrom") || c.has("viewSync") || c.has("importFrom")) this.listen();
    if (c.has("width") || c.has("height")) { this.layer = null; this.layerDirty = true; this.compose(); }
    if (c.has("background")) this.compose();
    if (c.has("tool") && c.get("tool") !== undefined && this.tool !== "select" && this.tool !== "select-color" && this.selected.size) { this.selected.clear(); this.drawOverlay(); }
    if (c.has("tool") || c.has("color") || c.has("size")) this.publish();
    if (c.has("persist")) void this.openLibrary();
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
    if (this.brushFrom) this.unsubs.push(listenDp(this.brushFrom, (v) => {
      const before = this.live.color;
      this.live = { ...(v && typeof v === "object" ? (v as Record<string, unknown>) : {}), ...(this.live.tip !== undefined && this.tipFrom ? { tip: this.live.tip } : {}) };
      // Outil de sélection : une couleur choisie (palette, nuancier) recolore la sélection.
      const tool = this.currentTool();
      if ((tool === "select" || tool === "select-color") && this.selected.size && typeof this.live.color === "string" && this.live.color !== before) {
        this.recolor(this.live.color);
        return;
      }
      if (tool !== "select" && tool !== "select-color" && this.selected.size) { this.selected.clear(); this.drawOverlay(); }
      this.publish();
    }));
    if (this.tipFrom) this.unsubs.push(listenDp(this.tipFrom, (v) => { this.live = { ...this.live, tip: tipFromValue(v) }; this.publish(); }));
    if (this.importFrom) {
      // Un objet publié arrive clé par clé : on relit la valeur complète après la publication (microtâche).
      const path = this.importFrom;
      let first = true, queued = false;
      this.unsubs.push(listenDp(path, () => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (this.importFrom !== path) return;
          const v = plain(get(path));
          this.importState = v;
          const o = (v && typeof v === "object" ? v : {}) as { status?: unknown; runs?: unknown };
          const runs = typeof o.runs === "number" ? o.runs : -1;
          // Un résultat déjà là au branchement n'est pas réimporté ; chaque nouveau calcul prêt l'est (import-auto).
          if (first) { first = false; this.importRuns = runs; return; }
          if (o.status !== "ready" || runs === this.importRuns) return;
          this.importRuns = runs;
          if (this.importAuto) this.importShapes();
        });
      }));
    }
    this.sync = this.viewSync ? new ViewSync(this.viewSync) : null;
    if (this.sync) {
      this.unsubs.push(this.sync.listen((v) => {
        const next = sanitizeView(v, this.view);
        if (next.x === this.view.x && next.y === this.view.y && next.zoom === this.view.zoom && next.rotation === this.view.rotation) return;
        this.setView(next);
      }));
    }
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
        if ("import" in c && this.trigger("import").feed(c.import)) this.importShapes();
        if (typeof c.exportScale === "number" || typeof c.exportScale === "string") this.liveExport.scale = Number(c.exportScale);
        if (c.exportArea === "view" || c.exportArea === "content") this.liveExport.area = c.exportArea;
        for (const cmd of ["undo", "redo", "clear", "save", "savePng", "fit", "reset", "zoomIn", "zoomOut", "rotateLeft", "rotateRight", "straighten", "selectAll", "deselect", "deleteSelection"] as const) {
          if (cmd in c && this.trigger(cmd).feed(c[cmd])) this[cmd]();
        }
        // `{recolor: n, color: "#…"}` : recolore la sélection (couleur du pinceau si `color` est absente).
        if ("recolor" in c && this.trigger("recolor").feed(c.recolor)) this.recolor(typeof c.color === "string" ? c.color : this.brush().color);
        // Retouches : `edit` + `editAmount` (px d'écran) + `editColors` → aperçu ; `editApply` / `editCancel` (compteurs).
        if ("editApply" in c && this.trigger("editApply").feed(c.editApply)) this.applyEdit();
        if ("editCancel" in c && this.trigger("editCancel").feed(c.editCancel)) this.cancelEdit();
        this.liveEdit = { op: c.edit, amount: c.editAmount, colors: c.editColors };
        this.queueEdit();
        // Carnet.
        const id = isDrawingId(c.drawingId) ? c.drawingId : null;
        if ("newDrawing" in c && this.trigger("newDrawing").feed(c.newDrawing)) void this.newDrawing();
        if ("openDrawing" in c && this.trigger("openDrawing").feed(c.openDrawing) && id) void this.openDrawing(id);
        if ("duplicateDrawing" in c && this.trigger("duplicateDrawing").feed(c.duplicateDrawing)) void this.duplicateDrawing();
        if ("deleteDrawing" in c && this.trigger("deleteDrawing").feed(c.deleteDrawing)) void this.deleteDrawing(id ?? this.drawingId);
        if ("renameDrawing" in c && this.trigger("renameDrawing").feed(c.renameDrawing)) void this.renameDrawing(c.drawingName);
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
    drawStrokes(s, this.pending?.strokes ?? this.doc.strokes, visibleRect(this.layerView, s.w, s.h));
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
    this.drawOverlay();
  }

  /**
   * Contour de la sélection, sur une toile à part (jamais dans l'image : ni export, ni source d'images) : trait
   * clair puis pointillés sombres, lisible sur toutes les couleurs, à épaisseur constante à l'écran.
   */
  private drawOverlay(): void {
    const c = this.overlayEl;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const { w, h, dpr } = this.dims();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const shown = this.pending ? this.pending.fresh : this.selected;
    if (!shown.size) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const path = new Path2D();
    for (const r of shown) {
      for (const poly of r.shape) for (const ring of poly) {
        ring.forEach(([x, y], i) => {
          const [sx, sy] = toScreen(this.view, x, y, w, h);
          if (i === 0) path.moveTo(sx, sy); else path.lineTo(sx, sy);
        });
        path.closePath();
      }
    }
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.setLineDash([]);
    ctx.stroke(path);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(17,17,17,0.95)";
    ctx.setLineDash([5, 4]);
    ctx.stroke(path);
    ctx.setLineDash([]);
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
    this.sync?.write(v);
    if (immediate) { this.layerDirty = true; this.compose(); } else { this.schedule(); this.settleLater(); }
    this.publish();
  }

  private invalidate(): void {
    // Le dessin a changé sous l'aperçu (trait, annulation…) : l'aperçu ne vaut plus.
    if (this.pending && (this.pending.base !== this.doc.strokes || this.pending.len !== this.doc.strokes.length)) this.pending = null;
    this.pruneSelection();
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
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") this.selectAll();
    else if ((e.key === "Delete" || e.key === "Backspace") && this.selected.size && !this.readonly) this.deleteSelection();
    else if (e.key === "Escape" && this.pending) this.cancelEdit();
    else if (e.key === "Escape" && this.selected.size) this.deselect();
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
    if (tool === "select" || tool === "select-color") {
      this.mode = "select";
      this.selectStart = p;
      return;
    }
    if (tool === "pick" || (e.altKey && tool === "paint")) {
      this.mode = "pick";
      this.pick(e, false);
      return;
    }
    this.startStroke(p, e, tool === "erase");
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.local(e);
    if (this.nav.move(e.pointerId, p)) return;
    if (e.pointerId !== this.pointer) return;
    if (this.mode === "pick") { this.pick(e, false); return; }
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
    else if (this.mode === "pick") this.pick(e, e.type === "pointerup");
    else if (this.mode === "select" && e.type === "pointerup") this.selectAt(this.local(e), e.shiftKey);
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
    this.trembler = new Trembler(seed);
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
    const t = this.trembler.apply(s.x, s.y, s.p, b.tremble, b.size);
    this.addPoint(t.x, t.y, t.p);
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
          const t = this.trembler.apply(s.x, s.y, s.p, b.tremble, b.size);
          this.addPoint(t.x, t.y, t.p);
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
    const tol = this.simplifyPx();
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
  /**
   * Importe le dernier résultat de `import-from` (`sonic-vectorize`) en aplats : chaque couche, du dessous au
   * dessus, est peinte opaque dans la carte d'aplats (les couches empilées recouvrent les précédentes), les
   * morceaux de même couleur s'unissent. Formes placées selon `import-place`, simplifiées à `simplify` px
   * d'écran, couleurs de `import-skip` ignorées. Une étape d'annulation. Retourne le nombre de couches importées.
   */
  importShapes(): number {
    const t0 = performance.now();
    const fail = (error: string) => { this.imported = { error }; this.publish(); return 0; };
    if (this.importFrom) this.importState = plain(get(this.importFrom));
    const v = (this.importState && typeof this.importState === "object" ? this.importState : {}) as {
      status?: unknown; width?: unknown; height?: unknown; paths?: unknown; frame?: unknown;
    };
    const W = Number(v.width), H = Number(v.height);
    const paths = Array.isArray(v.paths) ? v.paths.filter((p): p is { color: string; d: string } => !!p && typeof p.color === "string" && typeof p.d === "string" && p.d.length > 0) : [];
    if (v.status !== "ready" || !(W > 0 && H > 0) || !paths.length) return fail("rien à importer");
    const canvas = this.canvasEl;
    if (!canvas) return fail("toile pas prête");
    const cr = canvas.getBoundingClientRect();
    if (!(cr.width > 0 && cr.height > 0)) return fail("toile non affichée");
    const { w, h } = this.dims();
    // Image analysée → viewport : là où la source était affichée, ou ajustée dans la toile.
    const frame = Array.isArray(v.frame) && v.frame.length === 6 && v.frame.every((n) => Number.isFinite(n)) ? (v.frame as number[]) : null;
    const corners = frame ? [[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => applyAffine(frame, x, y)) : [];
    const onCanvas = corners.length > 0 &&
      Math.min(...corners.map((c) => c[0])) < cr.right && Math.max(...corners.map((c) => c[0])) > cr.left &&
      Math.min(...corners.map((c) => c[1])) < cr.bottom && Math.max(...corners.map((c) => c[1])) > cr.top;
    let m: number[];
    if (frame && (this.importPlace === "screen" || (this.importPlace !== "view" && onCanvas))) m = frame;
    else {
      const k = Math.min((cr.width * 0.9) / W, (cr.height * 0.9) / H);
      m = [k, 0, 0, k, cr.left + (cr.width - W * k) / 2, cr.top + (cr.height - H * k) / 2];
    }
    const toW = (x: number, y: number): Pt => {
      const [cx, cy] = applyAffine(m, x, y);
      return toWorld(this.view, ((cx - cr.left) / cr.width) * w, ((cy - cr.top) / cr.height) * h, w, h) as Pt;
    };
    // Tolérance : `simplify` px d'écran, ramenés aux pixels de l'image (courbes aplaties) puis au monde.
    const pxPerImage = Math.hypot(m[0], m[1]) * (w / cr.width) || 1;
    const tolPx = Math.max(0.25, Math.min(8, Number(this.simplify) || 0.35));
    const skip = this.skipColors();
    const recolor = this.importColorsFrom ? paletteOf(plain(get(this.importColorsFrom))) : [];
    const rank = new Map<string, number>();
    const near = (a: Rgba, b: Rgba) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 0.06;
    const layers: { rgba: Rgba; shape: Multi }[] = [];
    for (const p of paths) {
      const rgba = parseColor(p.color);
      if (!rgba || skip.some((c) => near(c, rgba))) continue;
      if (recolor.length) {
        const key = p.color.toLowerCase();
        if (!rank.has(key)) rank.set(key, rank.size);
        const c = recolor[rank.get(key)! % recolor.length];
        rgba[0] = c[0]; rgba[1] = c[1]; rgba[2] = c[2];
      }
      const local = pathToMulti(p.d, tolPx / pxPerImage);
      if (!local?.length) continue;
      const world = local.map((poly) => poly.map((ring) => ring.map(([x, y]) => toW(x, y))));
      const shape = simplifyMulti(world, tolPx / this.view.zoom);
      if (shape.length) layers.push({ rgba: [rgba[0], rgba[1], rgba[2], 1], shape });
    }
    if (!layers.length) return fail("aucune forme à importer");
    try {
      const all = layers.map((l) => multiBBox(l.shape));
      const x0 = Math.min(...all.map((b) => b.x)), y0 = Math.min(...all.map((b) => b.y));
      const ob = { x: x0, y: y0, w: Math.max(...all.map((b) => b.x + b.w)) - x0, h: Math.max(...all.map((b) => b.y + b.h)) - y0 };
      const strokes = this.doc.strokes;
      const index = this.targetFlat(ob);
      const top = index < strokes.length ? strokes[index] : null;
      const back = this.backdropAt(index);
      let regions = top ? top.flat! : [];
      for (const l of layers) {
        regions = paintFlat(regions, l.shape, l.rgba, 1, "normal", back);
        if (flatVertices(regions) > MAX_FLAT_VERTICES) return fail("trop de sommets : réduire les couleurs ou augmenter la tolérance");
      }
      const id = top ? top.id : this.doc.nextId++;
      const brush = { ...BRUSH_DEFAULTS, hardness: 1, opacity: 1, pressure: false, blend: undefined };
      const item: Stroke = { id, brush, pts: [], seed: 1, flat: regions, bbox: flatBBox(regions) };
      this.doc.replace([...strokes.slice(0, index), ...(regions.length ? [item] : []), ...strokes.slice(index + (top ? 1 : 0))]);
      this.imported = { layers: layers.length, regions: regions.length, ms: Math.round(performance.now() - t0) };
      this.invalidate();
      this.dispatchEvent(new CustomEvent("sketch-import", { detail: this.imported, bubbles: true, composed: true }));
      return layers.length;
    } catch (e) {
      return fail(e instanceof Error ? e.message : "import impossible");
    }
  }

  /** Couleurs ignorées à l'import (`import-skip`). */
  private skipColors(): Rgba[] {
    return this.importSkip.split(",").map((x) => x.trim()).filter(Boolean).flatMap((x) => {
      if (x === "background") {
        const c = this.rgbaOf(this.backgroundColor());
        return c && c[3] >= 0.999 ? [c] : [];
      }
      const c = parseColor(x);
      return c ? [c] : [];
    });
  }

  /** Index de la carte d'aplats où peindre une forme de boîte `ob` (ou `strokes.length` : nouvelle carte au-dessus). */
  private targetFlat(ob: { x: number; y: number; w: number; h: number }): number {
    const strokes = this.doc.strokes;
    const touches = (b: { x: number; y: number; w: number; h: number }) => b.x <= ob.x + ob.w && b.x + b.w >= ob.x && b.y <= ob.y + ob.h && b.y + b.h >= ob.y;
    for (let i = strokes.length - 1; i >= 0; i--) {
      if (strokes[i].flat) return i;
      if (touches(strokes[i].bbox)) break;
    }
    return strokes.length;
  }

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
      const index = this.targetFlat(multiBBox(outline));
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
   * Pipette (contrat `PickSource` de `shared/pick`) : couleur de ce calque sous le point du viewport. Lue dans
   * le modèle quand c'est sûr — le point tombe dans une région d'aplat opaque sans fusion différée (couleur
   * exacte, y compris une couleur née d'une fusion), ou sur le fond à travers un trou de gomme ou hors de
   * tout. Sinon (traits en empreintes, couleurs translucides, fusions différées) : le pixel affiché.
   */
  pickAt(clientX: number, clientY: number): { pixel: Pixel; exact?: boolean } | null {
    const canvas = this.canvasEl;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0) || clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) return null;
    const { w, h } = this.dims();
    const sx = ((clientX - rect.left) / rect.width) * w, sy = ((clientY - rect.top) / rect.height) * h;
    const [x, y] = toWorld(this.view, sx, sy, w, h);
    const tol = 0.5 / this.view.zoom;
    const px = (c: Rgba): Pixel => [c[0] * 255, c[1] * 255, c[2] * 255, c[3] * 255].map(Math.round) as Pixel;
    const bgRgba = (): Rgba => { const c = this.backgroundColor(); return (c ? this.rgbaOf(c) : null) ?? [0, 0, 0, 0]; };
    const strokes = this.doc.strokes;
    let exact: Rgba | null | undefined;
    for (let i = strokes.length - 1; i >= 0 && exact === undefined; i--) {
      const s = strokes[i], b = s.bbox;
      if (x < b.x - tol || x > b.x + b.w + tol || y < b.y - tol || y > b.y + b.h + tol) continue;
      if (s.mask) { if (shapeHit(s.mask, x, y, 0)) exact = bgRgba(); continue; }
      if (s.flat) {
        const hits = s.flat.filter((g) => shapeHit(g.shape, x, y, tol));
        if (!hits.length) continue;
        // Sur une frontière (moins d'un demi-pixel), plusieurs régions : la valeur affichée tranchera.
        const g = hits.length === 1 && shapeHit(hits[0].shape, x, y, 0) ? hits[0] : null;
        exact = g && g.rgba[3] >= 0.999 && !g.blend ? g.rgba : null;
        continue;
      }
      if (strokeHit(s, x, y, tol)) exact = null;
    }
    if (exact === undefined) exact = bgRgba();
    if (exact) return { pixel: px(exact), exact: true };
    const pixel = readCanvasPixel(canvas, ((clientX - rect.left) / rect.width) * canvas.width, ((clientY - rect.top) / rect.height) * canvas.height);
    return pixel ? { pixel } : null;
  }

  /**
   * Pipette : la couleur vue sous le point (calques et autres sources d'images en dessous compris) devient
   * celle du pinceau (aussi écrite dans `brush-from`, pour que la palette et les nuanciers la montrent). Au
   * lever, l'outil revient au pinceau si la pipette était choisie par `brush-from`.
   */
  private pick(e: { clientX: number; clientY: number }, done: boolean): void {
    const c = pickColorAt(e.clientX, e.clientY);
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

  /* ------------------------------------------------------------ sélection */

  private selectionTolerance(): number {
    const v = this.live.tolerance ?? this.tolerance;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
  }

  private selectionContiguous(): boolean {
    return typeof this.live.contiguous === "boolean" ? (this.live.contiguous as boolean) : this.contiguous;
  }

  /**
   * Clic de sélection (un glissé de plus de 6 px est ignoré) : la région sous le point, ou toutes celles de sa
   * couleur ; Maj ajoute (ou retire, si tout y est déjà). Un clic dans le vide sans Maj vide la sélection.
   */
  private selectAt(p: { x: number; y: number }, additive: boolean): void {
    const start = this.selectStart;
    this.selectStart = null;
    if (start && Math.hypot(p.x - start.x, p.y - start.y) > 6) return;
    const { w, h } = this.dims();
    const [x, y] = toWorld(this.view, p.x, p.y, w, h);
    const hit = regionAt(this.doc.strokes, x, y, 3 / this.view.zoom);
    const picked = !hit ? [] : this.currentTool() === "select-color"
      ? similarRegions(this.doc.strokes, hit, { tolerance: this.selectionTolerance(), contiguous: this.selectionContiguous() })
      : [hit];
    if (!additive) this.selected = new Set(picked);
    else if (picked.length && picked.every((r) => this.selected.has(r))) for (const r of picked) this.selected.delete(r);
    else for (const r of picked) this.selected.add(r);
    this.selectionChanged();
  }

  /** Retire de la sélection les régions qui n'existent plus (remplacées par un trait, une gomme, annulées). */
  private pruneSelection(): void {
    if (!this.selected.size) return;
    const present = new Set(allRegions(this.doc.strokes));
    for (const r of [...this.selected]) if (!present.has(r)) this.selected.delete(r);
  }

  private selectionChanged(): void {
    this.selVersion++;
    this.queueEdit();
    this.drawOverlay();
    this.publish();
    this.dispatchEvent(new CustomEvent("sketch-select", { detail: selectionInfo(this.selected), bubbles: true, composed: true }));
  }

  /** Sélectionne toutes les régions d'aplat. */
  selectAll(): void {
    this.selected = new Set(allRegions(this.doc.strokes));
    this.selectionChanged();
  }

  deselect(): void {
    if (!this.selected.size) return;
    this.selected.clear();
    this.selectionChanged();
  }

  /**
   * Recolore la sélection (une étape d'annulation) : chaque région prend la vraie couleur donnée et se ressoude
   * à ses voisines de même couleur ; la sélection suit les régions obtenues.
   */
  recolor(color: string): boolean {
    if (!this.selected.size || this.readonly) return false;
    const rgba = this.rgbaOf(color);
    if (!rgba) { this.error = `couleur illisible : ${color}`; this.publish(); return false; }
    try {
      const next = new Set<Region>();
      const after = this.doc.strokes.map((s) => {
        if (!s.flat || !s.flat.some((r) => this.selected.has(r))) return s;
        const { regions, fresh } = recolorFlat(s.flat, this.selected, rgba);
        for (const r of fresh) next.add(r);
        return { ...s, flat: regions, bbox: flatBBox(regions) };
      });
      this.doc.replace(after);
      this.selected = next;
      this.error = null;
    } catch {
      this.error = "recoloration impossible";
    }
    this.invalidate();
    this.dispatchEvent(new CustomEvent("sketch-select", { detail: selectionInfo(this.selected), bubbles: true, composed: true }));
    return !this.error;
  }

  /** Supprime les régions sélectionnées (une étape d'annulation). */
  deleteSelection(): void {
    if (!this.selected.size || this.readonly) return;
    const after: Stroke[] = [];
    for (const s of this.doc.strokes) {
      if (!s.flat || !s.flat.some((r) => this.selected.has(r))) { after.push(s); continue; }
      const regions = deleteFlat(s.flat, this.selected);
      if (regions.length) after.push({ ...s, flat: regions, bbox: flatBBox(regions) });
    }
    this.doc.replace(after);
    this.selected.clear();
    this.invalidate();
    this.dispatchEvent(new CustomEvent("sketch-select", { detail: selectionInfo(this.selected), bubbles: true, composed: true }));
  }


  /* ------------------------------------------------------------ retouches de la sélection */

  private editOp(): FlatEdit | null {
    const op = this.liveEdit.op;
    return typeof op === "string" && (FLAT_EDITS as readonly string[]).includes(op) ? (op as FlatEdit) : null;
  }

  /** Relance l'aperçu quand l'opération, ses réglages ou la sélection changent (regroupé sur ~40 ms). */
  private queueEdit(): void {
    const op = this.editOp();
    const sig = `${op}|${String(this.liveEdit.amount)}|${JSON.stringify(this.liveEdit.colors ?? null)}|${this.selVersion}`;
    if (sig === this.editSig) return;
    this.editSig = sig;
    clearTimeout(this.editTimer);
    if (!op) { if (this.pending) this.cancelEdit(); return; }
    this.editTimer = window.setTimeout(() => this.previewEdit(op, Number(this.liveEdit.amount), this.liveEdit.colors), 40);
  }

  /** Couleurs des anneaux : liste ou chaîne « #a, darker » ; mots-clés déduits de la couleur dominante. */
  private editColors(raw: unknown): Rgba[] {
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,;]+/) : [];
    let base: Rgba = [0, 0, 0, 1], best = -1;
    for (const r of this.selected) {
      const a = multiArea(r.shape);
      if (a > best) { best = a; base = r.rgba; }
    }
    const out = list.map((c) => deriveColor(c, base)).filter((c): c is Rgba => !!c).slice(0, 8);
    return out.length ? out : [deriveColor("darker", base)!];
  }

  /**
   * Montre le résultat d'une retouche de la sélection sans l'enregistrer : `simplify` (tolérance), `grow`
   * (décalage signé : négatif = réduire), `smooth` (rayon d'arrondi), `outline` (épaisseur de chaque anneau,
   * `colors` : un anneau par couleur, CSS ou `darker`, `lighter`, `complement`, `muted`, `vivid`, `black`, `white`
   * déduites de la couleur dominante). `amount` en pixels d'écran. `applyEdit` l'enregistre, `cancelEdit` l'abandonne.
   */
  previewEdit(op: FlatEdit, amount: number, colors?: unknown): boolean {
    this.pending = null;
    this.editError = null;
    if (!this.selected.size || this.readonly || !(FLAT_EDITS as readonly string[]).includes(op) || !Number.isFinite(amount) || amount === 0) {
      this.layerDirty = true; this.compose(); this.publish();
      return false;
    }
    const px = op === "grow" ? Math.max(-400, Math.min(400, amount)) : Math.max(0.1, Math.min(400, Math.abs(amount)));
    const world = px / this.view.zoom;
    const rings = op === "outline" ? this.editColors(colors) : undefined;
    try {
      const fresh = new Set<Region>();
      const base = this.doc.strokes;
      const strokes = base.map((s) => {
        if (!s.flat || !s.flat.some((r) => this.selected.has(r))) return s;
        const res = editFlat(s.flat, this.selected, op, { amount: world, colors: rings });
        for (const r of res.fresh) fresh.add(r);
        return res.regions.length ? { ...s, flat: res.regions, bbox: flatBBox(res.regions) } : null;
      }).filter((s): s is Stroke => !!s);
      this.pending = { strokes, fresh, base, len: base.length };
    } catch {
      this.editError = "retouche impossible";
    }
    this.layerDirty = true;
    this.compose();
    this.publish();
    return !!this.pending;
  }

  /** Enregistre la retouche en aperçu (une étape d'annulation) ; la sélection suit les régions obtenues. */
  applyEdit(): boolean {
    const p = this.pending;
    if (!p || p.base !== this.doc.strokes) { this.pending = null; return false; }
    this.pending = null;
    this.doc.replace(p.strokes);
    this.selected = new Set(p.fresh);
    this.invalidate();
    this.dispatchEvent(new CustomEvent("sketch-select", { detail: selectionInfo(this.selected), bubbles: true, composed: true }));
    return true;
  }

  /** Abandonne l'aperçu (le même réglage n'est pas remontré tant qu'il ne change pas). */
  cancelEdit(): void {
    clearTimeout(this.editTimer);
    if (!this.pending && !this.editError) return;
    this.pending = null;
    this.editError = null;
    this.layerDirty = true;
    this.compose();
    this.publish();
  }

  /* ------------------------------------------------------------ carnet de dessins */

  private get backend(): DrawingBackend { return (this.constructor as typeof SonicSketch).drawingBackend; }

  private thumbUrl(b: Blob | null): string {
    if (!b) return "";
    let u = this.thumbUrls.get(b);
    if (!u) { u = URL.createObjectURL(b); this.thumbUrls.set(b, u); }
    return u;
  }

  private setDrawings(list: DrawingMeta[]): void {
    const keep = new Set(list.map((d) => d.thumb).filter((b): b is Blob => !!b));
    for (const [b, u] of this.thumbUrls) if (!keep.has(b)) { URL.revokeObjectURL(u); this.thumbUrls.delete(b); }
    this.drawings = list;
  }

  private defaultName(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `Dessin du ${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** Branche le carnet (`persist`) : liste les dessins et rouvre le dernier ouvert si la toile est vide. */
  private async openLibrary(): Promise<void> {
    const token = ++this.libToken;
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    if (!this.persist) { this.libStatus = "off"; this.setDrawings([]); this.publish(); return; }
    this.libStatus = "loading";
    this.publish();
    try {
      const ns = this.persist;
      const list = await listDrawings(this.backend, ns);
      const cur = await readCurrent(this.backend, ns);
      if (token !== this.libToken) return;
      this.setDrawings(list);
      const rec = cur && !this.doc.strokes.length ? await this.backend.get(ns, cur) : null;
      if (token !== this.libToken) return;
      if (rec) this.load(rec);
      else this.markSaved();
      this.libStatus = "saved";
    } catch {
      if (token === this.libToken) this.libStatus = "error";
    }
    this.publish();
  }

  /** Montre un enregistrement : traits relus, historique neuf, vue rendue. */
  private load(rec: DrawingRecord): void {
    const strokes = readStrokes(rec.data) ?? [];
    this.cancelStroke();
    this.pending = null;
    this.selected.clear();
    this.doc = new Doc();
    this.doc.strokes = strokes;
    this.doc.nextId = strokes.length + 1;
    this.drawingId = rec.id;
    this.drawingName = rec.name;
    this.drawingCreated = rec.created;
    this.markSaved();
    this.setView(readView(rec.view), true);
    this.invalidate();
    this.selectionChanged();
  }

  private markSaved(): void { this.savedRef = { ref: this.doc.strokes, len: this.doc.strokes.length }; }

  private dirty(): boolean { return this.savedRef.ref !== this.doc.strokes || this.savedRef.len !== this.doc.strokes.length; }

  private queueSave(): void {
    if (!this.persist || this.libStatus === "loading" || this.libStatus === "off" || !this.dirty() || this.saveTimer) return;
    this.saveTimer = window.setTimeout(() => { this.saveTimer = 0; void this.saveNow(); }, 800);
  }

  private flushSave = (): void => {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    void this.saveNow();
  };

  private onVisibility = (): void => { if (document.visibilityState === "hidden") this.flushSave(); };

  /** Vignette PNG du dessin entier (~240 px), ou `null`. */
  private thumbnail(): Promise<Blob | null> {
    if (!this.doc.strokes.length) return Promise.resolve(null);
    const { w, h } = this.dims();
    const c = this.renderImage({ area: "content", scale: Math.max(0.25, 240 / Math.max(w, h, 1)) });
    return new Promise((resolve) => { if (!c || typeof c.toBlob !== "function") resolve(null); else c.toBlob((b) => resolve(b), "image/png"); });
  }

  /** Enregistre le dessin ouvert (le crée au premier trait). */
  async saveNow(): Promise<boolean> {
    if (!this.persist) return false;
    const ns = this.persist;
    const strokes = this.doc.strokes, len = strokes.length;
    if (!this.drawingId && !len) { this.markSaved(); return true; }
    if (!this.drawingId) { this.drawingId = newDrawingId(); this.drawingName = this.drawingName || this.defaultName(); this.drawingCreated = Date.now(); }
    const id = this.drawingId;
    this.libStatus = "saving";
    this.publish();
    try {
      const thumb = await this.thumbnail();
      const rec: DrawingRecord = {
        ns, id, name: this.drawingName, created: this.drawingCreated || Date.now(), updated: Date.now(), strokes: len,
        thumb, view: { ...this.view }, nextId: this.doc.nextId, data: writeStrokes(strokes.slice(0, len)),
      };
      await this.backend.put(rec);
      await writeCurrent(this.backend, ns, id);
      if (ns !== this.persist) return false;
      this.savedRef = { ref: strokes, len };
      const meta: DrawingMeta = { id, name: rec.name, created: rec.created, updated: rec.updated, strokes: len, thumb };
      this.setDrawings([meta, ...this.drawings.filter((d) => d.id !== id)]);
      this.libStatus = "saved";
    } catch {
      this.libStatus = "error";
    }
    this.publish();
    if (this.dirty()) this.queueSave();
    return this.libStatus === "saved";
  }

  /** Enregistre le dessin ouvert puis montre une toile vierge (un nouveau dessin, créé au premier trait). */
  async newDrawing(): Promise<void> {
    if (this.saveTimer || this.dirty()) { clearTimeout(this.saveTimer); this.saveTimer = 0; await this.saveNow(); }
    this.cancelStroke();
    this.pending = null;
    this.selected.clear();
    this.doc = new Doc();
    this.drawingId = null;
    this.drawingName = this.defaultName();
    this.drawingCreated = 0;
    this.markSaved();
    if (this.persist) await writeCurrent(this.backend, this.persist, null).catch(() => undefined);
    this.setView({ ...DEFAULT_VIEW }, true);
    this.invalidate();
    this.selectionChanged();
  }

  /** Enregistre le dessin ouvert puis ouvre `id`. */
  async openDrawing(id: string): Promise<boolean> {
    if (!this.persist || !isDrawingId(id) || id === CURRENT) return false;
    if (id === this.drawingId) return true;
    if (this.saveTimer || this.dirty()) { clearTimeout(this.saveTimer); this.saveTimer = 0; await this.saveNow(); }
    try {
      const rec = await this.backend.get(this.persist, id);
      if (!rec) return false;
      this.load(rec);
      await writeCurrent(this.backend, this.persist, id);
      return true;
    } catch {
      this.libStatus = "error";
      this.publish();
      return false;
    }
  }

  /** Copie du dessin ouvert, qui devient le dessin ouvert. */
  async duplicateDrawing(): Promise<void> {
    if (!this.persist || !this.doc.strokes.length) return;
    if (this.saveTimer || this.dirty()) { clearTimeout(this.saveTimer); this.saveTimer = 0; await this.saveNow(); }
    this.drawingId = null;
    this.drawingName = cleanName(`${this.drawingName || "Dessin"} (copie)`, "Copie");
    this.drawingCreated = 0;
    this.savedRef = { ref: null, len: -1 };
    await this.saveNow();
  }

  /** Supprime un dessin du carnet ; supprimer le dessin ouvert montre une toile vierge. */
  async deleteDrawing(id: string | null): Promise<void> {
    if (!this.persist || !id || !isDrawingId(id) || id === CURRENT) return;
    try {
      await this.backend.remove(this.persist, id);
    } catch {
      this.libStatus = "error";
    }
    this.setDrawings(this.drawings.filter((d) => d.id !== id));
    if (id === this.drawingId) {
      clearTimeout(this.saveTimer);
      this.saveTimer = 0;
      this.drawingId = null;
      this.markSaved();
      await this.newDrawing();
    } else this.publish();
  }

  /** Renomme le dessin ouvert. */
  async renameDrawing(name: unknown): Promise<void> {
    this.drawingName = cleanName(name, this.drawingName || this.defaultName());
    if (this.drawingId) this.savedRef = { ref: null, len: -1 };
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

  /**
   * Enregistre le dessin en SVG (URL `blob:`) dans `last` : tout le dessin, ou la vue courante quand la zone
   * d'export est DONNÉE et vaut `view` (attribut `export-area` posé, ou `exportArea` du DP `control`). Sans
   * zone donnée, le SVG reste le dessin entier (comportement historique).
   */
  save(): void {
    const area = this.liveExport.area ?? (this.hasAttribute("export-area") ? this.exportArea : "content");
    if (area === "view") {
      const { w, h } = this.dims();
      const r = visibleRect(this.view, w, h);
      try {
        const svg = exportSvg(this.doc.strokes, { background: this.background, area: r, margin: 0 });
        this.error = null;
        this.setLast(new Blob([svg], { type: "image/svg+xml" }), Math.round(w), Math.round(h));
      } catch (err) {
        this.error = err instanceof Error ? err.message : "export impossible";
        this.publish();
      }
      return;
    }
    const svg = this.toSvg();
    if (svg === null) return;
    const b = contentBBox(this.doc.strokes);
    this.setLast(new Blob([svg], { type: "image/svg+xml" }), Math.round(b?.w ?? 0), Math.round(b?.h ?? 0));
  }

  private liveExport: { scale?: number; area?: "view" | "content" } = {};

  /**
   * Rend le dessin dans un canvas neuf, net à la résolution demandée : `scale` × la taille de la vue
   * (`area: "view"`) ou du cadre du dessin (`area: "content"`, côté long = `scale` × le côté long de la vue).
   * 8192 px de côté au plus. Fond compris (sauf `transparent`).
   */
  renderImage(opts: { scale?: number; area?: "view" | "content" } = {}): HTMLCanvasElement | null {
    const { w, h } = this.dims();
    const scale = Math.min(8, Math.max(0.25, Number(opts.scale) || 1));
    let lw = w, lh = h, view: View = { ...this.view };
    if (opts.area === "content") {
      const b = contentBBox(this.doc.strokes);
      if (b && b.w > 0 && b.h > 0) {
        const long = Math.max(w, h);
        const k = long / Math.max(b.w, b.h);
        lw = Math.max(1, b.w * k);
        lh = Math.max(1, b.h * k);
        view = fitView(b, lw, lh, 0.04, 0);
      }
    }
    const f = Math.min(scale, 8192 / Math.max(lw, lh));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(lw * f));
    c.height = Math.max(1, Math.round(lh * f));
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(f, 0, 0, f, 0, 0);
    const bg = this.backgroundColor();
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, lw, lh); }
    drawStrokes({ ctx, w: lw, h: lh, view }, this.doc.strokes, visibleRect(view, lw, lh));
    return c;
  }

  /** Enregistre un PNG dans `last` : la vue courante, ou tout le dessin, à `export-scale` (voir `renderImage`). */
  savePng(): void {
    const c = this.renderImage({ scale: this.liveExport.scale ?? this.exportScale, area: this.liveExport.area ?? this.exportArea });
    c?.toBlob((blob) => { if (blob) this.setLast(blob, c.width, c.height); }, "image/png");
  }

  getState(): SketchState {
    const b = this.brush();
    return {
      status: this.error ? "error" : "ready", error: this.error, zoom: this.view.zoom, x: this.view.x, y: this.view.y, rotation: this.view.rotation,
      strokes: this.doc.strokes.length, points: this.doc.totalPoints, lastStroke: { ...this.lastCompaction }, ...this.flatStats(), drawing: this.mode === "draw", canUndo: this.doc.canUndo, canRedo: this.doc.canRedo,
      tool: this.currentTool(), color: b.color, picked: this.picked, imported: this.imported, selection: selectionInfo(this.selected), size: b.size, blend: this.currentBlend(), bbox: contentBBox(this.doc.strokes), last: this.last,
      edit: { op: this.editOp(), preview: !!this.pending, error: this.editError },
      library: {
        enabled: !!this.persist, status: this.libStatus, id: this.drawingId, name: this.drawingName,
        drawings: this.drawings.map((d) => ({ id: d.id, name: d.name, created: d.created, updated: d.updated, strokes: d.strokes, thumb: this.thumbUrl(d.thumb), current: d.id === this.drawingId })),
      },
    };
  }

  private publish(): void {
    this.queueSave();
    const s = this.getState();
    if (this.outDataProvider) set(this.outDataProvider, s);
    this.dispatchEvent(new CustomEvent("sketch-state", { detail: s, bubbles: true, composed: true }));
  }
}

/** Palette lue dans un DP : liste, chaîne « #a, #b » ou `{ colors }` (état de `sonic-palette`). */
export function paletteOf(v: unknown): Rgba[] {
  if (v && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as { colors?: unknown }).colors)) return paletteOf((v as { colors: unknown }).colors);
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,;]+/) : [];
  return list.flatMap((x) => {
    const c = typeof x === "string" ? parseColor(x.trim()) : null;
    return c ? [c] : [];
  });
}
