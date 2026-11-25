/**
 * Lecture régulière d'une source d'images (`#id` : sonic-camera, sonic-video, sonic-shader, sonic-still…) réduite à
 * une petite grille de pixels RGBA, pour les analyses sur processeur (mouvement, couleur). Retrouve la source si
 * elle apparaît après coup, n'analyse qu'une image nouvelle (`frameSeq`) et au plus toutes les `interval` ms.
 */
import { isFrameSource } from "../mediaRef";

export interface Pixels {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export type PixelReader = (el: Element, cols: number) => Pixels | null;

export class FrameSampler {
  source = "";
  interval = 50;
  cols = 64;
  /** Remplaçable (tests, sources spéciales). */
  reader: PixelReader = (el, cols) => this.readCanvas(el, cols);
  private raf = 0;
  private lastSeq = -1;
  private lastT = -Infinity;
  private canvas: HTMLCanvasElement | null = null;

  constructor(
    private host: Element,
    private onFrame: (px: Pixels, t: number) => void,
    private onMissing: () => void = () => {},
  ) {}

  start(): void {
    if (this.raf) return;
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      this.tick(t);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastSeq = -1;
  }

  resolve(): Element | null {
    if (!this.source.startsWith("#")) return null;
    const id = this.source.slice(1);
    const root = this.host.getRootNode() as Document | ShadowRoot;
    return (typeof (root as Document).getElementById === "function" ? (root as Document).getElementById(id) : null) ?? document.getElementById(id);
  }

  /** Une étape (appelée à chaque image d'affichage, ou à la main dans les tests). */
  tick(t: number): void {
    const el = this.resolve();
    if (!el || !isFrameSource(el)) {
      this.onMissing();
      return;
    }
    if (el.frameSeq === this.lastSeq || t - this.lastT < this.interval) return;
    const px = this.reader(el, this.cols);
    if (!px) return;
    this.lastSeq = el.frameSeq;
    this.lastT = t;
    this.onFrame(px, t);
  }

  private readCanvas(el: Element, cols: number): Pixels | null {
    if (!isFrameSource(el)) return null;
    const timed = el as unknown as { getFrameSource?: () => CanvasImageSource | null };
    const src = (typeof timed.getFrameSource === "function" ? timed.getFrameSource() : null) ?? el.getFrameCanvas();
    if (!src) return null;
    const sw = (src as HTMLVideoElement).videoWidth || (src as HTMLCanvasElement).width || 0;
    const sh = (src as HTMLVideoElement).videoHeight || (src as HTMLCanvasElement).height || 0;
    if (!sw || !sh) return null;
    const w = Math.max(8, Math.min(320, Math.round(cols)));
    const h = Math.max(1, Math.min(240, Math.round((w * sh) / sw)));
    const c = (this.canvas ??= document.createElement("canvas"));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    try {
      ctx.drawImage(src, 0, 0, w, h);
      return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
    } catch {
      return null; // image d'une autre origine
    }
  }
}
