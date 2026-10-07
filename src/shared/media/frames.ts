/**
 * Source de frames pour un <video> possédé par un composant (caméra, lecteur) :
 * - `frameSeq` incrémenté à chaque image présentée (requestVideoFrameCallback,
 *   repli requestAnimationFrame) ;
 * - `getFrameCanvas()` copie paresseusement l'image courante (seulement quand un
 *   consommateur la demande, et une seule fois par image) ; miroir optionnel ;
 * - `getFrameSource()` renvoie le <video> lui-même (sans copie, pour les
 *   consommateurs qui le savent).
 * Compatible avec `sonic-shader channel0="#id"` de Concorde (contrat SonicFrameSource).
 */
import type { SonicMediaRef } from "../mediaRef";

type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

export class VideoFrames {
  seq = 0;
  mirror = false;
  /** Largeur max de la copie (0 = taille native). */
  maxWidth = 0;
  readonly consumers = new Set<object>();
  private canvas: HTMLCanvasElement | null = null;
  private drawnSeq = -1;
  private handle = 0;
  private raf = 0;
  private lastTime = -1;
  private running = false;

  constructor(readonly video: HTMLVideoElement) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    const v = this.video as RVFCVideo;
    if (this.handle && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this.handle);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.handle = 0;
    this.raf = 0;
  }

  private schedule(): void {
    if (!this.running) return;
    const v = this.video as RVFCVideo;
    if (typeof v.requestVideoFrameCallback === "function") {
      this.handle = v.requestVideoFrameCallback(() => {
        this.seq++;
        this.schedule();
      });
      return;
    }
    this.raf = requestAnimationFrame(() => {
      if (v.readyState >= 2 && (v.currentTime !== this.lastTime || v.srcObject)) {
        this.lastTime = v.currentTime;
        this.seq++;
      }
      this.schedule();
    });
  }

  get ready(): boolean {
    return this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  getFrameCanvas(): HTMLCanvasElement | null {
    if (!this.ready) return null;
    if (this.canvas && this.drawnSeq === this.seq) return this.canvas;
    const v = this.video;
    const scale = this.maxWidth > 0 && v.videoWidth > this.maxWidth ? this.maxWidth / v.videoWidth : 1;
    const w = Math.max(1, Math.round(v.videoWidth * scale));
    const h = Math.max(1, Math.round(v.videoHeight * scale));
    const c = (this.canvas ??= document.createElement("canvas"));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.save();
    if (this.mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(v, 0, 0, w, h);
    ctx.restore();
    this.drawnSeq = this.seq;
    return c;
  }

  getFrameSource(): HTMLVideoElement | null {
    return this.ready ? this.video : null;
  }

  /** Photo de l'image courante → SonicMediaRef (blob + url). */
  async snapshot(type: "jpeg" | "png" | "webp" = "jpeg", quality = 0.9): Promise<SonicMediaRef | null> {
    if (!this.ready) return null;
    const v = this.video;
    const c = document.createElement("canvas");
    const scale = this.maxWidth > 0 && v.videoWidth > this.maxWidth ? this.maxWidth / v.videoWidth : 1;
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    if (this.mirror) {
      ctx.translate(c.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const mime = `image/${type}`;
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, mime, quality));
    if (!blob) return null;
    return { blob, url: URL.createObjectURL(blob), mime, width: c.width, height: c.height };
  }
}
