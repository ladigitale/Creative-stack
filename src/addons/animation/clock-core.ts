/**
 * Horloge pure : position normalisée `t` (0..1) qui avance de `dt` secondes.
 * Aucun accès au DOM ni à `performance.now` : l'élément `sonic-clock` fournit les dt.
 */
import type { ClockMode, ClockSnapshot } from "./types";

export class ClockCore {
  t = 0;
  playing = false;
  rate = 1;
  direction: 1 | -1 = 1;
  mode: ClockMode = "once";
  duration = 1;

  /** Avance de `dtSeconds`. Renvoie true si `t` ou `playing` a changé. */
  advance(dtSeconds: number): boolean {
    if (!this.playing || !(dtSeconds > 0) || !(this.duration > 0)) return false;
    const before = this.t;
    const wasPlaying = this.playing;
    let t = this.t + (dtSeconds * this.rate * this.direction) / this.duration;

    if (this.mode === "loop") {
      t = ((t % 1) + 1) % 1;
    } else if (this.mode === "pingpong") {
      // Réflexions successives aux bornes.
      let guard = 0;
      while ((t > 1 || t < 0) && guard++ < 8) {
        if (t > 1) t = 2 - t;
        else t = -t;
        this.direction = this.direction === 1 ? -1 : 1;
      }
      t = Math.min(1, Math.max(0, t));
    } else if (t >= 1 && this.rate * this.direction > 0) {
      t = 1;
      this.playing = false;
    } else if (t <= 0 && this.rate * this.direction < 0) {
      t = 0;
      this.playing = false;
    }
    this.t = t;
    return t !== before || this.playing !== wasPlaying;
  }

  seek(t: number): void {
    this.t = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  }

  play(): void {
    // Rejouer depuis le début si le mode `once` est arrivé au bout.
    if (this.mode === "once") {
      if (this.rate * this.direction > 0 && this.t >= 1) this.t = 0;
      else if (this.rate * this.direction < 0 && this.t <= 0) this.t = 1;
    }
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  snapshot(origin: string): ClockSnapshot {
    return {
      t: this.t,
      time: this.t * this.duration,
      duration: this.duration,
      playing: this.playing,
      rate: this.rate,
      direction: this.direction,
      origin,
    };
  }
}
