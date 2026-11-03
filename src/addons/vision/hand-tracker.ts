import { customElement, property } from "lit/decorators.js";
import type { CompiledMap } from "../../shared/ml/map-expr";
import { createMediaPipeEngine, getVisionConfig, type HandEngine } from "./hand-engine";
import { HandTrackerCore, type HandsOutput } from "./hand-state";
import { SonicMlTracker, type TrackerEngine, type TrackerPhase, type TrackerStatus } from "./tracker-base";
import type { RawHand } from "../../shared/ml/hands";

const tagName = "sonic-hand-tracker";

export type HandTrackerPhase = TrackerPhase;
export type HandTrackerStatus = TrackerStatus;

/**
 * Suit jusqu'à deux mains dans un flux d'images (`for="cam"`) et publie dans un DataProvider leurs
 * points, ouverture, pince, rotation et geste, par rôle `left` / `right` (repère écran).
 * Inférence locale : aucune image ne quitte l'appareil. Le modèle est une donnée : alias, ou URL
 * https soumise aux niveaux de confiance de `shared/ml/trust` (consentement affiché via `statusProvider`).
 */
@customElement(tagName)
export class SonicHandTracker extends SonicMlTracker<RawHand[], HandsOutput> {
  @property({ type: Number, attribute: "max-hands" })
  maxHands = 2;

  /** `"false"` : points seuls (HandLandmarker), sans reconnaissance de gestes. */
  @property({ type: String })
  gestures: "true" | "false" = "true";

  private core = new HandTrackerCore({ smooth: 0.5, holdMs: 150, mirror: true });

  protected defaultModel(): string {
    return this.gestures !== "false" ? "gesture-recognizer" : "hand-landmarker";
  }

  protected extraReloadKeys(): string[] {
    return ["gestures", "maxHands"];
  }

  protected hasCustomEngine(): boolean {
    return !!(getVisionConfig().createEngine || getVisionConfig().createMpEngine);
  }

  protected async createEngine(model: Uint8Array): Promise<TrackerEngine<RawHand[]>> {
    const factory = getVisionConfig().createEngine ?? createMediaPipeEngine;
    const engine: HandEngine = await factory({
      model,
      gestures: this.gestures !== "false",
      maxHands: Math.max(1, Math.min(2, Math.round(this.maxHands) || 2)),
      minScore: this.minScore,
      delegate: this.delegate,
      thread: this.thread,
    });
    return engine;
  }

  protected toOutput(hands: RawHand[], now: number, mirror: boolean): HandsOutput {
    this.core.configure({ mirror });
    return this.core.update(hands, now);
  }

  protected configureCore(opts: { smooth: number; holdMs: number; map: CompiledMap | null }): void {
    this.core.configure(opts);
  }

  protected resetCore(): void {
    this.core.reset();
  }
}

export default SonicHandTracker;
