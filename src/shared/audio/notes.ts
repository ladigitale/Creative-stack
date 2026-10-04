const NOTE_OFFSETS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** `C4` → 60, `C#4` → 61, `Eb3` → 51. null si invalide. */
export function noteToMidi(note: string): number | null {
  const m = /^([A-Ga-g])(#|b)?(-?\d)$/.exec(note);
  if (!m) return null;
  let midi = (Number(m[3]) + 1) * 12 + NOTE_OFFSETS[m[1].toLowerCase()];
  if (m[2] === "#") midi += 1;
  if (m[2] === "b") midi -= 1;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/** Nom ou numéro MIDI → numéro MIDI (null si invalide). */
export function toMidi(note: unknown): number | null {
  if (typeof note === "number") return Number.isFinite(note) && note >= 0 && note <= 127 ? note : null;
  if (typeof note === "string") {
    const trimmed = note.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return toMidi(Number(trimmed));
    return noteToMidi(trimmed);
  }
  return null;
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
