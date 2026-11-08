import { customElement, property } from "lit/decorators.js";
import type { RawFace } from "../../shared/ml/face";
import type { CompiledMap } from "../../shared/ml/map-expr";
import { FaceTrackerCore, type FacesOutput } from "./face-state";
import { facesFromMediaPipe } from "./landmarkers";
import { createMediaPipeMpEngine, getVisionConfig } from "./mp-engine";
import { FLAG, type ParamSpecs } from "./live-params";
import { SonicMlTracker, type TrackerEngine } from "./tracker-base";

const tagName = "sonic-face-tracker";

/**
 * Suit un visage (ou deux) dans un flux d'images (`for="cam"`) : position du nez, taille, orientation de la
 * tête (`yaw` / `pitch` / `roll`) et expressions (bouche ouverte, sourire, sourcils, clignements, regard)
 * issues des 52 blendshapes, en DataProvider. Inférence locale ; mêmes règles de modèle, de confiance et de
 * consentement que `sonic-hand-tracker`.
 */
@customElement(tagName)
export class SonicFaceTracker extends SonicMlTracker<RawFace[], FacesOutput> {
  @property({ type: Number, attribute: "max-faces" })
  maxFaces = 1;

  /** `"true"` : publie aussi les 478 points de chaque visage (`faces.N.landmarks`). Lourd, désactivé par défaut. */
  @property({ type: String })
  landmarks: "true" | "false" = "false";

  private core = new FaceTrackerCore({ smooth: 0.5, holdMs: 150, mirror: true });

  protected defaultModel(): string {
    return "face-landmarker";
  }

  protected extraReloadKeys(): string[] {
    return ["maxFaces"];
  }

  protected paramSpecs(): ParamSpecs {
    return { ...super.paramSpecs(), maxFaces: { kind: "number", min: 1, max: 2, int: true }, landmarks: FLAG };
  }

  protected hasCustomEngine(): boolean {
    return !!getVisionConfig().createMpEngine;
  }

  protected async createEngine(model: Uint8Array): Promise<TrackerEngine<RawFace[]>> {
    const factory = getVisionConfig().createMpEngine ?? createMediaPipeMpEngine;
    const mp = await factory({
      task: "face",
      model,
      options: {
        numFaces: Math.max(1, Math.min(2, Math.round(this.maxFaces) || 1)),
        minFaceDetectionConfidence: this.minScore,
        minFacePresenceConfidence: this.minScore,
        minTrackingConfidence: this.minScore,
        outputFaceBlendshapes: true,
      },
      delegate: this.delegate,
      thread: this.thread,
    });
    return {
      backend: mp.backend,
      thread: mp.thread,
      close: () => mp.close(),
      detect: async (frame, tsMs) => facesFromMediaPipe(await mp.detect(frame, tsMs)),
    };
  }

  protected toOutput(faces: RawFace[], now: number, mirror: boolean): FacesOutput {
    this.core.configure({ mirror, landmarks: this.landmarks === "true" });
    return this.core.update(faces, now);
  }

  protected configureCore(opts: { smooth: number; holdMs: number; map: CompiledMap | null }): void {
    this.core.configure(opts);
  }

  protected resetCore(): void {
    this.core.reset();
  }
}

export default SonicFaceTracker;
