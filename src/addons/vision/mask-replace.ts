import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { safeMediaUrl } from "../../shared/media/urls";
import type { SonicFrameSource } from "../../shared/mediaRef";
import {
  blurDivisor,
  boxesOf,
  coverRect,
  effectOf,
  featherDivisor,
  alphaBounds,
  grayToAlpha,
  mixBounds,
  padBounds,
  pixelDivisor,
  safeColor,
  selectBoxes,
  shapesOf,
  type Bounds,
  type Box,
  type MaskTarget,
  type ReplaceEffect,
} from "../../shared/ml/composite";

const tagName = "sonic-mask-replace";

const r4 = (n: number) => Math.round(n * 10000) / 10000;

export type MaskReplaceState = {
  ready: boolean;
  effect: ReplaceEffect;
  target: MaskTarget;
  /** Une source de masque (segmenteur) fournit une image. */
  mask: boolean;
  /** Objets détectés retenus pour le masque. */
  regions: number;
  /** Boîte (0..1, repère écran) de la zone masquée, lissée ; `null` sans zone. `cx`, `cy` : son centre. */
  box: { x: number; y: number; w: number; h: number; cx: number; cy: number } | null;
  error?: string;
};

type FrameEl = Element & {
  getFrameSource?: () => HTMLVideoElement | null;
  getFrameCanvas?: () => HTMLCanvasElement | null;
  mode?: string;
};
type Frame = { image: CanvasImageSource; width: number; height: number; flip: boolean };
type Layer = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };

/**
 * Remplace une zone d'une image par un effet, avec un masque : le fond derrière la personne (`mask="#seg"`, un
 * `sonic-segmenter`) ou les objets détectés (`detections` = sortie d'un `sonic-object-detector`, étiquettes
 * `labels`). `target="background"` garde la zone masquée et remplace le reste (fond virtuel) ; `target="subject"`
 * remplace la zone masquée. Effets : `blur`, `pixelate`, `color`, `image` (URL), `source` (une autre source
 * d'images : vidéo, shader, canvas…) ou `cutout` (la zone remplacée devient transparente). Les bords sont adoucis
 * (`feather`) et le masque lissé dans le temps (`smooth`). Le composant est lui-même une source d'images
 * (`getFrameCanvas`). Tout est calculé sur l'appareil, en canvas 2D ; aucun HTML n'est injecté.
 */
@customElement(tagName)
export class SonicMaskReplace extends LitElement implements SonicFrameSource {
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

  /** Id de la source d'images à modifier (`sonic-camera`, `sonic-frame-sync`…). */
  @property({ type: String })
  source = "";

  /** Id d'un `sonic-segmenter` dont le masque (personne) définit la zone. */
  @property({ type: String })
  mask = "";

  /** DataProvider de la sortie d'un `sonic-object-detector` : les boîtes des objets retenus définissent aussi la zone. */
  @property({ type: String })
  detections = "";

  /** Étiquettes d'objets retenues (virgules) ; vide : toutes. */
  @property({ type: String })
  labels = "";

  @property({ type: Number, attribute: "min-score" })
  minScore = 0.4;

  @property({ type: Number, attribute: "max-objects" })
  maxObjects = 5;

  /** Identité (`id` d'un `sonic-object-detector track="true"`) : seul cet objet est retenu ; 0 : tous. */
  @property({ type: Number, attribute: "object-id" })
  objectId = 0;

  /** Forme du masque d'un objet : `ellipse` ou `rect`. */
  @property({ type: String })
  shape: "ellipse" | "rect" = "ellipse";

  /** Marge autour de la boîte d'un objet (part de sa taille). */
  @property({ type: Number })
  pad = 0.05;

  /** `background` : garde la zone masquée, remplace le reste ; `subject` : remplace la zone masquée. */
  @property({ type: String })
  target: MaskTarget = "background";

  @property({ type: String })
  effect: ReplaceEffect = "blur";

  /** Force du flou ou de la pixellisation, 0..1. */
  @property({ type: Number })
  amount = 0.5;

  /** Couleur CSS de `effect="color"`. */
  @property({ type: String })
  color = "#101820";

  /** URL de l'image de `effect="image"` (https, blob:, data:image, relative). */
  @property({ type: String })
  image = "";

  /** Id de la source d'images de `effect="source"`. */
  @property({ type: String, attribute: "with-source" })
  withSource = "";

  /** Adoucissement des bords du masque, 0 (net) à 1. */
  @property({ type: Number })
  feather = 0.3;

  /**
   * `"true"` (avec `target="background"`) : l'image produite est recadrée sur la zone masquée (la personne), avec
   * un fond transparent si `effect="cutout"` : un « sprite » à placer ailleurs (`sonic-compose`).
   */
  @property({ type: String })
  crop: "true" | "false" = "false";

  /** Lissage du masque dans le temps, 0 (aucun) à 0,9. */
  @property({ type: Number })
  smooth = 0.4;

  /** Miroir : `auto` (retourne une vidéo native, pas un canvas déjà dessiné), `true`, `false`. */
  @property({ type: String })
  mirror: "auto" | "true" | "false" = "auto";

  /** Images par seconde au plus. */
  @property({ type: Number })
  fps = 30;

  /** Taille du canvas sans source. */
  @property({ type: Number })
  width = 640;

  @property({ type: Number })
  height = 480;

  /** DataProvider de l'état publié (`MaskReplaceState`). */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  @query("canvas")
  private canvas!: HTMLCanvasElement;

  private boxes: Box[] = [];
  private unlisten: (() => void) | null = null;
  private raf = 0;
  private seq = 0;
  private lastDraw = -Infinity;
  private lastState = "";
  private imageEl: HTMLImageElement | null = null;
  private imageError = "";
  private layers: Record<string, Layer | null> = {};
  private acc: Layer | null = null;
  private box: Bounds | null = null;

  get frameSeq(): number {
    return this.seq;
  }

  getFrameCanvas(): HTMLCanvasElement | null {
    return this.canvas && this.canvas.width > 0 && this.seq > 0 ? this.canvas : null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    this.loadImage();
  }

  disconnectedCallback(): void {
    this.unlisten?.();
    this.unlisten = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("detections")) this.listen();
    if (changed.has("image")) this.loadImage();
    this.schedule();
  }

  render() {
    return html`<canvas></canvas>`;
  }

  private listen(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.boxes = [];
    const dpId = this.detections.trim();
    if (!dpId) return;
    this.unlisten = listenDp(dpId, (v) => {
      this.boxes = boxesOf(v);
    });
  }

  private loadImage(): void {
    this.imageEl = null;
    this.imageError = "";
    const url = this.image.trim();
    if (!url) return;
    if (!safeMediaUrl(url, "image")) {
      this.imageError = "URL d'image refusée";
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (this.image.trim() === url) this.imageEl = img;
    };
    img.onerror = () => {
      this.imageError = "image illisible";
    };
    img.src = url;
  }

  private schedule(): void {
    if (this.raf || !this.isConnected || !this.source.trim()) return;
    this.raf = requestAnimationFrame((t) => {
      this.raf = 0;
      const gap = 1000 / Math.max(1, Number(this.fps) || 30);
      if (t - this.lastDraw >= gap - 1) {
        this.lastDraw = t;
        this.draw();
      }
      this.schedule();
    });
  }

  private elOf(idRaw: string): FrameEl | null {
    const id = idRaw.trim().replace(/^#/, "");
    if (!id) return null;
    const root = this.getRootNode() as Document | ShadowRoot;
    return (root.getElementById?.(id) ?? document.getElementById(id)) as FrameEl | null;
  }

  private frameOf(idRaw: string): Frame | null {
    const el = this.elOf(idRaw);
    const video = el?.getFrameSource?.();
    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      return { image: video, width: video.videoWidth, height: video.videoHeight, flip: this.mirror === "true" || this.mirror === "auto" };
    }
    const canvas = el?.getFrameCanvas?.();
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      return { image: canvas, width: canvas.width, height: canvas.height, flip: this.mirror === "true" };
    }
    return null;
  }

  private layer(name: string, w: number, h: number): Layer | null {
    let l = this.layers[name];
    if (!l) {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      l = this.layers[name] = { canvas, ctx };
    }
    if (l.canvas.width !== w) l.canvas.width = w;
    if (l.canvas.height !== h) l.canvas.height = h;
    return l;
  }

  private drawFlipped(ctx: CanvasRenderingContext2D, f: Frame, w: number, h: number): void {
    if (f.flip) {
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(f.image, 0, 0, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(f.image, 0, 0, w, h);
    }
  }

  /** Dessine `f` pour remplir w × h (recadrage centré). */
  private drawCover(ctx: CanvasRenderingContext2D, f: Frame, w: number, h: number): void {
    const r = coverRect(f.width, f.height, w, h);
    if (f.flip) {
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(f.image, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(f.image, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
    }
  }

  /** Masque (alpha) de la zone, ou null quand la source de masque n'a encore rien produit. */
  private buildMask(w: number, h: number): { canvas: HTMLCanvasElement; regions: number; fromSource: boolean } | null {
    const region = this.layer("region", w, h);
    if (!region) return null;
    const rc = region.ctx;
    rc.globalCompositeOperation = "source-over";
    rc.clearRect(0, 0, w, h);
    let fromSource = false;
    const maskId = this.mask.trim();
    if (maskId) {
      const el = this.elOf(maskId);
      const mc = el?.getFrameCanvas?.();
      if (mc && mc.width > 0 && mc.height > 0) {
        fromSource = true;
        let drawable: HTMLCanvasElement = mc;
        if (el?.mode !== "alpha") {
          // masque « gris » : converti en alpha à la résolution du modèle (petite)
          const tmp = this.layer("gray", mc.width, mc.height);
          const tctx = tmp?.ctx;
          if (tmp && tctx) {
            tctx.globalCompositeOperation = "source-over";
            tctx.clearRect(0, 0, mc.width, mc.height);
            tctx.drawImage(mc, 0, 0);
            const img = tctx.getImageData(0, 0, mc.width, mc.height);
            grayToAlpha(img.data);
            tctx.putImageData(img, 0, 0);
            drawable = tmp.canvas;
          }
        }
        rc.drawImage(drawable, 0, 0, w, h);
      } else if (!this.detections.trim()) {
        return null;
      }
    }
    const kept = this.detections.trim() ? selectBoxes(this.boxes, this.labels, Number(this.minScore) || 0, Number(this.maxObjects) || 0, Number(this.objectId) || 0) : [];
    if (kept.length) {
      rc.fillStyle = "#fff";
      for (const s of shapesOf(kept, w, h, this.shape === "rect" ? "rect" : "ellipse", Number(this.pad) || 0)) {
        rc.beginPath();
        if (s.kind === "ellipse") rc.ellipse(s.x + s.w / 2, s.y + s.h / 2, s.w / 2, s.h / 2, 0, 0, Math.PI * 2);
        else rc.rect(s.x, s.y, s.w, s.h);
        rc.fill();
      }
    }
    if (!maskId && !this.detections.trim()) return null;

    let current = region.canvas;
    const d = featherDivisor(Number(this.feather) || 0);
    if (d > 1) {
      const small = this.layer("feather", Math.max(1, Math.round(w / d)), Math.max(1, Math.round(h / d)));
      const soft = this.layer("soft", w, h);
      if (small && soft) {
        small.ctx.imageSmoothingEnabled = true;
        small.ctx.clearRect(0, 0, small.canvas.width, small.canvas.height);
        small.ctx.drawImage(current, 0, 0, small.canvas.width, small.canvas.height);
        soft.ctx.imageSmoothingEnabled = true;
        soft.ctx.globalCompositeOperation = "source-over";
        soft.ctx.clearRect(0, 0, w, h);
        soft.ctx.drawImage(small.canvas, 0, 0, w, h);
        current = soft.canvas;
      }
    }

    // Lissage dans le temps : acc = acc * s + masque * (1 - s)
    const s = Math.max(0, Math.min(0.9, Number(this.smooth) || 0));
    if (s > 0) {
      const next = this.layer("acc2", w, h);
      const prev = this.acc && this.acc.canvas.width === w && this.acc.canvas.height === h ? this.acc : null;
      if (next) {
        next.ctx.globalCompositeOperation = "source-over";
        next.ctx.globalAlpha = 1;
        next.ctx.clearRect(0, 0, w, h);
        if (prev) {
          next.ctx.globalAlpha = s;
          next.ctx.drawImage(prev.canvas, 0, 0);
        }
        next.ctx.globalCompositeOperation = "lighter";
        next.ctx.globalAlpha = prev ? 1 - s : 1;
        next.ctx.drawImage(current, 0, 0);
        next.ctx.globalAlpha = 1;
        next.ctx.globalCompositeOperation = "source-over";
        // échange des deux canvas d'accumulation
        const old = this.layers["acc"] ?? null;
        this.layers["acc"] = next;
        this.layers["acc2"] = old;
        this.acc = next;
        current = next.canvas;
      }
    } else {
      this.acc = null;
    }
    return { canvas: current, regions: kept.length, fromSource };
  }

  private drawEffect(ctx: CanvasRenderingContext2D, src: Frame, w: number, h: number): void {
    const effect = effectOf(this.effect);
    if (effect === "cutout") return;
    if (effect === "color") {
      ctx.fillStyle = safeColor(this.color) || "#101820";
      ctx.fillRect(0, 0, w, h);
      return;
    }
    if (effect === "image" && this.imageEl) {
      this.drawCover(ctx, { image: this.imageEl, width: this.imageEl.naturalWidth, height: this.imageEl.naturalHeight, flip: false }, w, h);
      return;
    }
    if (effect === "source") {
      const other = this.frameOf(this.withSource);
      if (other) {
        this.drawCover(ctx, other, w, h);
        return;
      }
    }
    // flou, pixellisation (et repli des effets image / source sans ressource) : copie réduite puis agrandie
    const pixelate = effect === "pixelate";
    const d = pixelate ? pixelDivisor(Number(this.amount) || 0) : blurDivisor(Number(this.amount) || 0);
    const small = this.layer("small", Math.max(1, Math.round(w / d)), Math.max(1, Math.round(h / d)));
    if (!small) return;
    small.ctx.imageSmoothingEnabled = true;
    small.ctx.clearRect(0, 0, small.canvas.width, small.canvas.height);
    this.drawFlipped(small.ctx, src, small.canvas.width, small.canvas.height);
    ctx.imageSmoothingEnabled = !pixelate;
    ctx.drawImage(small.canvas, 0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
  }

  /** Dessine une image ; retourne vrai si quelque chose a été dessiné (public pour les tests). */
  draw(): boolean {
    const canvas = this.canvas;
    if (!canvas) return false;
    const src = this.frameOf(this.source);
    const effect = effectOf(this.effect);
    const target: MaskTarget = this.target === "subject" ? "subject" : "background";
    if (!src) {
      this.publish({ ready: false, effect, target, mask: false, regions: 0, box: null });
      return false;
    }
    const w = src.width;
    const h = src.height;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      this.publish({ ready: false, effect, target, mask: false, regions: 0, box: null, error: "Canvas 2D indisponible" });
      return false;
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);

    const mask = this.buildMask(w, h);
    if (!mask) {
      // Pas encore de masque : l'image passe telle quelle (pas de clignotement).
      this.drawFlipped(ctx, src, w, h);
      this.seq++;
      this.publish({ ready: true, effect, target, mask: false, regions: 0, box: null, ...(this.imageError ? { error: this.imageError } : {}) });
      return true;
    }

    const keep = this.layer("keep", w, h);
    if (!keep) {
      this.drawFlipped(ctx, src, w, h);
      this.seq++;
      return true;
    }
    keep.ctx.globalCompositeOperation = "source-over";
    keep.ctx.clearRect(0, 0, w, h);
    this.drawFlipped(keep.ctx, src, w, h);
    keep.ctx.globalCompositeOperation = target === "background" ? "destination-in" : "destination-out";
    keep.ctx.drawImage(mask.canvas, 0, 0, w, h);
    keep.ctx.globalCompositeOperation = "source-over";

    // Boîte de la zone masquée (copie réduite du masque : peu coûteux)
    const bh = Math.max(1, Math.round((64 * h) / w));
    const probe = this.layer("bounds", 64, bh);
    if (probe) {
      probe.ctx.globalCompositeOperation = "source-over";
      probe.ctx.clearRect(0, 0, 64, bh);
      probe.ctx.drawImage(mask.canvas, 0, 0, 64, bh);
      const raw = alphaBounds(probe.ctx.getImageData(0, 0, 64, bh).data, 64, bh, 48);
      if (raw) this.box = mixBounds(this.box, padBounds(raw, 0.02), Math.max(0, Math.min(0.9, Number(this.smooth) || 0)));
      else this.box = null;
    }

    const crop = this.crop === "true" && target === "background";
    const full = crop ? this.layer("full", w, h) : null;
    const dctx = full ? full.ctx : ctx;
    if (full) {
      full.ctx.globalCompositeOperation = "source-over";
      full.ctx.clearRect(0, 0, w, h);
    }
    this.drawEffect(dctx, src, w, h);
    dctx.drawImage(keep.canvas, 0, 0);
    if (full) {
      const b = this.box;
      const sx = b ? Math.round(b.x0 * w) : 0;
      const sy = b ? Math.round(b.y0 * h) : 0;
      const sw = b ? Math.max(1, Math.round((b.x1 - b.x0) * w)) : 1;
      const sh = b ? Math.max(1, Math.round((b.y1 - b.y0) * h)) : 1;
      if (canvas.width !== sw) canvas.width = sw;
      if (canvas.height !== sh) canvas.height = sh;
      const out = canvas.getContext("2d");
      if (out) {
        out.clearRect(0, 0, sw, sh);
        if (b) out.drawImage(full.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
      }
    }
    this.seq++;
    const bx = this.box;
    this.publish({
      ready: true,
      effect,
      target,
      mask: mask.fromSource,
      regions: mask.regions,
      box: bx ? { x: r4(bx.x0), y: r4(bx.y0), w: r4(bx.x1 - bx.x0), h: r4(bx.y1 - bx.y0), cx: r4((bx.x0 + bx.x1) / 2), cy: r4((bx.y0 + bx.y1) / 2) } : null,
      ...(this.imageError ? { error: this.imageError } : {}),
    });
    return true;
  }

  private publish(state: MaskReplaceState): void {
    const dpId = this.outDataProvider.trim();
    if (!dpId) return;
    const key = JSON.stringify(state);
    if (key === this.lastState) return;
    this.lastState = key;
    set(dpId, state);
  }
}

export default SonicMaskReplace;
