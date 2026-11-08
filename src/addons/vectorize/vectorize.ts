import { LitElement, css, nothing, svg, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger, num } from "../../shared/media/control";
import { isFrameSource } from "../../shared/mediaRef";
import { toSvg, trace, type Layer, type TraceResult } from "./trace";

/** Réglages effectifs (attributs, puis `control`, puis `params` : le dernier l'emporte). */
export type VectorizeSettings = {
  colors: number;
  tolerance: number;
  minArea: number;
  denoise: number;
  curves: boolean;
  flat: boolean;
  maxSize: number;
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
  /** Détail des couches, du dessous au-dessus : couleur, surface (px² analysés) et part de l'image (0..1). */
  paths: { color: string; area: number; share: number }[];
  palette: string[];
  /** Document SVG autonome. */
  svg: string;
  /** Même SVG en SonicMediaRef (`blob:`), pour `sonic-media-download`, `sonic-image`, `sonic-still`. */
  file: { url: string; mime: string; width: number; height: number } | null;
  bytes: number;
  ms: number;
  runs: number;
  truncated: boolean;
  settings: VectorizeSettings;
};

const DEFAULTS: VectorizeSettings = { colors: 8, tolerance: 1, minArea: 4, denoise: 1, curves: false, flat: false, maxSize: 512 };
const IDLE: VectorizeState = {
  status: "idle", error: null, width: 0, height: 0, sourceWidth: 0, sourceHeight: 0, layers: 0, paths: [], palette: [],
  svg: "", file: null, bytes: 0, ms: 0, runs: 0, truncated: false, settings: { ...DEFAULTS },
};

/**
 * Image → vecteurs : lit une source d'images (`sonic-still`, `sonic-camera`… par `#id`), quantifie les
 * couleurs, suit les contours et dessine des chemins SVG (courbes en option).
 * Déclenchement : `control` (`{ n }`, la hausse de `n` lance) ou `auto` (chaque nouvelle image de la source,
 * au plus toutes les `interval` ms). Réglages en attributs, ou en direct par DataProvider : les clés
 * `colors, tolerance, minArea, denoise, curves, flat, maxSize` lues dans `control` et dans `params`
 * relancent le calcul sur l'image déjà lue.
 * Résultat complet dans `out-data-provider` (voir `VectorizeState`).
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
  @property({ type: Boolean, attribute: "hidden-preview" }) hiddenPreview = false;
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

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
  private lastSeq = -1;
  private lastRun = 0;
  private runs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private fileUrl: string | null = null;

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
    this.revoke();
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("control") || c.has("params")) this.listen();
    if (c.has("auto") || c.has("interval") || c.has("source")) this.syncAuto();
    if (["colors", "tolerance", "minArea", "denoise", "curves", "flat", "maxSize"].some((k) => c.has(k)) && this.image) this.schedule();
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
      curves: this.curves, flat: this.flat, maxSize: this.maxSize,
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
    };
  }

  /** Regroupe les changements de réglages rapprochés en un seul calcul. */
  private schedule(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = null;
      if (this.settings().maxSize !== this.imageMaxSize) this.run(true);
      else this.recompute();
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
    } catch (e) {
      this.fail(e instanceof Error && e.name === "SecurityError" ? "image non lisible (CORS)" : e instanceof Error ? e.message : "lecture de l'image impossible");
      return true;
    }
    this.recompute();
    return true;
  }

  /** Vectorise la dernière image lue avec les réglages courants. */
  private recompute(): void {
    const img = this.image;
    if (!img) return;
    const s = this.settings();
    this.publish({ ...this.stateValue, status: "working", error: null, settings: s });
    try {
      const t0 = performance.now();
      const res: TraceResult = trace(img, { colors: s.colors, tolerance: s.tolerance, minArea: s.minArea, denoise: s.denoise, curves: s.curves, stack: !s.flat });
      const doc = toSvg(res, { width: this.sourceSize.w, height: this.sourceSize.h });
      this.layerList = res.layers;
      this.box = { w: res.width, h: res.height };
      this.runs++;
      this.revoke();
      let file: VectorizeState["file"] = null;
      if (typeof URL.createObjectURL === "function" && typeof Blob !== "undefined") {
        this.fileUrl = URL.createObjectURL(new Blob([doc], { type: "image/svg+xml" }));
        file = { url: this.fileUrl, mime: "image/svg+xml", width: this.sourceSize.w, height: this.sourceSize.h };
      }
      const total = res.width * res.height || 1;
      this.publish({
        status: "ready", error: null, width: res.width, height: res.height,
        sourceWidth: this.sourceSize.w, sourceHeight: this.sourceSize.h,
        layers: res.layers.length,
        paths: res.layers.map((l) => ({ color: l.color, area: Math.round(l.area), share: Math.round((l.area / total) * 1e4) / 1e4 })),
        palette: res.palette, svg: doc, file, bytes: doc.length,
        ms: Math.round(performance.now() - t0), runs: this.runs, truncated: res.truncated, settings: s,
      });
    } catch (e) {
      this.fail(e instanceof Error ? e.message : "échec de la vectorisation");
    }
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
  for (const key of ["curves", "flat"] as const) {
    const x = p[key];
    if (typeof x === "boolean") o[key] = x;
    else if (typeof x === "number") o[key] = x !== 0;
  }
  return o;
}

function sameSettings(a: Partial<VectorizeSettings>, b: Partial<VectorizeSettings>): boolean {
  const ka = Object.keys(a) as (keyof VectorizeSettings)[];
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

const clamp = (v: unknown, a: number, b: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d;
};
