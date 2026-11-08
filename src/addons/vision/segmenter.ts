import { customElement, property } from "lit/decorators.js";
import { assignPath, evalMap, type CompiledMap } from "../../shared/ml/map-expr";
import { maskStats, maskToRgba, type MaskMode } from "../../shared/ml/mask";
import { Smoother } from "../../shared/ml/one-euro";
import { combineMasks, foreground, labelsFor, resolveClasses } from "../../shared/ml/segment-classes";
import { createMediaPipeMpEngine, getVisionConfig, type MpResult } from "./mp-engine";
import { FLAG, type ParamSpecs } from "./live-params";
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
  /** Modèle multi-classes avec `class-stats="true"` : couverture et centre de chaque classe (nom, ou indice sans nom). */
  classes?: Record<string, { coverage: number; cx: number; cy: number }>;
  /** Jetons de `classes` qui ne correspondent à aucune classe du modèle. */
  unknownClasses?: string[];
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

  /**
   * Modèle multi-classes (`selfie-multiclass` : background, hair, body-skin, face-skin, clothes, others ; `deeplab-v3` :
   * 21 catégories) : classes qui forment le masque, par noms ou indices (`hair,clothes`). Vide : tout sauf l'arrière-plan
   * pour un modèle multi-classes, sinon `mask-index`.
   */
  @property({ type: String })
  classes = "";

  /** Noms des classes d'un modèle perso (même nombre que de masques, dans l'ordre) ; vide : ceux de l'alias de modèle. */
  @property({ type: String })
  labels = "";

  /** `"true"` : publie `classes` (couverture et centre de chaque classe). */
  @property({ type: String, attribute: "class-stats" })
  classStats: "true" | "false" = "false";

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

  protected paramSpecs(): ParamSpecs {
    return {
      ...super.paramSpecs(),
      threshold: { kind: "number", min: 0, max: 1 },
      mode: { kind: "enum", values: ["gray", "alpha"] },
      invert: FLAG,
      maskIndex: { kind: "string", pattern: /^(auto|\d{1,3})$/ },
      classes: { kind: "string", max: 1000 },
      labels: { kind: "string", max: 4000 },
      classStats: FLAG,
    };
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

  /** Masque de la réunion des classes demandées ; à défaut le choix historique (`mask-index`). */
  private selectMask(masks: Masks, labels: string[]): { mask: Masks[number] | null; unknown: string[] } {
    let indices: number[] = [];
    let unknown: string[] = [];
    if (this.classes.trim()) ({ indices, unknown } = resolveClasses(this.classes, labels, masks.length));
    else if (labels.length > 2) indices = foreground(labels, masks.length);
    const combined = indices.length ? combineMasks(masks, indices) : null;
    return { mask: combined ?? this.pickMask(masks), unknown };
  }

  private classOutput(masks: Masks, labels: string[], mirror: boolean): NonNullable<SegmentOutput["classes"]> {
    const out: NonNullable<SegmentOutput["classes"]> = {};
    const t = Math.round(this.threshold * 255);
    masks.forEach((m, i) => {
      const st = maskStats(m.data, m.width, m.height, t, mirror);
      out[labels[i] ?? String(i)] = { coverage: round3(st.coverage), cx: round3(st.cx), cy: round3(st.cy) };
    });
    return out;
  }

  protected toOutput(masks: Masks, now: number, mirror: boolean): SegmentOutput {
    const labels = labelsFor(this.labels, this.model.trim() || this.defaultModel(), masks.length);
    const { mask, unknown } = this.selectMask(masks, labels);
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
    if (unknown.length) output.unknownClasses = unknown;
    if (this.classStats === "true" && masks.length > 1) output.classes = this.classOutput(masks, labels, mirror);
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

  /** Efface le masque affiché (source d'images vide, plus de personne) ; les consommateurs voient une nouvelle image. */
  protected clearMask(): void {
    const c = this.canvas;
    const ctx = c?.getContext("2d");
    if (c && ctx) {
      ctx.clearRect(0, 0, c.width, c.height);
      this.seq++;
    }
    this.smoother.reset();
    this.last = { present: 0, ...NEUTRAL };
    this.lastSeen = -Infinity;
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

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export default SonicSegmenter;
