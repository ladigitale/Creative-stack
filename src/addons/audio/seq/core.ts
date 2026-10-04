/**
 * Cœur du séquenceur : motifs → événements datés dans une fenêtre de temps.
 * Pur (pas d'audio) : l'élément `sonic-sequencer` l'appelle depuis son horloge.
 */
import type { SonicNoteEvent } from "../../../shared/audio/contracts";
import { toMidi } from "../../../shared/audio/notes";
import { degreeToMidi, eventsForCycle, parseLine, parseScale, type MiniEvent, type MiniNode } from "./mini";

export type TrackLine = { key: string; ast: MiniNode; notes: boolean };

export type Track = {
  /** Id de l'instrument visé. */
  target: string;
  lines: TrackLine[];
  scale: { root: number; steps: number[] } | null;
  vel: number;
  /** Part de la case occupée par une note (0..1). */
  gate: number;
  transpose: number;
};

export type ScheduledEvent = { target: string; event: SonicNoteEvent };

export type StepTick = {
  /** Pas dans la mesure (0..beats × stepsPerBeat - 1). */
  step: number;
  bar: number;
  beat: number;
  /** Position 0..1 dans la mesure. */
  phase: number;
  when: number;
};

export type CoreOptions = {
  bpm: number;
  swing: number;
  seed: number;
  beats: number;
  stepsPerBeat: number;
};

const RESERVED = new Set(["notes", "scale", "octave", "vel", "gate", "transpose"]);

/**
 * `pattern` : { "<id instrument>": "c4 e4 g4" | { notes, scale, octave, vel, gate, transpose, "<pad>": "x..x" } }
 */
export function compilePattern(pattern: unknown): { tracks: Track[]; errors: string[] } {
  const errors: string[] = [];
  const tracks: Track[] = [];
  if (pattern === null || pattern === undefined || pattern === "") return { tracks, errors };
  if (typeof pattern !== "object" || Array.isArray(pattern)) {
    return { tracks, errors: ["pattern : objet { idInstrument: ligne | { notes, pad: ligne… } } attendu"] };
  }
  for (const [target, raw] of Object.entries(pattern as Record<string, unknown>)) {
    const spec = typeof raw === "string" ? { notes: raw } : raw;
    if (!spec || typeof spec !== "object") {
      errors.push(`${target} : ligne ou objet attendu`);
      continue;
    }
    const s = spec as Record<string, unknown>;
    const octave = Number.isFinite(Number(s.octave)) ? Number(s.octave) : 4;
    let scale: Track["scale"] = null;
    if (s.scale !== undefined) {
      scale = parseScale(String(s.scale), octave);
      if (!scale) errors.push(`${target}.scale : "${s.scale}" invalide (ex. "a:minor-pentatonic", "c3:dorian")`);
    }
    const lines: TrackLine[] = [];
    for (const [key, value] of Object.entries(s)) {
      if (RESERVED.has(key) && key !== "notes") continue;
      if (typeof value !== "string") {
        errors.push(`${target}.${key} : ligne texte attendue`);
        continue;
      }
      const { ast, errors: lineErrors } = parseLine(value);
      for (const e of lineErrors) errors.push(`${target}.${key} : ${e}`);
      lines.push({ key, ast, notes: key === "notes" });
    }
    const num = (v: unknown, d: number, min: number, max: number) =>
      Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.min(max, Math.max(min, Number(v))) : d;
    tracks.push({
      target,
      lines,
      scale,
      vel: num(s.vel, 0.8, 0, 1),
      gate: num(s.gate, 0.9, 0.05, 4),
      transpose: num(s.transpose, 0, -48, 48),
    });
  }
  return { tracks, errors };
}

/** Valeur d'un pas → champs d'événement (note / sample / accent). null si invalide. */
export function valueToEvent(track: Track, line: TrackLine, value: string): Partial<SonicNoteEvent> | null {
  const accent = value === "X";
  if (value === "x" || value === "X") {
    return { ...(line.notes ? {} : { sample: line.key }), vel: accent ? Math.min(1, track.vel * 1.25 + 0.1) : track.vel };
  }
  if (!line.notes) return { sample: line.key, vel: track.vel };
  const parts = value.split("+");
  const midis: number[] = [];
  for (const p of parts) {
    let m: number | null;
    if (/^-?\d+$/.test(p)) m = track.scale ? degreeToMidi(Number(p), track.scale) : toMidi(Number(p));
    else m = toMidi(p);
    if (m === null) return null;
    midis.push(Math.min(127, Math.max(0, m + track.transpose)));
  }
  // accord : la première note porte l'événement, les autres sont dupliquées par l'appelant
  return { note: midis.length === 1 ? midis[0] : midis.join("+"), vel: track.vel };
}

export class SequencerCore {
  tracks: Track[];
  opts: CoreOptions;
  /** Instant audio du début de la mesure 0. */
  t0 = 0;
  private cache = new Map<string, MiniEvent[]>();
  invalid = new Set<string>();

  constructor(tracks: Track[], opts: CoreOptions) {
    this.tracks = tracks;
    this.opts = opts;
  }

  get barDur(): number {
    return (this.opts.beats * 60) / this.opts.bpm;
  }

  get stepCount(): number {
    return this.opts.beats * this.opts.stepsPerBeat;
  }

  get stepDur(): number {
    return this.barDur / this.stepCount;
  }

  start(t0: number): void {
    this.t0 = t0;
    this.cache.clear();
  }

  setTracks(tracks: Track[]): void {
    this.tracks = tracks;
    this.cache.clear();
  }

  setSeed(seed: number): void {
    this.opts.seed = seed;
    this.cache.clear();
  }

  /** Change le tempo en gardant la position courante (à `now`). */
  setBpm(bpm: number, now: number): void {
    const phase = (now - this.t0) / this.barDur;
    this.opts.bpm = bpm;
    this.t0 = now - phase * this.barDur;
  }

  /** Position (en mesures, fractionnaire) à l'instant t. */
  position(t: number): number {
    return (t - this.t0) / this.barDur;
  }

  private swingOffset(start: number): number {
    if (!this.opts.swing) return 0;
    const pos = start * this.stepCount;
    const idx = Math.round(pos);
    if (Math.abs(pos - idx) > 1e-6 || idx % 2 === 0) return 0;
    return this.opts.swing * this.stepDur;
  }

  private cycleEvents(track: number, line: number, cycle: number): MiniEvent[] {
    const key = `${track}:${line}:${cycle}`;
    let ev = this.cache.get(key);
    if (!ev) {
      // graine propre à chaque ligne pour décorréler les probabilités
      ev = eventsForCycle(this.tracks[track].lines[line].ast, cycle, (this.opts.seed + track * 7919 + line * 104729) >>> 0);
      this.cache.set(key, ev);
      if (this.cache.size > 2048) this.cache.clear();
    }
    return ev;
  }

  /** Événements dont l'instant tombe dans [from, to). */
  window(from: number, to: number): ScheduledEvent[] {
    const out: ScheduledEvent[] = [];
    if (to <= from) return out;
    const bar = this.barDur;
    const c0 = Math.max(0, Math.floor((from - this.t0) / bar) - 1);
    const c1 = Math.floor((to - this.t0) / bar);
    for (let cycle = c0; cycle <= c1; cycle++) {
      const cycleStart = this.t0 + cycle * bar;
      this.tracks.forEach((track, ti) => {
        track.lines.forEach((line, li) => {
          for (const e of this.cycleEvents(ti, li, cycle)) {
            const when = cycleStart + e.start * bar + this.swingOffset(e.start);
            if (when < from || when >= to) continue;
            const fields = valueToEvent(track, line, e.value);
            if (!fields) {
              this.invalid.add(`${track.target}.${line.key} : "${e.value}" n'est ni une note, ni un degré, ni x/X`);
              continue;
            }
            const durS = (e.end - e.start) * bar * track.gate;
            const notes = typeof fields.note === "string" ? fields.note.split("+").map(Number) : [fields.note];
            for (const note of notes) {
              const event: SonicNoteEvent = { ...fields, when, durS, id: `${track.target}:${line.key}:${cycle}:${e.start.toFixed(6)}:${note ?? "x"}` };
              if (note !== undefined) event.note = note;
              else delete event.note;
              out.push({ target: track.target, event });
            }
          }
        });
      });
    }
    return out.sort((a, b) => (a.event.when ?? 0) - (b.event.when ?? 0));
  }

  /** Pas de la grille dont l'instant tombe dans [from, to). */
  steps(from: number, to: number): StepTick[] {
    const out: StepTick[] = [];
    const sd = this.stepDur;
    let i = Math.ceil((from - this.t0) / sd - 1e-9);
    for (; ; i++) {
      if (i < 0) continue;
      const base = this.t0 + i * sd;
      if (base >= to) break;
      const stepInBar = i % this.stepCount;
      const when = base + (stepInBar % 2 === 1 ? this.opts.swing * sd : 0);
      if (when < from) continue;
      out.push({
        step: stepInBar,
        bar: Math.floor(i / this.stepCount),
        beat: Math.floor(stepInBar / this.opts.stepsPerBeat),
        phase: stepInBar / this.stepCount,
        when,
      });
      if (out.length > 4096) break;
    }
    return out;
  }
}
