/**
 * Hauteur fondamentale par YIN (de Cheveigné & Kawahara, 2002) sur un buffer
 * temporel : différence cumulée normalisée, premier creux sous le seuil,
 * interpolation parabolique. Fonction pure, sans WebAudio.
 */

export type PitchInfo = {
  /** Fréquence fondamentale (Hz, 0,1 près). */
  hz: number;
  /** Nom de la note la plus proche, dièses (« A4 », « C#3 »). */
  note: string;
  /** Numéro MIDI de cette note. */
  midi: number;
  /** Écart à la note, -50..50 cents. */
  cents: number;
  /** Netteté 0..1 (1 = périodique parfait). */
  clarity: number;
};

export type PitchOptions = {
  minHz?: number;
  maxHz?: number;
  /** Seuil YIN sur la différence normalisée (défaut 0,15 ; plus bas = plus exigeant). */
  threshold?: number;
  /** Niveau efficace sous lequel le buffer est un silence (défaut 0,01). */
  silence?: number;
  /** Netteté minimale pour publier une hauteur (défaut 0,6). */
  minClarity?: number;
  /** Échantillons lus au plus (défaut 2048 : le coût croît comme n²). */
  maxSize?: number;
};

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Hz → note la plus proche (`A4`, MIDI 69) et écart en cents. */
export function hzToNote(hz: number): { note: string; midi: number; cents: number } | null {
  if (!Number.isFinite(hz) || hz <= 0) return null;
  const exact = 69 + 12 * Math.log2(hz / 440);
  const midi = Math.round(exact);
  if (midi < 0 || midi > 127) return null;
  return { note: `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`, midi, cents: Math.round((exact - midi) * 100) };
}

/** Hauteur d'un buffer temporel (-1..1), null si silence, bruit ou hors de [minHz, maxHz]. */
export function yinPitch(td: ArrayLike<number>, sampleRate: number, opts: PitchOptions = {}): PitchInfo | null {
  const minHz = opts.minHz ?? 50;
  const maxHz = opts.maxHz ?? 2000;
  const threshold = opts.threshold ?? 0.15;
  const n = Math.min(td.length, opts.maxSize ?? 2048);
  const w = Math.floor(n / 2);
  if (w < 8 || !(sampleRate > 0)) return null;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += td[i] * td[i];
  if (Math.sqrt(energy / n) < (opts.silence ?? 0.01)) return null;
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(w - 1, Math.ceil(sampleRate / minHz));
  if (tauMax <= tauMin + 1) return null;

  // différence cumulée normalisée d'(τ)
  const d = new Float32Array(tauMax + 2);
  d[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let s = 0;
    for (let i = 0; i < w; i++) {
      const x = td[i] - td[i + tau];
      s += x * x;
    }
    running += s;
    d[tau] = running > 0 ? (s * tau) / running : 1;
  }

  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (d[t] < threshold) {
      while (t + 1 <= tauMax && d[t + 1] < d[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    // pas de creux sous le seuil : meilleur minimum global (souvent peu net)
    let best = tauMin;
    for (let t = tauMin + 1; t <= tauMax; t++) if (d[t] < d[best]) best = t;
    tau = best;
  }
  const clarity = Math.max(0, Math.min(1, 1 - d[tau]));
  if (clarity < (opts.minClarity ?? 0.6)) return null;
  const a = d[tau - 1];
  const b = d[tau];
  const c = d[tau + 1];
  const den = a - 2 * b + c;
  const shift = den > 0 ? Math.max(-1, Math.min(1, (0.5 * (a - c)) / den)) : 0;
  const hz = sampleRate / (tau + shift);
  if (hz < minHz * 0.97 || hz > maxHz * 1.03) return null;
  const n2 = hzToNote(hz);
  if (!n2) return null;
  return { hz: +hz.toFixed(1), ...n2, clarity: +clarity.toFixed(3) };
}
