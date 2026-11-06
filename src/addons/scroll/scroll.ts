import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import { activeSection, clamp01, ema, round, sectionMetrics, smoothTo, type Rect } from "./core";

export const MAX_SECTIONS = 100;

export type SectionState = { id: string; index: number; progress: number; pin: number; visible: number; inView: boolean };

export type ScrollState = {
  /** Position de défilement en px, maximum possible, avancement global (0..1). */
  y: number;
  max: number;
  progress: number;
  /** Mêmes grandeurs lissées (inertie) : à donner aux animations pour un mouvement doux. */
  smoothY: number;
  smoothProgress: number;
  /** Vitesse lissée (px/s, signée) et sens (-1 vers le haut, 0, 1 vers le bas). */
  velocity: number;
  direction: -1 | 0 | 1;
  atTop: boolean;
  atEnd: boolean;
  /** Section active (celle qui contient le milieu de l'écran) et ses mesures. */
  active: { index: number; id: string; progress: number; pin: number };
  sections: SectionState[];
};

const EMPTY: ScrollState = {
  y: 0, max: 0, progress: 0, smoothY: 0, smoothProgress: 0, velocity: 0, direction: 0, atTop: true, atEnd: false,
  active: { index: -1, id: "", progress: 0, pin: 0 }, sections: [],
};

/**
 * Source de défilement : publie la position, l'avancement (0..1), la vitesse, le sens et l'avancement de chaque
 * section dans un DataProvider. Ne détourne pas le défilement (la molette garde son comportement natif) : la valeur
 * lissée (`smooth`) sert à des animations douces. Lire `smoothProgress` avec `sonic-timeline time-source` ; une section
 * `position: sticky` plus haute que l'écran donne son avancement épinglé dans `pin`.
 */
@customElement("sonic-scroll")
export class SonicScroll extends LitElement {
  /** `#id` d'un conteneur défilant ; vide : la page. */
  @property({ type: String }) target = "";
  /** Sélecteur CSS des sections suivies (par exemple `section` ou `[data-section]`) ; vide : aucune. */
  @property({ type: String }) sections = "";
  /** Inertie des valeurs lissées : 1 sans retard, 0,05 très doux (défaut 0,1). Ignorée avec `prefers-reduced-motion`. */
  @property({ type: Number }) smooth = 0.1;
  /** DataProvider de commandes : `{ to: "#id" | px, n: compteur }` fait défiler jusqu'à la cible. */
  @property({ type: String }) control = "";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  private state: ScrollState = { ...EMPTY };
  private smoothY = 0;
  private lastY = 0;
  private lastT = 0;
  private velocity = 0;
  private raf = 0;
  private scroller: Element | Window | null = null;
  private trigger = new CounterTrigger();
  private unsubs: (() => void)[] = [];
  private ro: ResizeObserver | null = null;

  createRenderRoot(): HTMLElement | ShadowRoot { return this; }

  connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "none";
    this.attach();
    this.listen();
  }

  disconnectedCallback(): void {
    this.detach();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("target")) { this.detach(); this.attach(); }
    if (c.has("control")) this.listen();
    if (c.has("sections") || c.has("smooth")) this.wake();
  }

  private listen(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.trigger.reset();
    if (this.control) {
      this.unsubs.push(listenDp(this.control, (v) => {
        if (!v || typeof v !== "object") return;
        const c = v as { to?: unknown; n?: unknown };
        if (c.to !== undefined && this.trigger.feed(c.n)) this.scrollTo(c.to);
      }));
    }
  }

  private element(): Element | null {
    const id = this.target.trim().replace(/^#/, "");
    return id ? document.getElementById(id) : null;
  }

  private attach(): void {
    const el = this.element();
    this.scroller = el ?? window;
    this.scroller.addEventListener("scroll", this.wake, { passive: true });
    window.addEventListener("resize", this.wake, { passive: true });
    const first = this.position();
    this.smoothY = this.lastY = first;
    this.lastT = performance.now();
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(this.wake);
      this.ro.observe(el ?? document.documentElement);
    }
    this.frame(this.lastT, true);
  }

  private detach(): void {
    this.scroller?.removeEventListener("scroll", this.wake);
    window.removeEventListener("resize", this.wake);
    this.ro?.disconnect();
    this.ro = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.scroller = null;
  }

  private position(): number {
    const s = this.scroller;
    if (s instanceof Element) return s.scrollTop;
    return window.scrollY || document.documentElement.scrollTop || 0;
  }

  private metrics(): { max: number; vh: number; top: number } {
    const s = this.scroller;
    if (s instanceof Element) return { max: Math.max(0, s.scrollHeight - s.clientHeight), vh: s.clientHeight, top: s.getBoundingClientRect().top };
    const de = document.documentElement;
    return { max: Math.max(0, Math.max(de.scrollHeight, document.body?.scrollHeight ?? 0) - window.innerHeight), vh: window.innerHeight, top: 0 };
  }

  private wake = (): void => {
    if (!this.raf && this.isConnected) this.raf = requestAnimationFrame((t) => this.frame(t));
  };

  /** Fait défiler jusqu'à `#id`/sélecteur (haut de l'élément) ou jusqu'à une position en px. */
  scrollTo(to: unknown): void {
    const behavior: ScrollBehavior = matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    const s = this.scroller;
    let y: number | null = null;
    if (typeof to === "number" && Number.isFinite(to)) y = to;
    else if (typeof to === "string" && to.trim()) {
      const t = to.trim();
      const n = Number(t);
      if (Number.isFinite(n) && /^-?[\d.]+$/.test(t)) y = n;
      else {
        let el: Element | null = null;
        try { el = document.querySelector(t.startsWith("#") || /[.[\s>:]/.test(t) ? t : `#${t}`); } catch { el = null; }
        if (el) y = this.position() + el.getBoundingClientRect().top - this.metrics().top;
      }
    }
    if (y === null) return;
    if (s instanceof Element) s.scrollTo({ top: y, behavior });
    else window.scrollTo({ top: y, behavior });
  }

  private reduced(): boolean {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  private frame(now: number, first = false): void {
    this.raf = 0;
    const dt = first ? 0 : Math.min(0.25, Math.max(0.001, (now - this.lastT) / 1000));
    this.lastT = now;
    const y = this.position();
    const { max, vh, top } = this.metrics();
    const inst = dt > 0 ? (y - this.lastY) / dt : 0;
    this.velocity = dt > 0 ? ema(this.velocity, inst, dt) : 0;
    if (Math.abs(this.velocity) < 1 && y === this.lastY) this.velocity = 0;
    this.lastY = y;
    this.smoothY = this.reduced() ? y : smoothTo(this.smoothY, y, dt || 1 / 60, clamp01(Number.isFinite(this.smooth) ? this.smooth : 0.1) || 0.1);
    if (Math.abs(this.smoothY - y) < 0.05) this.smoothY = y;

    const rects: Rect[] = [];
    const ids: string[] = [];
    if (this.sections.trim()) {
      let list: Element[] = [];
      try { list = [...document.querySelectorAll(this.sections)].slice(0, MAX_SECTIONS); } catch { list = []; }
      list.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        rects.push({ top: r.top - top, bottom: r.bottom - top, height: r.height });
        ids.push(el.id || `section-${i + 1}`);
      });
    }
    const secs: SectionState[] = rects.map((r, index) => {
      const m = sectionMetrics(r, vh);
      return { id: ids[index], index, progress: round(m.progress), pin: round(m.pin), visible: round(m.visible), inView: m.inView };
    });
    const ai = activeSection(rects, vh);
    const progress = max > 0 ? clamp01(y / max) : 0;
    this.state = {
      y: round(y, 1), max: round(max, 1), progress: round(progress), smoothY: round(this.smoothY, 2), smoothProgress: round(max > 0 ? clamp01(this.smoothY / max) : 0),
      velocity: round(this.velocity, 1), direction: this.velocity > 5 ? 1 : this.velocity < -5 ? -1 : 0, atTop: y <= 1, atEnd: max > 0 && y >= max - 1,
      active: ai >= 0 ? { index: ai, id: ids[ai], progress: secs[ai].progress, pin: secs[ai].pin } : { index: -1, id: "", progress: 0, pin: 0 },
      sections: secs,
    };
    if (this.outDataProvider) set(this.outDataProvider, this.state);
    this.dispatchEvent(new CustomEvent("scroll-state", { detail: this.state, bubbles: true, composed: true }));
    // Continue tant que la valeur lissée rattrape le défilement ou que la page bouge encore.
    if (this.smoothY !== y || this.velocity !== 0) this.wake();
  }

  getState(): ScrollState { return this.state; }
}
