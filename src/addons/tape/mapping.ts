/**
 * Conversion de signaux de pilotage (capteurs, curseur, nombres d'un DataProvider)
 * en vitesse de lecture signée (1 = normal, −1 = à l'envers, 0 = arrêt). Fonctions pures.
 */

/** 33⅓ tours/min en °/s : une platine tournant à cette vitesse lit à 1×. */
export const TURNTABLE_33_DEG_PER_SEC = (33 + 1 / 3) * 6;

/** Rattrapage d'un écart de position : fermer l'écart en ce nombre de secondes. */
export const SCRUB_CATCHUP_S = 0.028;
/** Écart (échantillons) en dessous duquel la lecture s'arrête (cible atteinte). */
export const SCRUB_SNAP_SAMPLES = 48;
/** |vitesse| en dessous de laquelle la lecture est considérée arrêtée. */
export const RATE_EPS = 1e-3;

const fin = (n: number) => (Number.isFinite(n) ? n : 0);

export function deadzone(v: number, eps: number): number {
  return Math.abs(v) < eps ? 0 : v;
}

/** Lissage exponentiel (constante de temps `tauMs`). */
export function ema(prev: number, instant: number, dtMs: number, tauMs: number): number {
  if (!(dtMs > 0) || !Number.isFinite(instant) || !Number.isFinite(prev)) return prev;
  if (!(tauMs > 0)) return instant;
  return prev + (instant - prev) * (1 - Math.exp(-dtMs / tauMs));
}

/** Vitesse angulaire du plateau (°/s, signée) → vitesse de lecture. Pas de plafond. */
export function omegaToRate(omegaDegPerSec: number, refDegPerSec = TURNTABLE_33_DEG_PER_SEC): number {
  if (!(refDegPerSec > 0)) return 0;
  return fin(omegaDegPerSec / refDegPerSec);
}

/** Vitesse pour rejoindre `errorSamples` (cible − position) en `catchupS` secondes. */
export function scrubRate(errorSamples: number, sampleRate: number, catchupS = SCRUB_CATCHUP_S, snap = SCRUB_SNAP_SAMPLES): number {
  if (!(sampleRate > 0) || !(catchupS > 0) || !Number.isFinite(errorSamples)) return 0;
  if (Math.abs(errorSamples) <= snap) return 0;
  return fin(errorSamples / (sampleRate * catchupS));
}

/** Filtre passe-haut du 1er ordre : retire la composante lente (gravité d'un accéléromètre). */
export class HighPass {
  private x = 0;
  private y = 0;
  private primed = false;

  constructor(public tauMs = 300) {}

  feed(value: number, dtMs: number): number {
    if (!this.primed) {
      this.primed = true;
      this.x = value;
      this.y = 0;
      return 0;
    }
    const a = this.tauMs / (this.tauMs + Math.max(0, dtMs));
    this.y = a * (this.y + value - this.x);
    this.x = value;
    return this.y;
  }

  reset(): void {
    this.primed = false;
    this.x = 0;
    this.y = 0;
  }
}

/** Intégrateur à fuite : accélération → vitesse qui revient seule vers 0. */
export class LeakyIntegrator {
  value = 0;

  constructor(public leakMs = 400) {}

  feed(x: number, dtMs: number): number {
    const dt = Math.max(0, dtMs);
    this.value = this.value * (this.leakMs > 0 ? Math.exp(-dt / this.leakMs) : 0) + x * (dt / 1000);
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}

export type RateMode = "rate" | "omega" | "accel";

export type RateMapperOptions = {
  mode: RateMode;
  /** rate : multiplicateur ; omega : °/s de référence pour 1× (défaut 200) ; accel : vitesse de lecture par m/s. */
  scale: number;
  /** Zone morte sur le signal entrant. */
  deadzone: number;
  /** Lissage de la vitesse (ms), 0 = aucun. */
  smoothMs: number;
  /** accel : constante du passe-haut (ms) et fuite de l'intégrateur (ms). */
  highpassMs: number;
  leakMs: number;
};

export const DEFAULT_MAPPER: RateMapperOptions = {
  mode: "rate",
  scale: 1,
  deadzone: 0,
  smoothMs: 40,
  highpassMs: 300,
  leakMs: 400,
};

/**
 * Transforme un flux de valeurs brutes en vitesse de lecture signée.
 * - `rate` : valeur × scale ;
 * - `omega` : °/s → vitesse (platine), `scale` = °/s pour 1× ;
 * - `accel` : accélération avec gravité (m/s²) → passe-haut → intégrée en vitesse (à fuite) × scale.
 */
export class RateMapper {
  readonly opts: RateMapperOptions;
  private hp: HighPass;
  private integ: LeakyIntegrator;
  private smooth = 0;
  private last = 0;

  constructor(opts: Partial<RateMapperOptions> = {}) {
    this.opts = { ...DEFAULT_MAPPER, ...opts };
    this.hp = new HighPass(this.opts.highpassMs);
    this.integ = new LeakyIntegrator(this.opts.leakMs);
  }

  /** `nowMs` : horloge monotone (performance.now). Retourne la vitesse lissée. */
  feed(value: number, nowMs: number): number {
    const dt = this.last ? Math.min(250, Math.max(0, nowMs - this.last)) : 16;
    this.last = nowMs;
    if (!Number.isFinite(value)) return this.smooth;
    const o = this.opts;
    let instant: number;
    if (o.mode === "omega") instant = omegaToRate(deadzone(value, o.deadzone), o.scale > 0 && o.scale !== 1 ? o.scale : TURNTABLE_33_DEG_PER_SEC);
    else if (o.mode === "accel") {
      const a = deadzone(this.hp.feed(value, dt), o.deadzone);
      instant = this.integ.feed(a, dt) * o.scale;
    } else instant = deadzone(value, o.deadzone) * o.scale;
    this.smooth = o.smoothMs > 0 ? ema(this.smooth, instant, dt, o.smoothMs) : instant;
    return Math.abs(this.smooth) < RATE_EPS ? 0 : this.smooth;
  }

  reset(): void {
    this.hp.reset();
    this.integ.reset();
    this.smooth = 0;
    this.last = 0;
  }
}
