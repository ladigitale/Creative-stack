import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger, num } from "../../shared/media/control";
import { isFrameSource } from "../../shared/mediaRef";
import { createOcrEngine, parseLangs, shapeResult, type OcrEngine, type OcrLine, type RawResult } from "./engine";

/** Réglages effectifs (attributs, puis `control`, puis `params` : le dernier l'emporte). */
export type OcrSettings = {
  /** Langues demandées : normalisées (`fra+eng`) si elles sont valides, telles quelles sinon. */
  lang: string;
  minConfidence: number;
  maxSize: number;
};

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
  /** Langues du moteur qui a produit le résultat (ou qui se charge). */
  lang: string;
  ms: number;
  /** Nombre de lectures abouties. */
  runs: number;
  settings: OcrSettings;
};

const DEFAULTS: OcrSettings = { lang: "eng", minConfidence: 0, maxSize: 2000 };
const LIMITS = { minConfidence: [0, 100], maxSize: [64, 4000] } as const;
const IDLE: OcrState = {
  status: "idle", error: null, step: "", progress: 0, text: "", confidence: 0, lines: [], words: 0, width: 0, height: 0, lang: "", ms: 0,
  runs: 0, settings: { ...DEFAULTS },
};
/** Sans image au bout de ce délai, le mode auto le signale (et continue d'attendre). */
const AUTO_WAIT_MS = 5000;

type LastRead = { raw: RawResult; scale: number; maxSize: number; lang: string; width: number; height: number; ms: number };

/**
 * Reconnaissance de texte (OCR) sur toute source d'images : `sonic-still`, `sonic-camera`, `sonic-video`…
 * par `#id`. Déclenchement : `control` (`{ n }`, la hausse de `n` lance) ou `auto` (chaque nouvelle image
 * de la source, au plus toutes les `interval` ms). Réglages `lang, minConfidence, maxSize` en attributs ou
 * en direct par DataProvider (`control` et `params`) : un changement s'applique à la lecture déjà faite
 * (`minConfidence` sans relire, les autres en relisant), un changement de langue recharge le moteur.
 * Le moteur (environ 10 à 20 Mo avec la langue) se télécharge au premier usage ; la lecture est locale.
 * Résultat dans `out-data-provider` : `{ status, text, confidence, lines[{text, x, y, w, h, words[]}], settings }`.
 */
@customElement("sonic-ocr")
export class SonicOcr extends LitElement {
  @property({ type: String }) source = "";
  /** Langues Tesseract, séparées par `+` (3 au plus) : `eng`, `fra`, `fra+eng`… */
  @property({ type: String }) lang = DEFAULTS.lang;
  /** DP de pilotage : `{ n, …réglages }`. */
  @property({ type: String }) control = "";
  /** DP de réglages en direct : `{ lang, minConfidence, maxSize }`. */
  @property({ type: String }) params = "";
  @property({ type: Boolean }) auto = false;
  /** Intervalle minimal (ms) entre deux lectures en mode auto. */
  @property({ type: Number }) interval = 1000;
  /** Côté max (px) de l'image analysée. */
  @property({ type: Number, attribute: "max-size" }) maxSize = DEFAULTS.maxSize;
  /** Mots sous cette confiance (0..100) écartés. */
  @property({ type: Number, attribute: "min-confidence" }) minConfidence = DEFAULTS.minConfidence;
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  stateValue: OcrState = { ...IDLE };
  private trigger = new CounterTrigger();
  private unsubs: Array<() => void> = [];
  private fromControl: Partial<OcrSettings> = {};
  private fromParams: Partial<OcrSettings> = {};
  private engine: OcrEngine | null = null;
  private engineLang = "";
  private busy = false;
  /** Réglages changés pendant une lecture : les appliquer à la fin. */
  private dirty = false;
  private gone = false;
  private runs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private lastSeq = -1;
  private seqSource = "";
  private lastRun = 0;
  private autoSince = 0;
  private autoWarned = false;
  /** Dernier résultat brut (pour réappliquer `minConfidence` sans relire). */
  private last: LastRead | null = null;

  createRenderRoot(): HTMLElement | ShadowRoot { return this; }

  connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "none";
    this.gone = false;
    this.listen();
    this.publish({ ...IDLE, settings: this.settings() });
    this.syncAuto();
  }

  disconnectedCallback(): void {
    this.gone = true;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    void this.engine?.terminate();
    this.engine = null;
    this.engineLang = "";
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("control") || c.has("params")) this.listen();
    if (c.has("auto") || c.has("interval") || c.has("source")) this.syncAuto();
    if (c.has("lang") || c.has("minConfidence") || c.has("maxSize")) this.settingsChanged();
  }

  private listen(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.trigger.reset();
    if (this.control) this.unsubs.push(listenDp(this.control, (v) => {
      const next = readOcrSettings(v);
      const changed = !sameSettings(next, this.fromControl);
      this.fromControl = next;
      if (this.trigger.feed(v)) void this.run();
      else if (changed) this.settingsChanged();
    }));
    if (this.params) this.unsubs.push(listenDp(this.params, (v) => {
      const next = readOcrSettings(v);
      if (sameSettings(next, this.fromParams)) return;
      this.fromParams = next;
      this.settingsChanged();
    }));
  }

  /** Réglages modifiés : relance si une lecture a déjà eu lieu, sinon simple mise à jour de l'état. */
  private settingsChanged(): void {
    if (!this.isConnected) return;
    if (this.runs > 0 || this.busy) { this.schedule(); return; }
    // Rien de lu encore (ou échec) : en mode auto, l'image courante sera retentée avec ces réglages.
    if (this.auto) this.lastSeq = -1;
    this.publish({ settings: this.settings() });
  }

  /** Réglages effectifs, bornés. */
  settings(): OcrSettings {
    const s = { lang: this.lang, minConfidence: this.minConfidence, maxSize: this.maxSize, ...this.fromControl, ...this.fromParams };
    const raw = String(s.lang ?? "").trim();
    const langs = parseLangs(raw);
    return {
      lang: langs ? langs.join("+") : raw,
      minConfidence: clamp(s.minConfidence, LIMITS.minConfidence, DEFAULTS.minConfidence),
      maxSize: Math.round(clamp(s.maxSize, LIMITS.maxSize, DEFAULTS.maxSize)),
    };
  }

  /** Regroupe les changements de réglages rapprochés ; pendant une lecture, attend sa fin. */
  private schedule(): void {
    if (this.busy) { this.dirty = true; return; }
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = null;
      this.apply();
    }, 30);
  }

  /** Applique les réglages courants : remise en forme si seule `minConfidence` a changé, sinon relecture. */
  private apply(): void {
    if (this.gone || this.busy) return;
    const s = this.settings();
    const langs = parseLangs(s.lang);
    // Langue changée : le moteur de l'ancienne langue est libéré tout de suite.
    if (this.engine && langs && this.engineLang !== s.lang) {
      void this.engine.terminate();
      this.engine = null;
      this.engineLang = "";
    }
    const l = this.last;
    if (l && langs && l.lang === s.lang && l.maxSize === s.maxSize) {
      const res = shapeResult(l.raw, l.scale, s.minConfidence);
      this.publish({ status: "ready", error: null, step: "", progress: 1, ...res, width: l.width, height: l.height, lang: l.lang, ms: l.ms, settings: s });
      return;
    }
    void this.run();
  }

  private syncAuto(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // L'image déjà lue d'une même source n'est pas relue (relance de l'intervalle seule).
    if (this.seqSource !== this.source) { this.lastSeq = -1; this.seqSource = this.source; }
    this.autoWarned = false;
    if (!this.auto || !this.isConnected) return;
    this.autoSince = performance.now();
    const tick = () => {
      if (this.gone || this.busy) return;
      const el = this.resolve();
      if (!el || !isFrameSource(el) || !this.frame()) {
        if (!this.autoWarned && performance.now() - this.autoSince > AUTO_WAIT_MS) {
          this.autoWarned = true;
          this.fail("source d'images indisponible");
        }
        return;
      }
      const seq = el.frameSeq;
      if (seq === this.lastSeq) return;
      if (performance.now() - this.lastRun < Math.max(100, this.interval)) return;
      this.lastSeq = seq;
      void this.run();
    };
    this.timer = setInterval(tick, 100);
    tick();
  }

  private resolve(): Element | null {
    if (!this.source.startsWith("#")) return null;
    const id = this.source.slice(1);
    const root = this.getRootNode() as unknown as Document;
    return root.getElementById?.(id) ?? document.getElementById(id);
  }

  private frame(): HTMLCanvasElement | null {
    const el = this.resolve();
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
    this.last = null;
    this.publish({ ...IDLE, status: "error", error, runs: this.runs, settings: this.settings() });
  }

  /** Lit le texte de l'image courante. Ignoré tant qu'une lecture est en cours. */
  async run(): Promise<void> {
    if (this.busy) return;
    const settings = this.settings();
    const langs = parseLangs(settings.lang);
    if (!langs) return this.fail("langue non prise en charge");
    const src = this.frame();
    if (!src) return this.fail(this.source ? "source introuvable ou image pas prête" : "source manquante");
    this.busy = true;
    this.dirty = false;
    this.lastRun = performance.now();
    const t0 = performance.now();
    try {
      const key = langs.join("+");
      if (!this.engine || this.engineLang !== key) {
        const old = this.engine;
        this.engine = null;
        this.engineLang = "";
        await old?.terminate();
        this.publish({ ...IDLE, status: "loading", step: "moteur", lang: key, runs: this.runs, settings });
        const engine = await createOcrEngine(langs, (step) => !this.gone && this.publish({ status: "loading", step }));
        if (this.gone) { void engine.terminate(); return; }
        this.engine = engine;
        this.engineLang = key;
      }
      const scale = Math.min(1, settings.maxSize / Math.max(src.width, src.height));
      const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d");
      if (!ctx) throw new Error("canvas 2D indisponible");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(src, 0, 0, w, h);
      this.publish({ status: "working", step: "lecture", progress: 0, lang: key, settings });
      const raw = await this.engine.recognize(cv, (p) => !this.gone && this.publish({ progress: Math.round(p * 100) / 100 }));
      if (this.gone) return;
      const ms = Math.round(performance.now() - t0);
      this.last = { raw, scale, maxSize: settings.maxSize, lang: key, width: src.width, height: src.height, ms };
      this.runs++;
      const res = shapeResult(raw, scale, settings.minConfidence);
      this.publish({ status: "ready", error: null, step: "", progress: 1, ...res, width: src.width, height: src.height, lang: key, ms, runs: this.runs, settings });
    } catch (e) {
      this.fail(e instanceof Error && e.name === "SecurityError" ? "image non lisible (CORS)" : e instanceof Error ? e.message : "échec de la lecture");
    } finally {
      this.busy = false;
      if (this.dirty && !this.gone) { this.dirty = false; this.schedule(); }
    }
  }
}

/** Réglages présents dans une valeur de DataProvider (clés camelCase ou en tirets). */
export function readOcrSettings(v: unknown): Partial<OcrSettings> {
  const p = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const o: Partial<OcrSettings> = {};
  if (typeof p.lang === "string" && p.lang.trim()) o.lang = p.lang.trim();
  else if (Array.isArray(p.lang) && p.lang.length) o.lang = p.lang.map(String).join("+");
  const c = num(p.minConfidence ?? p["min-confidence"], ...LIMITS.minConfidence);
  if (c !== undefined) o.minConfidence = c;
  const m = num(p.maxSize ?? p["max-size"], ...LIMITS.maxSize);
  if (m !== undefined) o.maxSize = Math.round(m);
  return o;
}

function sameSettings(a: Partial<OcrSettings>, b: Partial<OcrSettings>): boolean {
  const ka = Object.keys(a) as (keyof OcrSettings)[];
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

const clamp = (v: unknown, [a, b]: readonly [number, number], d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d;
};
