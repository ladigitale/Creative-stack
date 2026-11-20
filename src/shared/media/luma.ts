/**
 * Mesure de luminosité d'une image et détection des fronts allumé / éteint d'un signal lumineux
 * (lampe, torche, écran qui clignote). Logique pure : `sonic-luma` l'alimente image par image.
 */

export type LumaMeasure = {
  /** Luminosité moyenne de la zone, 0..1. */
  level: number;
  /** Luminosité du point le plus clair, 0..1. */
  peak: number;
  /** Position du point le plus clair dans la zone, 0..1. */
  peakX: number;
  peakY: number;
};

/** Luminance Rec. 709 d'un tampon RGBA : moyenne, maximum et position du maximum. */
export function measureLuma(data: ArrayLike<number>, width: number, height: number): LumaMeasure {
  const n = Math.min(width * height, Math.floor(data.length / 4));
  if (n <= 0 || width <= 0) return { level: 0, peak: 0, peakX: 0.5, peakY: 0.5 };
  let sum = 0;
  let max = -1;
  let at = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const y = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
    sum += y;
    if (y > max) {
      max = y;
      at = i;
    }
  }
  const rows = Math.max(1, Math.ceil(n / width));
  return {
    level: sum / n / 255,
    peak: Math.max(0, max) / 255,
    peakX: ((at % width) + 0.5) / width,
    peakY: (Math.floor(at / width) + 0.5) / rows,
  };
}

/** Zone « x,y,w,h » en 0..1 (image entière par défaut, ou si la valeur est invalide). */
export function parseRegion(value: unknown): { x: number; y: number; w: number; h: number } {
  const full = { x: 0, y: 0, w: 1, h: 1 };
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  if (parts.length !== 4) return full;
  const [x, y, w, h] = parts.map((p) => Number(p));
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return full;
  const cx = Math.min(1, Math.max(0, x));
  const cy = Math.min(1, Math.max(0, y));
  return { x: cx, y: cy, w: Math.min(1 - cx, w), h: Math.min(1 - cy, h) };
}

export type LumaEdge = {
  /** Numéro du front (1, 2, 3…). */
  n: number;
  /** true : la lumière s'allume ; false : elle s'éteint. */
  on: boolean;
  /** Instant du front en ms (horloge de `performance.now()`), interpolé entre deux images. */
  t: number;
  /** Durée en ms de l'état qui vient de se terminer (0 pour le premier front). */
  dur: number;
  /** Valeur mesurée à l'image du front, 0..1. */
  level: number;
  /** ms entre la dernière commande de même sens (voir `mark`) et ce front ; null sans commande en attente. */
  sinceMark: number | null;
  /** Durée commandée de l'état qui se termine : ms entre les deux dernières commandes ; null si inconnue. */
  markGap: number | null;
};

export type LumaDetectorOptions = {
  /**
   * `level` (défaut) : compare la valeur à un seuil entre le sombre et le clair observés.
   * `jump` : cherche les sauts brusques de luminosité ; insensible à l'exposition automatique
   * de la caméra, qui ramène lentement l'image vers sa luminosité habituelle pendant un éclat long.
   */
  detect: "level" | "jump";
  /** Seuil fixe 0..1 (mode level) ; null : seuil automatique à mi-chemin entre le sombre et le clair observés. */
  threshold: number | null;
  /** Écart minimal sombre / clair (0..1) en dessous duquel aucun front n'est émis ; saut minimal en mode jump. */
  minContrast: number;
  /** Temps d'oubli des niveaux sombre et clair observés (et de l'ampleur des sauts), en ms. */
  adaptMs: number;
  /** Largeur de l'hystérésis, en part de l'écart sombre / clair (0..0.8, mode level). */
  hysteresis: number;
  /** Mode jump : fenêtre en ms sur laquelle un changement compte comme un saut. */
  jumpMs: number;
  /** Mode jump : part du plus grand saut récent qu'un saut doit atteindre (0..1). */
  jumpRatio: number;
  /** Durée maximale d'un état allumé en ms : au-delà, un front d'extinction est émis d'office (0 : sans limite). */
  maxOnMs: number;
};

export const LUMA_DEFAULTS: LumaDetectorOptions = {
  detect: "level",
  threshold: null,
  minContrast: 0.06,
  adaptMs: 5000,
  hysteresis: 0.2,
  jumpMs: 120,
  jumpRatio: 0.4,
  maxOnMs: 0,
};

type Sample = { t: number; v: number };

/**
 * Suit une valeur de luminosité dans le temps et émet un front à chaque passage sombre → clair
 * ou clair → sombre.
 *
 * - Mode `level` : seuil automatique entre les enveloppes basse et haute, qui se resserrent
 *   lentement (`adaptMs`) ; insensible au niveau absolu et aux dérives lentes.
 * - Mode `jump` : un front est un saut brusque (en `jumpMs`) d'au moins `jumpRatio` fois le plus
 *   grand saut récent. À préférer quand la caméra règle seule son exposition et que la lumière
 *   reste allumée plus de quelques dixièmes de seconde.
 *
 * `mark(t, on)` note l'instant d'une commande (allumer / éteindre) : le front suivant de même sens
 * porte le délai commande → lumière (`sinceMark`).
 */
export class LumaDetector {
  opts: LumaDetectorOptions;
  lo = 0;
  hi = 0;
  on = false;
  /** L'écart sombre / clair (ou le saut, en mode jump) dépasse `minContrast` : un signal est lisible. */
  signal = false;
  edges = 0;
  /** Plus grand saut récent (mode jump). */
  scale = 0;
  private prev: Sample | null = null;
  private hist: Sample[] = [];
  private lastEdgeT: number | null = null;
  private markOn: number | null = null;
  private markOff: number | null = null;
  private armedOn = false;
  private armedOff = false;

  constructor(opts: Partial<LumaDetectorOptions> = {}) {
    this.opts = { ...LUMA_DEFAULTS, ...opts };
  }

  reset(): void {
    this.lo = 0;
    this.hi = 0;
    this.on = false;
    this.signal = false;
    this.edges = 0;
    this.scale = 0;
    this.prev = null;
    this.hist = [];
    this.lastEdgeT = null;
    this.markOn = null;
    this.markOff = null;
    this.armedOn = false;
    this.armedOff = false;
  }

  /** Note l'instant d'une commande d'allumage (`on` vrai) ou d'extinction. */
  mark(t: number, on: boolean): void {
    if (on) {
      this.markOn = t;
      this.armedOn = true;
    } else {
      this.markOff = t;
      this.armedOff = true;
    }
  }

  get contrast(): number {
    return Math.max(0, this.hi - this.lo);
  }

  /** Nouvelle mesure `v` (0..1) à l'instant `t` (ms). Retourne le front détecté, sinon null. */
  feed(t: number, v: number): LumaEdge | null {
    if (!Number.isFinite(t) || !Number.isFinite(v)) return null;
    const prev = this.prev;
    this.prev = { t, v };
    if (!prev) {
      this.lo = v;
      this.hi = v;
      this.hist = [{ t, v }];
      return null;
    }
    const dt = Math.min(1000, Math.max(0, t - prev.t));
    const k = this.opts.adaptMs > 0 ? 1 - Math.exp(-dt / this.opts.adaptMs) : 1;
    this.lo = v < this.lo ? v : this.lo + (v - this.lo) * k;
    this.hi = v > this.hi ? v : this.hi + (v - this.hi) * k;
    const at = this.opts.detect === "jump" ? this.jump(t, v, k) : this.level(t, v, prev);
    this.hist.push({ t, v });
    const keep = t - Math.max(500, this.opts.jumpMs * 3);
    while (this.hist.length > 2 && this.hist[0].t < keep) this.hist.shift();
    return at === null ? null : this.emit(at, v);
  }

  /** Seuil entre sombre et clair : instant du passage, sinon null. */
  private level(t: number, v: number, prev: Sample): number | null {
    let up: number;
    let down: number;
    const fixed = this.opts.threshold;
    if (fixed !== null && Number.isFinite(fixed)) {
      this.signal = true;
      up = fixed + 0.02;
      down = fixed - 0.02;
    } else {
      const c = this.hi - this.lo;
      this.signal = c >= this.opts.minContrast;
      if (!this.signal) return null;
      const h = Math.min(0.8, Math.max(0, this.opts.hysteresis)) / 2;
      up = this.lo + c * (0.5 + h);
      down = this.lo + c * (0.5 - h);
    }
    const next = !this.on && v > up ? true : this.on && v < down ? false : this.on;
    if (next === this.on) return this.overdue(t);
    const thr = next ? up : down;
    let tc = t;
    if (v !== prev.v && (next ? prev.v < thr : prev.v > thr)) {
      tc = prev.t + ((thr - prev.v) / (v - prev.v)) * (t - prev.t);
      tc = Math.min(t, Math.max(prev.t, tc));
    }
    return tc;
  }

  /** Saut brusque par rapport aux mesures des `jumpMs` précédentes : instant du saut, sinon null. */
  private jump(t: number, v: number, k: number): number | null {
    const from = t - Math.max(1, this.opts.jumpMs);
    // Fenêtre : les mesures récentes, et toujours au moins la précédente (caméra lente).
    let start = this.hist.length - 1;
    while (start > 0 && this.hist[start - 1].t >= from) start--;
    let min = Infinity;
    let max = -Infinity;
    for (let i = start; i < this.hist.length; i++) {
      min = Math.min(min, this.hist[i].v);
      max = Math.max(max, this.hist[i].v);
    }
    const rise = v - min;
    const fall = max - v;
    this.scale = Math.max(rise, fall, this.scale * (1 - k));
    this.signal = this.scale >= this.opts.minContrast;
    const need = Math.max(this.opts.minContrast, Math.min(1, Math.max(0, this.opts.jumpRatio)) * this.scale);
    const next = !this.on && rise > need ? true : this.on && fall > need ? false : this.on;
    if (next === this.on) return this.overdue(t);
    // Instant : milieu du plus grand pas entre deux mesures consécutives de la fenêtre.
    const seq = [...this.hist.slice(start), { t, v }];
    let best = 0;
    let tc = t;
    for (let i = 1; i < seq.length; i++) {
      const step = next ? seq[i].v - seq[i - 1].v : seq[i - 1].v - seq[i].v;
      if (step > best) {
        best = step;
        tc = (seq[i - 1].t + seq[i].t) / 2;
      }
    }
    return tc;
  }

  /** État allumé trop long (`maxOnMs`) : extinction d'office à l'instant `t`. */
  private overdue(t: number): number | null {
    const max = this.opts.maxOnMs;
    if (!this.on || !(max > 0) || this.lastEdgeT === null || t - this.lastEdgeT <= max) return null;
    return t;
  }

  private emit(tc: number, v: number): LumaEdge {
    const next = !this.on;
    this.on = next;
    this.edges++;
    const dur = this.lastEdgeT === null ? 0 : tc - this.lastEdgeT;
    this.lastEdgeT = tc;
    let sinceMark: number | null = null;
    let markGap: number | null = null;
    if (next) {
      if (this.armedOn && this.markOn !== null) sinceMark = tc - this.markOn;
      this.armedOn = false;
      if (this.markOn !== null && this.markOff !== null && this.markOff <= this.markOn) markGap = this.markOn - this.markOff;
    } else {
      if (this.armedOff && this.markOff !== null) sinceMark = tc - this.markOff;
      this.armedOff = false;
      if (this.markOn !== null && this.markOff !== null && this.markOn <= this.markOff) markGap = this.markOff - this.markOn;
    }
    return { n: this.edges, on: next, t: tc, dur, level: v, sinceMark, markGap };
  }
}
