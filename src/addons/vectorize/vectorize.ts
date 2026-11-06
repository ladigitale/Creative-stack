import { LitElement, css, nothing, svg, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import { isFrameSource } from "../../shared/mediaRef";
import { toSvg, trace, type Layer, type TraceResult } from "./trace";

export type VectorizeState = {
  status: "idle" | "working" | "ready" | "error";
  error: string | null;
  width: number;
  height: number;
  layers: number;
  palette: string[];
  svg: string;
  ms: number;
  truncated: boolean;
};

const IDLE: VectorizeState = { status: "idle", error: null, width: 0, height: 0, layers: 0, palette: [], svg: "", ms: 0, truncated: false };

/**
 * Image → vecteurs : lit une source d'images (`sonic-still`, `sonic-camera`… par `#id`), quantifie les
 * couleurs, suit les contours et dessine des chemins SVG (courbes de Bézier en option).
 * Déclenchement : `control` (`{ n }`, la hausse de `n` lance) ou `auto` (une fois l'image prête).
 * Résultat dans `out-data-provider` : `{ status, svg, layers, palette, width, height, ms, error }`.
 */
@customElement("sonic-vectorize")
export class SonicVectorize extends LitElement {
  static styles = css`
    :host { display: block; line-height: 0; }
    :host([hidden-preview]) { display: none; }
    svg { display: block; width: 100%; height: auto; }
  `;

  @property({ type: String }) source = "";
  @property({ type: String }) control = "";
  @property({ type: Boolean }) auto = false;
  @property({ type: Number }) colors = 8;
  @property({ type: Number }) tolerance = 0.8;
  @property({ type: Number, attribute: "min-area" }) minArea = 4;
  @property({ type: Number }) denoise = 1;
  @property({ type: Boolean }) curves = false;
  @property({ type: Boolean }) flat = false;
  /** Côté max (px) de l'image analysée : borne le temps de calcul. */
  @property({ type: Number, attribute: "max-size" }) maxSize = 256;
  @property({ type: Boolean, attribute: "hidden-preview" }) hiddenPreview = false;
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  @state() private layers: Layer[] = [];
  @state() private box = { w: 0, h: 0 };

  stateValue: VectorizeState = { ...IDLE };
  private trigger = new CounterTrigger();
  private unsub: (() => void) | null = null;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    this.publish(IDLE);
    if (this.auto) this.waitAndRun(0);
  }

  disconnectedCallback(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("control")) this.listen();
  }

  private listen(): void {
    this.unsub?.();
    this.unsub = null;
    this.trigger.reset();
    if (this.control) this.unsub = listenDp(this.control, (v) => { if (this.trigger.feed(v)) this.run(); });
  }

  private waitAndRun(tries: number): void {
    if (this.run(true)) return;
    if (tries < 50) this.autoTimer = setTimeout(() => this.waitAndRun(tries + 1), 100);
    else this.fail("source d'images indisponible");
  }

  private resolve(): Element | null {
    if (!this.source.startsWith("#")) return null;
    const id = this.source.slice(1);
    const root = this.getRootNode() as ParentNode;
    return (root as unknown as Document).getElementById?.(id) ?? document.getElementById(id);
  }

  private fail(error: string): void {
    this.publish({ ...IDLE, status: "error", error });
  }

  private publish(s: VectorizeState): void {
    this.stateValue = s;
    if (this.outDataProvider) set(this.outDataProvider, s);
    this.dispatchEvent(new CustomEvent("vectorize-state", { detail: s, bubbles: true, composed: true }));
  }

  /** Lance la vectorisation de l'image courante. Retourne faux si la source n'est pas encore prête (mode silencieux). */
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
    this.publish({ ...IDLE, status: "working" });
    try {
      const t0 = performance.now();
      const scale = Math.min(1, Math.max(16, this.maxSize) / Math.max(src.width, src.height));
      const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("canvas 2D indisponible");
      ctx.drawImage(src, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const res: TraceResult = trace(img, { colors: this.colors, tolerance: this.tolerance, minArea: this.minArea, denoise: this.denoise, curves: this.curves, stack: !this.flat });
      this.layers = res.layers;
      this.box = { w: res.width, h: res.height };
      this.publish({ status: "ready", error: null, width: res.width, height: res.height, layers: res.layers.length, palette: res.palette, svg: toSvg(res), ms: Math.round(performance.now() - t0), truncated: res.truncated });
    } catch (e) {
      this.fail(e instanceof Error && e.name === "SecurityError" ? "image non lisible (CORS)" : e instanceof Error ? e.message : "échec de la vectorisation");
    }
    return true;
  }

  render(): TemplateResult | typeof nothing {
    if (!this.layers.length) return nothing;
    return svg`<svg viewBox="0 0 ${this.box.w} ${this.box.h}" role="img">${this.layers.map((l) => svg`<path fill=${l.color} fill-rule="evenodd" d=${l.d}></path>`)}</svg>`;
  }
}
