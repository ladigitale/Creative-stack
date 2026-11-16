import { css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { DeviceElement, type CommandArg, type CommandMap, type DeviceBaseState } from "../../shared/device/base";
import { listenDp } from "../../shared/audio/dp";
import { isBytePipe, type SonicBytePipe } from "../../shared/bluetooth/pipe";
import { isFrameSource, type SonicFrameSource } from "../../shared/mediaRef";
import { centerInWidth, coverage, dither, DITHER_MODES, fitRect, packBitmap, rotateBitmap, toGray, type Bitmap, type DitherMode } from "../../shared/raster1bit";
import { createProtocol, DEFAULT_MODELS, modelFromName, modelFromReply, PROTOCOLS, type PrinterModel, type ProtocolId } from "./printer/models";
import { PrinterLink, type PaperType, type PrinterProtocol } from "./printer/protocol";

const tagName = "sonic-label-printer";

const MAX_COPIES = 50;
/** Longueur maximale d'une impression, en millimètres. */
const MAX_LENGTH_MM = 1000;
const FITS = ["contain", "cover", "stretch"] as const;
const PAPERS: PaperType[] = ["gap", "black-mark", "continuous"];

export type LabelPrinterSettings = {
  labelMm: [number, number];
  orientation: "landscape" | "portrait";
  fit: (typeof FITS)[number];
  dither: DitherMode;
  threshold: number;
  density: number;
  paper: PaperType;
  copies: number;
};

export type LabelPrinterState = DeviceBaseState & {
  protocol: string | null;
  model: string | null;
  firmware: string | null;
  head: { widthPx: number; dpi: number } | null;
  battery: number | null;
  charging: boolean;
  paper: "ok" | "out" | "unknown";
  cover: "closed" | "open" | "unknown";
  overheated: boolean;
  printing: boolean;
  /** Avancement de la copie en cours, 0..1. */
  progress: number;
  copy: number;
  copies: number;
  /** Impressions terminées (utilisable comme `trigger`). */
  jobs: number;
  /** Taille de l'aperçu en points, dans le sens du dessin. */
  preview: { width: number; height: number; ink: number } | null;
  /** Remarques adressées à l'auteur du document (valeur ramenée, modèle inconnu…). */
  issues: string[];
  settings: LabelPrinterSettings;
};

type ImageLike = { getContext(type: "2d", opts?: { willReadFrequently?: boolean }): CanvasRenderingContext2D | null; width: number; height: number };

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** `"30x12"` (longueur × largeur, en mm) → `[30, 12]`. */
export function parseLabelMm(value: unknown): [number, number] | null {
  if (Array.isArray(value) && value.length === 2 && value.every((n) => Number.isFinite(Number(n)) && Number(n) > 0)) return [Number(value[0]), Number(value[1])];
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d+(?:[.,]\d+)?)\s*[x×*]\s*(\d+(?:[.,]\d+)?)$/i);
  if (!m) return null;
  const a = Number(m[1].replace(",", "."));
  const b = Number(m[2].replace(",", "."));
  return a > 0 && b > 0 ? [a, b] : null;
}

/**
 * Taille du dessin en points pour une étiquette et une tête données. `across` est limité à la largeur de
 * la tête ; `along` (sens du défilement) à `MAX_LENGTH_MM`.
 */
export function labelPixels(labelMm: [number, number], model: PrinterModel): { along: number; across: number } {
  const perMm = model.dpi / 25.4;
  // 203 dpi = 8 points par millimètre exactement dans ces imprimantes.
  const dots = (mm: number): number => Math.round(mm * (Math.abs(perMm - 8) < 0.05 ? 8 : perMm));
  return { along: clamp(dots(Math.min(labelMm[0], MAX_LENGTH_MM)), 8, 65535), across: clamp(dots(labelMm[1]), 8, model.widthPx) };
}

/**
 * Du dessin (sens de lecture) aux lignes envoyées à l'imprimante : en `landscape` le dessin fait
 * `along × across` et tourne d'un quart de tour ; en `portrait` il fait `across × along`.
 */
export function toPrintBitmap(design: Bitmap, orientation: "landscape" | "portrait", headWidthPx: number, flip = false): Bitmap {
  const turned = rotateBitmap(design, (orientation === "landscape" ? 90 : 0) + (flip ? 180 : 0));
  return centerInWidth(turned, headWidthPx);
}

/**
 * Imprimante thermique d'étiquettes (ou de tickets) derrière un `sonic-bluetooth` : imprime l'image d'une
 * source (`sonic-sketch`, `sonic-paint`, `sonic-still`, un canvas…) en 1 bit, avec aperçu exact.
 *
 * - `transport="#bt"` : le `sonic-bluetooth` (profil `luck` pour une Fichero d'Action).
 * - `source="#dessin"` : source d'images.
 * - `for="bouton"` ou `control {print: n}` : imprime. Autres commandes : `preview`, `feed`, `refresh`, `cancel`.
 * - Réglages (attributs, ou en direct par `control`) : `label-mm`, `orientation`, `fit`, `dither`,
 *   `threshold`, `density`, `paper`, `copies`.
 * - État `<id>State` : imprimante (modèle, batterie, papier, capot), tâche (printing, progress, jobs), `preview`.
 * - `show-preview` affiche l'aperçu 1 bit ; c'est aussi une source d'images (`#id` : canal de shader, vision…).
 */
@customElement(tagName)
export class SonicLabelPrinter extends DeviceElement<LabelPrinterState> implements SonicFrameSource {
  @property({ type: String }) transport = "";
  @property({ type: String }) source = "";
  /**
   * `auto` (d'après le nom de l'appareil, puis le profil du transport), `luck-aiyin`, `luck-lujiang`, `escpos`,
   * `niimbot` (variante choisie d'après le modèle), ou une variante imposée `niimbot-d110`, `niimbot-b1`,
   * `niimbot-d11v1`, `niimbot-b21v1`, `niimbot-v4`.
   */
  @property({ type: String }) protocol = "auto";
  /** Largeur de la tête en points, pour un modèle inconnu (multiple de 8). */
  @property({ type: Number, attribute: "width-px" }) widthPx = 0;
  /** Longueur × largeur de l'étiquette en mm : `"30x12"`. Défaut selon le modèle. */
  @property({ type: String, attribute: "label-mm" }) labelMm = "";
  @property({ type: String }) orientation = "landscape";
  @property({ type: String }) fit = "contain";
  @property({ type: String }) dither = "threshold";
  @property({ type: Number }) threshold = 128;
  @property({ type: Number }) density = 1;
  @property({ type: String }) paper = "gap";
  @property({ type: Number }) copies = 1;
  /** Retourne l'impression d'un demi-tour (étiquette qui sort à l'envers). */
  @property({ type: Boolean }) flip = false;
  /** Affiche l'aperçu 1 bit à la place du composant (sinon il reste invisible). */
  @property({ type: Boolean, attribute: "show-preview", reflect: true }) showPreview = false;
  /** Facteur des délais du protocole (1 ; 0 dans les tests). */
  @property({ type: Number, attribute: "time-scale" }) timeScale = 1;

  static styles = css`
    :host {
      display: none;
    }
    :host([show-preview]) {
      display: inline-block;
      line-height: 0;
    }
    canvas {
      display: block;
      width: 100%;
      height: auto;
      image-rendering: pixelated;
      background: #fff;
    }
  `;

  protected feature = null;
  protected readonly defaultCommand = "print";
  protected state: LabelPrinterState = this.initial();

  frameSeq = 0;
  private previewCanvas: HTMLCanvasElement | null = null;
  private live: Partial<LabelPrinterSettings> = {};
  private pipe: SonicBytePipe | null = null;
  private link: PrinterLink | null = null;
  private impl: PrinterProtocol | null = null;
  private model: PrinterModel | null = null;
  private cancelled = false;
  private watch: ReturnType<typeof setInterval> | null = null;
  private transportKey = "";
  private lastSourceSeq = -1;
  private busy = false;

  private initial(): LabelPrinterState {
    return {
      status: "idle", error: null, supported: true, allowed: "unknown", active: false,
      protocol: null, model: null, firmware: null, head: null, battery: null, charging: false,
      paper: "unknown", cover: "unknown", overheated: false, printing: false, progress: 0, copy: 0, copies: 0, jobs: 0,
      preview: null, issues: [], settings: this.settings([]),
    };
  }

  protected commands(): CommandMap {
    return {
      print: (a) => this.print(a),
      preview: () => this.renderPreview() !== null,
      feed: () => this.feed(),
      refresh: () => this.refresh(),
      cancel: () => this.cancel(),
    };
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.patch({ settings: this.settings([]) });
    // Suit la connexion du transport et les nouvelles images de la source (4 fois par seconde, sans rendu).
    this.watch = setInterval(() => this.tick(), 250);
  }

  disconnectedCallback(): void {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    this.cancelled = true;
    this.unsubLive?.();
    this.unsubLive = null;
    this.detach();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    super.updated(changed);
    const keys = ["labelMm", "orientation", "fit", "dither", "threshold", "density", "paper", "copies", "widthPx", "protocol"];
    if (keys.some((k) => changed.has(k))) {
      this.lastSourceSeq = -1;
      this.patch({ settings: this.settings([]) });
    }
  }

  /** Réglages lus dans `control` en plus des compteurs de commandes. */
  private readLive(v: unknown): void {
    if (!v || typeof v !== "object") return;
    const c = v as Record<string, unknown>;
    const next: Partial<LabelPrinterSettings> = {};
    const label = parseLabelMm(c.labelMm);
    if (label) next.labelMm = label;
    if (c.orientation === "landscape" || c.orientation === "portrait") next.orientation = c.orientation;
    if (FITS.includes(c.fit as (typeof FITS)[number])) next.fit = c.fit as (typeof FITS)[number];
    if (DITHER_MODES.includes(c.dither as DitherMode)) next.dither = c.dither as DitherMode;
    for (const k of ["threshold", "density", "copies"] as const) if (Number.isFinite(Number(c[k])) && c[k] !== null && c[k] !== "") next[k] = Number(c[k]);
    if (PAPERS.includes(c.paper as PaperType)) next.paper = c.paper as PaperType;
    if (JSON.stringify(next) !== JSON.stringify(this.live)) {
      this.live = next;
      this.lastSourceSeq = -1;
      this.patch({ settings: this.settings([]) });
    }
  }

  /** Réglages effectifs : défauts du modèle, attributs, puis `control`. Les valeurs ramenées sont signalées. */
  private settings(issues: string[]): LabelPrinterSettings {
    const model = this.currentModel();
    const pick = <T extends string>(value: string, list: readonly T[], fallback: T, name: string): T => {
      if (list.includes(value as T)) return value as T;
      if (value) issues.push(`${name} inconnu : ${value}`);
      return fallback;
    };
    const base: LabelPrinterSettings = {
      labelMm: parseLabelMm(this.labelMm) ?? model.labelMm,
      orientation: pick(this.orientation, ["landscape", "portrait"] as const, "landscape", "orientation"),
      fit: pick(this.fit, FITS, "contain", "fit"),
      dither: pick(this.dither, DITHER_MODES, "threshold", "dither"),
      threshold: this.threshold,
      density: this.density,
      paper: pick(this.paper, PAPERS, "gap", "paper"),
      copies: this.copies,
    };
    if (this.labelMm && !parseLabelMm(this.labelMm)) issues.push(`label-mm invalide : ${this.labelMm} (forme "30x12")`);
    const s = { ...base, ...this.live };
    const bounded = (name: "threshold" | "density" | "copies", min: number, max: number, round: boolean): void => {
      const raw = Number.isFinite(s[name]) ? s[name] : min;
      const v = clamp(round ? Math.round(raw) : raw, min, max);
      if (v !== s[name]) issues.push(`${name} ramené à ${v}`);
      s[name] = v;
    };
    bounded("threshold", 0, 255, false);
    bounded("density", 0, 2, true);
    bounded("copies", 1, MAX_COPIES, true);
    const maxAcross = (model.widthPx / model.dpi) * 25.4;
    if (s.labelMm[1] > maxAcross + 0.5) issues.push(`largeur d'étiquette ramenée à ${Math.round(maxAcross)} mm (tête de ${model.widthPx} points)`);
    return s;
  }

  private currentModel(): PrinterModel {
    const base = this.model ?? DEFAULT_MODELS[PROTOCOLS.includes(this.protocol as ProtocolId) ? (this.protocol as ProtocolId) : "luck-aiyin"];
    const width = Math.round(this.widthPx);
    return width >= 8 && width <= 2400 ? { ...base, widthPx: width - (width % 8) } : base;
  }

  // ─── Transport ────────────────────────────────────────────────────────────────────────────────────────────────
  private byId(ref: string): Element | null {
    if (!ref.startsWith("#")) return null;
    const id = ref.slice(1);
    const root = this.getRootNode() as ParentNode;
    return (root as unknown as Document).getElementById?.(id) ?? document.getElementById(id);
  }

  private tick(): void {
    const el = this.byId(this.transport);
    const pipe = isBytePipe(el) ? el : null;
    const ready = !!pipe?.pipeReady;
    const key = `${pipe ? "1" : "0"}${ready ? "1" : "0"}`;
    if (key !== this.transportKey || (ready && pipe !== this.pipe)) {
      this.transportKey = key;
      if (ready && pipe) void this.attach(pipe);
      else {
        this.detach();
        this.patch({ status: "idle", active: false, printing: false, error: this.transport && !pipe ? "transport introuvable (transport=\"#id\" d'un sonic-bluetooth)" : null });
      }
    }
    // Aperçu tenu à jour quand la source publie une nouvelle image.
    const src = this.byId(this.source);
    if (isFrameSource(src) && src.frameSeq !== this.lastSourceSeq && !this.state.printing) {
      this.lastSourceSeq = src.frameSeq;
      this.renderPreview();
    }
  }

  private detach(): void {
    this.link?.close();
    this.link = null;
    this.pipe = null;
    this.impl = null;
    this.model = null;
  }

  /** Transport connecté : choix du protocole, lecture du modèle et de l'état. */
  private async attach(pipe: SonicBytePipe): Promise<void> {
    this.detach();
    this.pipe = pipe;
    const issues: string[] = [];
    const named = modelFromName(pipe.deviceName);
    let id = this.protocol;
    if (id === "auto" || !id) {
      id = named?.protocol ?? (pipe.pipeProfile === "niimbot" ? "niimbot" : "luck-aiyin");
      if (!named) issues.push(`modèle non reconnu (« ${pipe.deviceName} ») : protocole ${id} supposé, préciser protocol et width-px`);
    }
    const impl = createProtocol(id);
    if (!impl) {
      this.patch({ status: "error", error: `protocole inconnu : ${id} (disponibles : ${PROTOCOLS.join(", ")})`, active: false });
      return;
    }
    this.impl = impl;
    this.model = named && (named.protocol === id || (named.protocol === "niimbot" && id.startsWith("niimbot"))) ? named : DEFAULT_MODELS[id as ProtocolId];
    const link = new PrinterLink(pipe, this.timeScale);
    this.link = link;
    const info = await impl.info(link);
    if (this.link !== link) return;
    this.model = modelFromReply(info.model) ?? this.model;
    const model = this.currentModel();
    this.lastSourceSeq = -1;
    this.patch({
      status: "ready", error: null, active: true, protocol: impl.id, model: info.model, firmware: info.firmware,
      head: { widthPx: model.widthPx, dpi: model.dpi }, battery: info.battery,
      charging: info.status?.charging ?? false, paper: info.status?.paper ?? "unknown", cover: info.status?.cover ?? "unknown",
      overheated: info.status?.overheated ?? false, issues, settings: this.settings(issues),
    });
  }

  /** Relit modèle, batterie et état de l'imprimante. */
  async refresh(): Promise<boolean> {
    if (!this.link || !this.impl || this.state.printing) return false;
    const info = await this.impl.info(this.link);
    this.patch({
      battery: info.battery, model: info.model ?? this.state.model, firmware: info.firmware ?? this.state.firmware,
      charging: info.status?.charging ?? false, paper: info.status?.paper ?? "unknown", cover: info.status?.cover ?? "unknown",
      overheated: info.status?.overheated ?? false,
    });
    return true;
  }

  async feed(): Promise<boolean> {
    if (!this.link || !this.impl || this.state.printing) return false;
    return this.impl.feed(this.link);
  }

  /** Demande l'arrêt : effectif entre deux copies (une étiquette commencée va au bout). */
  cancel(): boolean {
    this.cancelled = true;
    return true;
  }

  // ─── Image ────────────────────────────────────────────────────────────────────────────────────────────────────
  private sourceImage(): CanvasImageSource | null {
    const el = this.byId(this.source);
    if (!el) return null;
    if (isFrameSource(el)) return el.getFrameCanvas();
    if (el instanceof HTMLCanvasElement) return el;
    if (el instanceof HTMLImageElement) return el.complete && el.naturalWidth ? el : null;
    return null;
  }

  /** Dessin en 1 bit, dans le sens de lecture. `null` si la source n'est pas prête. */
  private designBitmap(settings: LabelPrinterSettings): Bitmap | null {
    const image = this.sourceImage();
    if (!image) return null;
    const { along, across } = labelPixels(settings.labelMm, this.currentModel());
    const [w, h] = settings.orientation === "landscape" ? [along, across] : [across, along];
    const canvas = document.createElement("canvas") as unknown as ImageLike & HTMLCanvasElement;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    const sw = (image as { naturalWidth?: number; width: number }).naturalWidth || (image as { width: number }).width;
    const sh = (image as { naturalHeight?: number; height: number }).naturalHeight || (image as { height: number }).height;
    if (!sw || !sh) return null;
    const r = fitRect(sw, sh, w, h, settings.fit);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    try {
      ctx.drawImage(image, r.x, r.y, r.w, r.h);
      const pixels = ctx.getImageData(0, 0, w, h).data;
      return dither(toGray(pixels, w, h), w, h, settings.dither, settings.threshold);
    } catch {
      // Canvas marqué par une image d'une autre origine : illisible.
      return null;
    }
  }

  /** Calcule et publie l'aperçu 1 bit. Retourne le dessin, ou `null` si la source n'est pas prête. */
  renderPreview(): Bitmap | null {
    const issues: string[] = [...this.state.issues.filter((i) => i.startsWith("modèle non reconnu"))];
    const settings = this.settings(issues);
    const design = this.designBitmap(settings);
    if (!design) {
      this.patch({ preview: null, settings, issues });
      return null;
    }
    const canvas = this.previewCanvas ?? document.createElement("canvas");
    if (!this.previewCanvas) {
      this.previewCanvas = canvas;
      this.requestUpdate();
    }
    canvas.width = design.width;
    canvas.height = design.height;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const out = ctx.createImageData(design.width, design.height);
      for (let i = 0; i < design.bits.length; i++) {
        const v = design.bits[i] ? 0 : 255;
        out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
        out.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(out, 0, 0);
    }
    this.frameSeq++;
    const ink = Math.round(coverage(design) * 1000) / 1000;
    if (ink === 0) issues.push("aperçu vide : rien à imprimer (image blanche, ou trop claire pour ce seuil)");
    this.patch({ preview: { width: design.width, height: design.height, ink }, settings, issues });
    return design;
  }

  render() {
    return this.showPreview && this.previewCanvas ? html`${this.previewCanvas}` : html``;
  }

  getFrameCanvas(): HTMLCanvasElement | null {
    return this.previewCanvas && this.previewCanvas.width ? this.previewCanvas : null;
  }

  // ─── Impression ───────────────────────────────────────────────────────────────────────────────────────────────
  /** Imprime une image déjà en 1 bit (dessin dans le sens de lecture). Sert aussi aux tests. */
  async printBitmap(design: Bitmap, settings = this.settings([])): Promise<boolean> {
    const link = this.link;
    const impl = this.impl;
    if (!link || !impl || !this.pipe?.pipeReady) {
      this.patch({ status: "error", error: "imprimante non connectée" });
      return false;
    }
    if (this.busy) return false;
    this.busy = true;
    this.cancelled = false;
    const packed = packBitmap(toPrintBitmap(design, settings.orientation, this.currentModel().widthPx, this.flip));
    this.patch({ status: "ready", error: null, printing: true, progress: 0, copy: 0, copies: settings.copies });
    let error: string | null = null;
    try {
      for (let copy = 1; copy <= settings.copies && !this.cancelled; copy++) {
        this.patch({ copy, progress: 0 });
        error = await impl.print(link, { ...packed, density: settings.density, paper: settings.paper }, (p) => this.patch({ progress: Math.round(p * 100) / 100 }, false));
        if (error) break;
      }
    } finally {
      this.busy = false;
    }
    if (error) {
      this.patch({ status: "error", error, printing: false });
      this.emit("sonic-label-printer-error", { error });
      void this.refresh();
      return false;
    }
    this.patch({ printing: false, progress: 1, jobs: this.state.jobs + 1 });
    this.emit("sonic-label-printer-done", { copies: this.state.copy });
    return true;
  }

  async print(arg: CommandArg = {}): Promise<boolean> {
    const issues: string[] = [];
    const settings = this.settings(issues);
    const copies = Number(arg.copies);
    if (Number.isFinite(copies) && copies >= 1) settings.copies = clamp(Math.round(copies), 1, MAX_COPIES);
    const design = this.renderPreview();
    if (!design) {
      this.patch({ status: this.link ? "ready" : "error", error: "source introuvable ou image pas encore prête" });
      return false;
    }
    if (!coverage(design)) {
      this.patch({ error: "rien à imprimer : l'aperçu est vide" });
      return false;
    }
    return this.printBitmap(design, settings);
  }

  // `control` porte aussi des réglages : ils sont lus en plus des compteurs de commandes.
  private unsubLive: (() => void) | null = null;
  protected willUpdate(changed: Map<string | number | symbol, unknown>): void {
    if (!changed.has("control")) return;
    this.unsubLive?.();
    this.live = {};
    this.unsubLive = this.control ? listenDp(this.control, (v) => this.readLive(v)) : null;
  }
}

export default SonicLabelPrinter;
