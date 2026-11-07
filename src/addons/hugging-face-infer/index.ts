/**
 * Addon `sonic-hugging-face-infer`.
 * Appeler `configureHuggingFace` (runtime + allowlist de modèles) avant usage.
 */
export { default as SonicHuggingFaceInfer } from "./hugging-face-infer";
export * from "./hugging-face";
export { default as SonicSegmentAnything, type SegmentAnythingState } from "./segment-anything";
export { parsePoints, parseBox, applyGesture, toPixels, type SamPoint, type SamBox, type SamPrompts } from "./sam-prompts";
export type { HfSamImage, HfSamPoint, HfSamBox, HfSamEncodeResult, HfSamDecodeResult } from "./hf-protocol";
