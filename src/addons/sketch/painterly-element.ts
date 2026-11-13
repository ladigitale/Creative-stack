import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp, plain } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import { isFrameSource } from "../../shared/mediaRef";
import { STROKES_DEFAULT, illustrateImage } from "./illustrate";
import { paintImage, type PainterlyOptions } from "./painterly";

export type PainterlyState = {
  /** `idle` : rien à peindre ; `loading` : image en cours de chargement ; `working` ; `ready` ; `error`. */
  status: "idle" | "loading" | "working" | "ready" | "error";
  error: string | null;
  /** Jeu de gestes (JSON) en URL `blob:` : à brancher sur `sonic-sketch gestures-from="<dp>.url"` ou `gestures-from="<dp>"`. */
  url: string | null;
  width: number;
  height: number;
  /** Nombre de traits, couches (rayon en unités du cadre, traits), écart moyen restant (0..1), durée. */
  strokes: number;
  layers: { radius: number; strokes: number }[];
  residual: number;
  ms: number;
  runs: number;
};

const IDLE: PainterlyState = { status: "idle", error: null, url: null, width: 0, height: 0, strokes: 0, layers: [], residual: 0, ms: 0, runs: 0 };
const OPTION_KEYS = ["maxSide", "detail", "layers", "threshold", "maxLength", "curvature", "opacity", "jitter", "maxStrokes", "frame", "seed", "background", "style"] as const;

/** URL d'image acceptée (`https:`, `blob:`, `data:image/…` ; `http:` pour localhost), ou null. */
export function imageUrlOf(v: unknown): string | null {
  const u = typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { url?: unknown }).url === "string" ? (v as { url: string }).url : null;
  if (!u) return null;
  const t = u.trim();
  return /^(https:|blob:)/i.test(t) || /^data:image\/(png|jpeg|webp|gif|avif)[;,]/i.test(t) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(t) ? t : null;
}

/** Réglages (attributs puis DP `params`) bornés pour `paintImage`. */
export function readPainterlyOptions(v: unknown): PainterlyOptions {
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const out: PainterlyOptions = {};
  for (const k of OPTION_KEYS) {
    const x = o[k];
    if (k === "style") { if (x === "realiste" || x === "illustration" || x === "huile") out.style = x; continue; }
    if (k === "background") { if (typeof x === "string" && /^#[0-9a-f]{6}$/i.test(x)) out.background = x; continue; }
    const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
    if (Number.isFinite(n)) (out as Record<string, number>)[k] = n;
  }
  return out;
}

/**
 * Peintre : peint une image en gestes de pinceau (`painterly.ts`, du gros au fin, là où il manque encore du
 * détail), rejoués ensuite par `sonic-sketch` avec ses vrais pinceaux. N'importe quelle image : une source
 * d'images de la page (`source="#id"`, ex. `sonic-still`, `sonic-camera`) ou une URL d'image (`src-from`, DP d'une
 * chaîne ou de `{url}` : asset d'artefact, fichier ouvert). Réglages `max-side`, `detail`, `max-strokes` ou DP
 * `params` ; peint à chaque nouvelle image avec `auto`, ou sur demande (`control`, compteur `paint`).
 * Le jeu de gestes est publié en URL `blob:` (pas de gros volume dans les DataProviders) dans `out-data-provider`.
 */
@customElement("sonic-painterly")
export class SonicPainterly extends LitElement {
  static styles = css`:host { display: none; }`;

  @property({ type: String }) source = "";
  @property({ type: String, attribute: "src-from" }) srcFrom = "";
  @property({ type: String }) params = "";
  @property({ type: String }) control = "";
  @property({ type: Boolean }) auto = false;
  @property({ type: Number, attribute: "max-side" }) maxSide = 360;
  @property({ type: Number }) detail = 0.6;
  /** Plafond de traits ; 0 (défaut) : celui de la manière (réaliste 5000, illustration 3000, huile 12000). */
  @property({ type: Number, attribute: "max-strokes" }) maxStrokes = 0;
  /** `realiste` (défaut : touches fondues, proche de l'image), `illustration` (passes visibles) ou `huile` (touches opaques). */
  @property({ type: String, attribute: "paint-style" }) paintStyle: "realiste" | "illustration" | "huile" = "realiste";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  private state: PainterlyState = { ...IDLE };
  private unsubs: (() => void)[] = [];
  private trigger = new CounterTrigger();
  private live: PainterlyOptions = {};
  private srcUrl: string | null = null;
  private job = 0;
  private blobUrl: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSeq = -1;

  getState(): PainterlyState { return this.state; }

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    this.publish({ ...IDLE });
  }

  disconnectedCallback(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.job++;
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = null;
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if ((c.has("srcFrom") || c.has("params") || c.has("control") || c.has("auto") || c.has("source")) && this.isConnected && c.get("srcFrom") !== undefined) this.listen();
  }

  private listen(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.trigger.reset();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.params) this.unsubs.push(listenDp(this.params, (v) => { this.live = readPainterlyOptions(v); }));
    if (this.control) this.unsubs.push(listenDp(this.control, (v) => {
      const c = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
      if (this.trigger.feed(c.paint)) void this.paint();
    }));
    if (this.srcFrom) {
      // Une image déjà là au branchement n'est peinte que sur demande ; chaque nouvelle l'est avec `auto`.
      this.srcUrl = imageUrlOf(plain(get(this.srcFrom)));
      this.unsubs.push(listenDp(this.srcFrom, (v) => {
        const u = imageUrlOf(v);
        if (u === this.srcUrl) return;
        this.srcUrl = u;
        if (u && this.auto) void this.paint();
      }));
    }
    if (this.source && this.auto) {
      this.timer = setInterval(() => {
        const el = this.resolve();
        if (!el || !isFrameSource(el) || el.frameSeq === this.lastSeq || this.state.status === "working") return;
        this.lastSeq = el.frameSeq;
        void this.paint();
      }, 250);
    }
  }

  private resolve(): Element | null {
    if (!this.source.startsWith("#")) return null;
    const id = this.source.slice(1);
    const root = this.getRootNode() as ParentNode;
    return (root as unknown as Document).getElementById?.(id) ?? document.getElementById(id);
  }

  /** Réglages effectifs : attributs, puis `params`. */
  options(): PainterlyOptions {
    const o: PainterlyOptions = { maxSide: this.maxSide, detail: this.detail, style: this.paintStyle === "huile" || this.paintStyle === "illustration" ? this.paintStyle : "realiste", ...this.live };
    if (this.maxStrokes > 0 && this.live.maxStrokes === undefined) o.maxStrokes = this.maxStrokes;
    if (!o.maxStrokes) o.maxStrokes = STROKES_DEFAULT[o.style ?? "realiste"];
    return o;
  }

  /** Charge l'image (URL ou source de la page) et la peint. Retourne le nombre de traits. */
  async paint(): Promise<number> {
    const job = ++this.job;
    const t0 = performance.now();
    let pixels: ImageData | null = null;
    try {
      const maxSide = Math.max(32, Math.min(1200, Number(this.options().maxSide) || 360));
      let src: CanvasImageSource | null = null, sw = 0, sh = 0;
      if (this.srcUrl) {
        this.publish({ ...this.state, status: "loading", error: null });
        const img = await loadImage(this.srcUrl);
        src = img; sw = img.naturalWidth; sh = img.naturalHeight;
      } else {
        const el = this.resolve();
        if (!el || !isFrameSource(el)) throw new Error("ni image (src-from) ni source (source=\"#id\")");
        const c = el.getFrameCanvas();
        if (!c || !c.width || !c.height) throw new Error("image pas encore prête");
        src = c; sw = c.width; sh = c.height;
      }
      if (job !== this.job) return 0;
      // Lecture des pixels à une taille modeste (l'analyse réduit encore).
      const k = Math.min(1, (maxSide * 2) / Math.max(sw, sh));
      const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("canvas 2D indisponible");
      ctx.drawImage(src, 0, 0, w, h);
      pixels = ctx.getImageData(0, 0, w, h);
    } catch (e) {
      if (job === this.job) this.publish({ ...this.state, status: "error", error: e instanceof Error ? e.message : "image illisible" });
      return 0;
    }
    this.publish({ ...this.state, status: "working", error: null });
    // Laisse l'état s'afficher avant le calcul (quelques centaines de ms à quelques secondes).
    await new Promise((r) => setTimeout(r, 0));
    if (job !== this.job) return 0;
    try {
      const o = this.options();
      const res = o.style === "huile" ? paintImage(pixels, o) : illustrateImage(pixels, o);
      const doc = JSON.stringify({ width: res.width, height: res.height, strokes: res.strokes });
      if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = URL.createObjectURL(new Blob([doc], { type: "application/json" }));
      this.publish({
        status: "ready", error: null, url: this.blobUrl, width: res.width, height: res.height, strokes: res.strokes.length,
        layers: res.layers, residual: Math.round(res.error * 1e4) / 1e4, ms: Math.round(performance.now() - t0), runs: this.state.runs + 1,
      });
      return res.strokes.length;
    } catch (e) {
      this.publish({ ...this.state, status: "error", error: e instanceof Error ? e.message : "peinture impossible" });
      return 0;
    }
  }

  private publish(s: PainterlyState): void {
    this.state = s;
    if (this.outDataProvider) set(this.outDataProvider, s);
    this.dispatchEvent(new CustomEvent("painterly-state", { detail: s, bubbles: true, composed: true }));
  }

  render() {
    return html``;
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, ko) => {
    const img = new Image();
    if (!/^(blob:|data:)/i.test(url)) img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => ok(img);
    img.onerror = () => ko(new Error("image introuvable ou refusée"));
    img.src = url;
  });
}
