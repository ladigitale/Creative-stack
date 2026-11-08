import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine, resolveAudioElement } from "../../shared/audio/engine";
import { isAudioSource } from "../../shared/audio/contracts";
import { listenDp } from "../../shared/audio/dp";
import { bool, num } from "../../shared/media/control";
import type { SonicFrameConsumerHost, SonicFrameSource } from "../../shared/mediaRef";

const tagName = "sonic-audio-analyser";

/** Réglages effectifs (attributs, puis `params` : le dernier l'emporte), bornés. */
export type AnalyserSettings = {
  bands: number;
  fft: number;
  smoothing: number;
  pitch: boolean;
  onsetThreshold: number;
  rate: number;
};

export type AnalyserState = {
  status: "idle" | "ready" | "waiting-source" | "unsupported" | "error";
  error: string | null;
  /** Niveau efficace 0..1, crête 0..1, niveau en dBFS. */
  rms: number;
  peak: number;
  db: number;
  /** Bandes 0..1, échelle logarithmique de 40 Hz à 16 kHz. */
  bands: number[];
  centroidHz: number;
  /** Attaque détectée à cette mise à jour ; compteur cumulé (pratique comme trigger). */
  onset: boolean;
  onsetCount: number;
  /** Hauteur estimée (attribut `pitch`), null si incertaine. */
  pitchHz: number | null;
  settings: AnalyserSettings;
};

const DEFAULTS: AnalyserSettings = { bands: 16, fft: 2048, smoothing: 0.7, pitch: false, onsetThreshold: 1.5, rate: 30 };

/**
 * Analyse d'une source audio (`master` ou `#id` d'un sonic-patch, sonic-sampler…).
 * Publie niveaux, bandes, attaques dans un DataProvider et expose une texture
 * (ligne 0 : spectre, ligne 1 : forme d'onde) lisible par `sonic-shader channel0="#id"`.
 * Réglages en attributs, ou en direct par le DP `params`
 * `{ bands, fft, smoothing, pitch, onsetThreshold, rate }` : l'analyseur est reconfiguré
 * sans être recréé (l'analyse ne touche pas au son).
 */
@customElement(tagName)
export class SonicAudioAnalyser extends LitElement implements SonicFrameSource, SonicFrameConsumerHost {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** `master` (défaut) ou `#id` d'un composant qui produit du son. */
  @property({ type: String })
  source = "master";

  /** Publications par seconde (défaut 30). */
  @property({ type: Number })
  rate = 30;

  @property({ type: Number })
  bands = 16;

  /** Taille de FFT (puissance de 2, 256..8192). */
  @property({ type: Number })
  fft = 2048;

  @property({ type: Number })
  smoothing = 0.7;

  /** Estime la hauteur (autocorrélation, plus coûteux). */
  @property({ type: Boolean })
  pitch = false;

  /** Sensibilité de la détection d'attaques (défaut 1.5 : plus haut = moins d'attaques). */
  @property({ type: Number, attribute: "onset-threshold" })
  onsetThreshold = 1.5;

  /** DP de réglages en direct : `{ bands, fft, smoothing, pitch, onsetThreshold, rate }`. */
  @property({ type: String })
  params = "";

  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private live: Partial<AnalyserSettings> = {};
  private unlistenParams: (() => void) | null = null;
  private analyser: AnalyserNode | null = null;
  private sink: GainNode | null = null;
  private connectedSource: AudioNode | null = null;
  private raf = 0;
  private lastPublish = 0;
  private lastOnset = 0;
  private fluxHistory: number[] = [];
  private prevSpectrum: Float32Array | null = null;
  private timeData: Float32Array<ArrayBuffer> | null = null;
  private freqData: Uint8Array<ArrayBuffer> | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private seq = 0;
  private consumers = new Set<object>();
  private state: AnalyserState = emptyState(DEFAULTS);
  private unsubscribeEngine: (() => void) | null = null;

  get frameSeq(): number {
    return this.seq;
  }

  getFrameCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  registerFrameConsumer(token: object = {}): void {
    this.consumers.add(token);
  }

  unregisterFrameConsumer(token: object = {}): void {
    this.consumers.delete(token);
  }

  /** Dernières mesures (aussi publiées dans le DataProvider). */
  getState(): AnalyserState {
    return this.state;
  }

  /** Réglages effectifs, bornés. */
  settings(): AnalyserSettings {
    return analyserSettings(
      { bands: this.bands, fft: this.fft, smoothing: this.smoothing, pitch: this.pitch, onsetThreshold: this.onsetThreshold, rate: this.rate },
      this.live,
    );
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.listenParams();
    this.unsubscribeEngine = AudioEngine.get().onChange(() => this.ensure());
    this.ensure();
    this.loop();
  }

  disconnectedCallback(): void {
    cancelAnimationFrame(this.raf);
    this.unsubscribeEngine?.();
    this.unlistenParams?.();
    this.unlistenParams = null;
    this.disconnectSource();
    try {
      this.analyser?.disconnect();
      this.sink?.disconnect();
    } catch {
      /* ok */
    }
    this.analyser = null;
    this.sink = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("params") && this.isConnected) this.listenParams();
    if (changed.has("fft") || changed.has("smoothing")) this.configure();
    if (changed.has("source")) this.disconnectSource();
    if (["bands", "pitch", "onsetThreshold", "rate"].some((k) => changed.has(k))) this.refreshSettings();
  }

  private listenParams(): void {
    this.unlistenParams?.();
    this.unlistenParams = null;
    const path = this.params.trim();
    if (this.live && Object.keys(this.live).length) {
      this.live = {};
      this.configure();
    }
    if (!path) return;
    this.unlistenParams = listenDp(path, (v) => {
      this.live = readAnalyserParams(v);
      this.configure();
      this.refreshSettings();
    });
  }

  /** Republie l'état quand les réglages effectifs changent (même sans source). */
  private refreshSettings(): void {
    const s = this.settings();
    if (JSON.stringify(s) === JSON.stringify(this.state.settings)) return;
    this.state = { ...this.state, settings: s, ...(s.pitch ? {} : { pitchHz: null }) };
    this.publish(true);
  }

  private ensure(): void {
    const engine = AudioEngine.get();
    if (!engine.supported) {
      this.state = { ...emptyState(this.settings()), status: "unsupported", error: "WebAudio indisponible dans ce navigateur" };
      this.publish(true);
      return;
    }
    const ac = engine.context;
    if (!ac || this.analyser) return;
    try {
      this.analyser = ac.createAnalyser();
      // Sortie muette vers la destination : garantit que l'analyseur est traité.
      this.sink = ac.createGain();
      this.sink.gain.value = 0;
      this.analyser.connect(this.sink).connect(ac.destination);
    } catch (e) {
      this.analyser = null;
      this.sink = null;
      this.fail(e instanceof Error ? e.message : "analyseur impossible à créer");
      return;
    }
    this.configure();
  }

  private fail(error: string): void {
    this.state = { ...emptyState(this.settings()), onsetCount: this.state.onsetCount, status: "error", error };
    this.publish(true);
  }

  /** Applique fft et lissage au nœud existant (pas de recréation : la source reste branchée). */
  private configure(): void {
    const a = this.analyser;
    if (!a) return;
    const { fft: size, smoothing } = this.settings();
    a.smoothingTimeConstant = smoothing;
    if (a.fftSize === size && this.timeData?.length === size) return;
    a.fftSize = size;
    this.timeData = new Float32Array(new ArrayBuffer(size * 4));
    this.freqData = new Uint8Array(new ArrayBuffer(size / 2));
    this.prevSpectrum = null;
    if (typeof document !== "undefined") {
      this.canvas ??= document.createElement("canvas");
      this.canvas.width = Math.min(512, size / 2);
      this.canvas.height = 2;
    }
  }

  private resolveSource(): AudioNode | null {
    const engine = AudioEngine.get();
    const ref = (this.source || "master").trim();
    if (ref === "master") return engine.master;
    const el = resolveAudioElement(this, ref);
    return isAudioSource(el) ? el.getAudioOutput() : null;
  }

  private disconnectSource(): void {
    if (this.connectedSource && this.analyser) {
      try {
        this.connectedSource.disconnect(this.analyser);
      } catch {
        /* déjà déconnecté */
      }
    }
    this.connectedSource = null;
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const a = this.analyser;
    if (!a || !this.timeData || !this.freqData) return;
    // La sortie d'un patch change quand il est recompilé : on suit.
    const src = this.resolveSource();
    if (src !== this.connectedSource) {
      this.disconnectSource();
      if (src) {
        try {
          src.connect(a);
          this.connectedSource = src;
        } catch (e) {
          if (this.state.status !== "error") this.fail(e instanceof Error ? e.message : "source impossible à brancher");
          return;
        }
      }
    }
    if (!this.connectedSource) {
      if (this.state.status !== "waiting-source") {
        this.state = { ...emptyState(this.settings()), status: "waiting-source" };
        this.publish(true);
      }
      return;
    }
    const now = performance.now();
    const settings = this.settings();
    const interval = 1000 / settings.rate;
    const wantTexture = this.consumers.size > 0;
    const due = now - this.lastPublish >= interval;
    if (!due && !wantTexture) return;

    a.getFloatTimeDomainData(this.timeData);
    a.getByteFrequencyData(this.freqData);
    if (wantTexture || due) this.paintTexture();
    if (!due) return;
    this.lastPublish = now;
    this.state = this.measure(a.context.sampleRate, now, settings);
    this.publish();
  };

  private measure(sampleRate: number, now: number, settings: AnalyserSettings): AnalyserState {
    const td = this.timeData!;
    const fd = this.freqData!;
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < td.length; i++) {
      const v = td[i];
      sum += v * v;
      const abs = Math.abs(v);
      if (abs > peak) peak = abs;
    }
    const rms = Math.sqrt(sum / td.length);
    const db = rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;

    // Bandes logarithmiques 40 Hz – 16 kHz
    const nyquist = sampleRate / 2;
    const n = settings.bands;
    const bands: number[] = [];
    const binHz = nyquist / fd.length;
    const lo = Math.log(40);
    const hi = Math.log(Math.min(16000, nyquist));
    for (let b = 0; b < n; b++) {
      const f0 = Math.exp(lo + ((hi - lo) * b) / n);
      const f1 = Math.exp(lo + ((hi - lo) * (b + 1)) / n);
      const i0 = Math.max(0, Math.floor(f0 / binHz));
      const i1 = Math.min(fd.length, Math.max(i0 + 1, Math.ceil(f1 / binHz)));
      let s = 0;
      for (let i = i0; i < i1; i++) s += fd[i];
      bands.push(+(s / (i1 - i0) / 255).toFixed(3));
    }

    // Centroïde et flux spectral (attaques)
    let num = 0;
    let den = 0;
    let flux = 0;
    const spec = new Float32Array(fd.length);
    for (let i = 0; i < fd.length; i++) {
      const m = fd[i] / 255;
      spec[i] = m;
      num += m * i * binHz;
      den += m;
      if (this.prevSpectrum) flux += Math.max(0, m - this.prevSpectrum[i]);
    }
    this.prevSpectrum = spec;
    flux /= fd.length;
    const hist = this.fluxHistory;
    const mean = hist.length ? hist.reduce((x, y) => x + y, 0) / hist.length : 0;
    hist.push(flux);
    if (hist.length > 20) hist.shift();
    const onset = hist.length > 3 && flux > mean * settings.onsetThreshold + 0.004 && now - this.lastOnset > 80;
    if (onset) this.lastOnset = now;

    return {
      status: "ready",
      error: null,
      rms: +rms.toFixed(4),
      peak: +peak.toFixed(4),
      db: +db.toFixed(1),
      bands,
      centroidHz: den > 0 ? Math.round(num / den) : 0,
      onset,
      onsetCount: this.state.onsetCount + (onset ? 1 : 0),
      pitchHz: settings.pitch ? estimatePitch(td, sampleRate) : null,
      settings,
    };
  }

  private paintTexture(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const img = ctx.createImageData(w, 2);
    const fd = this.freqData!;
    const td = this.timeData!;
    const fStep = fd.length / w;
    const tStep = td.length / w;
    for (let x = 0; x < w; x++) {
      const f = fd[Math.floor(x * fStep)];
      const t = Math.round((Math.max(-1, Math.min(1, td[Math.floor(x * tStep)])) + 1) * 127.5);
      img.data.set([f, f, f, 255], x * 4);
      img.data.set([t, t, t, 255], (w + x) * 4);
    }
    ctx.putImageData(img, 0, 0);
    this.seq++;
  }

  private publish(force = false): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (!out) return;
    if (force || this.state) set(out, this.state);
  }

  render() {
    return html``;
  }
}

function emptyState(settings: AnalyserSettings): AnalyserState {
  return { status: "idle", error: null, rms: 0, peak: 0, db: -100, bands: [], centroidHz: 0, onset: false, onsetCount: 0, pitchHz: null, settings };
}

/** Lit le DP `params` : clés reconnues seulement, valeurs bornées, le reste ignoré. */
export function readAnalyserParams(v: unknown): Partial<AnalyserSettings> {
  const p = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const o: Partial<AnalyserSettings> = {};
  const bands = num(p.bands, 1, 64); if (bands !== undefined) o.bands = Math.round(bands);
  const fft = num(p.fft, 256, 8192); if (fft !== undefined) o.fft = pow2(fft);
  const smoothing = num(p.smoothing, 0, 0.99); if (smoothing !== undefined) o.smoothing = smoothing;
  const pitch = bool(p.pitch); if (pitch !== undefined) o.pitch = pitch;
  const onset = num(p.onsetThreshold, 0.1, 20); if (onset !== undefined) o.onsetThreshold = onset;
  const rate = num(p.rate, 1, 120); if (rate !== undefined) o.rate = rate;
  return o;
}

/** Réglages effectifs : attributs, puis `params` ; bornés (valeur absurde → défaut). */
export function analyserSettings(attrs: AnalyserSettings, live: Partial<AnalyserSettings> = {}): AnalyserSettings {
  const s = { ...attrs, ...live };
  return {
    // 0 vaut « défaut » pour bands, fft et rate (comportement historique des attributs)
    bands: Math.round(clamp(s.bands || DEFAULTS.bands, 1, 64, DEFAULTS.bands)),
    fft: pow2(clamp(s.fft || DEFAULTS.fft, 256, 8192, DEFAULTS.fft)),
    smoothing: clamp(s.smoothing, 0, 0.99, DEFAULTS.smoothing),
    pitch: !!s.pitch,
    onsetThreshold: clamp(s.onsetThreshold, 0.1, 20, DEFAULTS.onsetThreshold),
    rate: clamp(s.rate || DEFAULTS.rate, 1, 120, DEFAULTS.rate),
  };
}

const pow2 = (n: number) => Math.pow(2, Math.round(Math.log2(n)));
const clamp = (v: number, a: number, b: number, d: number) => (Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d);

/**
 * Autocorrélation normalisée, 50–1000 Hz : premier pic marqué après le premier creux
 * (évite les erreurs d'octave) ; null si le signal est faible ou peu périodique.
 */
export function estimatePitch(td: Float32Array, sampleRate: number): number | null {
  const n = Math.min(td.length, 1024);
  let energy = 0;
  for (let i = 0; i < n; i++) energy += td[i] * td[i];
  if (Math.sqrt(energy / n) < 0.01) return null;
  const minLag = Math.max(2, Math.floor(sampleRate / 1000));
  const maxLag = Math.min(n - 2, Math.floor(sampleRate / 50));
  const r = (lag: number) => {
    let c = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i + lag < n; i++) {
      c += td[i] * td[i + lag];
      e1 += td[i] * td[i];
      e2 += td[i + lag] * td[i + lag];
    }
    return c / Math.sqrt(e1 * e2 || 1);
  };
  let dipped = false;
  let prev = 1;
  let cur = r(1);
  for (let lag = 1; lag < maxLag; lag++) {
    const next = r(lag + 1);
    if (cur < 0.3) dipped = true;
    if (dipped && lag >= minLag && cur > 0.8 && cur >= prev && cur >= next) {
      const d = prev - 2 * cur + next;
      const shift = d ? (0.5 * (prev - next)) / d : 0;
      return +(sampleRate / (lag + shift)).toFixed(1);
    }
    prev = cur;
    cur = next;
  }
  return null;
}

export default SonicAudioAnalyser;
