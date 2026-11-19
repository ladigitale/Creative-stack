import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { listenDp, plain } from "../../shared/audio/dp";
import { multiply, squareToQuad, toCssMatrix3d, type Pt } from "./core/homography";

/** Rectangle d'affichage d'une image `iw×ih` dans une boîte `bw×bh` (object-fit). */
export function fitRect(iw: number, ih: number, bw: number, bh: number, fit: "contain" | "cover"): { x: number; y: number; w: number; h: number } {
  if (!(iw > 0) || !(ih > 0)) return { x: 0, y: 0, w: bw, h: bh };
  const s = fit === "contain" ? Math.min(bw / iw, bh / ih) : Math.max(bw / iw, bh / ih);
  const w = iw * s, h = ih * s;
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}

/** `matrix3d` qui envoie un contenu `cw×ch` (origine 0,0) sur 4 coins en pixels. */
export function projectionMatrix(cw: number, ch: number, corners: Pt[]): string | null {
  const H = squareToQuad(corners);
  if (!H) return null;
  return toCssMatrix3d(multiply(H, new Float64Array([1 / cw, 0, 0, 0, 1 / ch, 0, 0, 0, 1])));
}

/**
 * Projette son contenu (n'importe quel SDUI : image, `sonic-shader`, texte, dessin…) sur la zone suivie
 * par `sonic-anchor`, en perspective. À placer par-dessus l'affichage de la caméra, dans le même conteneur
 * positionné, avec le même `fit` que la caméra.
 *
 * - `anchor` (DP) : état de `sonic-anchor` (`corners`, `width`, `height`, `found`).
 * - `content-width` / `content-height` : taille du plan de contenu (px) ; son rapport donne les proportions
 *   du contenu avant projection (le contenu remplit toujours toute la zone).
 * - `fade` (ms) : fondu d'apparition et de disparition.
 * - `interactive` : le contenu reçoit les clics (sinon il laisse passer vers la page).
 */
@customElement("sonic-anchor-view")
export class SonicAnchorView extends LitElement {
  static styles = css`
    :host { position: absolute; inset: 0; overflow: hidden; pointer-events: none; display: block; }
    .plane { position: absolute; left: 0; top: 0; transform-origin: 0 0; opacity: 0; will-change: transform, opacity; }
    :host([interactive]) .plane.on { pointer-events: auto; }
    ::slotted(*) { width: 100%; height: 100%; display: block; box-sizing: border-box; }
  `;

  @property({ type: String }) anchor = "";
  @property({ type: String }) fit: "contain" | "cover" = "cover";
  @property({ type: Number, attribute: "content-width" }) contentWidth = 800;
  @property({ type: Number, attribute: "content-height" }) contentHeight = 600;
  @property({ type: Number }) fade = 180;
  @property({ type: Boolean, reflect: true }) interactive = false;

  @query(".plane") private plane!: HTMLDivElement;
  private unsub: (() => void) | null = null;
  private last: { corners: Pt[] | null; width: number; height: number; found: boolean } = { corners: null, width: 0, height: 0, found: false };
  private ro: ResizeObserver | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.apply());
      this.ro.observe(this);
    }
  }

  disconnectedCallback(): void {
    this.unsub?.();
    this.unsub = null;
    this.ro?.disconnect();
    this.ro = null;
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("anchor")) {
      this.unsub?.();
      this.unsub = this.anchor ? listenDp(this.anchor, (v) => this.onState(plain(v))) : null;
    }
    if (c.has("fit") || c.has("contentWidth") || c.has("contentHeight") || c.has("fade")) this.apply();
  }

  /** Nouvel état d'ancrage (public pour les tests). */
  onState(v: unknown): void {
    const s = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const corners = Array.isArray(s.corners) && s.corners.length === 4 ? (s.corners as Pt[]) : null;
    this.last = { corners, width: Number(s.width) || 0, height: Number(s.height) || 0, found: !!s.found && !!corners };
    this.apply();
  }

  /** Transformation CSS courante (`null` si rien à afficher). */
  transformFor(boxW: number, boxH: number): string | null {
    const { corners, width, height, found } = this.last;
    if (!found || !corners) return null;
    const r = fitRect(width, height, boxW, boxH, this.fit === "contain" ? "contain" : "cover");
    const px = corners.map((p) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h }));
    return projectionMatrix(Math.max(1, this.contentWidth), Math.max(1, this.contentHeight), px);
  }

  private apply(): void {
    const plane = this.plane;
    if (!plane) return;
    const cw = Math.max(1, this.contentWidth), ch = Math.max(1, this.contentHeight);
    plane.style.width = `${cw}px`;
    plane.style.height = `${ch}px`;
    plane.style.transition = `opacity ${Math.max(0, this.fade)}ms ease`;
    const t = this.transformFor(this.clientWidth, this.clientHeight);
    if (t) plane.style.transform = t;
    plane.style.opacity = t ? "1" : "0";
    plane.classList.toggle("on", !!t);
  }

  render() {
    return html`<div class="plane" part="plane"><slot></slot></div>`;
  }
}
