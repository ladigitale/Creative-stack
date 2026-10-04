/**
 * Addon son : bruitages, sons d'interface et musiques synthétisés en WebAudio,
 * pilotés par DataProvider (`sonic-sound`, `sonic-sfx`).
 */
export { SonicSound } from "./sound";
export { SonicSfx } from "./sfx";
export { SoundEngine } from "./engine";
export { getSoundEngine, playSound } from "./registry";
export { validateSoundBank, noteToMidi, midiToFreq, songDuration, LIMITS } from "./bank";
export { SFX_PRESETS, INSTRUMENT_PRESETS } from "./presets";
export { playSynth } from "./synth";
export { SongPlayer } from "./sequencer";
export type * from "./types";
