/**
 * Format de banque son — conçu pour être écrit par un agent.
 *
 * Tout est synthétisé en WebAudio (aucun échantillon) : une banque complète
 * (musiques + bruitages + sons d'interface) tient en quelques Ko de JSON.
 */

export type Wave = "sine" | "square" | "triangle" | "sawtooth" | "noise";

export type FilterType = "lowpass" | "highpass" | "bandpass" | "notch";

/** Définition d'une voix de synthèse (bruitage ou instrument). */
export type SynthDef = {
  /** Part d'un preset intégré, les autres champs le surchargent. */
  preset?: string;
  wave?: Wave;
  /** Fréquence de base en Hz (ignorée pour un instrument mélodique : la note la fixe). */
  freq?: number;
  /** Transposition en demi-tons appliquée à la hauteur jouée. */
  transpose?: number;
  /** Glissement de hauteur en demi-tons sur `slideTime` (ex. -24 = deux octaves vers le bas). */
  slide?: number;
  /** Durée du glissement en s (défaut : `dur`). */
  slideTime?: number;
  /** Durée tenue en s, hors release (défaut 0.15). Pour un instrument, la note fixe la durée. */
  dur?: number;
  attack?: number;
  decay?: number;
  /** Niveau de maintien 0..1 relatif à `vol`. */
  sustain?: number;
  release?: number;
  /** Volume 0..1. */
  vol?: number;
  /** Arpège : décalages en demi-tons joués en boucle pendant la voix. */
  arp?: number[];
  /** Durée d'un pas d'arpège en s (défaut 0.05). */
  arpRate?: number;
  vibrato?: { rate: number; depth: number };
  filter?: { type?: FilterType; freq: number; q?: number; to?: number };
  /** Répétitions de la voix (ex. 2 pour un double blip). */
  repeat?: number;
  /** Écart entre répétitions en s. */
  repeatGap?: number;
  /** Variation aléatoire de hauteur à chaque déclenchement, en demi-tons (bruitages). */
  jitter?: number;
  /** Panoramique -1..1. */
  pan?: number;
  /** Couches jouées en même temps (chacune est une SynthDef). */
  layers?: SynthDef[];
};

/** Bruitage : une voix + réglages de déclenchement. */
export type SfxDef = SynthDef & {
  /** Bus de sortie (défaut "sfx"). */
  bus?: "sfx" | "ui";
  /** Délai minimal entre deux déclenchements en ms (anti-spam, défaut 30). */
  cooldown?: number;
};

/**
 * Morceau en notation tracker texte.
 * Une piste = une chaîne de pas séparés par des espaces :
 *   `C4` note · `C#4` / `Eb3` altérations · `C4+E4+G4` accord
 *   `.` silence · `-` tenue de la note précédente · `x` frappe · `X` frappe accentuée
 *   suffixe `!` = accent (ex. `G4!`) · `|` ignoré (repère de mesure)
 */
export type SongDef = {
  bpm?: number;
  /** Pas par temps (défaut 4 = doubles croches). */
  steps?: number;
  /** Temps par mesure (défaut 4). */
  beats?: number;
  /** Volume du morceau 0..1 (défaut 0.8). */
  vol?: number;
  /** Boucle la séquence (défaut true). */
  loop?: boolean;
  /** Index de séquence où reprendre la boucle (défaut 0, pour une intro non rejouée). */
  loopFrom?: number;
  /** Swing 0..0.5 : retarde les pas impairs. */
  swing?: number;
  instruments: Record<string, SynthDef>;
  /** Motifs : nom → { instrument → piste }. */
  patterns: Record<string, Record<string, string>>;
  /** Ordre des motifs (défaut : ordre de déclaration). */
  sequence?: string[];
};

export type SoundBank = {
  /** Bruitages et sons d'interface. */
  sfx?: Record<string, SfxDef>;
  /** Musiques et jingles. */
  songs?: Record<string, SongDef>;
};

/* ------------------------------------------------------------------ */
/* Pilotage (DataProvider d'entrée)                                    */
/* ------------------------------------------------------------------ */

export type PlayTrigger =
  | number
  | {
      /** Compteur : toute hausse déclenche le son. */
      n: number;
      /** Transposition en demi-tons pour ce déclenchement. */
      pitch?: number;
      /** Multiplicateur de volume. */
      vol?: number;
    };

export type SoundControl = {
  /** Morceau courant (null = silence). Changer la valeur enchaîne en fondu. */
  music?: string | null;
  /** Durée du fondu enchaîné en s (défaut 0.6). */
  fade?: number;
  /** Met la musique en pause. */
  paused?: boolean;
  /** Coupe tout le son. */
  muted?: boolean;
  volume?: Partial<Record<"master" | "music" | "sfx" | "ui", number>>;
  /** Compteurs de déclenchement : `{ coin: 12 }` → passer à 13 joue `coin`. */
  play?: Record<string, PlayTrigger>;
};

/* ------------------------------------------------------------------ */
/* État publié (DataProvider de sortie)                                */
/* ------------------------------------------------------------------ */

export type SoundState = {
  /** WebAudio disponible dans ce navigateur. */
  supported: boolean;
  /** Le navigateur a autorisé le son (geste utilisateur reçu). */
  unlocked: boolean;
  muted: boolean;
  paused: boolean;
  volume: Record<"master" | "music" | "sfx" | "ui", number>;
  music: {
    id: string | null;
    playing: boolean;
    ended: boolean;
    bpm: number;
    bar: number;
    beat: number;
    step: number;
    pattern: string | null;
    loops: number;
  };
  /** Dernier bruitage joué (bus sfx, jingles inclus). */
  lastSfx: { id: string; at: number } | null;
  /** Dernier son d'interface joué (bus ui). */
  lastUi: { id: string; at: number } | null;
  /** Nombre de lectures effectives par son depuis le chargement. */
  played: Record<string, number>;
  voices: number;
  sounds: string[];
  songs: string[];
  /** Erreurs de banque ou de pilotage, lisibles par l'agent. */
  errors: string[];
};

/* ------------------------------------------------------------------ */
/* Forme normalisée interne                                            */
/* ------------------------------------------------------------------ */

export type ResolvedSynth = Required<
  Omit<SynthDef, "preset" | "layers" | "filter" | "vibrato" | "arp" | "slideTime">
> & {
  slideTime: number | null;
  arp: number[] | null;
  vibrato: { rate: number; depth: number } | null;
  filter: { type: FilterType; freq: number; q: number; to: number | null } | null;
  layers: ResolvedSynth[];
};

export type ResolvedSfx = ResolvedSynth & { bus: "sfx" | "ui"; cooldown: number };

/** Un événement de note dans un pas de séquence. */
export type NoteEvent = {
  instrument: string;
  /** Notes MIDI (accord) ; null pour une frappe sans hauteur (`x`). */
  midi: number[] | null;
  /** Durée en pas. */
  length: number;
  accent: boolean;
};

export type ResolvedPattern = {
  name: string;
  length: number;
  /** events[pas] = événements déclenchés à ce pas. */
  events: NoteEvent[][];
};

export type ResolvedSong = {
  bpm: number;
  steps: number;
  beats: number;
  vol: number;
  loop: boolean;
  loopFrom: number;
  swing: number;
  instruments: Record<string, ResolvedSynth>;
  patterns: Record<string, ResolvedPattern>;
  sequence: string[];
};

export type ResolvedBank = {
  sfx: Record<string, ResolvedSfx>;
  songs: Record<string, ResolvedSong>;
};
