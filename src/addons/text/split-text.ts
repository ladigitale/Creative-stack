import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { num } from "../../shared/media/control";
import { EFFECTS, effectStyle, ease, lineIndices, splitPieces, unitProgress, type Ease, type Effect, type Split } from "./core";

type UnitRef = { outer: HTMLSpanElement; inner: HTMLSpanElement; line: number };

const SPLITS: readonly Split[] = ["chars", "words", "lines"];
const EASES: readonly Ease[] = ["linear", "out", "inout"];
const MAX_TEXT = 20_000;

/** Réglages effectifs (attributs, puis `params`). */
export type SplitTextSettings = { text: string; split: Split; effect: Effect; ease: Ease; spread: number; distance: number; duration: number };

/**
 * Lit le DP `params` : `{ text, split, effect, ease, spread (0..1), distance (px, -2000..2000), duration (s, 0.05..600) }`.
 * Clé absente ou `null` : l'attribut s'applique. `invalid` liste les clés présentes mais refusées (valeur inconnue,
 * non numérique, texte de plus de 20 000 caractères).
 */
export function readSplitTextParams(v: unknown): { settings: Partial<SplitTextSettings>; invalid: string[] } {
  const p = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const o: Partial<SplitTextSettings> = {};
  const invalid: string[] = [];
  const present = (k: string) => p[k] !== undefined && p[k] !== null;
  if (present("text")) {
    if ((typeof p.text === "string" || typeof p.text === "number") && String(p.text).length <= MAX_TEXT) o.text = String(p.text);
    else invalid.push("text");
  }
  const pick = <T extends string>(k: "split" | "effect" | "ease", list: readonly T[]) => {
    if (!present(k) || p[k] === "") return;
    if (list.includes(p[k] as T)) (o as Record<string, unknown>)[k] = p[k];
    else invalid.push(k);
  };
  pick("split", SPLITS);
  pick("effect", EFFECTS);
  pick("ease", EASES);
  for (const [k, min, max] of [["spread", 0, 1], ["distance", -2000, 2000], ["duration", 0.05, 600]] as const) {
    if (!present(k) || p[k] === "") continue;
    const n = typeof p[k] === "boolean" ? undefined : num(p[k], min, max);
    if (n === undefined) invalid.push(k);
    else o[k] = n;
  }
  return { settings: o, invalid };
}

export type SplitTextState = {
  /** `idle` : aucun texte ; `ready` : texte découpé ; `error` : valeur refusée (attribut inconnu ou `params`). */
  status: "idle" | "ready" | "error";
  error: string | null;
  progress: number;
  units: number;
  done: boolean;
  settings: SplitTextSettings;
};

/**
 * Texte cinétique : le texte est découpé en caractères, mots ou lignes révélés avec un décalage (montée masquée,
 * fondu, flou, balayage, échelle, glissement). L'avancement 0..1 vient d'un attribut, d'un DataProvider
 * (`progress-source="defil.smoothProgress"`) ou d'une lecture automatique à l'entrée dans l'écran (`play`).
 * Réglages en direct par le DP `params` : `{ text, split, effect, ease, spread, distance, duration }`.
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
  /** DP de réglages en direct : `{ text, split, effect, ease, spread, distance, duration }` (prioritaire sur les attributs). */
  @property({ type: String }) params = "";

  private units: UnitRef[] = [];
  private cur = 0;
  private unsub: (() => void) | null = null;
  private io: IntersectionObserver | null = null;
  private ro: ResizeObserver | null = null;
  private raf = 0;
  private original = "";
  private built = "";
  private live: Partial<SplitTextSettings> = {};
  private liveInvalid: string[] = [];
  private unsubParams: (() => void) | null = null;

  createRenderRoot(): HTMLElement | ShadowRoot { return this; }

  connectedCallback(): void {
    super.connectedCallback();
    if (!this.text && !this.original) this.original = this.textContent ?? "";
    this.listenParams();
    this.build();
    this.bind();
  }

  disconnectedCallback(): void {
    this.unbind();
    this.unsubParams?.();
    this.unsubParams = null;
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("params") && c.get("params") !== undefined && this.isConnected) { this.listenParams(); this.refresh(); }
    if (c.has("text") || c.has("split") || c.has("effect")) { this.build(); if (this.isConnected) this.syncResize(); this.apply(this.cur); }
    if (c.has("progressSource") || c.has("play")) { this.unbind(); this.bind(); }
    if (c.has("progress") && !this.progressSource && !this.play) this.apply(this.progress);
    if (c.has("spread") || c.has("ease") || c.has("distance")) this.apply(this.cur);
  }

  /** Réglages effectifs (attributs, puis `params`), valeurs inconnues ramenées au défaut. */
  settings(): SplitTextSettings {
    const s = { text: this.text, split: this.split, effect: this.effect, ease: this.ease, spread: this.spread, distance: this.distance, duration: this.duration, ...this.live };
    const spread = Number(s.spread);
    const duration = Number(s.duration);
    return {
      text: String(s.text ?? ""),
      split: SPLITS.includes(s.split) ? s.split : "words",
      effect: EFFECTS.includes(s.effect) ? s.effect : "rise",
      ease: EASES.includes(s.ease) ? s.ease : "out",
      spread: Number.isFinite(spread) ? Math.min(1, Math.max(0, spread)) : 0.7,
      distance: Number(s.distance) || 0,
      duration: Number.isFinite(duration) && duration > 0 ? Math.max(0.05, duration) : 1.2,
    };
  }

  private configError(): string | null {
    if (this.liveInvalid.length) return `params : valeur refusée pour ${this.liveInvalid.join(", ")}`;
    const bad: string[] = [];
    if (this.live.split === undefined && !SPLITS.includes(this.split)) bad.push(`split "${String(this.split)}" (${SPLITS.join(" | ")})`);
    if (this.live.effect === undefined && !EFFECTS.includes(this.effect)) bad.push(`effect "${String(this.effect)}" (${EFFECTS.join(" | ")})`);
    if (this.live.ease === undefined && !EASES.includes(this.ease)) bad.push(`ease "${String(this.ease)}" (${EASES.join(" | ")})`);
    return bad.length ? `valeur inconnue : ${bad.join(", ")}` : null;
  }

  private listenParams(): void {
    this.unsubParams?.();
    this.unsubParams = null;
    this.live = {};
    this.liveInvalid = [];
    const path = this.params.trim();
    if (!path) return;
    this.unsubParams = listenDp(path, (v) => {
      const { settings, invalid } = readSplitTextParams(v);
      this.live = settings;
      this.liveInvalid = invalid;
      this.refresh();
    });
  }

  /** Reconstruit si le découpage a changé, puis réapplique l'avancement courant. */
  private refresh(): void {
    if (!this.isConnected) return;
    this.build();
    this.syncResize();
    this.apply(this.cur);
  }

  private reduced(): boolean {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  private source(): string { return (this.settings().text || this.original).replace(/\s+/g, " ").trim(); }

  private build(): void {
    const txt = this.source();
    const { split: mode, effect } = this.settings();
    const key = `${mode}|${effect}|${txt}`;
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
    if (this.settings().split !== "lines") { this.units.forEach((u, i) => (u.line = i)); return; }
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
    this.syncResize();
  }

  /** Mode `lines` : les lignes sont remesurées quand la largeur change. */
  private syncResize(): void {
    const want = this.settings().split === "lines" && typeof ResizeObserver !== "undefined";
    if (want === !!this.ro) return;
    this.ro?.disconnect();
    this.ro = null;
    if (!want) return;
    this.ro = new ResizeObserver(() => { this.measureLines(); this.apply(this.cur); });
    this.ro.observe(this);
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
      const dur = this.settings().duration * 1000;
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
    const s = this.settings();
    const effect: Effect = s.effect;
    const dist = s.distance;
    const spread = s.spread;
    const e: Ease = s.ease;
    const lines = s.split === "lines";
    const count = lines ? (this.units.length ? this.units[this.units.length - 1].line + 1 : 0) : this.units.length;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const idx = lines ? u.line : i;
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
    if (this.outDataProvider) set(this.outDataProvider, this.getState());
    this.dispatchEvent(new CustomEvent("split-progress", { detail: { progress: prog, done: prog >= 1 }, bubbles: true, composed: true }));
  }

  /** État courant (aussi publié dans `out-data-provider`). */
  getState(): SplitTextState {
    const error = this.configError();
    const status: SplitTextState["status"] = error ? "error" : this.units.length ? "ready" : "idle";
    return { status, error, progress: this.cur, units: this.units.length, done: this.cur >= 1, settings: this.settings() };
  }
}
