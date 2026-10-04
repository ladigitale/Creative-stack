/**
 * Lecteur de morceau à ordonnancement anticipé (lookahead) : le moteur appelle
 * `schedule(horizon)` régulièrement, le lecteur programme les pas dont l'instant
 * tombe avant l'horizon. Indépendant de WebAudio pour être testable.
 */
import type { NoteEvent, ResolvedSong } from "./types";

export type SongPosition = {
  /** Index dans la séquence. */
  index: number;
  pattern: string;
  /** Pas dans le motif courant. */
  step: number;
  /** Mesure et temps depuis le début (0-based). */
  bar: number;
  beat: number;
  /** Nombre de bouclages effectués. */
  loops: number;
};

export type SongCallbacks = {
  /** Programme un événement de note à `time`, tenu `hold` secondes. */
  note: (event: NoteEvent, time: number, hold: number) => void;
  /** Début d'un temps (pour la publication de position). */
  beat?: (pos: SongPosition, time: number) => void;
  /** Fin d'un morceau non bouclé. */
  end?: (time: number) => void;
};

export class SongPlayer {
  readonly song: ResolvedSong;
  private cb: SongCallbacks;
  private index = 0;
  private step = 0;
  private tick = 0;
  private loops = 0;
  private nextTime = 0;
  private running = false;
  ended = false;

  constructor(song: ResolvedSong, callbacks: SongCallbacks) {
    this.song = song;
    this.cb = callbacks;
  }

  get stepDur(): number {
    return 60 / this.song.bpm / this.song.steps;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(time: number): void {
    this.index = 0;
    this.step = 0;
    this.tick = 0;
    this.loops = 0;
    this.ended = false;
    this.nextTime = time;
    this.running = true;
  }

  /** Reprise après pause : le pas suivant tombe à `time`. */
  resume(time: number): void {
    if (this.ended) return;
    this.nextTime = time;
    this.running = true;
  }

  pause(): void {
    this.running = false;
  }

  position(): SongPosition {
    const perBar = this.song.steps * this.song.beats;
    return {
      index: this.index,
      pattern: this.song.sequence[this.index] ?? "",
      step: this.step,
      bar: Math.floor(this.tick / perBar),
      beat: Math.floor(this.tick / this.song.steps) % this.song.beats,
      loops: this.loops,
    };
  }

  /** Programme tous les pas qui commencent avant `horizon`. */
  schedule(horizon: number): void {
    let guard = 0;
    while (this.running && this.nextTime < horizon && guard++ < 1024) {
      this.playStep(this.nextTime);
      this.advance();
    }
  }

  private playStep(time: number): void {
    const s = this.song;
    const pattern = s.patterns[s.sequence[this.index]];
    const swing = this.step % 2 === 1 ? s.swing * this.stepDur : 0;
    const t = time + swing;
    if (this.tick % s.steps === 0) this.cb.beat?.(this.position(), t);
    for (const ev of pattern.events[this.step] ?? []) {
      // Une frappe isolée garde la durée de l'instrument (hold = -1 → défaut).
      const hold = ev.midi === null && ev.length === 1 ? -1 : ev.length * this.stepDur * 0.92;
      this.cb.note(ev, t, hold);
    }
  }

  private advance(): void {
    const s = this.song;
    this.nextTime += this.stepDur;
    this.tick++;
    this.step++;
    if (this.step < s.patterns[s.sequence[this.index]].length) return;
    this.step = 0;
    this.index++;
    if (this.index < s.sequence.length) return;
    if (s.loop) {
      this.index = s.loopFrom;
      this.loops++;
      return;
    }
    this.running = false;
    this.ended = true;
    this.index = s.sequence.length - 1;
    this.cb.end?.(this.nextTime);
  }
}
