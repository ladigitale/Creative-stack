import { LitElement, css, nothing, svg, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger, num } from "../../shared/media/control";
import { isFrameSource } from "../../shared/mediaRef";
import { frameToClient } from "../../shared/frame-geometry";
import { parsePalette, toSvg, type Layer, type TraceResult } from "./trace";
import { SupersededError, TraceRunner } from "./worker-client";
import { parseSvgDocument } from "./svgdoc";

/** Réglages effectifs (attributs, puis `control`, puis `params` : le dernier l'emporte). */
export type VectorizeSettings = {
  colors: number;
  tolerance: number;
  minArea: number;
  denoise: number;
  curves: boolean;
  flat: boolean;
  maxSize: number;
  /** Palette imposée (#rrggbb) ; vide = palette calculée sur `colors` couleurs. */
  palette: string[];
};

export type VectorizeState = {
  status: "idle" | "working" | "ready" | "error";
  error: string | null;
  /** Dimensions de l'image analysée (repère du `viewBox`). */
  width: number;
  height: number;
  /** Dimensions de l'image d'origine (taille d'affichage du SVG). */
  sourceWidth: number;
  sourceHeight: number;
  /** Nombre de couches (une par couleur). */
  layers: number;
  /**
   * Détail des couches, du dessous au-dessus : couleur, surface (px² analysés), part de l'image (0..1) et
   * tracé `d` (repère `width` × `height`), lu par `sonic-sketch import-from`.
   */
  paths: { color: string; area: number; share: number; d: string; opacity?: number }[];
  palette: string[];
  /** Document SVG autonome. */
  svg: string;
  /** Même SVG en SonicMediaRef (`blob:`), pour `sonic-media-download`, `sonic-image`, `sonic-still`. */
  file: { url: string; mime: string; width: number; height: number } | null;
  bytes: number;
  ms: number;
  /** Où le calcul a tourné : Web Worker (page fluide) ou fil principal (repli). */
  engine: "worker" | "main";
  runs: number;
  truncated: boolean;
  settings: VectorizeSettings;
  /**
   * Où l'image lue apparaissait à l'écran au moment de la lecture : matrice [a, b, c, d, e, f] des pixels de
   * l'image analysée vers le viewport (null si la source n'était pas affichée). `sonic-sketch` s'en sert pour
   * poser les formes à leur place.
   */
  frame: number[] | null;
  /** D'où viennent les couches : image tracée, ou SVG lu tel quel (`svg-from`). */
  source: "image" | "svg";
  /** `keep-colors` : les couleurs d'origine sont à garder (`sonic-sketch` ne les remplace pas par sa palette). */
  keepColors: boolean;
  /** SVG lu tel quel : éléments ignorés par type (textes, images, filtres…). */
  skipped: Record<string, number>;
};

const DEFAULTS: VectorizeSettings = { colors: 8, tolerance: 1, minArea: 4, denoise: 1, curves: false, flat: false, maxSize: 512, palette: [] };
const IDLE: VectorizeState = {
  status: "idle", error: null, width: 0, height: 0, sourceWidth: 0, sourceHeight: 0, layers: 0, paths: [], palette: [],
  svg: "", file: null, bytes: 0, ms: 0, engine: "main", runs: 0, truncated: false, settings: { ...DEFAULTS }, frame: null,
  source: "image", keepColors: false, skipped: {},
};

/** SonicMediaRef d'un SVG (`blob:` seulement : un fichier ouvert dans la page), ou null. */
export function svgRefOf(v: unknown): { url: string } | null {
  const r = v as { url?: unknown; mime?: unknown; name?: unknown } | null;
  if (!r || typeof r.url !== "string" || !/^blob:/.test(r.url)) return null;
  const mime = String(r.mime ?? "").toLowerCase();
  return mime === "image/svg+xml" || (!mime && /\.svgz?$/i.test(String(r.name ?? ""))) ? { url: r.url } : null;
}

/**
 * Image → vecteurs : lit une source d'images (`sonic-still`, `sonic-camera`… par `#id`), quantifie les
 * couleurs, suit les contours et dessine des chemins SVG (courbes en option).
 * Déclenchement : `control` (`{ n }`, la hausse de `n` lance) ou `auto` (chaque nouvelle image de la source,
 * au plus toutes les `interval` ms). Réglages en attributs, ou en direct par DataProvider : les clés
 * `colors, tolerance, minArea, denoise, curves, flat, maxSize` lues dans `control` et dans `params`
 * relancent le calcul sur l'image déjà lue.
 * Résultat complet dans `out-data-provider` (voir `VectorizeState`).
 *
 * `svg-from` (DP d'un SonicMediaRef, ex. `ref-provider` de `sonic-file-open`) : quand il désigne un fichier SVG,
 * ses formes sont lues telles quelles (courbes, couleurs et opacités exactes ; voir `parseSvgDocument`) au lieu
 * d'être tracées depuis l'image ; sinon la source d'images est tracée comme d'habitude. Avec `auto`, chaque
 * nouveau fichier est lu dès qu'il arrive. `keep-colors` marque le résultat : couleurs d'origine à garder.
 */
@customElement("sonic-vectorize")
export class SonicVectorize extends LitElement {
  static styles = css`
    :host { display: block; line-height: 0; }
    :host([hidden-preview]) { display: none; }
    svg { display: block; width: 100%; height: auto; }
  `;

  @property({ type: String }) source = "";
  /** DP de pilotage : `{ n, …réglages }`. */
  @property({ type: String }) control = "";
  /** DP de réglages en direct : `{ colors, tolerance, minArea, denoise, curves, flat, maxSize }`. */
  @property({ type: String }) params = "";
  @property({ type: Boolean }) auto = false;
  /** Intervalle minimal (ms) entre deux analyses en mode auto. */
  @property({ type: Number }) interval = 500;
  @property({ type: Number }) colors = DEFAULTS.colors;
  @property({ type: Number }) tolerance = DEFAULTS.tolerance;
  @property({ type: Number, attribute: "min-area" }) minArea = DEFAULTS.minArea;
  @property({ type: Number }) denoise = DEFAULTS.denoise;
  @property({ type: Boolean }) curves = DEFAULTS.curves;
  @property({ type: Boolean }) flat = DEFAULTS.flat;
  /** Côté max (px) de l'image analysée : borne le temps de calcul. */
  @property({ type: Number, attribute: "max-size" }) maxSize = DEFAULTS.maxSize;
  /** Palette imposée : couleurs séparées par des virgules (ou clé DP `palette`, tableau ou chaîne). */
  @property({ type: String }) palette = "";
  @property({ type: Boolean, attribute: "hidden-preview" }) hiddenPreview = false;
  /** Calcule sur le fil principal plutôt que dans un Web Worker (débogage). */
  @property({ type: Boolean, attribute: "main-thread" }) mainThread = false;
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";
  @property({ type: String, attribute: "svg-from" }) svgFrom = "";
  @property({ type: Boolean, attribute: "keep-colors" }) keepColors = false;

  @state() private layerList: Layer[] = [];
  @state() private box = { w: 0, h: 0 };

  stateValue: VectorizeState = { ...IDLE };
  private trigger = new CounterTrigger();
  private unsubs: Array<() => void> = [];
  private fromControl: Partial<VectorizeSettings> = {};
  private fromParams: Partial<VectorizeSettings> = {};
  private image: ImageData | null = null;
  private imageMaxSize = 0;
  private sourceSize = { w: 0, h: 0 };
  private frame: number[] | null = null;
  private lastSeq = -1;
  private lastRun = 0;
  private runs = 0;
  private runner: TraceRunner | null = null;
  private job = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private fileUrl: string | null = null;
  private svgRef: { url: string } | null = null;
  /** Dernier SVG lu (URL) : la source d'images qui affiche le même fichier ne le fait pas retracer. */
  private svgDone: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    this.publish({ ...IDLE, settings: this.settings() });
    this.syncAuto();
  }

  disconnectedCallback(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    this.runner?.dispose();
    this.runner = null;
    this.revoke();
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("control") || c.has("params") || c.has("svgFrom")) this.listen();
    if (c.has("auto") || c.has("interval") || c.has("source")) this.syncAuto();
    if (["colors", "tolerance", "minArea", "denoise", "curves", "flat", "maxSize", "palette"].some((k) => c.has(k)) && this.image) this.schedule();
  }

  private listen(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.trigger.reset();
    if (this.control) this.unsubs.push(listenDp(this.control, (v) => {
      const next = readSettings(v);
      const changed = !sameSettings(next, this.fromControl);
      this.fromControl = next;
      if (this.trigger.feed(v)) this.run();
      else if (changed && this.image) this.schedule();
    }));
    if (this.svgFrom) {
      let first = true;
      this.unsubs.push(listenDp(this.svgFrom, (v) => {
        const ref = svgRefOf(v);
        const fresh = ref?.url !== this.svgRef?.url;
        this.svgRef = ref;
        if (!first && fresh && ref && this.auto) this.run(true);
        first = false;
      }));
    }
    if (this.params) this.unsubs.push(listenDp(this.params, (v) => {
      const next = readSettings(v);
      if (sameSettings(next, this.fromParams)) return;
      this.fromParams = next;
      if (this.image) this.schedule();
    }));
  }

  private syncAuto(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lastSeq = -1;
    if (!this.auto) return;
    const tick = () => {
      const el = this.resolve();
      if (!el || !isFrameSource(el)) return;
      const seq = el.frameSeq;
      if (seq === this.lastSeq) return;
      if (performance.now() - this.lastRun < Math.max(100, this.interval)) return;
      if (this.run(true)) this.lastSeq = seq;
    };
    this.timer = setInterval(tick, 100);
    tick();
  }

  /** Réglages effectifs, bornés. */
  settings(): VectorizeSettings {
    const s = {
      colors: this.colors, tolerance: this.tolerance, minArea: this.minArea, denoise: this.denoise,
      curves: this.curves, flat: this.flat, maxSize: this.maxSize, palette: paletteList(this.palette),
      ...this.fromControl, ...this.fromParams,
    };
    return {
      colors: Math.round(clamp(s.colors, 2, 32, DEFAULTS.colors)),
      tolerance: clamp(s.tolerance, 0.1, 10, DEFAULTS.tolerance),
      minArea: clamp(s.minArea, 0, 1e6, DEFAULTS.minArea),
      denoise: Math.round(clamp(s.denoise, 0, 3, DEFAULTS.denoise)),
      curves: !!s.curves,
      flat: !!s.flat,
      maxSize: Math.round(clamp(s.maxSize, 16, 1400, DEFAULTS.maxSize)),
      palette: parsePalette(s.palette).map((c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("")),
    };
  }

  /** Regroupe les changements de réglages rapprochés en un seul calcul. */
  private schedule(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = null;
      if (this.settings().maxSize !== this.imageMaxSize) this.run(true);
      else void this.recompute();
    }, 30);
  }

  private resolve(): Element | null {
    if (!this.source.startsWith("#")) return null;
    const id = this.source.slice(1);
    const root = this.getRootNode() as ParentNode;
    return (root as unknown as Document).getElementById?.(id) ?? document.getElementById(id);
  }

  private fail(error: string): void {
    this.publish({ ...this.stateValue, status: "error", error, settings: this.settings() });
  }

  private publish(s: VectorizeState): void {
    this.stateValue = s;
    if (this.outDataProvider) set(this.outDataProvider, s);
    this.dispatchEvent(new CustomEvent("vectorize-state", { detail: s, bubbles: true, composed: true }));
  }

  private revoke(): void {
    if (this.fileUrl) URL.revokeObjectURL(this.fileUrl);
    this.fileUrl = null;
  }

  /** Lit l'image courante de la source puis la vectorise. Retourne faux si la source n'est pas prête (mode silencieux). */
  run(quiet = false): boolean {
    // Fichier SVG désigné par `svg-from` : lu tel quel (une seule fois par fichier en mode auto).
    if (this.svgRef) {
      if (quiet && this.svgDone === this.svgRef.url) return true;
      void this.readSvg(this.svgRef.url);
      return true;
    }
    const el = this.resolve();
    if (!el || !isFrameSource(el)) {
      if (!quiet) this.fail("source introuvable ou sans image");
      return false;
    }
    const src = el.getFrameCanvas();
    if (!src || !src.width || !src.height) {
      if (!quiet) this.fail("image pas encore prête");
      return false;
    }
    this.lastRun = performance.now();
    const maxSize = this.settings().maxSize;
    try {
      const scale = Math.min(1, maxSize / Math.max(src.width, src.height));
      const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("canvas 2D indisponible");
      ctx.drawImage(src, 0, 0, w, h);
      this.image = ctx.getImageData(0, 0, w, h);
      this.imageMaxSize = maxSize;
      this.sourceSize = { w: src.width, h: src.height };
      const f = frameToClient(el, src);
      // Pixels analysés → pixels de la source → viewport.
      this.frame = f ? [f[0] / scale, f[1] / scale, f[2] / scale, f[3] / scale, f[4], f[5]] : null;
    } catch (e) {
      this.fail(e instanceof Error && e.name === "SecurityError" ? "image non lisible (CORS)" : e instanceof Error ? e.message : "lecture de l'image impossible");
      return true;
    }
    void this.recompute();
    return true;
  }

  /** Lit les formes d'un fichier SVG telles quelles et les publie comme des couches. */
  private async readSvg(url: string): Promise<void> {
    const job = ++this.job;
    const s = this.settings();
    this.svgDone = url;
    this.lastRun = performance.now();
    this.publish({ ...this.stateValue, status: "working", error: null, settings: s });
    const t0 = performance.now();
    let res;
    try {
      const text = await (await fetch(url)).text();
      if (job !== this.job) return;
      res = parseSvgDocument(text);
    } catch (e) {
      if (job !== this.job) return;
      this.fail(e instanceof Error ? e.message : "SVG illisible");
      return;
    }
    if (job !== this.job || !this.isConnected) return;
    if (!res.paths.length) { this.fail("aucune forme remplie dans ce SVG"); return; }
    const total = res.width * res.height || 1;
    const layers: Layer[] = res.paths.map((p) => ({ color: p.color, d: p.d, area: p.area }));
    const body = res.paths.map((p) => `<path fill="${p.color}"${p.opacity < 1 ? ` fill-opacity="${p.opacity}"` : ""} fill-rule="evenodd" d="${p.d}"/>`).join("");
    const doc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${res.width} ${res.height}" width="${res.width}" height="${res.height}">${body}</svg>`;
    this.layerList = layers;
    this.box = { w: res.width, h: res.height };
    this.image = null;
    this.runs++;
    this.revoke();
    this.publish({
      status: "ready", error: null, width: res.width, height: res.height, sourceWidth: res.width, sourceHeight: res.height,
      layers: layers.length,
      paths: res.paths.map((p) => ({ color: p.color, area: p.area, share: Math.round((p.area / total) * 1e4) / 1e4, d: p.d, opacity: p.opacity })),
      palette: [...new Set(res.paths.map((p) => p.color))], svg: doc, file: null, bytes: doc.length,
      ms: Math.round(performance.now() - t0), engine: "main", runs: this.runs, truncated: res.truncated, settings: s, frame: null,
      source: "svg", keepColors: this.keepColors, skipped: res.skipped,
    });
  }

  /** Vectorise la dernière image lue avec les réglages courants (dans un Web Worker si possible). */
  private async recompute(): Promise<void> {
    const img = this.image;
    if (!img) return;
    const s = this.settings();
    const job = ++this.job;
    const size = { ...this.sourceSize };
    const frame = this.frame;
    this.publish({ ...this.stateValue, status: "working", error: null, settings: s });
    if (!this.runner) this.runner = new TraceRunner(!this.mainThread);
    const runner = this.runner;
    const t0 = performance.now();
    let res: TraceResult;
    try {
      res = await runner.run(img, { colors: s.colors, tolerance: s.tolerance, minArea: s.minArea, denoise: s.denoise, curves: s.curves, stack: !s.flat, palette: s.palette });
    } catch (e) {
      if (e instanceof SupersededError || job !== this.job) return;
      this.fail(e instanceof Error ? e.message : "échec de la vectorisation");
      return;
    }
    if (job !== this.job || !this.isConnected) return;
    const doc = toSvg(res, { width: size.w, height: size.h });
    this.layerList = res.layers;
    this.box = { w: res.width, h: res.height };
    this.runs++;
    this.revoke();
    let file: VectorizeState["file"] = null;
    if (typeof URL.createObjectURL === "function" && typeof Blob !== "undefined") {
      this.fileUrl = URL.createObjectURL(new Blob([doc], { type: "image/svg+xml" }));
      file = { url: this.fileUrl, mime: "image/svg+xml", width: size.w, height: size.h };
    }
    const total = res.width * res.height || 1;
    this.publish({
      status: "ready", error: null, width: res.width, height: res.height,
      sourceWidth: size.w, sourceHeight: size.h,
      layers: res.layers.length,
      paths: res.layers.map((l) => ({ color: l.color, area: Math.round(l.area), share: Math.round((l.area / total) * 1e4) / 1e4, d: l.d })),
      palette: res.palette, svg: doc, file, bytes: doc.length,
      ms: Math.round(performance.now() - t0), engine: runner.engine, runs: this.runs, truncated: res.truncated, settings: s, frame,
      source: "image", keepColors: this.keepColors, skipped: {},
    });
  }

  render(): TemplateResult | typeof nothing {
    if (!this.layerList.length || this.hiddenPreview) return nothing;
    return svg`<svg viewBox="0 0 ${this.box.w} ${this.box.h}" role="img" aria-label="Image vectorisée">${this.layerList.map((l) => svg`<path fill=${l.color} fill-rule="evenodd" d=${l.d}></path>`)}</svg>`;
  }
}

/** Réglages présents dans une valeur de DataProvider (clés camelCase ou en tirets). */
export function readSettings(v: unknown): Partial<VectorizeSettings> {
  const p = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const o: Partial<VectorizeSettings> = {};
  const n = (key: keyof VectorizeSettings, alt: string, min: number, max: number) => {
    const x = num(p[key] ?? p[alt], min, max);
    if (x !== undefined) (o as Record<string, number>)[key] = x;
  };
  n("colors", "colors", 2, 32);
  n("tolerance", "tolerance", 0.1, 10);
  n("minArea", "min-area", 0, 1e6);
  n("denoise", "denoise", 0, 3);
  n("maxSize", "max-size", 16, 1400);
  const pal = p.palette;
  if (Array.isArray(pal) || typeof pal === "string" || (pal && typeof pal === "object")) o.palette = paletteList(pal);
  for (const key of ["curves", "flat"] as const) {
    const x = p[key];
    if (typeof x === "boolean") o[key] = x;
    else if (typeof x === "number") o[key] = x !== 0;
  }
  return o;
}

function sameSettings(a: Partial<VectorizeSettings>, b: Partial<VectorizeSettings>): boolean {
  const ka = Object.keys(a) as (keyof VectorizeSettings)[];
  const eq = (x: unknown, y: unknown) => (Array.isArray(x) && Array.isArray(y) ? x.join() === y.join() : x === y);
  return ka.length === Object.keys(b).length && ka.every((k) => eq(a[k], b[k]));
}

/** Palette en tableau ou en chaîne « #a, #b » ; aussi `{ colors: [...] }` (état de `sonic-palette`). */
function paletteList(v: unknown): string[] {
  if (v && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as { colors?: unknown }).colors)) return paletteList((v as { colors: unknown[] }).colors);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").map((x) => x.trim());
  if (typeof v === "string") return v.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  return [];
}

const clamp = (v: unknown, a: number, b: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d;
};
