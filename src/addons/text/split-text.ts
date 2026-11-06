import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { EFFECTS, effectStyle, ease, lineIndices, splitPieces, unitProgress, type Ease, type Effect, type Split } from "./core";

type UnitRef = { outer: HTMLSpanElement; inner: HTMLSpanElement; line: number };

/**
 * Texte cinétique : le texte est découpé en caractères, mots ou lignes révélés avec un décalage (montée masquée,
 * fondu, flou, balayage, échelle, glissement). L'avancement 0..1 vient d'un attribut, d'un DataProvider
 * (`progress-source="defil.smoothProgress"`) ou d'une lecture automatique à l'entrée dans l'écran (`play`).
 */
@customElement("sonic-split-text")
export class SonicSplitText extends LitElement {
  /** Texte à découper ; vide : le texte contenu dans l'élément. */
  @property({ type: String }) text = "";
  @property({ type: String }) split: Split = "words";
  @property({ type: String }) effect: Effect = "rise";
  /** Avancement 0..1 fixé à la main. */
  @property({ type: Number }) progress = 0;
  /** Chemin DataProvider de l'avancement (ex. `defil.smoothProgress`) : remplace `progress`. */
  @property({ type: String, attribute: "progress-source" }) progressSource = "";
  /** Part de la course consacrée au décalage entre unités (0..1). */
  @property({ type: Number }) spread = 0.7;
  @property({ type: String }) ease: Ease = "out";
  /** Distance en px de l'effet `slide`. */
  @property({ type: Number }) distance = 24;
  /** Lecture automatique à l'entrée dans l'écran, sans source d'avancement. */
  @property({ type: Boolean }) play = false;
  /** Durée en secondes de la lecture automatique. */
  @property({ type: Number }) duration = 1.2;
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  private units: UnitRef[] = [];
  private cur = 0;
  private unsub: (() => void) | null = null;
  private io: IntersectionObserver | null = null;
  private ro: ResizeObserver | null = null;
  private raf = 0;
  private original = "";
  private built = "";

  createRenderRoot(): HTMLElement | ShadowRoot { return this; }

  connectedCallback(): void {
    super.connectedCallback();
    if (!this.text && !this.original) this.original = this.textContent ?? "";
    this.build();
    this.bind();
  }

  disconnectedCallback(): void {
    this.unbind();
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("text") || c.has("split") || c.has("effect")) { this.build(); this.apply(this.cur); }
    if (c.has("progressSource") || c.has("play")) { this.unbind(); this.bind(); }
    if (c.has("progress") && !this.progressSource && !this.play) this.apply(this.progress);
    if (c.has("spread") || c.has("ease") || c.has("distance")) this.apply(this.cur);
  }

  private reduced(): boolean {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  private source(): string { return (this.text || this.original).replace(/\s+/g, " ").trim(); }

  private build(): void {
    const txt = this.source();
    const mode: Split = this.split === "chars" || this.split === "lines" ? this.split : "words";
    const key = `${mode}|${this.effect}|${txt}`;
    if (key === this.built) return;
    this.built = key;
    this.replaceChildren();
    this.units = [];
    this.setAttribute("aria-label", txt);
    this.setAttribute("role", "text");
    this.style.whiteSpace = "pre-wrap";
    const frag = document.createDocumentFragment();
    for (const p of splitPieces(txt, mode === "lines" ? "words" : mode)) {
      if (!p.unit) { frag.appendChild(document.createTextNode(p.text)); continue; }
      const outer = document.createElement("span");
      const inner = document.createElement("span");
      outer.setAttribute("aria-hidden", "true");
      outer.style.display = "inline-block";
      outer.style.verticalAlign = "top";
      inner.style.display = "inline-block";
      inner.style.willChange = "transform, opacity";
      inner.textContent = p.text;
      outer.appendChild(inner);
      frag.appendChild(outer);
      this.units.push({ outer, inner, line: 0 });
    }
    this.appendChild(frag);
    this.measureLines();
  }

  private measureLines(): void {
    if (this.split !== "lines") { this.units.forEach((u, i) => (u.line = i)); return; }
    const lines = lineIndices(this.units.map((u) => u.outer.offsetTop));
    this.units.forEach((u, i) => (u.line = lines[i] ?? 0));
  }

  private bind(): void {
    if (this.progressSource.trim()) {
      this.unsub = listenDp(this.progressSource.trim(), (v) => { const n = Number(v); if (Number.isFinite(n)) this.apply(n); });
    } else if (this.play) {
      this.watchViewport();
    } else {
      this.apply(this.progress);
    }
    if (this.split === "lines" && typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => { this.measureLines(); this.apply(this.cur); });
      this.ro.observe(this);
    }
  }

  private unbind(): void {
    this.unsub?.();
    this.unsub = null;
    this.io?.disconnect();
    this.io = null;
    this.ro?.disconnect();
    this.ro = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private watchViewport(): void {
    const start = () => {
      if (this.reduced()) { this.apply(1); return; }
      const t0 = performance.now();
      const dur = Math.max(0.05, Number(this.duration) || 1.2) * 1000;
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / dur);
        this.apply(p);
        this.raf = p < 1 ? requestAnimationFrame(step) : 0;
      };
      this.raf = requestAnimationFrame(step);
    };
    this.apply(0);
    if (typeof IntersectionObserver === "undefined") { start(); return; }
    this.io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { this.io?.disconnect(); this.io = null; start(); }
    }, { threshold: 0.2 });
    this.io.observe(this);
  }

  /** Applique l'avancement global `p` à chaque unité. */
  private apply(p: number): void {
    const prog = this.reduced() ? 1 : Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0));
    this.cur = prog;
    const effect: Effect = EFFECTS.includes(this.effect) ? this.effect : "rise";
    const dist = Number(this.distance) || 0;
    const spread = Number.isFinite(this.spread) ? this.spread : 0.7;
    const e: Ease = this.ease === "linear" || this.ease === "inout" ? this.ease : "out";
    const count = this.split === "lines" ? (this.units.length ? this.units[this.units.length - 1].line + 1 : 0) : this.units.length;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const idx = this.split === "lines" ? u.line : i;
      const t = ease(unitProgress(idx, count, prog, spread), e);
      const s = effectStyle(effect, t, dist);
      u.outer.style.overflow = s.outerClip ? "clip" : "";
      u.outer.style.paddingBottom = s.outerClip ? "0.2em" : "";
      u.outer.style.marginBottom = s.outerClip ? "-0.2em" : "";
      u.inner.style.opacity = s.opacity === 1 ? "" : String(s.opacity);
      u.inner.style.transform = s.transform;
      u.inner.style.filter = s.filter;
      u.inner.style.clipPath = s.clipPath;
    }
    if (this.outDataProvider) set(this.outDataProvider, { progress: prog, units: this.units.length, done: prog >= 1 });
    this.dispatchEvent(new CustomEvent("split-progress", { detail: { progress: prog, done: prog >= 1 }, bubbles: true, composed: true }));
  }

  getState(): { progress: number; units: number; done: boolean } { return { progress: this.cur, units: this.units.length, done: this.cur >= 1 }; }
}
