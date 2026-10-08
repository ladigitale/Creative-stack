/**
 * Table des modules du patch : type, rôle, paramètres (défauts, bornes,
 * modulables ou non). Source unique pour le compilateur, le runtime et la doc.
 */

export type ModuleKind =
  /** Produit un signal audio sans entrée (oscillateur, bruit). */
  | "source"
  /** Traite une entrée audio. */
  | "processor"
  /** Produit un signal de modulation (enveloppe, LFO). */
  | "control";

export type ParamSpec = {
  default: number | string;
  /** Bornes des valeurs numériques. */
  min?: number;
  max?: number;
  /** Valeurs permises (paramètre énuméré). */
  values?: string[];
  /** Paramètre porté par un AudioParam : modulable et rampable. */
  audio?: boolean;
  /** Liste de nombres séparés par des espaces. */
  list?: boolean;
  /** Durée exprimable en fraction de tempo (`3/16`). */
  tempo?: boolean;
};

export type ModuleSpec = {
  kind: ModuleKind;
  params: Record<string, ParamSpec>;
};

const WAVES = ["sine", "square", "sawtooth", "triangle", "pulse"];

export const MODULES: Record<string, ModuleSpec> = {
  "sonic-osc": {
    kind: "source",
    params: {
      wave: { default: "sawtooth", values: WAVES },
      "freq-hz": { default: "voice.pitch", min: 0, max: 20000, audio: true },
      detune: { default: 0, min: -4800, max: 4800, audio: true },
      octave: { default: 0, min: -4, max: 4 },
      semi: { default: 0, min: -48, max: 48 },
      pw: { default: 0.5, min: 0.02, max: 0.98 },
      harmonics: { default: "", list: true },
      level: { default: 1, min: 0, max: 4, audio: true },
      fm: { default: "" },
      "fm-amount": { default: 200, min: 0, max: 20000 },
    },
  },
  "sonic-noise": {
    kind: "source",
    params: {
      color: { default: "white", values: ["white", "pink", "brown"] },
      level: { default: 1, min: 0, max: 4, audio: true },
    },
  },
  /** Entrée externe (micro, vidéo, autre patch) : hors sonic-voice uniquement. */
  "sonic-audio-input": {
    kind: "source",
    params: {
      source: { default: "#mic" },
      level: { default: 1, min: 0, max: 4, audio: true },
    },
  },
  "sonic-mixer": {
    kind: "processor",
    params: { levels: { default: "", list: true } },
  },
  "sonic-filter": {
    kind: "processor",
    params: {
      type: { default: "lowpass", values: ["lowpass", "highpass", "bandpass", "notch", "lowshelf", "highshelf", "peaking", "allpass"] },
      "freq-hz": { default: 1200, min: 10, max: 20000, audio: true },
      q: { default: 1, min: 0.0001, max: 40, audio: true },
      "gain-db": { default: 0, min: -40, max: 40, audio: true },
    },
  },
  "sonic-vca": {
    kind: "processor",
    params: { gain: { default: 1, min: 0, max: 8, audio: true } },
  },
  "sonic-env": {
    kind: "control",
    params: {
      a: { default: 0.005, min: 0, max: 20 },
      d: { default: 0.1, min: 0, max: 20 },
      s: { default: 0.7, min: 0, max: 1 },
      r: { default: 0.2, min: 0, max: 30 },
    },
  },
  "sonic-lfo": {
    kind: "control",
    params: {
      wave: { default: "sine", values: ["sine", "square", "sawtooth", "triangle"] },
      "rate-hz": { default: 2, min: 0.001, max: 200, audio: true },
      sync: { default: "" },
    },
  },
  "sonic-shaper": {
    kind: "processor",
    params: {
      curve: { default: "soft", values: ["soft", "hard", "fold", "bit"] },
      drive: { default: 2, min: 0.1, max: 100 },
      oversample: { default: "2x", values: ["none", "2x", "4x"] },
    },
  },
  "sonic-pan": {
    kind: "processor",
    params: { pan: { default: 0, min: -1, max: 1, audio: true } },
  },
  "sonic-delay": {
    kind: "processor",
    params: {
      time: { default: 0.25, min: 0.001, max: 4, tempo: true, audio: true },
      feedback: { default: 0.35, min: 0, max: 0.95, audio: true },
      mix: { default: 0.3, min: 0, max: 1 },
      tone: { default: 6000, min: 200, max: 20000 },
    },
  },
  "sonic-reverb": {
    kind: "processor",
    params: {
      "size-s": { default: 2, min: 0.1, max: 10 },
      damp: { default: 0.5, min: 0, max: 1 },
      mix: { default: 0.25, min: 0, max: 1 },
    },
  },
  "sonic-chorus": {
    kind: "processor",
    params: {
      "rate-hz": { default: 0.8, min: 0.01, max: 20, audio: true },
      depth: { default: 3, min: 0, max: 20 },
      delay: { default: 12, min: 1, max: 40 },
      mix: { default: 0.5, min: 0, max: 1 },
    },
  },
  "sonic-comp": {
    kind: "processor",
    params: {
      "threshold-db": { default: -18, min: -100, max: 0, audio: true },
      ratio: { default: 4, min: 1, max: 20, audio: true },
      knee: { default: 6, min: 0, max: 40, audio: true },
      attack: { default: 0.005, min: 0, max: 1, audio: true },
      release: { default: 0.15, min: 0, max: 1, audio: true },
    },
  },
};

/** Balises de structure (pas des modules). */
export const STRUCTURE_TAGS = ["sonic-voice", "sonic-mod", "sonic-param"];

/** Sources implicites disponibles dans une voix. */
export const VOICE_SOURCES = ["voice.pitch", "voice.gate", "voice.vel", "voice.note", "voice.rand", "voice.bend", "voice.pressure", "voice.timbre"];

/** Expressions par note (MPE, pitch bend, aftertouch) : signaux mis à jour pendant la note. */
export const VOICE_EXPRESSIONS = ["bend", "pressure", "timbre"] as const;
export type VoiceExpression = { bend?: number; pressure?: number; timbre?: number };

/** Tempo d'une fraction (`3/16`) → secondes à `bpm` (ronde = 4 temps). */
export function tempoToSeconds(value: string, bpm: number): number | null {
  const m = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!m) return null;
  const frac = Number(m[1]) / Number(m[2]);
  if (!Number.isFinite(frac) || frac <= 0) return null;
  return (frac * 4 * 60) / bpm;
}
