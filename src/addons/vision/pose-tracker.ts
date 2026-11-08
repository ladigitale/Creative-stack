import { customElement, property } from "lit/decorators.js";
import type { CompiledMap } from "../../shared/ml/map-expr";
import type { RawPose } from "../../shared/ml/pose";
import { posesFromMediaPipe } from "./landmarkers";
import { PoseTrackerCore, type PoseOutput } from "./pose-state";
import { createMediaPipeMpEngine, getVisionConfig } from "./mp-engine";
import type { ParamSpecs } from "./live-params";
import { SonicMlTracker, type TrackerEngine } from "./tracker-base";

const tagName = "sonic-pose-tracker";

/**
 * Suit le corps (33 points) dans un flux d'images (`for="cam"`) : points nommés (`joints.leftWrist.x`),
 * hauteur des bras (`raiseLeft` / `raiseRight`), écartement (`span`), inclinaison du buste (`lean`) et position
 * (`x` / `y`) en DataProvider. Inférence locale ; mêmes règles de modèle, de confiance et de consentement
 * que `sonic-hand-tracker`. Modèles : `pose-landmarker` (léger, défaut), `pose-landmarker-full`, `pose-landmarker-heavy`.
 */
@customElement(tagName)
export class SonicPoseTracker extends SonicMlTracker<RawPose[], PoseOutput> {
  @property({ type: Number, attribute: "max-poses" })
  maxPoses = 1;

  private core = new PoseTrackerCore({ smooth: 0.5, holdMs: 150, mirror: true });

  protected defaultModel(): string {
    return "pose-landmarker";
  }

  protected extraReloadKeys(): string[] {
    return ["maxPoses"];
  }

  protected paramSpecs(): ParamSpecs {
    return { ...super.paramSpecs(), maxPoses: { kind: "number", min: 1, max: 4, int: true } };
  }

  protected hasCustomEngine(): boolean {
    return !!getVisionConfig().createMpEngine;
  }

  protected async createEngine(model: Uint8Array): Promise<TrackerEngine<RawPose[]>> {
    const factory = getVisionConfig().createMpEngine ?? createMediaPipeMpEngine;
    const mp = await factory({
      task: "pose",
      model,
      options: {
        numPoses: Math.max(1, Math.min(4, Math.round(this.maxPoses) || 1)),
        minPoseDetectionConfidence: this.minScore,
        minPosePresenceConfidence: this.minScore,
        minTrackingConfidence: this.minScore,
      },
      delegate: this.delegate,
      thread: this.thread,
    });
    return {
      backend: mp.backend,
      thread: mp.thread,
      close: () => mp.close(),
      detect: async (frame, tsMs) => posesFromMediaPipe(await mp.detect(frame, tsMs)),
    };
  }

  protected toOutput(poses: RawPose[], now: number, mirror: boolean): PoseOutput {
    this.core.configure({ mirror });
    return this.core.update(poses, now);
  }

  protected configureCore(opts: { smooth: number; holdMs: number; map: CompiledMap | null }): void {
    this.core.configure(opts);
  }

  protected resetCore(): void {
    this.core.reset();
  }
}

export default SonicPoseTracker;
