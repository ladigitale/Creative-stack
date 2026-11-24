import { css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { get } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { DeviceElement, type CommandMap, type DeviceBaseState } from "../../shared/device/base";
import { listenDp, plain } from "../../shared/audio/dp";
import { isFrameSource, type SonicFrameSource } from "../../shared/mediaRef";
import { DITHER_MODES, toGray, type DitherMode } from "../../shared/raster1bit";
import { svgRefOf, svgTextOf } from "../vectorize";
import { analyzeGcode, type GcodeStats } from "./codec";
import type { SonicGcodeSource } from "./machines";
import { cleanOp, rasterToGcode, svgToGcode, TOOLPATH_DEFAULTS, MAX_GCODE_LINES, type FoundColor, type LaserMode, type LaserOp, type ToolpathSettings } from "./toolpath";
import { burnsToGcode, LINE_STYLES, photoBurns, type LineStyle } from "./photo";

const IMAGE_RENDERS = [...DITHER_MODES, "gray", ...LINE_STYLES] as const;
type ImageRender = DitherMode | "gray" | LineStyle;

const tagName = "sonic-gcode";

/** Points d'image au plus pour une gravure par balayage. */
const MAX_RASTER_PIXELS = 4_000_000;
const MAX_OPS = 24;
const PREVIEW_PX = 720;

export type GcodeSettings = {
  tool: "laser" | "pen";
  input: "auto" | "vector" | "image";
  mode: LaserMode;
  power: number;
  speed: number;
  passes: number;
  interval: number;
  kerf: number;
  ops: LaserOp[];
  widthMm: number;
  heightMm: number;
  xMm: number;
  yMm: number;
  frame: "content" | "document";
  maxS: number;
  dither: ImageRender;
  threshold: number;
  minPower: number;
  /** Écart entre traits des rendus en traits (hachures, ondes, spirale, pointillisme), en mm. */
  lineSpacing: number;
  /** Paliers des lignes de niveau. */
  levels: number;
};

export type GcodeState = DeviceBaseState & {
  /** Un programme est prêt (`getGcode()` le donne à `sonic-grbl`). */
  ready: boolean;
  /** Incrémenté à chaque programme produit (utilisable comme `trigger`). */
  seq: number;
  kind: "vector" | "image" | null;
  lines: number;
  /** Emprise du programme en mm. */
  bbox: GcodeStats["bbox"];
  /** Taille du dessin une fois mis à l'échelle, en mm. */
  sizeMm: { w: number; h: number } | null;
  estimateS: number;
  burnMm: number;
  travelMm: number;
  issues: string[];
  /** Éléments du SVG non pris en charge (textes, images…), par balise. */
  skipped: Record<string, number>;
  /** Couleurs du dessin vectoriel : `[{color, fill, stroke}]` (nombre de surfaces et de traits). */
  colors: FoundColor[];
  settings: GcodeSettings;
};

type SvgSource = Element & { toSvg(): string | null };
const hasSvg = (el: unknown): el is SvgSource => !!el && typeof (el as SvgSource).toSvg === "function";

/**
 * Prépare un programme G-code pour un laser (ou un traceur à stylo) à partir d'un dessin : SVG (traits suivis,
 * surfaces hachurées, réglages par couleur) ou image (gravure par balayage, tramée ou en niveaux de gris).
 *
 * - `source="#dessin"` : un `sonic-sketch` (son SVG), ou une source d'images (`sonic-still`, `sonic-paint`…).
 * - `svg-from` : DP d'un fichier SVG ouvert (`ref-provider` de `sonic-file-open`) ou du SVG en texte.
 * - Réglages par défaut : `power` (%), `speed` (mm/min), `passes`, `mode`, `interval`, `kerf` ; par couleur :
 *   `ops` = `[{ "color": "#ff0000", "mode": "line", "power": 90, "speed": 300, "passes": 2 }]`, exécutées dans
 *   l'ordre (la découpe en dernier). Le blanc ne brûle pas.
 * - Taille et position : `width-mm` / `height-mm` (proportions gardées), `x-mm`, `y-mm` ; origine en bas à gauche.
 * - `control` (DP) : `{ build: n, download: n, clear: n }` et les mêmes réglages en direct (camelCase).
 * - État `<id>State` : `{ status, error, ready, seq, kind, lines, bbox, sizeMm, estimateS, burnMm, travelMm,
 *   issues, skipped, settings }`. `show-preview` dessine les parcours (c'est aussi une source d'images).
 * - Le programme est lu par `sonic-grbl source="#id"`.
 */
@customElement(tagName)
export class SonicGcode extends DeviceElement<GcodeState> implements SonicGcodeSource, SonicFrameSource {
  @property({ type: String }) source = "";
  @property({ type: String, attribute: "svg-from" }) svgFrom = "";
  /** `auto` (SVG si la source en fournit un, sinon image), `vector` ou `image`. */
  @property({ type: String }) input = "auto";
  @property({ type: String }) tool = "laser";
  @property({ type: String }) mode = "auto";
  @property({ type: Number }) power = TOOLPATH_DEFAULTS.power;
  @property({ type: Number }) speed = TOOLPATH_DEFAULTS.speed;
  @property({ type: Number }) passes = 1;
  @property({ type: Number }) interval = TOOLPATH_DEFAULTS.interval;
  @property({ type: Number }) kerf = 0;
  /** JSON `[{color, mode, power, speed, passes, interval, kerf}]`. */
  @property({ type: String }) ops = "";
  @property({ type: Number, attribute: "width-mm" }) widthMm = 0;
  @property({ type: Number, attribute: "height-mm" }) heightMm = 0;
  @property({ type: Number, attribute: "x-mm" }) xMm = 0;
  @property({ type: Number, attribute: "y-mm" }) yMm = 0;
  @property({ type: String }) frame = "content";
  /** Valeur S de pleine puissance : celle de la machine (`$30`, `grblState.maxS`). */
  @property({ type: Number, attribute: "max-s" }) maxS = 1000;
  /**
   * Image : rendu. Tramages (shared/raster1bit) `floyd` (défaut), `atkinson`, `jarvis`, `stucki`, `burkes`, `sierra`,
   * `sierra-lite`, `bayer`, `random`, `threshold`, `adaptive` (seuil local) ; `gray` (puissance selon le gris) ;
   * traits `hatch`, `waves`, `spiral`, `isolines`, `stipple`. La préparation (niveaux, contours, effets) se fait
   * dans la source : un sonic-shader de la bibliothèque (niveaux, pile-effets, sobel, halftone…) donné en `source`.
   */
  @property({ type: String }) dither = "floyd";
  @property({ type: Number, attribute: "line-spacing" }) lineSpacing = 0.5;
  @property({ type: Number }) levels = 8;
  @property({ type: Number }) threshold = 128;
  @property({ type: Number, attribute: "min-power" }) minPower = 0;
  /** Reconstruit le programme dès que la source ou un réglage change. */
  @property({ type: Boolean }) auto = false;
  @property({ type: Boolean, attribute: "show-preview", reflect: true }) showPreview = false;
  @property({ type: String, attribute: "file-name" }) fileName = "tache.gcode";

  static styles = css`
    :host {
      display: none;
    }
    :host([show-preview]) {
      display: block;
      line-height: 0;
    }
    canvas {
      display: block;
      width: 100%;
      height: auto;
    }
  `;

  protected feature = null;
  protected readonly defaultCommand = "build";
  protected state: GcodeState = this.initial();

  gcodeSeq = 0;
  frameSeq = 0;
  private program: string[] | null = null;
  private previewCanvas: HTMLCanvasElement | null = null;
  private live: Record<string, unknown> = {};
  private unsubLive: (() => void) | null = null;
  private unsubSvg: (() => void) | null = null;
  private svgInput: { url: string } | { text: string } | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  private building = false;
  private dirty = false;
  private lastSourceSeq: number | string = -1;

  private initial(): GcodeState {
    return {
      status: "idle", error: null, supported: true, allowed: "unknown", active: false,
      ready: false, seq: 0, kind: null, lines: 0, bbox: null, sizeMm: null, estimateS: 0, burnMm: 0, travelMm: 0, issues: [], skipped: {}, colors: [],
      settings: this.settings([]),
    };
  }

  protected commands(): CommandMap {
    return {
      build: () => this.build(),
      download: () => this.download(),
      clear: () => this.clear(),
    };
  }

  getGcode(): string[] | null {
    return this.program;
  }

  getFrameCanvas(): HTMLCanvasElement | null {
    return this.previewCanvas;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.patch({ settings: this.settings([]) });
    this.watch = setInterval(() => this.tick(), 400);
  }

  disconnectedCallback(): void {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    this.unsubLive?.();
    this.unsubLive = null;
    this.unsubSvg?.();
    this.unsubSvg = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    super.updated(changed);
    if (changed.has("control")) {
      this.unsubLive?.();
      this.unsubLive = this.control ? listenDp(this.control, (v) => this.readLive(v)) : null;
    }
    if (changed.has("svgFrom")) {
      this.unsubSvg?.();
      this.unsubSvg = null;
      this.svgInput = null;
      if (this.svgFrom) {
        const read = (v: unknown): void => {
          const ref = svgRefOf(v);
          const text = ref ? null : svgTextOf(v);
          const next = ref ?? (text ? { text } : null);
          if (JSON.stringify(next) !== JSON.stringify(this.svgInput)) {
            this.svgInput = next;
            this.dirty = true;
            this.dropProgram();
          }
        };
        read(plain(get(this.svgFrom)));
        this.unsubSvg = listenDp(this.svgFrom, read);
      }
    }
    const keys = ["tool", "input", "mode", "power", "speed", "passes", "interval", "kerf", "ops", "widthMm", "heightMm", "xMm", "yMm", "frame", "maxS", "dither", "threshold", "minPower", "source", "lineSpacing", "levels"];
    if (["source", "input", "tool"].some((k) => changed.has(k) && changed.get(k) !== undefined)) this.dropProgram();
    if (keys.some((k) => changed.has(k))) {
      this.dirty = true;
      this.patch({ settings: this.settings([]) });
    }
  }

  private readLive(v: unknown): void {
    if (!v || typeof v !== "object") return;
    const c = v as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const k of ["tool", "input", "mode", "power", "speed", "passes", "interval", "kerf", "ops", "widthMm", "heightMm", "xMm", "yMm", "frame", "maxS", "dither", "threshold", "minPower", "lineSpacing", "levels"]) {
      if (c[k] !== undefined && c[k] !== null && c[k] !== "") next[k] = c[k];
    }
    if (JSON.stringify(next) !== JSON.stringify(this.live)) {
      this.live = next;
      this.dirty = true;
      this.patch({ settings: this.settings([]) });
    }
  }

  /** Réglages effectifs : attributs, puis `control`. Les valeurs refusées sont signalées. */
  private settings(issues: string[]): GcodeSettings {
    const live = this.live ?? {};
    const pick = <T extends string>(key: string, attr: string, list: readonly T[], fallback: T): T => {
      const v = (live[key] ?? attr) as string;
      if (list.includes(v as T)) return v as T;
      if (v) issues.push(`${key} inconnu : ${v}`);
      return fallback;
    };
    const n = (key: string, attr: number, min: number, max: number, fallback: number): number => {
      const raw = live[key] ?? attr;
      const v = Number(raw);
      if (!Number.isFinite(v)) return fallback;
      const c = Math.min(max, Math.max(min, v));
      if (c !== v) issues.push(`${key} ramené à ${c}`);
      return c;
    };
    const base: LaserOp = {
      mode: pick("mode", this.mode, ["auto", "line", "fill", "skip"] as const, "auto"),
      power: n("power", this.power, 0, 100, TOOLPATH_DEFAULTS.power),
      speed: n("speed", this.speed, 10, 20000, TOOLPATH_DEFAULTS.speed),
      passes: Math.round(n("passes", this.passes, 1, 50, 1)),
      interval: n("interval", this.interval, 0.03, 10, TOOLPATH_DEFAULTS.interval),
      kerf: n("kerf", this.kerf, -5, 5, 0),
    };
    let rawOps: unknown = live.ops ?? this.ops;
    if (typeof rawOps === "string" && rawOps.trim()) {
      try {
        rawOps = JSON.parse(rawOps);
      } catch {
        issues.push("ops : JSON invalide");
        rawOps = [];
      }
    }
    const ops: LaserOp[] = [];
    if (Array.isArray(rawOps)) {
      for (const raw of rawOps.slice(0, MAX_OPS)) {
        if (!raw || typeof raw !== "object") continue;
        const op = cleanOp(raw as Record<string, unknown>, base);
        if (op.color) ops.push(op);
        else issues.push("ops : couleur attendue (#rrggbb)");
      }
    }
    return {
      ...base, ops,
      tool: pick("tool", this.tool, ["laser", "pen"] as const, "laser"),
      input: pick("input", this.input, ["auto", "vector", "image"] as const, "auto"),
      widthMm: n("widthMm", this.widthMm, 0, 2000, 0),
      heightMm: n("heightMm", this.heightMm, 0, 2000, 0),
      xMm: n("xMm", this.xMm, -2000, 2000, 0),
      yMm: n("yMm", this.yMm, -2000, 2000, 0),
      frame: pick("frame", this.frame, ["content", "document"] as const, "content"),
      maxS: n("maxS", this.maxS, 1, 100000, 1000),
      dither: pick("dither", this.dither, IMAGE_RENDERS, "floyd"),
      threshold: n("threshold", this.threshold, 0, 255, 128),
      minPower: n("minPower", this.minPower, 0, 100, 0),
      lineSpacing: n("lineSpacing", this.lineSpacing, 0.1, 10, 0.5),
      levels: Math.round(n("levels", this.levels, 2, 16, 8)),
    };
  }

  private byId(ref: string): Element | null {
    if (!ref.startsWith("#")) return null;
    const id = ref.slice(1);
    const root = this.getRootNode() as ParentNode;
    return (root as unknown as Document).getElementById?.(id) ?? document.getElementById(id);
  }

  /**
   * Version de la source à suivre : son contenu (`contentSeq`, ex. un dessin) quand on la lit en SVG — zoomer ou
   * déplacer la vue d'un dessin ne relance pas le calcul —, sinon chaque nouvelle image (`frameSeq`).
   */
  private sourceSeq(src: SonicFrameSource): number | string {
    const c = (src as unknown as { contentSeq?: unknown }).contentSeq;
    const input = (this.live ?? {}).input ?? this.input;
    const vector = input !== "image" && hasSvg(src) && (typeof c === "string" || typeof c === "number");
    return vector ? (c as string | number) : src.frameSeq;
  }

  private tick(): void {
    if (!this.auto || this.building) return;
    const src = this.byId(this.source);
    if (isFrameSource(src) && this.sourceSeq(src) !== this.lastSourceSeq) this.dirty = true;
    if (this.dirty) void this.build(true);
  }

  private giveUp(error: string, issues: string[], quiet: boolean): boolean {
    // Plus de programme valable : on n'en garde jamais un ancien, qui ne correspond plus à la source ni aux
    // réglages (une machine pourrait le lancer à la place de ce qui est affiché).
    const had = !!this.program;
    this.dropProgram();
    // En mode auto, une source pas encore prête n'est pas une erreur à afficher.
    if (quiet && !had) this.patch({ status: "idle", error: null, issues });
    else this.patch({ status: quiet ? "idle" : "error", error: quiet ? null : error, issues });
    return false;
  }

  /** Retire le programme courant (état `ready` faux, aperçu vidé). */
  private dropProgram(): void {
    if (!this.program) return;
    this.program = null;
    this.gcodeSeq++;
    if (this.previewCanvas) {
      this.previewCanvas.getContext("2d")?.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
      this.frameSeq++;
    }
    this.patch({ ready: false, active: false, seq: this.gcodeSeq, kind: null, lines: 0, bbox: null, sizeMm: null, estimateS: 0, burnMm: 0, travelMm: 0 });
  }

  /** Construit le programme depuis la source. */
  async build(quiet = false): Promise<boolean> {
    if (this.building) return false;
    this.building = true;
    this.dirty = false;
    // Réglages écrits dans le même envoi que le compteur `build` : lus avant de construire.
    if (this.control) this.readLive(plain(get(this.control)));
    try {
      return await this.buildNow(quiet);
    } finally {
      this.building = false;
    }
  }

  private async buildNow(quiet: boolean): Promise<boolean> {
    const issues: string[] = [];
    const s = this.settings(issues);
    const src = this.byId(this.source);
    if (isFrameSource(src)) this.lastSourceSeq = this.sourceSeq(src);
    const tp: ToolpathSettings = { ...TOOLPATH_DEFAULTS, ...s, ops: s.ops };

    let svg: string | null = null;
    if (s.input !== "image") {
      if (this.svgInput && "text" in this.svgInput) svg = this.svgInput.text;
      else if (this.svgInput) {
        try {
          svg = await (await fetch(this.svgInput.url)).text();
        } catch {
          return this.giveUp("fichier SVG illisible", issues, quiet);
        }
      } else if (hasSvg(src)) svg = src.toSvg();
    }
    if (!this.isConnected) return false;

    let lines: string[] | null;
    let kind: "vector" | "image";
    let sizeMm: { w: number; h: number } | null = null;
    let skipped: Record<string, number> = {};
    if (svg) {
      kind = "vector";
      const res = svgToGcode(svg, tp);
      issues.push(...res.issues);
      this.patch({ colors: res.colors }, false);
      if (res.error) return this.giveUp(res.error, issues, quiet && !res.colors.length);
      lines = res.lines;
      sizeMm = res.sizeMm;
      skipped = res.skipped;
      const ignored = Object.entries(skipped).map(([k, v]) => `${v} ${k}`);
      if (ignored.length) issues.push(`éléments du SVG ignorés : ${ignored.join(", ")}`);
    } else {
      kind = "image";
      if (this.state.colors.length) this.patch({ colors: [] }, false);
      if (s.input === "vector") return this.giveUp("aucun SVG : source sans dessin vectoriel, ou svg-from vide", issues, quiet);
      if (s.tool === "pen") return this.giveUp("une image ne se trace pas au stylo : la vectoriser d'abord (sonic-vectorize)", issues, quiet);
      const canvas = isFrameSource(src) ? src.getFrameCanvas() : null;
      if (!canvas || !canvas.width || !canvas.height) return this.giveUp(this.source ? "source introuvable ou image pas encore prête" : "aucune source : source=\"#id\" ou svg-from", issues, quiet);
      const widthMm = s.widthMm > 0 ? s.widthMm : s.heightMm > 0 ? (s.heightMm * canvas.width) / canvas.height : 50;
      if (!(s.widthMm > 0 || s.heightMm > 0)) issues.push("taille non donnée : 50 mm de large (width-mm)");
      const lineStyle = (LINE_STYLES as readonly string[]).includes(s.dither);
      // Les rendus en traits échantillonnent l'image au plus fin de leur pas, sans dépasser 1 600 points de large.
      const asked = lineStyle ? Math.max(s.interval, Math.min(s.lineSpacing / 3, widthMm / 1600)) : s.interval;
      // Grand format : la définition demandée est ramenée à ce que le navigateur et le programme supportent, plutôt
      // que d'abandonner (300 mm à 0,1 mm = 9 Mpx).
      const ratio = canvas.height / canvas.width;
      let res = Math.max(asked, Math.sqrt((widthMm * widthMm * ratio) / MAX_RASTER_PIXELS));
      let heightMm = 0;
      lines = null;
      for (let attempt = 0; attempt < 4 && !lines; attempt++, res *= 1.5) {
        const cols = Math.max(1, Math.round(widthMm / res));
        const rows = Math.max(1, Math.round(cols * ratio));
        if (cols * rows > MAX_RASTER_PIXELS) continue;
        let gray: Float32Array;
        try {
          const work = document.createElement("canvas");
          work.width = cols;
          work.height = rows;
          const ctx = work.getContext("2d", { willReadFrequently: true });
          if (!ctx) throw new Error("canvas 2D indisponible");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, cols, rows);
          ctx.drawImage(canvas, 0, 0, cols, rows);
          gray = toGray(ctx.getImageData(0, 0, cols, rows).data, cols, rows);
        } catch (e) {
          return this.giveUp(e instanceof Error && e.name === "SecurityError" ? "image non lisible (CORS)" : "lecture de l'image impossible", issues, quiet);
        }
        heightMm = rows * (widthMm / cols);
        const fullS = Math.round((s.power / 100) * s.maxS);
        lines = lineStyle
          ? burnsToGcode(
              photoBurns(gray, cols, rows, { style: s.dither as LineStyle, widthMm, heightMm, spacing: s.lineSpacing, step: Math.max(res, 0.05), s: fullS, minS: Math.round((s.minPower / 100) * s.maxS), levels: s.levels, seed: 7 }),
              { xMm: s.xMm, yMm: s.yMm, speed: s.speed, returnHome: true, maxLines: MAX_GCODE_LINES },
            )
          : rasterToGcode(gray, cols, rows, { widthMm, xMm: s.xMm, yMm: s.yMm, dither: s.dither as DitherMode | "gray", threshold: s.threshold, power: s.power, minPower: s.minPower, speed: s.speed, maxS: s.maxS, returnHome: true });
        if (lines && res > asked * 1.01) issues.push(`définition ramenée à ${Math.round(res * 100) / 100} mm pour cette taille`);
      }
      if (lines && !lines.length) return this.giveUp("image entièrement blanche : rien à graver", issues, quiet);
      sizeMm = { w: Math.round(widthMm * 100) / 100, h: Math.round(heightMm * 100) / 100 };
    }
    if (!lines) return this.giveUp("programme trop long : augmenter interval ou réduire la taille", issues, quiet);

    const stats = analyzeGcode(lines, TOOLPATH_DEFAULTS.travelSpeed);
    this.program = lines;
    this.gcodeSeq++;
    this.drawPreview(lines, stats, s.maxS);
    this.patch({
      status: "ready", error: null, active: true, ready: true, seq: this.gcodeSeq, kind, lines: lines.length, bbox: stats.bbox, sizeMm,
      estimateS: stats.estimateS, burnMm: stats.burnMm, travelMm: stats.travelMm, issues, skipped, settings: s,
    });
    this.emit("sonic-gcode-ready", { lines: lines.length, bbox: stats.bbox });
    return true;
  }

  private clear(): boolean {
    this.program = null;
    this.gcodeSeq++;
    this.patch({ ...this.initial(), seq: this.gcodeSeq });
    return true;
  }

  /** Enregistre le programme dans un fichier (à lancer dans un geste). */
  private download(): boolean {
    if (!this.program) {
      this.patch({ error: "aucun programme à enregistrer : build d'abord" });
      return false;
    }
    const url = URL.createObjectURL(new Blob([this.program.join("\n") + "\n"], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = /^[\w .-]{1,80}$/.test(this.fileName) ? this.fileName : "tache.gcode";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  }

  // ─── Aperçu ───────────────────────────────────────────────────────────────────────────────────────────────────
  /** Dessine les mouvements faisceau allumé, d'autant plus foncés que la puissance est haute. */
  private drawPreview(lines: string[], stats: GcodeStats, maxS: number): void {
    const b = stats.bbox;
    if (!b || typeof document === "undefined") return;
    const canvas = this.previewCanvas ?? document.createElement("canvas");
    const pad = 6;
    const w = Math.max(b.w, 0.1), h = Math.max(b.h, 0.1);
    const scale = Math.min((PREVIEW_PX - 2 * pad) / w, (PREVIEW_PX - 2 * pad) / h);
    canvas.width = Math.max(16, Math.round(w * scale + 2 * pad));
    canvas.height = Math.max(16, Math.round(h * scale + 2 * pad));
    const ctx = canvas.getContext("2d");
    this.previewCanvas = canvas;
    if (!ctx) return;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 1;
    ctx.lineCap = "round";
    const X = (x: number): number => pad + (x - b.x) * scale;
    const Y = (y: number): number => canvas.height - pad - (y - b.y) * scale;
    const re = /([GXYSM])([+-]?(?:\d+\.?\d*|\.\d+))/g;
    let x = 0, y = 0, motion = 0, power = 0, on = false;
    // Un tracé par couleur d'opération (`;op #rrggbb`) et par niveau de puissance : peu d'appels à stroke().
    let color = "#141414";
    const paths = new Map<string, Path2D>();
    const pathFor = (level: number): Path2D | null => {
      if (typeof Path2D === "undefined") return null;
      const k = `${color}|${level}`;
      let p = paths.get(k);
      if (!p) paths.set(k, (p = new Path2D()));
      return p;
    };
    for (const line of lines) {
      if (line.startsWith(";op ")) {
        const c = line.slice(4).trim();
        if (/^#[0-9a-f]{6}$/i.test(c)) color = c.toLowerCase() === "#ffffff" ? "#141414" : c;
        continue;
      }
      let nx = x, ny = y, moved = false;
      re.lastIndex = 0;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        const v = Number(m[2]);
        if (m[1] === "G") { if (v >= 0 && v <= 3) motion = v; }
        else if (m[1] === "M") { if (v === 3 || v === 4) on = true; else if (v === 5) on = false; }
        else if (m[1] === "S") power = v;
        else if (m[1] === "X") { nx = v; moved = true; }
        else { ny = v; moved = true; }
      }
      if (!moved) continue;
      if (motion !== 0 && on && power > 0) {
        const p = pathFor(Math.min(3, Math.floor((power / maxS) * 4)));
        p?.moveTo(X(x), Y(y));
        p?.lineTo(X(nx), Y(ny));
      }
      x = nx;
      y = ny;
    }
    for (const [k, p] of paths) {
      const [c, level] = k.split("|");
      ctx.globalAlpha = 0.35 + Number(level) * 0.21;
      ctx.strokeStyle = c;
      ctx.stroke(p);
    }
    ctx.globalAlpha = 1;
    this.frameSeq++;
    this.requestUpdate();
  }

  render() {
    return this.showPreview && this.previewCanvas ? html`${this.previewCanvas}` : html``;
  }
}

export default SonicGcode;
