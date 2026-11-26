/**
 * Addon speech : voix du navigateur en DataProviders, sans JS —
 * synthèse vocale (`sonic-speak`, speechSynthesis) et reconnaissance vocale
 * (`sonic-listen`, SpeechRecognition). Pour une transcription qui reste sur l'appareil :
 * `sonic-hugging-face-infer` avec Whisper (addon hugging-face-infer).
 */
export { SonicSpeak, type SpeakState, type SpeakSettings, type SpeakVoice } from "./speak";
export { SonicListen, type ListenState, type ListenSettings, type ListenMatch } from "./listen";
export { splitSpeech, pickVoice, normalizeSpeech, parsePhrases, matchPhrase, recognitionError, synthesisError, wordAt, restartDelay, MAX_CHUNK, type SpeechChunk } from "./core";
