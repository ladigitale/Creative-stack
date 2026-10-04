import type { WebGpuFrameState } from "./gpu-runtime";

const CHANNEL_COUNT = 4;
const MIX_EPS = 0.001;
const TINT_ALPHA = 0.45;
const TINT_RGB = "rgb(38, 89, 217)";

/**
 * Dernier recours : Canvas2D (webview / contexte GL mort).
 * Affiche channel0 + mix param0 — pas de WGSL.
 */
export class Canvas2dFallbackRuntime {
  readonly backend = "canvas2d" as const;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private images: (HTMLImageElement | null)[] = [null, null, null, null];
  private channelUrls: [string, string, string, string] = ["", "", "", ""];
  private channelSizes: ({ width: number; height: number } | null)[] = [
    null,
    null,
    null,
    null,
  ];
  /** Un token par canal (évite d’annuler Promise.all multi-canaux). */
  private channelLoadTokens = [0, 0, 0, 0];
  private disposed = false;

  private constructor(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
  ) {
    this.canvas = canvas;
    this.ctx = ctx;
  }

  static create(canvas: HTMLCanvasElement): Canvas2dFallbackRuntime {
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("Canvas2D indisponible");
    return new Canvas2dFallbackRuntime(canvas, ctx);
  }

  async setShader(_userBody: string): Promise<void> {
    this.assertAlive();
  }

  async setChannel(index: 0 | 1 | 2 | 3, url: string): Promise<void> {
    this.assertAlive();
    const trimmed = url.trim();
    if (this.channelUrls[index] === trimmed && this.images[index]) return;
    this.channelUrls[index] = trimmed;
    const token = ++this.channelLoadTokens[index];
    if (!trimmed) {
      this.images[index] = null;
      this.channelSizes[index] = null;
      return;
    }
    const img = await loadImage(trimmed);
    if (token !== this.channelLoadTokens[index] || this.disposed) return;
    this.images[index] = img;
    this.channelSizes[index] = { width: img.naturalWidth, height: img.naturalHeight };
  }

  getTextureSize(url: string): { width: number; height: number } | null {
    const i = this.channelUrls.indexOf(url.trim());
    if (i < 0) return null;
    return this.channelSizes[i];
  }

  resize(width: number, height: number) {
    this.assertAlive();
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  draw(state: WebGpuFrameState) {
    this.assertAlive();
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const img = this.images[0];
    const mix = Math.min(1, Math.max(0, state.params[0] ?? 0));
    if (img) {
      ctx.drawImage(img, 0, 0, w, h);
      if (mix > MIX_EPS) {
        ctx.save();
        ctx.globalAlpha = mix * TINT_ALPHA;
        ctx.fillStyle = TINT_RGB;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
    } else {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, `rgb(38,${Math.round(40 + mix * 80)},80)`);
      g.addColorStop(1, `rgb(90,${Math.round(60 + mix * 40)},120)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  }

  dispose(_destroyDevice = false) {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = 0; i < CHANNEL_COUNT; i++) this.channelLoadTokens[i]++;
    this.images = [null, null, null, null];
  }

  private assertAlive() {
    if (this.disposed) throw new Error("Canvas2D fallback disposed");
  }
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`Failed to load texture: ${url}`));
    img.src = url;
  });
  return img;
}
