/**
 * Addon audio : moteur partagé, synthèse modulaire (`sonic-patch` + modules),
 * bibliothèque de patches. Tout se pilote par DataProvider.
 */
export { SonicAudioUnlock } from "./unlock";
export { SonicAudioMaster } from "./master";
export { SonicPatch, type PatchState } from "./patch";
export { MODULE_TAGS } from "./modules-elements";
export { compilePatch, domToPatchNodes, type CompiledPatch, type PatchNode } from "./patch/compile";
export { PatchRuntime } from "./patch/runtime";
export { PATCH_LIBRARY, PATCH_PRESETS } from "./patch/library";
export { MODULES } from "./patch/modules";
export { AudioEngine, AUDIO_DP } from "../../shared/audio/engine";
export { toMidi, noteToMidi, midiToFreq } from "../../shared/audio/notes";
export type * from "../../shared/audio/contracts";
