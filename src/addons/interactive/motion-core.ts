/**
 * Cœur de `sonic-motion` : vitesse, accélération et pic de vitesse lissés d'une ou plusieurs valeurs qui
 * changent dans le temps (position d'une main, ouverture de la bouche…). Sans DOM : testable sous node.
 */

export type MotionOptions = {
  /** Constante de temps du lissage de la vitesse (ms) ; 0 = aucun lissage. */
  smoothMs: number;
  /** Vitesse (unités par seconde) qui correspond à `vel` = 1. */
  speedMax: number;
  /** Sans nouvelle valeur pendant ce temps (ms), la vitesse retombe doucement vers 0. */
  idleMs: number;
  /** Fenêtre (ms) sur laquelle on garde le pic de vitesse. */
  peakMs: number;
};

export type MotionOutput = {
  /** Première valeur suivie (valeur courante). */
  value: number;
  values: number[];
  /** Unités par seconde ; signée avec une seule valeur, norme du déplacement avec plusieurs. */
  speed: number;
  /** Unités par seconde au carré, lissée comme la vitesse. */
  accel: number;
  /** |speed| / speedMax, bornée à 0..1 : directement utilisable comme vélocité MIDI. */
  vel: number;
  /** Plus grande |vitesse| des `peakMs` dernières millisecondes. */
  peak: number;
  /** `peak` ramenée à 0..1 : vélocité d'un geste (le coup, pas l'instant). */
  peakVel: number;
  moving: boolean;
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const MAX_GAP_S = 0.5;
const MOVING_RATIO = 0.02;

export class MotionTracker {
  private prev: number[] | null = null;
  private prevT = 0;
  private speed = 0;
  private accel = 0;
  private lastT: number | null = null;
  private lastIdleT = 0;
  private peaks: Array<{ t: number; v: number }> = [];
  private lastValues: number[] = [];

  constructor(public opts: MotionOptions) {}

  reset(): void {
    this.prev = null;
    this.speed = 0;
    this.accel = 0;
    this.lastT = null;
    this.peaks = [];
    this.lastValues = [];
  }

  private alpha(dtS: number): number {
    const tau = Math.max(0, this.opts.smoothMs) / 1000;
    return tau === 0 ? 1 : 1 - Math.exp(-dtS / tau);
  }

  private prune(now: number): void {
    const from = now - Math.max(0, this.opts.peakMs);
    while (this.peaks.length && this.peaks[0].t < from) this.peaks.shift();
  }

  private output(): MotionOutput {
    const max = this.opts.speedMax > 0 ? this.opts.speedMax : 1;
    const peak = this.peaks.reduce((m, p) => (p.v > m ? p.v : m), 0);
    return {
      value: this.lastValues[0] ?? 0,
      values: [...this.lastValues],
      speed: this.speed,
      accel: this.accel,
      vel: clamp01(Math.abs(this.speed) / max),
      peak,
      peakVel: clamp01(peak / max),
      moving: Math.abs(this.speed) > MOVING_RATIO * max,
    };
  }

  /** Nouvelle mesure (temps en ms) ; retourne la sortie à publier. */
  update(now: number, values: number[]): MotionOutput {
    this.lastValues = values;
    const dtS = this.prev ? (now - this.prevT) / 1000 : 0;
    if (!this.prev || this.prev.length !== values.length || dtS <= 0 || dtS > MAX_GAP_S) {
      // Première mesure, forme différente ou trou trop long : on repart sans vitesse.
      this.prev = values;
      this.prevT = now;
      this.lastT = now;
      this.speed = 0;
      this.accel = 0;
      this.peaks = [];
      return this.output();
    }
    const dt = Math.max(dtS, 1e-3);
    let raw: number;
    if (values.length === 1) {
      raw = (values[0] - this.prev[0]) / dt;
    } else {
      let sum = 0;
      for (let i = 0; i < values.length; i++) sum += (values[i] - this.prev[i]) ** 2;
      raw = Math.sqrt(sum) / dt;
    }
    const a = this.alpha(dt);
    const next = this.speed + (raw - this.speed) * a;
    const rawAccel = (next - this.speed) / dt;
    this.accel = this.accel + (rawAccel - this.accel) * a;
    this.speed = next;
    this.prev = values;
    this.prevT = now;
    this.lastT = now;
    this.peaks.push({ t: now, v: Math.abs(this.speed) });
    this.prune(now);
    return this.output();
  }

  /**
   * Appelée à intervalle régulier : sans mesure récente, la vitesse retombe vers 0. Retourne la sortie à
   * publier, ou null s'il n'y a rien à changer.
   */
  idle(now: number): MotionOutput | null {
    if (this.lastT === null || now - this.lastT <= Math.max(0, this.opts.idleMs)) return null;
    const settled = this.speed === 0 && this.accel === 0 && this.peaks.length === 0;
    if (settled) return null;
    const dtS = Math.max(0, (now - Math.max(this.lastIdleT, this.lastT)) / 1000);
    this.lastIdleT = now;
    const tau = Math.max(Math.max(0, this.opts.smoothMs), 30) / 1000;
    this.speed *= Math.exp(-dtS / tau);
    if (Math.abs(this.speed) < 1e-4) this.speed = 0;
    this.accel = 0;
    this.prune(now);
    return this.output();
  }
}

/** Hauteur MIDI d'une valeur 0..1 sur la plage [lo, hi], arrondie ou calée sur une gamme (décalages en demi-tons depuis `lo`). */
export function quantizeNote(v: number, lo: number, hi: number, scale?: readonly number[] | null): number {
  const a = Math.round(Math.min(lo, hi));
  const b = Math.round(Math.max(lo, hi));
  const raw = a + clamp01(Number.isFinite(v) ? v : 0) * (b - a);
  const centre = Math.round(raw);
  if (!scale || scale.length === 0) return Math.max(a, Math.min(b, centre));
  const allowed = new Set(scale.map((s) => ((Math.round(s) % 12) + 12) % 12));
  let best = Math.max(a, Math.min(b, centre));
  let bestDist = Number.POSITIVE_INFINITY;
  for (let n = a; n <= b; n++) {
    if (!allowed.has((n - a) % 12)) continue;
    const d = Math.abs(n - raw);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  return best;
}

/** « 48,72 » → [48, 72] ; undefined si illisible. */
export function parseRange(text: string): [number, number] | undefined {
  const p = text.split(",").map((s) => Number(s.trim()));
  if (p.length !== 2 || !p.every((n) => Number.isFinite(n) && n >= 0 && n <= 127)) return undefined;
  return [p[0], p[1]];
}

/** « 0,2,4,7,9 » → [0, 2, 4, 7, 9] ; undefined si vide ou illisible. */
export function parseScale(text: string): number[] | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const p = t.split(",").map((s) => Number(s.trim()));
  return p.every((n) => Number.isFinite(n)) ? p : undefined;
}
