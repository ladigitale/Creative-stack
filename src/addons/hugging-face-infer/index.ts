/**
 * Addon `sonic-hugging-face-infer`.
 * Appeler `configureHuggingFace` (runtime + allowlist de modèles) avant usage.
 */
import { getHuggingFaceRegistry } from "./hf-registry";
import { onHuggingFaceConfig } from "./hf-config";

export { default as SonicHuggingFaceInfer } from "./hugging-face-infer";
export * from "./hugging-face";
export { default as SonicSegmentAnything, type SegmentAnythingState } from "./segment-anything";
export { parsePoints, parseBox, applyGesture, toPixels, type SamPoint, type SamBox, type SamPrompts } from "./sam-prompts";
export type { HfSamImage, HfSamPoint, HfSamBox, HfSamEncodeResult, HfSamDecodeResult } from "./hf-protocol";

/**
 * Registre de la page pour les autres addons (`sonic-listen engine="whisper"`) : exporté, et
 * déposé sur `globalThis.__creativeStackHuggingFace` pour qu'un autre bundle s'en serve sans
 * embarquer sa propre copie (le registre est un singleton : une copie ne serait jamais configurée).
 */
export { getHuggingFaceRegistry, onHuggingFaceConfig };
export type { HuggingFaceRegistry } from "./hf-registry";
(globalThis as { __creativeStackHuggingFace?: unknown }).__creativeStackHuggingFace = { getHuggingFaceRegistry, onHuggingFaceConfig };
