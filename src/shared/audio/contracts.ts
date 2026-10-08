/**
 * Contrats audio partagés par tous les addons creative-stack.
 * Câblage des flux par `#id` (comme les canaux shader), valeur réservée `master`.
 */

/** Tout composant qui produit du son. */
export type SonicAudioSource = {
  /** null tant que le composant n'est pas prêt (contexte non déverrouillé…). */
  getAudioOutput(): AudioNode | null;
};

/** Tout composant qui reçoit du son (effet, analyseur, enregistreur…). */
export type SonicAudioSink = {
  getAudioInput(): AudioNode | null;
};

/** Événement musical commun (séquenceur, DataProvider, MIDI…). */
export type SonicNoteEvent = {
  /**
   * "note" (défaut) : note de durée `durS` (ou durée par défaut de l'instrument) ;
   * "noteOn" : tenue jusqu'au "noteOff" de la même note (clavier, MIDI) ;
   * "param" : change un paramètre (`path`, `value`, `rampS`) ;
   * "expr" : expressions d'une note tenue (`bend`, `pressure`, `timbre`) — MPE, pitch bend, aftertouch ;
   * "cc" : contrôle MIDI (`cc`, `value` 0..1) — ignoré par les instruments internes.
   */
  type?: "note" | "noteOn" | "noteOff" | "param" | "expr" | "cc";
  /** Nom ("A4", "C#3", "Bb2") ou numéro MIDI. */
  note?: string | number;
  /** Nom de pad / sample (sampler, batterie). */
  sample?: string;
  /** Vélocité 0..1 (défaut 0.8). */
  vel?: number;
  /** Durée en s. Absente : la note tient jusqu'au noteOff (ou durée par défaut de l'instrument). */
  durS?: number;
  /** Instant cible (AudioContext.currentTime). Absent : maintenant. Passé de plus de 50 ms : ignoré. */
  when?: number;
  /** Dédoublonnage : un même id n'est joué qu'une fois. */
  id?: string;
  /** Expressions : bend en demi-tons, pressure et timbre 0..1 (aussi valeurs initiales d'un noteOn). */
  bend?: number;
  pressure?: number;
  timbre?: number;
  /** Canal MIDI 1..16 (entrée MIDI, ou sortie vers un appareil). */
  ch?: number;
  /** type "cc" : numéro de contrôleur 0..127. */
  cc?: number;
  /** type "param" : chemin `module.param`, valeur et rampe. */
  path?: string;
  value?: number;
  rampS?: number;
};

/** Tout ce qui joue des notes. Seul chemin pour déclencher une note. */
export type SonicInstrument = {
  schedule(events: SonicNoteEvent[]): void;
  allNotesOff(): void;
};

/** État standard publié par les composants actifs. */
export type SonicStatus = "idle" | "requesting" | "ready" | "denied" | "error" | "unsupported";

export function isAudioSource(v: unknown): v is SonicAudioSource {
  return !!v && typeof (v as SonicAudioSource).getAudioOutput === "function";
}

export function isAudioSink(v: unknown): v is SonicAudioSink {
  return !!v && typeof (v as SonicAudioSink).getAudioInput === "function";
}

export function isInstrument(v: unknown): v is SonicInstrument {
  return !!v && typeof (v as SonicInstrument).schedule === "function";
}
