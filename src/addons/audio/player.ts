import { LitElement, css, html, svg, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { AudioEngine } from "../../shared/audio/engine";
import { listenDp } from "../../shared/audio/dp";
import { loadSample, safeSampleUrl } from "../../shared/audio/samples";

const tagName = "sonic-audio-player";

/** Largeur d'une barre + espace (px CSS). */
const BAR_STEP = 5;

/** Valeur d'un DP source : URL, ou SonicMediaRef `{ url }`. */
export function readSrc(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object" && typeof (v as { url?: unknown }).url === "string") return String((v as { url: string }).url).trim();
  return "";
}

/** `m:ss` (secondes négatives, NaN, Infinity : 0:00). */
export function formatTime(s: number): string {
  const t = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/**
 * Crêtes normalisées (0..1) de `bars` tranches : maximum absolu par tranche, ramené au maximum du son,
 * courbe racine pour que les passages calmes restent visibles.
 */
export function computePeaks(data: ArrayLike<number>, bars: number): number[] {
  const n = Math.max(1, Math.floor(bars));
  const out = new Array<number>(n).fill(0);
  const len = data.length;
  if (!len) return out;
  const size = len / n;
  for (let b = 0; b < n; b++) {
    const start = Math.floor(b * size);
    const end = Math.max(start + 1, Math.floor((b + 1) * size));
    // au plus ~400 échantillons lus par tranche
    const stride = Math.max(1, Math.floor((end - start) / 400));
    let m = 0;
    for (let i = start; i < end && i < len; i += stride) {
      const a = Math.abs(data[i]);
      if (a > m) m = a;
    }
    out[b] = m;
  }
  const max = Math.max(...out);
  return max > 0 ? out.map((v) => Math.sqrt(v / max)) : out;
}

/** Barres d'attente stables pour une même URL (pas de saut à l'affichage). */
export function placeholderPeaks(seed: string, bars: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += Math.max(1, Math.floor(seed.length / 64))) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const out: number[] = [];
  for (let b = 0; b < Math.max(1, bars); b++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    out.push(0.25 + ((h >>> 0) % 1000) / 1000 * 0.45);
  }
  return out;
}

/** Lecteur en cours (un seul à la fois sur la page). */
let current: SonicAudioPlayer | null = null;

/**
 * Lecteur de son : bouton lecture / pause, forme d'onde où l'on se déplace (toucher, glisser, flèches du
 * clavier), temps écoulé / durée. Joue par le moteur audio de la page (déverrouillé au clic sur lecture) ;
 * un seul lecteur joue à la fois.
 *
 * - `src` : URL du son (https, blob:, data:audio/…, relative) ; dans un modèle de liste : `data-bind` + `::src`.
 * - `src-from` : chemin DP, URL ou SonicMediaRef `{ url }` (ex. un enregistrement de sonic-audio-recorder).
 * - `label` : nom accessible (défaut « Son »).
 * - Couleurs : `--sonic-player-accent` (partie jouée, bouton), `--sonic-player-wave` (reste de l'onde),
 *   `--sonic-player-ink` (icône du bouton), `--sonic-player-text` (temps).
 */
@customElement(tagName)
export class SonicAudioPlayer extends LitElement {
  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      min-width: 12rem;
      --_accent: var(--sonic-player-accent, #ff3d7f);
      --_wave: var(--sonic-player-wave, rgba(120, 124, 136, 0.35));
      --_ink: var(--sonic-player-ink, #ffffff);
      --_text: var(--sonic-player-text, currentColor);
    }
    button {
      flex: none;
      width: 2.6rem;
      height: 2.6rem;
      border: 0;
      border-radius: 50%;
      background: var(--_accent);
      color: var(--_ink);
      display: grid;
      place-items: center;
      cursor: pointer;
      padding: 0;
      transition: transform 0.12s ease;
    }
    button:active {
      transform: scale(0.92);
    }
    button:focus-visible,
    canvas:focus-visible {
      outline: 2px solid var(--_accent);
      outline-offset: 2px;
    }
    button[disabled] {
      opacity: 0.45;
      cursor: default;
    }
    svg {
      width: 1.1rem;
      height: 1.1rem;
      fill: currentColor;
    }
    canvas {
      flex: 1;
      min-width: 4rem;
      height: 2.6rem;
      touch-action: pan-y;
      cursor: pointer;
      border-radius: 0.4rem;
    }
    .time {
      flex: none;
      font-variant-numeric: tabular-nums;
      font-size: 0.82rem;
      font-weight: 600;
      color: var(--_text);
      min-width: 2.6rem;
      text-align: right;
    }
    @media (prefers-reduced-motion: reduce) {
      button {
        transition: none;
      }
    }
  `;

  @property({ type: String }) src = "";
  @property({ type: String, attribute: "src-from" }) srcFrom = "";
  @property({ type: String }) label = "Son";

  @state() private playing = false;
  @state() private position = 0;
  @state() private duration = 0;
  @state() private status: "idle" | "loading" | "ready" | "error" = "idle";

  @query("canvas") private canvas?: HTMLCanvasElement;

  private url = "";
  private fromDp = "";
  private buffer: AudioBuffer | null = null;
  private peaks: number[] = [];
  private node: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  /** Temps du contexte au début de la lecture, moins le décalage de départ. */
  private t0 = 0;
  private raf = 0;
  private dragging = false;
  private unlisten: (() => void) | null = null;
  private resize: ResizeObserver | null = null;
  private bars = 40;
  private loadSeq = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stop();
    if (current === this) current = null;
    this.unlisten?.();
    this.unlisten = null;
    this.resize?.disconnect();
    this.resize = null;
  }

  protected firstUpdated(): void {
    if (typeof ResizeObserver !== "undefined" && this.canvas) {
      this.resize = new ResizeObserver(() => this.layout());
      this.resize.observe(this.canvas);
    }
    this.layout();
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has("srcFrom")) this.listen();
    if (changed.has("src") || changed.has("srcFrom")) this.setUrl(this.srcFrom ? this.fromDp : this.src);
    this.draw();
  }

  private listen(): void {
    this.unlisten?.();
    this.unlisten = null;
    if (!this.srcFrom || !this.isConnected) return;
    this.unlisten = listenDp(this.srcFrom, (v) => {
      this.fromDp = readSrc(v);
      this.setUrl(this.fromDp);
    });
  }

  private setUrl(url: string): void {
    if (url === this.url) return;
    this.stop();
    this.url = url;
    this.buffer = null;
    this.position = 0;
    this.duration = 0;
    this.peaks = [];
    if (!url) {
      this.status = "idle";
      return;
    }
    if (!safeSampleUrl(url)) {
      this.status = "error";
      return;
    }
    this.status = "loading";
    this.loop();
    const seq = ++this.loadSeq;
    loadSample(url).then(
      (buf) => {
        if (seq !== this.loadSeq) return;
        this.buffer = buf;
        this.duration = buf.duration;
        this.status = "ready";
        this.computeBars();
      },
      () => {
        if (seq === this.loadSeq) this.status = "error";
      },
    );
  }

  private layout(): void {
    const c = this.canvas;
    if (!c) return;
    const w = c.clientWidth || 200;
    const h = c.clientHeight || 42;
    const dpr = Math.min(3, (typeof devicePixelRatio === "number" && devicePixelRatio) || 1);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    this.bars = Math.max(8, Math.floor(w / BAR_STEP));
    this.computeBars();
  }

  private computeBars(): void {
    this.peaks = this.buffer ? computePeaks(this.buffer.getChannelData(0), this.bars) : [];
    this.draw();
  }

  private draw(now = 0): void {
    const c = this.canvas;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const style = getComputedStyle(this);
    const accent = style.getPropertyValue("--_accent").trim() || "#ff3d7f";
    const wave = style.getPropertyValue("--_wave").trim() || "rgba(120,124,136,.35)";
    const W = c.width;
    const H = c.height;
    ctx.clearRect(0, 0, W, H);
    const ready = this.peaks.length > 0;
    const peaks = ready ? this.peaks : placeholderPeaks(this.url || "vide", this.bars);
    const n = peaks.length;
    const step = W / n;
    const bw = Math.max(1, step * 0.6);
    const frac = this.duration > 0 ? Math.min(1, this.position / this.duration) : 0;
    const head = frac * n;
    const t = now / 1000;
    ctx.globalAlpha = ready ? 1 : this.status === "loading" ? 0.35 + 0.15 * Math.sin(t * 4) : 0.3;
    for (let i = 0; i < n; i++) {
      let amp = peaks[i];
      // petites barres qui dansent autour de la tête de lecture
      if (this.playing && Math.abs(i - head) < 4) amp = Math.min(1, amp * (1 + 0.22 * Math.sin(t * 14 + i * 1.7)));
      const bh = Math.max(bw, amp * H * 0.92);
      const x = i * step + (step - bw) / 2;
      const y = (H - bh) / 2;
      ctx.fillStyle = ready && i < head ? accent : wave;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, bw, bh, bw / 2);
      else ctx.rect(x, y, bw, bh);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (ready && (this.playing || frac > 0)) {
      ctx.fillStyle = accent;
      ctx.fillRect(Math.min(W - 2, frac * W), 0, Math.max(1.5, W / 300), H);
    }
  }

  private tick = (now: number) => {
    this.raf = 0;
    const ac = AudioEngine.get().context;
    if (this.playing && ac && !this.dragging) {
      this.position = Math.min(this.duration, ac.currentTime - this.t0);
    }
    this.draw(now);
    if (this.playing || this.status === "loading") this.raf = requestAnimationFrame(this.tick);
  };

  private loop(): void {
    if (!this.raf && typeof requestAnimationFrame === "function") this.raf = requestAnimationFrame(this.tick);
  }

  private startAt(offset: number): void {
    const engine = AudioEngine.get();
    const ac = engine.context;
    if (!ac || !engine.master || !this.buffer) return;
    this.halt();
    const node = ac.createBufferSource();
    node.buffer = this.buffer;
    const gain = ac.createGain();
    node.connect(gain).connect(engine.master);
    const from = Math.max(0, Math.min(offset, this.buffer.duration - 0.01));
    node.onended = () => {
      if (this.node !== node) return;
      this.node = null;
      this.playing = false;
      this.position = 0;
      this.draw();
    };
    node.start(0, from);
    this.node = node;
    this.gain = gain;
    this.t0 = ac.currentTime - from;
    this.position = from;
    this.playing = true;
    this.loop();
  }

  /** Arrête la source sans changer l'état affiché. */
  private halt(): void {
    const node = this.node;
    this.node = null;
    if (node) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        /* déjà arrêtée */
      }
      node.disconnect();
    }
    this.gain?.disconnect();
    this.gain = null;
  }

  /** Met en pause (la position est gardée). */
  pause(): void {
    if (!this.playing) return;
    const ac = AudioEngine.get().context;
    if (ac) this.position = Math.min(this.duration, ac.currentTime - this.t0);
    this.halt();
    this.playing = false;
  }

  private stop(): void {
    this.halt();
    this.playing = false;
    if (this.raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Lecture depuis la position courante (à appeler dans un geste). */
  play(): void {
    if (this.status !== "ready") return;
    if (current && current !== this) current.pause();
    current = this;
    const engine = AudioEngine.get();
    const go = () => this.startAt(this.position >= this.duration - 0.05 ? 0 : this.position);
    // unlock() reprend le contexte de façon synchrone dans le geste (iOS)
    const unlocked = engine.unlock();
    if (engine.context && engine.master && (engine.context as AudioContext).state === "running") go();
    else void unlocked.then(go);
  }

  private toggle = () => {
    if (this.playing) this.pause();
    else this.play();
  };

  private seekTo(sec: number): void {
    if (!this.duration) return;
    const s = Math.max(0, Math.min(this.duration, sec));
    if (this.playing) this.startAt(s);
    else this.position = s;
  }

  private fracAt(e: PointerEvent): number {
    const r = this.canvas!.getBoundingClientRect();
    return r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
  }

  private onDown = (e: PointerEvent) => {
    if (this.status !== "ready" || e.button > 0) return;
    this.dragging = true;
    this.canvas?.setPointerCapture?.(e.pointerId);
    this.position = this.fracAt(e) * this.duration;
  };

  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.position = this.fracAt(e) * this.duration;
  };

  private onUp = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.dragging = false;
    this.seekTo(this.fracAt(e) * this.duration);
  };

  private onCancel = () => {
    this.dragging = false;
  };

  private onKey = (e: KeyboardEvent) => {
    if (this.status !== "ready") return;
    const big = Math.max(1, this.duration / 10);
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, PageUp: big, PageDown: -big };
    if (e.key in moves) this.seekTo(this.position + moves[e.key]);
    else if (e.key === "Home") this.seekTo(0);
    else if (e.key === "End") this.seekTo(this.duration);
    else if (e.key === " " || e.key === "Enter") this.toggle();
    else return;
    e.preventDefault();
  };

  render() {
    const ready = this.status === "ready";
    const name = this.label || "Son";
    const icon = this.playing
      ? svg`<rect x="6" y="5" width="4" height="14" rx="1.2"></rect><rect x="14" y="5" width="4" height="14" rx="1.2"></rect>`
      : svg`<path d="M8 5.2v13.6a1 1 0 0 0 1.5.86l11-6.8a1 1 0 0 0 0-1.72l-11-6.8A1 1 0 0 0 8 5.2z"></path>`;
    const shown = this.playing || this.position > 0 ? this.position : this.duration;
    return html`
      <button
        type="button"
        part="button"
        ?disabled=${!ready}
        aria-label=${`${this.playing ? "Pause" : "Écouter"} : ${name}`}
        title=${this.status === "error" ? "Son illisible" : this.playing ? "Pause" : "Écouter"}
        @click=${this.toggle}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>
      </button>
      <canvas
        part="wave"
        role="slider"
        tabindex=${ready ? 0 : -1}
        aria-label=${`Position dans ${name}`}
        aria-valuemin="0"
        aria-valuemax=${Math.round(this.duration)}
        aria-valuenow=${Math.round(this.position)}
        aria-valuetext=${`${formatTime(this.position)} sur ${formatTime(this.duration)}`}
        @pointerdown=${this.onDown}
        @pointermove=${this.onMove}
        @pointerup=${this.onUp}
        @pointercancel=${this.onCancel}
        @keydown=${this.onKey}
      ></canvas>
      <span class="time" part="time">${this.status === "error" ? "–:––" : formatTime(shown)}</span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [tagName]: SonicAudioPlayer;
  }
}
