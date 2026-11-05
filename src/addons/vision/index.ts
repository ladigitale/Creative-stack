/**
 * Addon vision : suivi en temps réel par modèles ML locaux (mains pour l'instant), sorties en DataProvider
 * branchables sans code sur sonic-param, sonic-if, sonic-stage, sonic-shader et sonic-jsonata.
 */
export { SonicHandTracker, type HandTrackerPhase, type HandTrackerStatus } from "./hand-tracker";
export { SonicFaceTracker } from "./face-tracker";
export { SonicPoseTracker } from "./pose-tracker";
export { SonicObjectDetector } from "./object-detector";
export { SonicSegmenter, type SegmentOutput } from "./segmenter";
export { SonicLandmarksOverlay } from "./landmarks-overlay";
export { SonicFaceMesh, type FaceMeshMode, type FaceMeshState } from "./face-mesh";
export { SonicExampleClassifier, type ClassifierOutput } from "./example-classifier";
export { DetectorCore, labelKey, type ObjectsOutput } from "./detector-state";
export { SonicMlTracker, type TrackerEngine, type TrackerPhase, type TrackerStatus } from "./tracker-base";
export { FaceTrackerCore, type FacesOutput } from "./face-state";
export { PoseTrackerCore, type PoseOutput } from "./pose-state";
export { detectionsFromMediaPipe, facesFromMediaPipe, posesFromMediaPipe, type RawDetection } from "./landmarkers";
export {
  createMediaPipeMpEngine,
  plainResult,
  type MpEngine,
  type MpEngineFactory,
  type MpEngineOptions,
  type MpTask,
} from "./mp-engine";
export {
  configureVision,
  createMediaPipeEngine,
  getVisionConfig,
  handsFromMediaPipe,
  resetVisionConfig,
  type HandEngine,
  type HandEngineFactory,
  type HandEngineOptions,
  type VisionConfig,
} from "./hand-engine";
export { HandTrackerCore, type HandsOutput, type RoleOutput } from "./hand-state";
export {
  DEFAULT_POLICY,
  configureMl,
  decideTrust,
  getMlPolicy,
  normalizeOrigins,
  type MlPolicy,
  type TrustDecision,
} from "../../shared/ml/trust";
