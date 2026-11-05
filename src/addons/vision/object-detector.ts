import { customElement, property } from "lit/decorators.js";
import type { CompiledMap } from "../../shared/ml/map-expr";
import { DetectorCore, type ObjectsOutput } from "./detector-state";
import { detectionsFromMediaPipe, type RawDetection } from "./landmarkers";
import { createMediaPipeMpEngine, getVisionConfig } from "./mp-engine";
import { SonicMlTracker, type TrackerEngine } from "./tracker-base";

const tagName = "sonic-object-detector";

/**
 * Détecte des objets (80 classes COCO par défaut : personne, tasse, téléphone, chaise…) dans un flux d'images
 * (`for="cam"`) et publie en DataProvider le meilleur objet, les comptes par étiquette et la liste des boîtes
 * (0..1, repère écran). Inférence locale ; mêmes règles de modèle, de confiance et de consentement que les
 * autres trackers. Sans `track`, `smooth` ne s'applique pas (pas d'identité entre images) ; avec `track="true"`, chaque objet a un `id` stable et sa boîte est lissée.
 */
@customElement(tagName)
export class SonicObjectDetector extends SonicMlTracker<RawDetection[], ObjectsOutput> {
  @property({ type: Number, attribute: "max-results" })
  maxResults = 5;

  /** Étiquettes retenues, séparées par des virgules (`person,cup`). Vide : toutes. */
  @property({ type: String })
  categories = "";

  /** `"true"` : chaque objet reçoit un `id` stable d'une image à l'autre (`objects.N.id`, `ids`, `id`), et `smooth` lisse sa boîte. */
  @property({ type: String })
  track: "true" | "false" = "false";

  /** Recouvrement minimal (0..1) pour reconnaître un objet d'une image à l'autre. */
  @property({ type: Number, attribute: "track-iou" })
  trackIou = 0.3;

  /** Un objet disparu garde son `id` pendant cette durée (ms) : il le retrouve s'il revient au même endroit. */
  @property({ type: Number, attribute: "track-max-age-ms" })
  trackMaxAgeMs = 500;

  private core = new DetectorCore({ holdMs: 150, mirror: true });
  private smoothValue = 0;

  protected defaultModel(): string {
    return "object-detector";
  }

  protected extraReloadKeys(): string[] {
    return ["maxResults", "categories"];
  }

  protected hasCustomEngine(): boolean {
    return !!getVisionConfig().createMpEngine;
  }

  protected async createEngine(model: Uint8Array): Promise<TrackerEngine<RawDetection[]>> {
    const factory = getVisionConfig().createMpEngine ?? createMediaPipeMpEngine;
    const allow = this.categories.split(",").map((c) => c.trim()).filter(Boolean);
    const score = this.minScore;
    const mp = await factory({
      task: "detect",
      model,
      options: {
        maxResults: Math.max(1, Math.min(20, Math.round(this.maxResults) || 5)),
        scoreThreshold: score,
        ...(allow.length ? { categoryAllowlist: allow } : {}),
      },
      delegate: this.delegate,
      thread: this.thread,
    });
    return {
      backend: mp.backend,
      thread: mp.thread,
      close: () => mp.close(),
      detect: async (frame, tsMs) => detectionsFromMediaPipe(await mp.detect(frame, tsMs), score),
    };
  }

  protected toOutput(raw: RawDetection[], now: number, mirror: boolean): ObjectsOutput {
    this.core.configure({
      mirror,
      track: this.track === "true",
      trackIou: Number(this.trackIou) || 0.3,
      trackMaxAgeMs: Number(this.trackMaxAgeMs) || 500,
      smooth: this.smoothValue,
    });
    return this.core.update(raw, now);
  }

  protected configureCore(opts: { smooth: number; holdMs: number; map: CompiledMap | null }): void {
    this.smoothValue = opts.smooth;
    this.core.configure({ holdMs: opts.holdMs, map: opts.map, smooth: opts.smooth });
  }

  protected resetCore(): void {
    this.core.reset();
  }
}

export default SonicObjectDetector;
