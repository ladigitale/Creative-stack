import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import { isFrameSource } from "../../shared/mediaRef";
import { createOcrEngine, parseLangs, shapeResult, type OcrEngine, type OcrLine } from "./engine";

export type OcrState = {
  status: "idle" | "loading" | "working" | "ready" | "error";
  error: string | null;
  /** Étape du chargement (téléchargement du moteur / de la langue). */
  step: string;
  /** Avancement de la lecture, 0..1. */
  progress: number;
  text: string;
  confidence: number;
  lines: OcrLine[];
  words: number;
  width: number;
  height: number;
  lang: string;
  ms: number;
};

const IDLE: OcrState = { status: "idle", error: null, step: "", progress: 0, text: "", confidence: 0, lines: [], words: 0, width: 0, height: 0, lang: "", ms: 0 };

/**
 * Reconnaissance de texte (OCR) sur toute source d'images : `sonic-still`, `sonic-camera`, `sonic-video`…
 * par `#id`. Déclenchement : `control` (`{ n }`, la hausse de `n` lance) ou `auto`. Le moteur (environ
 * 10 à 20 Mo avec la langue) se télécharge au premier usage ; la lecture est locale.
 * Résultat dans `out-data-provider` : `{ status, text, confidence, lines[{text, x, y, w, h, words[]}] }`.
 */
@customElement("sonic-ocr")
export class SonicOcr extends LitElement {
  @property({ type: String }) source = "";
  /** Langues Tesseract, séparées par `+` (3 au plus) : `eng`, `fra`, `fra+eng`… */
  @property({ type: String }) lang = "eng";
  @property({ type: String }) control = "";
  @property({ type: Boolean }) auto = false;
  /** Côté max (px) de l'image analysée. */
  @property({ type: Number, attribute: "max-size" }) maxSize = 2000;
  /** Mots sous cette confiance (0..100) écartés. */
  @property({ type: Number, attribute: "min-confidence" }) minConfidence = 0;
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  stateValue: OcrState = { ...IDLE };
  private trigger = new CounterTrigger();
  private unsub: (() => void) | null = null;
  private engine: OcrEngine | null = null;
  private engineLang = "";
  private busy = false;
  private gone = false;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;

  createRenderRoot(): HTMLElement | ShadowRoot { return this; }

  connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "none";
    this.gone = false;
    this.listen();
    this.publish(IDLE);
    if (this.auto) this.waitAndRun(0);
  }

  disconnectedCallback(): void {
    this.gone = true;
    this.unsub?.();
    this.unsub = null;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    void this.engine?.terminate();
    this.engine = null;
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("control")) this.listen();
  }

  private listen(): void {
    this.unsub?.();
    this.unsub = null;
    this.trigger.reset();
    if (this.control) this.unsub = listenDp(this.control, (v) => { if (this.trigger.feed(v)) void this.run(); });
  }

  private waitAndRun(tries: number): void {
    if (this.gone) return;
    if (this.frame()) { void this.run(); return; }
    if (tries < 50) this.autoTimer = setTimeout(() => this.waitAndRun(tries + 1), 100);
    else this.fail("source d'images indisponible");
  }

  private frame(): HTMLCanvasElement | null {
    if (!this.source.startsWith("#")) return null;
    const id = this.source.slice(1);
    const root = this.getRootNode() as unknown as Document;
    const el = root.getElementById?.(id) ?? document.getElementById(id);
    if (!el || !isFrameSource(el)) return null;
    const c = el.getFrameCanvas();
    return c && c.width && c.height ? c : null;
  }

  private publish(s: Partial<OcrState>): void {
    this.stateValue = { ...this.stateValue, ...s };
    if (this.outDataProvider) set(this.outDataProvider, this.stateValue);
    this.dispatchEvent(new CustomEvent("ocr-state", { detail: this.stateValue, bubbles: true, composed: true }));
  }

  private fail(error: string): void {
    this.publish({ ...IDLE, status: "error", error });
  }

  /** Lit le texte de l'image courante. Ignoré tant qu'une lecture est en cours. */
  async run(): Promise<void> {
    if (this.busy) return;
    const langs = parseLangs(this.lang);
    if (!langs) return this.fail("langue non prise en charge");
    const src = this.frame();
    if (!src) return this.fail(this.source ? "source introuvable ou image pas prête" : "source manquante");
    this.busy = true;
    const t0 = performance.now();
    try {
      const key = langs.join("+");
      if (!this.engine || this.engineLang !== key) {
        await this.engine?.terminate();
        this.engine = null;
        this.publish({ ...IDLE, status: "loading", step: "moteur", lang: key });
        const engine = await createOcrEngine(langs, (step) => !this.gone && this.publish({ status: "loading", step }));
        if (this.gone) { void engine.terminate(); return; }
        this.engine = engine;
        this.engineLang = key;
      }
      const scale = Math.min(1, Math.max(64, this.maxSize) / Math.max(src.width, src.height));
      const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d");
      if (!ctx) throw new Error("canvas 2D indisponible");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(src, 0, 0, w, h);
      this.publish({ status: "working", step: "lecture", progress: 0, lang: key });
      const raw = await this.engine.recognize(cv, (p) => !this.gone && this.publish({ progress: Math.round(p * 100) / 100 }));
      if (this.gone) return;
      const res = shapeResult(raw, scale, this.minConfidence);
      this.publish({ status: "ready", error: null, step: "", progress: 1, ...res, width: src.width, height: src.height, lang: key, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      this.fail(e instanceof Error && e.name === "SecurityError" ? "image non lisible (CORS)" : e instanceof Error ? e.message : "échec de la lecture");
    } finally {
      this.busy = false;
    }
  }
}
