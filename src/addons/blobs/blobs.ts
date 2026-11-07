import { LitElement, css, nothing, svg, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger, num } from "../../shared/media/control";
import { isFrameSource } from "../../shared/mediaRef";
import { detectBlobs, toOverlaySvg, type BlobOptions, type BlobResult, type Polarity } from "./detect";

export type BlobItem = {
  id: number;
  /** Centre et boîte en pixels de l'image analysée. */
  cx: number; cy: number; x: number; y: number; w: number; h: number;
  /** Mêmes valeurs en 0..1 (repère de l'image), pour se placer sur l'image affichée. */
  nx: number; ny: number; nw: number; nh: number;
  area: number;
  k: number;
  split: boolean;
  border: boolean;
};

export type BlobsState = {
  status: "idle" | "working" | "ready" | "error";
  error: string | null;
  width: number;
  height: number;
  count: number;
  estimate: number;
  clusters: number;
  median: number;
  reference: "median" | "point" | "area";
  polarity: "dark" | "light" | null;
  ms: number;
  runs: number;
  blobs: BlobItem[];
  overlay: { url: string };
};

const EMPTY_SVG = "data:image/svg+xml;charset=utf-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
const IDLE: BlobsState = {
  status: "idle", error: null, width: 0, height: 0, count: 0, estimate: 0, clusters: 0, median: 0,
  reference: "median", polarity: null, ms: 0, runs: 0, blobs: [], overlay: { url: EMPTY_SVG },
};
const MAX_BLOBS = 2000;
const POLARITIES: Polarity[] = ["auto", "dark", "light"];

/**
 * Compte les objets d'une image : seuillage adaptatif, composantes connexes, séparation
 * des objets qui se touchent. Source : `#id` d'une source d'images (`sonic-still`, `sonic-camera`…).
 * Déclenchement : `control` (`{ n }`, une hausse lance) ou `auto` (chaque nouvelle image, au plus
 * toutes les `interval` ms : en continu sur une caméra). Réglages en attributs ou en direct par `params`.
 * Résultat dans `out-data-provider` ; l'aperçu dessine les marqueurs (à superposer à l'image, même `fit`).
 */
@customElement("sonic-blobs")
export class SonicBlobs extends LitElement {
  static styles = css`
    :host { display: block; line-height: 0; pointer-events: none; }
    :host([hidden-preview]) { display: none; }
    svg { display: block; width: 100%; height: 100%; overflow: visible; }
    text { font-family: ui-monospace, monospace; font-weight: 700; paint-order: stroke; }
  `;

  @property({ type: String }) source = "";
  @property({ type: String }) control = "";
  @property({ type: Boolean }) auto = false;
  /** Intervalle minimal (ms) entre deux analyses en mode auto. */
  @property({ type: Number }) interval = 500;
  @property({ type: Number, attribute: "max-size" }) maxSize = 640;
  @property({ type: String }) polarity: Polarity = "auto";
  @property({ type: Number }) flatten = 0.12;
  @property({ type: Number }) bias = 0;
  @property({ type: Number }) open = 1;
  @property({ type: Number, attribute: "min-area-frac" }) minAreaFrac = 0.0002;
  @property({ type: Number, attribute: "min-area-rel" }) minAreaRel = 0.3;
  @property({ type: Boolean, attribute: "no-split" }) noSplit = false;
  @property({ type: Number, attribute: "split-ratio" }) splitRatio = 1.6;
  @property({ type: Number, attribute: "peak-rel" }) peakRel = 0.55;
  @property({ type: Number, attribute: "min-part-rel" }) minPartRel = 0.6;
  @property({ type: Boolean, attribute: "drop-border" }) dropBorder = false;
  /** DP d'un point {x, y} (0..1) sur un objet type : sa taille devient la référence. */
  @property({ type: String, attribute: "ref-from" }) refFrom = "";
  /** DP de réglages en direct : {polarity, bias, flatten, open, minAreaRel, split, dropBorder}. */
  @property({ type: String }) params = "";
  /** Cadrage de l'aperçu, comme l'image dessous : contain (défaut) | cover. */
  @property({ type: String }) fit: "contain" | "cover" = "contain";
  @property({ type: Boolean, attribute: "hidden-preview" }) hiddenPreview = false;
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  @state() private result: BlobResult | null = null;

  stateValue: BlobsState = { ...IDLE };
  private trigger = new CounterTrigger();
  private unsubs: Array<() => void> = [];
  private live: Partial<BlobOptions> = {};
  private refPoint: { x: number; y: number } | null = null;
  private image: ImageData | null = null;
  private lastSeq = -1;
  private lastRun = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private runs = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    this.publish(IDLE);
    this.syncAuto();
  }

  disconnectedCallback(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("control") || c.has("refFrom") || c.has("params")) this.listen();
    if (c.has("auto") || c.has("interval")) this.syncAuto();
  }

  private listen(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.trigger.reset();
    if (this.control) this.unsubs.push(listenDp(this.control, (v) => { if (this.trigger.feed(v)) this.run(); }));
    if (this.refFrom) this.unsubs.push(listenDp(this.refFrom, (v) => {
      const p = v as { x?: unknown; y?: unknown } | null;
      const x = num(p?.x, 0, 1), y = num(p?.y, 0, 1);
      this.refPoint = x !== undefined && y !== undefined ? { x, y } : null;
      this.recompute();
    }));
    if (this.params) this.unsubs.push(listenDp(this.params, (v) => {
      this.live = readParams(v);
      this.recompute();
    }));
  }

  private syncAuto(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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

  private resolve(): Element | null {
    if (!this.source.startsWith("#")) return null;
    const id = this.source.slice(1);
    const root = this.getRootNode() as ParentNode;
    return (root as unknown as Document).getElementById?.(id) ?? document.getElementById(id);
  }

  private options(): BlobOptions {
    const o: BlobOptions = {
      polarity: POLARITIES.includes(this.polarity) ? this.polarity : "auto",
      flatten: clamp(this.flatten, 0.02, 0.5),
      bias: clamp(this.bias, -3, 3),
      open: Math.round(clamp(this.open, 0, 4)),
      minAreaFrac: clamp(this.minAreaFrac, 0, 0.5),
      minAreaRel: clamp(this.minAreaRel, 0, 1),
      split: !this.noSplit,
      splitRatio: clamp(this.splitRatio, 1.1, 5),
      peakRel: clamp(this.peakRel, 0.1, 0.95),
      minPartRel: clamp(this.minPartRel, 0.1, 1),
      dropBorder: this.dropBorder,
      ...this.live,
    };
    if (this.refPoint && this.image) o.refPoint = { x: this.refPoint.x * (this.image.width - 1), y: this.refPoint.y * (this.image.height - 1) };
    return o;
  }

  private fail(error: string): void {
    this.result = null;
    this.publish({ ...IDLE, status: "error", error, runs: this.runs });
  }

  private publish(s: BlobsState): void {
    this.stateValue = s;
    if (this.outDataProvider) set(this.outDataProvider, s);
    this.dispatchEvent(new CustomEvent("blobs-state", { detail: s, bubbles: true, composed: true }));
  }

  /** Analyse l'image courante de la source. Retourne faux si elle n'est pas prête (mode silencieux). */
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
    try {
      const scale = Math.min(1, Math.max(64, Math.min(1600, this.maxSize)) / Math.max(src.width, src.height));
      const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("canvas 2D indisponible");
      ctx.drawImage(src, 0, 0, w, h);
      this.image = ctx.getImageData(0, 0, w, h);
    } catch (e) {
      this.fail(e instanceof Error && e.name === "SecurityError" ? "image non lisible (CORS)" : e instanceof Error ? e.message : "lecture de l'image impossible");
      return true;
    }
    this.recompute();
    return true;
  }

  /** Recalcule sur la dernière image lue (réglages ou point de référence modifiés). */
  private recompute(): void {
    const img = this.image;
    if (!img) return;
    this.publish({ ...this.stateValue, status: "working", error: null });
    try {
      const r = detectBlobs(img.data, img.width, img.height, this.options());
      this.result = r;
      this.runs++;
      const blobs = r.blobs.slice(0, MAX_BLOBS);
      this.publish({
        status: "ready", error: null, width: r.width, height: r.height,
        count: r.count, estimate: r.estimate, clusters: r.blobs.filter((b) => b.k > 1).length,
        median: Math.round(r.median), reference: r.reference, polarity: r.polarity, ms: r.ms, runs: this.runs,
        blobs: blobs.map((b) => ({
          id: b.id, cx: round1(b.cx), cy: round1(b.cy), x: b.x, y: b.y, w: b.w, h: b.h,
          nx: round4(b.cx / r.width), ny: round4(b.cy / r.height), nw: round4(b.w / r.width), nh: round4(b.h / r.height),
          area: b.area, k: b.k, split: b.split, border: b.border,
        })),
        overlay: { url: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(toOverlaySvg({ width: r.width, height: r.height, blobs })) },
      });
    } catch (e) {
      this.fail(e instanceof Error ? e.message : "échec de l'analyse");
    }
  }

  render(): TemplateResult | typeof nothing {
    const r = this.result;
    if (!r || this.hiddenPreview) return nothing;
    const sw = Math.max(1, Math.min(r.width, r.height) / 160);
    const fs = Math.max(8, Math.min(r.width, r.height) / 22);
    return svg`<svg viewBox="0 0 ${r.width} ${r.height}" preserveAspectRatio=${this.fit === "cover" ? "xMidYMid slice" : "xMidYMid meet"} role="img" aria-label=${`${r.count} objets`}>
      ${r.blobs.slice(0, MAX_BLOBS).map((b, i) => svg`
        <circle cx=${b.cx} cy=${b.cy} r=${Math.max(b.w, b.h) / 2 + sw * 2} fill="none" stroke=${b.split ? "var(--sonic-blobs-split, #ff7a00)" : "var(--sonic-blobs-color, #f5c400)"} stroke-width=${sw}></circle>
        <text x=${b.cx} y=${b.cy + fs * 0.35} font-size=${fs} text-anchor="middle" fill="#fff" stroke="#111" stroke-width=${sw * 0.9}>${b.k > 1 ? `×${b.k}` : i + 1}</text>`)}
    </svg>`;
  }
}

function readParams(v: unknown): Partial<BlobOptions> {
  const p = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const o: Partial<BlobOptions> = {};
  if (typeof p.polarity === "string" && POLARITIES.includes(p.polarity as Polarity)) o.polarity = p.polarity as Polarity;
  const bias = num(p.bias, -3, 3); if (bias !== undefined) o.bias = bias;
  const flatten = num(p.flatten, 0.02, 0.5); if (flatten !== undefined) o.flatten = flatten;
  const open = num(p.open, 0, 4); if (open !== undefined) o.open = Math.round(open);
  const rel = num(p.minAreaRel, 0, 1); if (rel !== undefined) o.minAreaRel = rel;
  if (typeof p.split === "boolean") o.split = p.split;
  if (typeof p.split === "number") o.split = p.split !== 0;
  if (typeof p.dropBorder === "boolean") o.dropBorder = p.dropBorder;
  return o;
}

const clamp = (v: number, a: number, b: number) => (Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : a);
const round1 = (v: number) => Math.round(v * 10) / 10;
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
