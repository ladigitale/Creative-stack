import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { listenDp } from "../../shared/audio/dp";
import { buildShapes, type OverlayKind, type Shape } from "../../shared/ml/shapes";

const tagName = "sonic-landmarks-overlay";

type FrameSource = Element & {
  getFrameSource?: () => HTMLVideoElement | null;
  getFrameCanvas?: () => HTMLCanvasElement | null;
};

type Background = { image: CanvasImageSource; width: number; height: number; native: boolean };

/**
 * Dessine sur un canvas la sortie d'un tracker (`sonic-hand-tracker`, `sonic-face-tracker`,
 * `sonic-pose-tracker`) : points, segments, contours du visage. Pensé comme **panneau séparé** (à côté de la
 * caméra : rien ne se superpose à la vue) ; avec `background="cam"` il redessine aussi l'image de la caméra
 * dessous, pour un aperçu de contrôle. Le visage n'apparaît que si le tracker publie ses points
 * (`landmarks="true"`). Aucun HTML n'est injecté : seul un canvas est dessiné.
 */
@customElement(tagName)
export class SonicLandmarksOverlay extends LitElement {
  static styles = css`
    :host {
      display: block;
      position: relative;
      line-height: 0;
    }
    canvas {
      width: 100%;
      height: auto;
      display: block;
      border-radius: inherit;
    }
  `;

  /** DataProvider de la sortie du tracker (son `outputProvider`, ou l'id du tracker). */
  @property({ type: String })
  source = "";

  /** `auto` (d'après les clés de la sortie), `hands`, `face`, `pose`, `objects`. */
  @property({ type: String })
  kind: "auto" | OverlayKind = "auto";

  /** Id d'une source d'images (`sonic-camera`, `sonic-segmenter`…) redessinée sous les formes. Vide : fond uni ou transparent. */
  @property({ type: String })
  background = "";

  /** Miroir de l'image de fond : `auto` (retournée si la source native n'est pas déjà en miroir), `true`, `false`. */
  @property({ type: String })
  mirror: "auto" | "true" | "false" = "auto";

  /** Taille du canvas quand il n'y a pas d'image de fond (le rapport d'aspect suit). */
  @property({ type: Number })
  width = 640;

  @property({ type: Number })
  height = 480;

  /** Couleur de fond du canvas (vide : transparent). */
  @property({ type: String })
  fill = "";

  /** Couleur principale (main gauche, premier visage / corps). */
  @property({ type: String })
  color = "#f2b45c";

  /** Couleur secondaire (main droite, visage / corps suivants). */
  @property({ type: String })
  color2 = "#5cc8f2";

  @property({ type: Number, attribute: "line-width" })
  lineWidth = 3;

  @property({ type: Number, attribute: "point-radius" })
  pointRadius = 4;

  /** `"false"` : sans points. */
  @property({ type: String })
  points: "true" | "false" = "true";

  /** `"false"` : sans segments ni contours. */
  @property({ type: String })
  bones: "true" | "false" = "true";

  @query("canvas")
  private canvas!: HTMLCanvasElement;

  private data: unknown = null;
  private unlisten: (() => void) | null = null;
  private raf = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
  }

  disconnectedCallback(): void {
    this.unlisten?.();
    this.unlisten = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("source")) this.listen();
    if (changed.has("background")) this.schedule();
    this.schedule();
  }

  private listen(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.data = null;
    const path = this.source.trim();
    if (!path) return;
    this.unlisten = listenDp(path, (v) => {
      this.data = v;
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.raf || !this.isConnected) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
      if (this.background.trim()) this.schedule(); // l'image de fond change à chaque trame
    });
  }

  private backgroundImage(): Background | null {
    const id = this.background.trim().replace(/^#/, "");
    if (!id) return null;
    const root = this.getRootNode() as Document | ShadowRoot;
    const src = (root.getElementById?.(id) ?? document.getElementById(id)) as FrameSource | null;
    const video = src?.getFrameSource?.();
    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      return { image: video, width: video.videoWidth, height: video.videoHeight, native: true };
    }
    const canvas = src?.getFrameCanvas?.();
    if (canvas && canvas.width > 0 && canvas.height > 0) return { image: canvas, width: canvas.width, height: canvas.height, native: false };
    return null;
  }

  /** Dessine l'état courant ; retourne le nombre de formes tracées (public pour les tests). */
  draw(): number {
    const canvas = this.canvas;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return 0;
    const bg = this.backgroundImage();
    const w = bg ? bg.width : Math.max(1, Math.round(this.width) || 640);
    const h = bg ? bg.height : Math.max(1, Math.round(this.height) || 480);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    ctx.clearRect(0, 0, w, h);
    if (this.fill) {
      ctx.fillStyle = this.fill;
      ctx.fillRect(0, 0, w, h);
    }
    if (bg) {
      // `auto` : la vidéo native n'est pas retournée, une source déjà dessinée (masque, canvas) l'est.
      const flip = this.mirror === "true" || (this.mirror === "auto" && bg.native);
      ctx.save();
      if (flip) {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(bg.image, 0, 0, w, h);
      ctx.restore();
    }

    const shapes = buildShapes(this.data, this.kind, {
      points: this.points !== "false",
      bones: this.bones !== "false",
    });
    const colorOf = (s: Shape) => (s.role === "right" || (s.role && /^[pfo][1-9]/.test(s.role)) ? this.color2 : this.color);
    ctx.lineWidth = Math.max(0.5, this.lineWidth);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const s of shapes) {
      const c = colorOf(s);
      if (s.type === "rect") {
        ctx.strokeStyle = c;
        ctx.strokeRect(s.x * w, s.y * h, s.w * w, s.h * h);
        if (s.label) {
          ctx.fillStyle = c;
          ctx.font = `${Math.max(10, Math.round(h / 32))}px system-ui, sans-serif`;
          ctx.fillText(s.label, s.x * w + 4, Math.max(12, s.y * h - 4));
        }
      } else if (s.type === "line") {
        if (s.pts.length < 2) continue;
        ctx.strokeStyle = c;
        ctx.beginPath();
        ctx.moveTo(s.pts[0].x * w, s.pts[0].y * h);
        for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i].x * w, s.pts[i].y * h);
        if (s.closed) ctx.closePath();
        ctx.stroke();
      } else {
        ctx.fillStyle = c;
        const r = Math.max(0.5, s.small ? this.pointRadius / 3 : this.pointRadius);
        for (const p of s.pts) {
          ctx.beginPath();
          ctx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    return shapes.length;
  }

  render() {
    return html`<canvas width=${this.width} height=${this.height} part="canvas"></canvas>`;
  }
}

export default SonicLandmarksOverlay;
