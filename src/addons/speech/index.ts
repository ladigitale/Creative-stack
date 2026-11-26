/**
 * Addon speech : voix du navigateur en DataProviders, sans JS —
 * synthèse vocale (`sonic-speak`, speechSynthesis) et reconnaissance vocale
 * (`sonic-listen`, SpeechRecognition ; `engine="whisper"` : Whisper sur l'appareil, via le
 * registre de modèles de l'addon hugging-face-infer).
 */
export { SonicSpeak, type SpeakState, type SpeakSettings, type SpeakVoice } from "./speak";
export { SonicListen, type ListenState, type ListenSettings, type ListenMatch, type ListenEngine } from "./listen";
export { splitSpeech, pickVoice, normalizeSpeech, parsePhrases, matchPhrase, recognitionError, synthesisError, wordAt, restartDelay, MAX_CHUNK, type SpeechChunk } from "./core";
export { SpeechSegmenter, resample, rms, downmix, whisperLanguage, isWhisperNoise, WHISPER_RATE, DEFAULT_WHISPER_MODEL, type SegmenterOptions } from "./whisper";
