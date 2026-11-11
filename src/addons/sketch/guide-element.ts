import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { listenDp, plain } from "../../shared/audio/dp";
import { get } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { GUIDE_DEFAULTS, guidePaths, sanitizeGuide, type GuideMap, type GuideSettings, type GuideType, type P } from "./guide";
import { DEFAULT_VIEW, sanitizeView, toScreen, toWorld, type View } from "./model";

/**
 * Calque guide posé sur une toile (`sonic-sketch`, `sonic-paint`) : grilles, isométrie, perspectives à 1, 2 ou 3
 * points de fuite, tiers, nombre d'or, diagonales, symétrie radiale, proportions du visage, mannequin de posture.
 * Jamais dans l'image (ni export, ni source d'images) ; ne capte aucun pointeur. Ancré à l'écran, ou au dessin
 * (`anchor="world"` : suit la vue lue dans `view-from`, à partir de la vue du moment où l'ancrage est pris ;
 * les grilles s'y affinent ou s'espacent avec le zoom). Réglages par attributs ou en direct par `settings-from`.
 */
@customElement("sonic-sketch-guide")
export class SonicSketchGuide extends LitElement {
  static styles = css`
    :host { display: block; position: absolute; inset: 0; pointer-events: none; }
    canvas { display: block; width: 100%; height: 100%; pointer-events: none; }
  `;

  @property({ type: String }) type: GuideType = "none";
  @property({ type: String }) color = GUIDE_DEFAULTS.color;
  @property({ type: Number }) opacity = GUIDE_DEFAULTS.opacity;
  @property({ type: String }) anchor: "screen" | "world" = "screen";
  @property({ type: Number }) spacing = GUIDE_DEFAULTS.spacing;
  @property({ type: Number }) subdiv = GUIDE_DEFAULTS.subdiv;
  @property({ type: String }) pose = GUIDE_DEFAULTS.pose;
  /** DP des réglages en direct (mêmes clés que les attributs, plus horizon, vp1..vp3, rays, angle, yaw, pitch, heads, mirror). */
  @property({ type: String, attribute: "settings-from" }) settingsFrom = "";
  /** DP de vue `{ x, y, zoom, rotation }` de la toile (son `view-sync`). */
  @property({ type: String, attribute: "view-from" }) viewFrom = "";

  @query("canvas") private canvasEl!: HTMLCanvasElement;

  private live: Record<string, unknown> = {};
  private view: View = { ...DEFAULT_VIEW };
  /** Vue d'ancrage (`anchor="world"`), prise quand l'ancrage ou le type change. */
  private pinned: View | null = null;
  private pinKey = "";
  private unsubs: (() => void)[] = [];
  private raf = 0;
  private ro: ResizeObserver | null = null;

  settings(): GuideSettings {
    const base = sanitizeGuide({ type: this.type, color: this.color, opacity: this.opacity, anchor: this.anchor, spacing: this.spacing, subdiv: this.subdiv, pose: this.pose });
    return sanitizeGuide(this.live, base);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.schedule());
      this.ro.observe(this);
    }
  }

  disconnectedCallback(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.ro?.disconnect();
    this.ro = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("settingsFrom") || c.has("viewFrom")) this.listen();
    this.schedule();
  }

  private listen(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.settingsFrom) {
      const path = this.settingsFrom;
      let queued = false;
      this.unsubs.push(listenDp(path, () => {
        if (queued) return;
        queued = true;
        // Un objet publié arrive clé par clé : relecture complète après la publication.
        queueMicrotask(() => {
          queued = false;
          const v = plain(get(path));
          this.live = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
          this.schedule();
        });
      }));
    }
    if (this.viewFrom) this.unsubs.push(listenDp(this.viewFrom, (v) => {
      this.view = sanitizeView(v, this.view);
      this.schedule();
    }));
  }

  /** Reprend l'ancrage au dessin sur la vue courante (le guide revient en place à l'écran). */
  repin(): void {
    this.pinned = { ...this.view };
    this.schedule();
  }

  private schedule(): void {
    if (this.raf || typeof requestAnimationFrame === "undefined") return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  private map(s: GuideSettings, w: number, h: number): GuideMap {
    const key = `${s.anchor}|${s.type}`;
    if (key !== this.pinKey) { this.pinKey = key; this.pinned = { ...this.view }; }
    if (s.anchor !== "world" || !this.pinned) return { to: (p) => p, from: (p) => p, k: 1 };
    const pin = this.pinned, view = this.view;
    return {
      to: ([x, y]: P): P => { const [wx, wy] = toWorld(pin, x, y, w, h); return toScreen(view, wx, wy, w, h); },
      from: ([x, y]: P): P => { const [wx, wy] = toWorld(view, x, y, w, h); return toScreen(pin, wx, wy, w, h); },
      k: view.zoom / pin.zoom,
    };
  }

  private draw(): void {
    const c = this.canvasEl;
    if (!c) return;
    const w = this.clientWidth, h = this.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    let ctx: CanvasRenderingContext2D | null = null;
    try { ctx = c.getContext("2d"); } catch { ctx = null; }
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const s = this.settings();
    if (s.type === "none" || !w || !h || s.opacity <= 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    const paths = guidePaths(s, w, h, this.map(s, w, h));
    const alpha = [0.45, 0.8, 1];
    const width = [0.75, 1.1, 1.6];
    for (const level of [0, 1, 2] as const) {
      ctx.globalAlpha = s.opacity * alpha[level];
      ctx.lineWidth = width[level];
      const path = new Path2D();
      for (const p of paths) {
        if (p.w !== level) continue;
        if (p.dot) { const [x, y] = p.pts[0]; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill(); continue; }
        p.pts.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
        if (p.closed) path.closePath();
      }
      ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
  }

  render() {
    return html`<canvas aria-hidden="true"></canvas>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sonic-sketch-guide": SonicSketchGuide;
  }
}
