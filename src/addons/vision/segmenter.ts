import { customElement, property } from "lit/decorators.js";
import { assignPath, evalMap, type CompiledMap } from "../../shared/ml/map-expr";
import { maskStats, maskToRgba, type MaskMode } from "../../shared/ml/mask";
import { Smoother } from "../../shared/ml/one-euro";
import { createMediaPipeMpEngine, getVisionConfig, type MpResult } from "./mp-engine";
import { SonicMlTracker, type TrackerEngine } from "./tracker-base";

const tagName = "sonic-segmenter";

type Masks = NonNullable<MpResult["masks"]>;

export type SegmentOutput = {
  present: 0 | 1;
  /** Part de l'image couverte par la personne (0..1). */
  coverage: number;
  /** Centre de gravité et boîte englobante, 0..1, repère écran. */
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  [derived: string]: unknown;
};

const NEUTRAL = { coverage: 0, cx: 0.5, cy: 0.5, x0: 0, y0: 0, x1: 0, y1: 0 };
const STAT_KEYS = ["coverage", "cx", "cy", "x0", "y0", "x1", "y1"] as const;

/**
 * Segmente la personne (modèle « selfie » par défaut) dans un flux d'images (`for="cam"`). Le masque est
 * exposé comme **source d'images** : `<sonic-shader channel1="#seg">` le lit comme une caméra (niveau de gris ou
 * alpha, selon `mode`). Les statistiques (couverture, centre, boîte) sont publiées en DataProvider.
 * Inférence locale ; mêmes règles de modèle, de confiance et de consentement que les autres trackers.
 */
@customElement(tagName)
export class SonicSegmenter extends SonicMlTracker<Masks, SegmentOutput> {
  /** `gray` : r = g = b = masque, alpha 255 (canal de luminosité pour un shader) ; `alpha` : blanc, alpha = masque. */
  @property({ type: String })
  mode: MaskMode = "gray";

  /** `"true"` : inverse le masque (fond au lieu de la personne). */
  @property({ type: String })
  invert: "true" | "false" = "false";

  /** Seuil (0..1) des statistiques : au-dessus, un pixel compte comme « personne ». */
  @property({ type: Number })
  threshold = 0.5;

  /** Masque à utiliser quand le modèle en fournit plusieurs : `auto` (le dernier si plusieurs, sinon le seul) ou un indice. */
  @property({ type: String, attribute: "mask-index" })
  maskIndex = "auto";

  private canvas: HTMLCanvasElement | null = null;
  private seq = 0;
  private smoother = new Smoother(0.5);
  private hold = 150;
  private lastSeen = -Infinity;
  private last: SegmentOutput = { present: 0, ...NEUTRAL };
  private compiled: CompiledMap | null = null;

  /* --- contrat SonicFrameSource : lu par sonic-shader (channelN="#id") --- */

  getFrameCanvas(): HTMLCanvasElement | null {
    return this.seq > 0 ? this.canvas : null;
  }

  /** Incrémenté à chaque masque dessiné. */
  get frameSeq(): number {
    return this.seq;
  }

  protected defaultModel(): string {
    return "selfie-segmenter";
  }

  protected extraReloadKeys(): string[] {
    return [];
  }

  protected hasCustomEngine(): boolean {
    return !!getVisionConfig().createMpEngine;
  }

  protected async createEngine(model: Uint8Array): Promise<TrackerEngine<Masks>> {
    const factory = getVisionConfig().createMpEngine ?? createMediaPipeMpEngine;
    const mp = await factory({
      task: "segment",
      model,
      options: { outputConfidenceMasks: true, outputCategoryMask: false },
      delegate: this.delegate,
      thread: this.thread,
    });
    return {
      backend: mp.backend,
      thread: mp.thread,
      close: () => mp.close(),
      detect: async (frame, tsMs) => (await mp.detect(frame, tsMs)).masks ?? [],
    };
  }

  private pickMask(masks: Masks): Masks[number] | null {
    if (masks.length === 0) return null;
    const i = Number(this.maskIndex);
    if (this.maskIndex !== "auto" && Number.isInteger(i) && masks[i]) return masks[i];
    return masks.length > 1 ? masks[masks.length - 1] : masks[0];
  }

  protected toOutput(masks: Masks, now: number, mirror: boolean): SegmentOutput {
    const mask = this.pickMask(masks);
    if (mask && mask.width > 0 && mask.height > 0) {
      const stats = maskStats(mask.data, mask.width, mask.height, Math.round(this.threshold * 255), mirror);
      const invert = this.invert === "true";
      this.draw(mask, mirror, invert);
      if (stats.coverage > 0.005) {
        const next = { present: 1 as const, ...NEUTRAL };
        for (const k of STAT_KEYS) next[k] = this.smoother.apply(k, stats[k], now);
        this.last = next;
        this.lastSeen = now;
      } else if (now - this.lastSeen > this.hold) {
        this.last = { present: 0, ...NEUTRAL };
        this.smoother.reset();
      }
    }
    const output: SegmentOutput = { ...this.last };
    if (this.compiled && this.compiled.ok) {
      for (const [key, value] of Object.entries(evalMap(this.compiled, output))) assignPath(output, key, value);
    }
    return output;
  }

  private draw(mask: Masks[number], mirror: boolean, invert: boolean): void {
    if (!this.canvas) this.canvas = document.createElement("canvas");
    const c = this.canvas;
    if (c.width !== mask.width) c.width = mask.width;
    if (c.height !== mask.height) c.height = mask.height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const rgba = maskToRgba(mask.data, mask.width, mask.height, this.mode === "alpha" ? "alpha" : "gray", mirror, invert);
    const image = ctx.createImageData(mask.width, mask.height);
    image.data.set(rgba);
    ctx.putImageData(image, 0, 0);
    this.seq++;
  }

  protected configureCore(opts: { smooth: number; holdMs: number; map: CompiledMap | null }): void {
    if (this.smoother.smooth !== opts.smooth) this.smoother = new Smoother(opts.smooth);
    this.hold = opts.holdMs;
    this.compiled = opts.map;
  }

  protected resetCore(): void {
    this.smoother.reset();
    this.last = { present: 0, ...NEUTRAL };
    this.lastSeen = -Infinity;
    this.seq = 0;
  }
}

export default SonicSegmenter;
