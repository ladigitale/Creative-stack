/**
 * Addon vision : suivi en temps réel par modèles ML locaux (mains pour l'instant), sorties en DataProvider
 * branchables sans code sur sonic-param, sonic-if, sonic-stage, sonic-shader et sonic-jsonata.
 */
export { SonicHandTracker, type HandTrackerPhase, type HandTrackerStatus } from "./hand-tracker";
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
  configureMl,
  decideTrust,
  getMlPolicy,
  normalizeOrigins,
  type MlPolicy,
  type TrustDecision,
} from "../../shared/ml/trust";
