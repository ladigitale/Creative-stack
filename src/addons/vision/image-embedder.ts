import { customElement, property } from "lit/decorators.js";
import { listenDp } from "../../shared/audio/dp";
import { cropBox, boxesOf, selectBoxes, type Box } from "../../shared/ml/composite";
import type { CompiledMap } from "../../shared/ml/map-expr";
import { EmbedderCore, embeddingFromMediaPipe, vectorOf, type EmbedOutput } from "./embed-state";
import { createMediaPipeMpEngine, getVisionConfig } from "./mp-engine";
import { SonicMlTracker, type TrackerEngine } from "./tracker-base";

const tagName = "sonic-image-embedder";

/** Taille minimale (pixels de l'image brute) d'une zone recadrée : en dessous, rien n'est analysé. */
const MIN_CROP_PX = 8;

/** Une propriété texte devient `null` quand son attribut est retiré. */
const text = (v: string | null | undefined): string => (v ?? "").trim();

/** Zone fixe `x,y,w,h` (0..1 de l'image, repère écran) ; `null` si absente ou invalide. */
export function parseRegion(value: string): { x: number; y: number; w: number; h: number } | null {
  const p = value.trim().split(/[\s,]+/).map(Number);
  if (p.length !== 4 || !p.every(Number.isFinite)) return null;
  const [x, y, w, h] = p;
  if (w <= 0 || h <= 0) return null;
  const x0 = Math.max(0, Math.min(1, x));
  const y0 = Math.max(0, Math.min(1, y));
  const x1 = Math.max(0, Math.min(1, x + w));
  const y1 = Math.max(0, Math.min(1, y + h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * Empreinte numérique d'une image (MobileNet V3 par défaut, vecteur de ~1 024 nombres) : deux images qui se
 * ressemblent ont des vecteurs proches. Sert à reconnaître « ce qui est dans l'image » sans l'étiqueter à
 * l'avance : `similarity` (cosinus avec le DataProvider `reference`), ou apprentissage de classes par
 * `sonic-example-classifier features="embed"`. Peut analyser seulement une zone : la boîte d'un objet détecté
 * (`crop` = sortie d'un `sonic-object-detector`) ou une zone fixe (`region`). Inférence locale ; mêmes règles de
 * modèle, de confiance et de consentement que les autres trackers. Cadence par défaut : 5 images / s.
 */
@customElement(tagName)
export class SonicImageEmbedder extends SonicMlTracker<number[] | null, EmbedOutput> {
  /** DataProvider d'un vecteur de comparaison (tableau ou `{ vector }` : la sortie d'un autre embedder) → `similarity`. */
  @property({ type: String })
  reference = "";

  /** Tête du modèle dont on lit le vecteur (0 : la première). */
  @property({ type: Number })
  head = 0;

  /** DataProvider de la sortie d'un `sonic-object-detector` : seule la meilleure boîte retenue est analysée. */
  @property({ type: String })
  crop = "";

  /** Étiquettes de `crop` retenues, séparées par des virgules ; vide : toutes. */
  @property({ type: String, attribute: "crop-labels" })
  cropLabels = "";

  /** Score minimal d'une boîte de `crop`. */
  @property({ type: Number, attribute: "crop-min-score" })
  cropMinScore = 0.4;

  /** Marge autour de la boîte (part de sa taille, de chaque côté). */
  @property({ type: Number, attribute: "crop-pad" })
  cropPad = 0.1;

  /** Zone fixe analysée `x,y,w,h` (0..1 de l'image, repère écran) ; ignorée si `crop` est renseigné. */
  @property({ type: String })
  region = "";

  private core = new EmbedderCore({ smooth: 0, holdMs: 150 });
  private refVector: number[] | null = null;
  private boxes: Box[] = [];
  private unlisten: Array<() => void> = [];
  private scratch: HTMLCanvasElement | null = null;

  constructor() {
    super();
    this.fps = 5;
    this.smooth = 0.3;
    this.holdMs = 300;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
  }

  disconnectedCallback(): void {
    this.unlistenAll();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string, unknown>): void {
    super.updated(changed);
    if (changed.has("reference") || changed.has("crop")) this.listen();
    if (changed.has("reference")) this.core.configure({ reference: this.refVector });
  }

  private unlistenAll(): void {
    for (const u of this.unlisten) u();
    this.unlisten = [];
  }

  private listen(): void {
    this.unlistenAll();
    this.refVector = null;
    this.boxes = [];
    const ref = text(this.reference);
    if (ref) {
      this.unlisten.push(
        listenDp(ref, (v) => {
          this.refVector = vectorOf(v);
          this.core.configure({ reference: this.refVector });
        }),
      );
    }
    const crop = text(this.crop);
    if (crop) this.unlisten.push(listenDp(crop, (v) => (this.boxes = boxesOf(v))));
  }

  protected defaultModel(): string {
    return "image-embedder";
  }

  protected extraReloadKeys(): string[] {
    return ["head"];
  }

  protected hasCustomEngine(): boolean {
    return !!getVisionConfig().createMpEngine;
  }

  /**
   * Zone de l'image brute à analyser (0..1), ou `undefined` : image entière. `null` : une zone est demandée
   * (`crop`, `region`) mais n'existe pas pour l'instant, rien n'est analysé.
   */
  private zoneFor(mirror: boolean): { x: number; y: number; w: number; h: number } | null | undefined {
    if (text(this.crop)) {
      const kept = selectBoxes(this.boxes, text(this.cropLabels), Number(this.cropMinScore) || 0, 1);
      if (kept.length === 0) return null;
      return cropBox(kept[0], Number(this.cropPad) || 0, mirror);
    }
    const region = text(this.region);
    if (region) {
      const r = parseRegion(region);
      if (!r) return null;
      return { x: mirror ? 1 - (r.x + r.w) : r.x, y: r.y, w: r.w, h: r.h };
    }
    return undefined;
  }

  /** Copie la zone dans un canvas de travail ; `null` si elle est trop petite ou si le canvas 2D manque. */
  private cropped(frame: CanvasImageSource, zone: { x: number; y: number; w: number; h: number }): HTMLCanvasElement | null {
    const f = frame as { videoWidth?: number; videoHeight?: number; width?: number; height?: number };
    const fw = f.videoWidth || f.width || 0;
    const fh = f.videoHeight || f.height || 0;
    const sw = Math.round(zone.w * fw);
    const sh = Math.round(zone.h * fh);
    if (sw < MIN_CROP_PX || sh < MIN_CROP_PX) return null;
    if (!this.scratch) this.scratch = document.createElement("canvas");
    const c = this.scratch;
    if (c.width !== sw) c.width = sw;
    if (c.height !== sh) c.height = sh;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(frame, Math.round(zone.x * fw), Math.round(zone.y * fh), sw, sh, 0, 0, sw, sh);
    return c;
  }

  protected async createEngine(model: Uint8Array): Promise<TrackerEngine<number[] | null>> {
    const factory = getVisionConfig().createMpEngine ?? createMediaPipeMpEngine;
    const mp = await factory({
      task: "embed",
      model,
      options: { l2Normalize: false, quantize: false },
      delegate: this.delegate,
      thread: this.thread,
    });
    const head = Math.max(0, Math.round(this.head) || 0);
    return {
      backend: mp.backend,
      thread: mp.thread,
      close: () => mp.close(),
      detect: async (frame, tsMs) => {
        const native = typeof HTMLVideoElement !== "undefined" && frame instanceof HTMLVideoElement;
        const mirror = this.mirror === "true" || (this.mirror === "auto" && native);
        const zone = this.zoneFor(mirror);
        if (zone === null) return null;
        const image = zone ? this.cropped(frame, zone) : frame;
        if (!image) return null;
        return embeddingFromMediaPipe(await mp.detect(image, tsMs), head);
      },
    };
  }

  protected toOutput(raw: number[] | null, now: number): EmbedOutput {
    return this.core.update(raw, now);
  }

  protected configureCore(opts: { smooth: number; holdMs: number; map: CompiledMap | null }): void {
    this.core.configure({ smooth: opts.smooth, holdMs: opts.holdMs, map: opts.map, reference: this.refVector });
  }

  protected resetCore(): void {
    this.core.reset();
  }
}

export default SonicImageEmbedder;
