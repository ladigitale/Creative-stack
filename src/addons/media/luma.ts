import { LitElement, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { dispatch } from "../interactive";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger, num } from "../../shared/media/control";
import type { FrameInfo, FrameListener } from "../../shared/media/frames";
import { LUMA_DEFAULTS, LumaDetector, measureLuma, parseRegion, type LumaEdge } from "../../shared/media/luma";
import { isFrameSource } from "../../shared/mediaRef";

const tagName = "sonic-luma";

/** Pas de la boucle qui retrouve la source (créée après coup, remplacée, retirée). */
const SYNC_MS = 300;
const MEASURES = ["mean", "peak"] as const;
type Measure = (typeof MEASURES)[number];

export type LumaSettings = {
  active: boolean;
  measure: Measure;
  region: string;
  resolution: number;
  /** null : seuil automatique. */
  threshold: number | null;
  minContrast: number;
  adaptMs: number;
  hysteresis: number;
  interval: number;
};

export type LumaState = {
  status: "idle" | "ready" | "error";
  error: string | null;
  active: boolean;
  /** Luminosité moyenne de la zone, 0..1. */
  level: number;
  /** Point le plus clair de la zone, 0..1, et sa position dans la zone. */
  peak: number;
  peakX: number;
  peakY: number;
  /** Niveaux sombre et clair observés, et leur écart. */
  lo: number;
  hi: number;
  contrast: number;
  /** Un signal est lisible (écart suffisant). */
  signal: boolean;
  /** La lumière est allumée. */
  on: boolean;
  /** Nombre de fronts depuis le démarrage (ou la remise à zéro). */
  edges: number;
  last: LumaEdge | null;
  /** Derniers fronts, du plus ancien au plus récent. */
  events: LumaEdge[];
  /** Images analysées par seconde. */
  fps: number;
  /** Origine des instants : capture (instant de prise de vue), frame (présentation), poll (relevé). */
  clock: "capture" | "frame" | "poll" | null;
  settings: LumaSettings;
};

type TimedSource = Element & {
  addFrameListener?: (l: FrameListener) => () => void;
  getFrameSource?: () => CanvasImageSource | null;
};

const r1 = (v: number) => Math.round(v * 10) / 10;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

function roundEdge(e: LumaEdge): LumaEdge {
  return {
    n: e.n,
    on: e.on,
    t: r1(e.t),
    dur: r1(e.dur),
    level: r4(e.level),
    sinceMark: e.sinceMark === null ? null : r1(e.sinceMark),
    markGap: e.markGap === null ? null : r1(e.markGap),
  };
}

function truthy(v: unknown): boolean {
  if (typeof v === "string") return v !== "" && v !== "false" && v !== "0";
  return Boolean(v);
}

/**
 * Sonde de luminosité : mesure, image par image, la luminosité d'une source d'images (`source="#cam"`)
 * et détecte les fronts allumé / éteint d'un signal lumineux (lampe, torche, écran qui clignote).
 *
 * - Mesure : `level` (moyenne de la zone) et `peak` (point le plus clair) ; `measure` choisit laquelle
 *   pilote la détection (`mean` pour une scène entière, `peak` pour une lampe lointaine).
 * - Fronts : seuil automatique (ou `threshold` fixe), horodatés à l'instant de capture de l'image quand
 *   la source le fournit (`sonic-camera`). Chaque front est publié dans l'état (`last`, `events`) et
 *   envoyé en action au store `target` : `{type, payload: {n, on, t, dur, level, sinceMark, markGap, fps, clock}}`.
 * - `mark-from` : chemin d'un DataProvider booléen qui commande la lumière (ex. `reglages.torch`) ;
 *   chaque front porte alors le délai commande → lumière (`sinceMark`).
 *
 * Réglages en attributs ou en direct par `params` ; `control {reset: n}` remet la détection à zéro.
 */
@customElement(tagName)
export class SonicLuma extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** `#id` d'une source d'images (sonic-camera, sonic-video, sonic-screen, sonic-shader…). */
  @property({ type: String })
  source = "";

  /** `mean` (défaut) : moyenne de la zone ; `peak` : point le plus clair. */
  @property({ type: String })
  measure: Measure = "mean";

  /** Zone analysée « x,y,w,h » en 0..1 de l'image (défaut : toute l'image). */
  @property({ type: String })
  region = "";

  /** Largeur de la grille d'analyse en cellules (8..160, défaut 64). */
  @property({ type: Number })
  resolution = 64;

  /** `auto` (défaut) ou seuil fixe 0..1. */
  @property({ type: String })
  threshold = "auto";

  /** Écart sombre / clair minimal (0..1) pour émettre des fronts. */
  @property({ type: Number, attribute: "min-contrast" })
  minContrast = LUMA_DEFAULTS.minContrast;

  /** Temps d'oubli des niveaux sombre et clair, en ms. */
  @property({ type: Number, attribute: "adapt-ms" })
  adaptMs = LUMA_DEFAULTS.adaptMs;

  /** Hystérésis, en part de l'écart sombre / clair (0..0.8). */
  @property({ type: Number })
  hysteresis = LUMA_DEFAULTS.hysteresis;

  /** Période de publication des niveaux, en ms (les fronts sont publiés tout de suite). */
  @property({ type: Number })
  interval = 100;

  /** Fronts gardés dans `events`. */
  @property({ type: Number, attribute: "max-events" })
  maxEvents = 32;

  /** Chemin d'un DataProvider booléen qui commande la lumière : mesure le délai commande → lumière. */
  @property({ type: String, attribute: "mark-from" })
  markFrom = "";

  /** Store qui reçoit une action par front. */
  @property({ type: String })
  target = "";

  /** Type de l'action envoyée (défaut `edge`). */
  @property({ type: String })
  type = "edge";

  /** DataProvider de réglages en direct, prioritaires sur les attributs. */
  @property({ type: String })
  params = "";

  /** DataProvider de pilotage : `{reset: compteur}`. */
  @property({ type: String })
  control = "";

  /** DataProvider de sortie (défaut `<id>State`). */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private detector = new LumaDetector();
  private live: Partial<LumaSettings> = {};
  private unsubs: (() => void)[] = [];
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private attached: Element | null = null;
  private detachSource: (() => void) | null = null;
  private raf = 0;
  private lastSeq = -1;
  private canvas: HTMLCanvasElement | null = null;
  private events: LumaEdge[] = [];
  private last: LumaEdge | null = null;
  private level = 0;
  private peak = 0;
  private peakX = 0.5;
  private peakY = 0.5;
  private fps = 0;
  private lastT: number | null = null;
  private clock: LumaState["clock"] = null;
  private status: LumaState["status"] = "idle";
  private error: string | null = null;
  private lastPublish = -Infinity;
  private resetTrigger = new CounterTrigger();
  private markState = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    this.sync();
    this.syncTimer = setInterval(() => this.sync(), SYNC_MS);
    this.publish(true);
  }

  disconnectedCallback(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.detach();
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("params") || c.has("control") || c.has("markFrom")) this.listen();
    if (c.has("source")) this.sync();
    this.applySettings();
  }

  getState(): LumaState {
    const d = this.detector;
    return {
      status: this.status,
      error: this.error,
      active: this.settings().active,
      level: r4(this.level),
      peak: r4(this.peak),
      peakX: r4(this.peakX),
      peakY: r4(this.peakY),
      lo: r4(d.lo),
      hi: r4(d.hi),
      contrast: r4(d.contrast),
      signal: d.signal,
      on: d.on,
      edges: d.edges,
      last: this.last,
      events: [...this.events],
      fps: r1(this.fps),
      clock: this.clock,
      settings: this.settings(),
    };
  }

  /** Remet la détection à zéro (niveaux observés, fronts, commandes en attente). */
  reset(): void {
    this.detector.reset();
    this.events = [];
    this.last = null;
    this.lastT = null;
    this.fps = 0;
    this.publish(true);
  }

  /** Réglages effectifs : attributs, puis `params`. */
  settings(): LumaSettings {
    const fixed = num(this.threshold === "auto" ? undefined : this.threshold, 0, 1);
    const base: LumaSettings = {
      active: true,
      measure: MEASURES.includes(this.measure) ? this.measure : "mean",
      region: this.region,
      resolution: Math.round(num(this.resolution, 8, 160) ?? 64),
      threshold: fixed ?? null,
      minContrast: num(this.minContrast, 0, 1) ?? LUMA_DEFAULTS.minContrast,
      adaptMs: num(this.adaptMs, 0, 600000) ?? LUMA_DEFAULTS.adaptMs,
      hysteresis: num(this.hysteresis, 0, 0.8) ?? LUMA_DEFAULTS.hysteresis,
      interval: num(this.interval, 16, 5000) ?? 100,
    };
    return { ...base, ...this.live };
  }

  /* ---------------------------------------------------------------- */

  private listen(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.resetTrigger.reset();
    this.live = {};
    if (this.params) {
      this.unsubs.push(
        listenDp(this.params, (v) => {
          this.live = readParams(v);
          this.applySettings();
          this.publish(true);
        }),
      );
    }
    if (this.control) {
      this.unsubs.push(
        listenDp(this.control, (v) => {
          if (this.resetTrigger.feed((v as { reset?: unknown } | null)?.reset)) this.reset();
        }),
      );
    }
    if (this.markFrom) {
      this.markState = false;
      this.unsubs.push(
        listenDp(this.markFrom, (v) => {
          const on = truthy(v);
          if (on === this.markState) return;
          this.markState = on;
          this.detector.mark(performance.now(), on);
        }),
      );
    }
  }

  private applySettings(): void {
    const s = this.settings();
    this.detector.opts = { threshold: s.threshold, minContrast: s.minContrast, adaptMs: s.adaptMs, hysteresis: s.hysteresis };
  }

  private resolve(): Element | null {
    if (!this.source.startsWith("#")) return null;
    const id = this.source.slice(1);
    const root = this.getRootNode() as ParentNode;
    return (root as unknown as Document).getElementById?.(id) ?? document.getElementById(id);
  }

  /** Retrouve la source et s'y branche (écouteur d'images si elle en propose, relevé à chaque rafraîchissement sinon). */
  private sync(): void {
    const el = this.resolve();
    const ok = el && isFrameSource(el) ? el : null;
    if (ok === this.attached) {
      if (!ok && this.source && this.status !== "error") this.fail("source introuvable");
      return;
    }
    this.detach();
    if (!ok) {
      if (this.source) this.fail("source introuvable");
      return;
    }
    this.attached = ok;
    this.error = null;
    this.status = "idle";
    const timed = ok as TimedSource;
    if (typeof timed.addFrameListener === "function") {
      this.detachSource = timed.addFrameListener((info) => this.feedFrame(info));
    } else {
      const loop = () => {
        this.raf = requestAnimationFrame(loop);
        this.tick(performance.now());
      };
      this.raf = requestAnimationFrame(loop);
    }
    this.publish(true);
  }

  private detach(): void {
    this.detachSource?.();
    this.detachSource = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.attached = null;
    this.lastSeq = -1;
  }

  private fail(error: string): void {
    this.status = "error";
    this.error = error;
    this.publish(true);
  }

  /** Image annoncée par la source, avec ses instants (voie horodatée). */
  feedFrame(info: FrameInfo): void {
    const capture = info.captureTime;
    // Instant de capture retenu seulement s'il est sur la même horloge que la présentation.
    const useCapture = capture !== null && Math.abs(info.time - capture) < 1000;
    this.sample(useCapture ? capture : info.time, useCapture ? "capture" : "frame");
  }

  /** Relevé d'une source sans écouteur d'images : analyse l'image si elle a changé. */
  tick(now: number): void {
    const el = this.attached;
    if (!el || !isFrameSource(el)) return;
    const seq = el.frameSeq;
    if (seq === this.lastSeq) return;
    this.lastSeq = seq;
    this.sample(now, "poll");
  }

  /** Pixels RGBA de la zone analysée, réduite à la grille ; null si la source n'a pas d'image. */
  protected readPixels(el: Element, s: LumaSettings): { data: ArrayLike<number>; width: number; height: number } | null {
    const timed = el as TimedSource;
    const src = (typeof timed.getFrameSource === "function" ? timed.getFrameSource() : null) ?? (isFrameSource(el) ? el.getFrameCanvas() : null);
    if (!src) return null;
    const sw = (src as HTMLVideoElement).videoWidth || (src as HTMLCanvasElement).width || 0;
    const sh = (src as HTMLVideoElement).videoHeight || (src as HTMLCanvasElement).height || 0;
    if (!sw || !sh) return null;
    const r = parseRegion(s.region);
    const rw = Math.max(1, r.w * sw);
    const rh = Math.max(1, r.h * sh);
    const cols = Math.max(1, Math.min(s.resolution, Math.round(rw)));
    const rows = Math.max(1, Math.min(160, Math.round((cols * rh) / rw)));
    const c = (this.canvas ??= document.createElement("canvas"));
    if (c.width !== cols || c.height !== rows) {
      c.width = cols;
      c.height = rows;
    }
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    try {
      ctx.drawImage(src, r.x * sw, r.y * sh, rw, rh, 0, 0, cols, rows);
      return { data: ctx.getImageData(0, 0, cols, rows).data, width: cols, height: rows };
    } catch {
      return null; // image d'une autre origine : pixels illisibles
    }
  }

  private sample(t: number, clock: NonNullable<LumaState["clock"]>): void {
    const el = this.attached;
    const s = this.settings();
    if (!el || !s.active) return;
    const px = this.readPixels(el, s);
    if (!px) return;
    const m = measureLuma(px.data, px.width, px.height);
    this.level = m.level;
    this.peak = m.peak;
    this.peakX = m.peakX;
    this.peakY = m.peakY;
    this.clock = clock;
    if (this.lastT !== null && t > this.lastT) {
      const inst = 1000 / (t - this.lastT);
      this.fps = this.fps ? this.fps + (inst - this.fps) * 0.1 : inst;
    }
    this.lastT = t;
    const first = this.status !== "ready";
    this.status = "ready";
    this.error = null;

    const edge = this.detector.feed(t, s.measure === "peak" ? m.peak : m.level);
    if (edge) {
      const e = roundEdge(edge);
      this.last = e;
      this.events.push(e);
      const max = Math.max(1, Math.round(num(this.maxEvents, 1, 256) ?? 32));
      if (this.events.length > max) this.events.splice(0, this.events.length - max);
      const target = this.target.trim();
      if (target) dispatch(target, { type: this.type.trim() || "edge", payload: { ...e, fps: r1(this.fps), clock: this.clock } });
      this.dispatchEvent(new CustomEvent("luma-edge", { detail: e, bubbles: true, composed: true }));
    }
    this.publish(Boolean(edge) || first);
  }

  private publish(force: boolean): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (!out) return;
    const now = performance.now();
    if (!force && now - this.lastPublish < this.settings().interval) return;
    this.lastPublish = now;
    set(out, this.getState());
  }
}

function readParams(v: unknown): Partial<LumaSettings> {
  const p = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const out: Partial<LumaSettings> = {};
  if (typeof p.active === "boolean") out.active = p.active;
  if (typeof p.measure === "string" && (MEASURES as readonly string[]).includes(p.measure)) out.measure = p.measure as Measure;
  if (typeof p.region === "string") out.region = p.region;
  const resolution = num(p.resolution, 8, 160);
  if (resolution !== undefined) out.resolution = Math.round(resolution);
  if (p.threshold === "auto") out.threshold = null;
  else {
    const threshold = num(p.threshold, 0, 1);
    if (threshold !== undefined) out.threshold = threshold;
  }
  const minContrast = num(p.minContrast, 0, 1);
  if (minContrast !== undefined) out.minContrast = minContrast;
  const adaptMs = num(p.adaptMs, 0, 600000);
  if (adaptMs !== undefined) out.adaptMs = adaptMs;
  const hysteresis = num(p.hysteresis, 0, 0.8);
  if (hysteresis !== undefined) out.hysteresis = hysteresis;
  const interval = num(p.interval, 16, 5000);
  if (interval !== undefined) out.interval = interval;
  return out;
}

export default SonicLuma;
