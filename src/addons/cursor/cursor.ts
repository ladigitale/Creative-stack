import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { ema, round, smoothTo } from "../scroll/core";
import { hoverTarget, magneticOffset } from "./core";

export const MAX_MAGNETIC = 100;

export type CursorState = {
  /** Position du pointeur en px de la fenêtre et en fraction (0..1). */
  x: number;
  y: number;
  nx: number;
  ny: number;
  /** Position lissée (celle du suiveur). */
  smoothX: number;
  smoothY: number;
  /** Vitesse lissée (px/s) et module. */
  vx: number;
  vy: number;
  speed: number;
  down: boolean;
  inside: boolean;
  /** Pointeur tactile ou stylet : pas de suiveur. */
  touch: boolean;
  /** Nom (valeur de `data-cursor`) et id de l'élément survolé qui en porte un. */
  hover: { name: string; id: string } | null;
};

const EMPTY: CursorState = { x: 0, y: 0, nx: 0, ny: 0, smoothX: 0, smoothY: 0, vx: 0, vy: 0, speed: 0, down: false, inside: false, touch: false, hover: null };

/**
 * Source de pointeur : position, vitesse, appui et élément survolé (`data-cursor="voir"`) en DataProvider ; suiveur
 * visuel optionnel (`follower="dot|ring"`) ; effet magnétique sur les éléments d'un sélecteur (`magnetic="[data-magnetic]"`).
 * Le curseur natif n'est masqué que sur demande (`hide-native`) et seulement avec une souris.
 */
@customElement("sonic-cursor")
export class SonicCursor extends LitElement {
  /** `dot` (point), `ring` (anneau) ou `none` : suiveur dessiné. */
  @property({ type: String }) follower: "none" | "dot" | "ring" = "none";
  @property({ type: Number }) size = 16;
  /** Couleur CSS du suiveur ; vide : jeton `--sc-primary`. */
  @property({ type: String }) color = "";
  /** `difference` : le suiveur inverse les couleurs sous lui. */
  @property({ type: String }) blend: "normal" | "difference" = "normal";
  /** Inertie du suiveur et des valeurs lissées : 1 sans retard, 0,05 très doux. */
  @property({ type: Number }) smooth = 0.2;
  /** Agrandissement du suiveur sur un élément `data-cursor` (1 : aucun). */
  @property({ type: Number, attribute: "hover-scale" }) hoverScale = 2.5;
  /** Masque le curseur natif (souris seulement). */
  @property({ type: Boolean, attribute: "hide-native" }) hideNative = false;
  /** Sélecteur des éléments attirés par le pointeur. */
  @property({ type: String }) magnetic = "";
  /** Part de l'écart au centre suivie par l'élément (0..1), portée en px autour de lui, et décalage maximal en px. */
  @property({ type: Number, attribute: "magnetic-strength" }) magneticStrength = 0.35;
  @property({ type: Number, attribute: "magnetic-radius" }) magneticRadius = 60;
  @property({ type: Number, attribute: "magnetic-max" }) magneticMax = 14;
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  private state: CursorState = { ...EMPTY };
  private tx = 0;
  private ty = 0;
  private sx = 0;
  private sy = 0;
  private lx = 0;
  private ly = 0;
  private lt = 0;
  private vx = 0;
  private vy = 0;
  private hover: CursorState["hover"] = null;
  private raf = 0;
  private dot: HTMLDivElement | null = null;
  private shifts = new Map<HTMLElement, { x: number; y: number }>();
  private mo: MutationObserver | null = null;
  private magnets: HTMLElement[] = [];
  private styleEl: HTMLStyleElement | null = null;
  private seen = false;

  createRenderRoot(): HTMLElement | ShadowRoot { return this; }

  connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "none";
    window.addEventListener("pointermove", this.onMove, { passive: true });
    window.addEventListener("pointerdown", this.onDown, { passive: true });
    window.addEventListener("pointerup", this.onUp, { passive: true });
    window.addEventListener("pointercancel", this.onUp, { passive: true });
    document.documentElement.addEventListener("pointerleave", this.onLeave);
    this.lt = performance.now();
    this.refresh();
    if (typeof MutationObserver !== "undefined") {
      this.mo = new MutationObserver(() => this.refresh(true));
      this.mo.observe(this.tree() instanceof Document ? document.body : this.tree(), { childList: true, subtree: true });
    }
  }

  disconnectedCallback(): void {
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("pointercancel", this.onUp);
    document.documentElement.removeEventListener("pointerleave", this.onLeave);
    this.mo?.disconnect();
    this.mo = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.releaseMagnets();
    this.dot?.remove();
    this.dot = null;
    this.styleEl?.remove();
    this.styleEl = null;
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("follower") || c.has("size") || c.has("color") || c.has("blend") || c.has("hideNative") || c.has("magnetic")) this.refresh();
  }

  private tree(): Document | ShadowRoot {
    const r = this.getRootNode();
    return r instanceof Document || r instanceof ShadowRoot ? r : document;
  }

  private finePointer(): boolean {
    return typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;
  }

  private reduced(): boolean {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /** (Re)construit le suiveur, le masquage du curseur natif et la liste des éléments magnétiques. */
  private refresh(onlyMagnets = false): void {
    let list: HTMLElement[] = [];
    if (this.magnetic.trim()) {
      try { list = [...this.tree().querySelectorAll<HTMLElement>(this.magnetic)].slice(0, MAX_MAGNETIC); } catch { list = []; }
    }
    for (const el of this.magnets) if (!list.includes(el)) this.release(el);
    this.magnets = list;
    if (onlyMagnets) return;

    const wantDot = this.follower !== "none";
    if (wantDot && !this.dot) {
      this.dot = document.createElement("div");
      this.dot.setAttribute("aria-hidden", "true");
      document.body.appendChild(this.dot);
    }
    if (!wantDot && this.dot) { this.dot.remove(); this.dot = null; }
    if (this.dot) {
      const d = this.dot.style;
      const px = Math.max(2, Math.min(200, Number(this.size) || 16));
      d.cssText = `position:fixed;left:0;top:0;width:${px}px;height:${px}px;margin:${-px / 2}px 0 0 ${-px / 2}px;border-radius:50%;pointer-events:none;z-index:2147483000;will-change:transform;opacity:0;transition:opacity .2s;` +
        (this.follower === "ring" ? `border:2px solid ${cssColor(this.color)};box-sizing:border-box;` : `background:${cssColor(this.color)};`) +
        (this.blend === "difference" ? "mix-blend-mode:difference;" : "");
    }
    if (this.hideNative && !this.styleEl) {
      this.styleEl = document.createElement("style");
      this.styleEl.textContent = "@media (hover: hover) and (pointer: fine){html,html *{cursor:none !important}}";
      document.head.appendChild(this.styleEl);
    } else if (!this.hideNative && this.styleEl) {
      this.styleEl.remove();
      this.styleEl = null;
    }
  }

  private onMove = (e: PointerEvent): void => {
    this.tx = e.clientX;
    this.ty = e.clientY;
    if (!this.seen) { this.sx = this.lx = e.clientX; this.sy = this.ly = e.clientY; this.seen = true; }
    this.state = { ...this.state, inside: true, touch: e.pointerType !== "mouse" };
    this.hover = hoverTarget(typeof e.composedPath === "function" ? e.composedPath() : []);
    this.wake();
  };

  private onDown = (e: PointerEvent): void => { this.onMove(e); this.state = { ...this.state, down: true }; this.wake(); };
  private onUp = (): void => { this.state = { ...this.state, down: false }; this.wake(); };
  private onLeave = (): void => { this.state = { ...this.state, inside: false }; this.hover = null; this.wake(); };

  private wake(): void {
    if (!this.raf && this.isConnected) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private release(el: HTMLElement): void {
    el.style.removeProperty("translate");
    el.style.removeProperty("--mx");
    el.style.removeProperty("--my");
    this.shifts.delete(el);
  }

  private releaseMagnets(): void {
    for (const el of this.magnets) this.release(el);
    this.magnets = [];
  }

  private frame(now: number): void {
    this.raf = 0;
    const dt = Math.min(0.25, Math.max(0.001, (now - this.lt) / 1000));
    this.lt = now;
    const reduced = this.reduced();
    const lerp = reduced ? 1 : Math.max(0.01, Math.min(1, Number(this.smooth) || 0.2));
    this.sx = smoothTo(this.sx, this.tx, dt, lerp);
    this.sy = smoothTo(this.sy, this.ty, dt, lerp);
    if (Math.abs(this.sx - this.tx) < 0.05) this.sx = this.tx;
    if (Math.abs(this.sy - this.ty) < 0.05) this.sy = this.ty;
    this.vx = ema(this.vx, (this.tx - this.lx) / dt, dt);
    this.vy = ema(this.vy, (this.ty - this.ly) / dt, dt);
    if (Math.abs(this.vx) < 1 && this.tx === this.lx) this.vx = 0;
    if (Math.abs(this.vy) < 1 && this.ty === this.ly) this.vy = 0;
    this.lx = this.tx;
    this.ly = this.ty;

    let moving = false;
    const k = Math.max(0.05, Math.min(1, Number(this.smooth) || 0.2));
    for (const el of this.magnets) {
      const r = el.getBoundingClientRect();
      const target = this.state.inside && !this.state.touch
        ? magneticOffset({ left: r.left - (this.shifts.get(el)?.x ?? 0), top: r.top - (this.shifts.get(el)?.y ?? 0), width: r.width, height: r.height }, this.tx, this.ty, Number(this.magneticRadius) || 0, Math.max(0, Math.min(1, Number(this.magneticStrength) || 0)), Math.max(0, Number(this.magneticMax) || 0))
        : { dx: 0, dy: 0, active: false };
      const cur = this.shifts.get(el) ?? { x: 0, y: 0 };
      const nx = reduced ? target.dx : smoothTo(cur.x, target.dx, dt, Math.max(0.12, k));
      const ny = reduced ? target.dy : smoothTo(cur.y, target.dy, dt, Math.max(0.12, k));
      const x = Math.abs(nx - target.dx) < 0.05 ? target.dx : nx, y = Math.abs(ny - target.dy) < 0.05 ? target.dy : ny;
      if (x !== cur.x || y !== cur.y) {
        this.shifts.set(el, { x, y });
        if (x === 0 && y === 0) this.release(el);
        else { el.style.translate = `${round(x, 2)}px ${round(y, 2)}px`; el.style.setProperty("--mx", `${round(x, 2)}px`); el.style.setProperty("--my", `${round(y, 2)}px`); }
      }
      if (x !== target.dx || y !== target.dy) moving = true;
    }

    if (this.dot) {
      const show = this.state.inside && !this.state.touch && this.finePointer();
      this.dot.style.opacity = show ? "1" : "0";
      const scale = this.hover && this.hoverScale > 0 ? Math.min(8, this.hoverScale) : 1;
      this.dot.style.transform = `translate3d(${round(this.sx, 1)}px, ${round(this.sy, 1)}px, 0) scale(${this.state.down ? scale * 0.85 : scale})`;
    }

    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    this.state = {
      ...this.state, x: round(this.tx, 1), y: round(this.ty, 1), nx: round(this.tx / w), ny: round(this.ty / h),
      smoothX: round(this.sx, 1), smoothY: round(this.sy, 1), vx: round(this.vx, 1), vy: round(this.vy, 1), speed: round(Math.hypot(this.vx, this.vy), 1), hover: this.hover,
    };
    if (this.outDataProvider) set(this.outDataProvider, this.state);
    this.dispatchEvent(new CustomEvent("cursor-state", { detail: this.state, bubbles: true, composed: true }));
    if (this.sx !== this.tx || this.sy !== this.ty || this.vx !== 0 || this.vy !== 0 || moving) this.wake();
  }

  getState(): CursorState { return this.state; }
}

/** Couleur sûre pour une propriété CSS : un jeton ou une valeur simple, sinon le jeton principal. */
function cssColor(c: string): string {
  const v = c.trim();
  if (/^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/-]+\)|[a-z]{3,20}|var\(--[\w-]+\))$/i.test(v)) return v;
  return "var(--sc-primary, #4f46e5)";
}
