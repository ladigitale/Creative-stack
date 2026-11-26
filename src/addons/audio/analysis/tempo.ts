/**
 * Tempo : la fonction d'attaque (nouveauté du flux spectral) est rangée sur une
 * grille régulière (`OnsetEnvelope`), son autocorrélation donne la période
 * (peigne de 4 multiples, préférence douce autour de 120 BPM pour lever
 * l'ambiguïté d'octave), puis la phase est calée sur les attaques
 * (`estimateTempo`). `BeatClock` compte les temps entre deux estimations.
 * Fonctions pures, sans WebAudio.
 */

/** Fonction d'attaque sur une grille de `fps` cases, gardée `seconds` secondes. */
export class OnsetEnvelope {
  readonly size: number;
  private buf: Float32Array;
  private lastBin = -1;
  private filled = 0;

  constructor(
    readonly fps = 50,
    seconds = 8,
  ) {
    this.size = Math.max(8, Math.round(fps * seconds));
    this.buf = new Float32Array(this.size);
  }

  reset(): void {
    this.buf.fill(0);
    this.lastBin = -1;
    this.filled = 0;
  }

  /** Valeur mesurée à `tMs` (cases sautées = 0, même case = maximum). */
  add(tMs: number, value: number): void {
    const bin = Math.floor((tMs * this.fps) / 1000);
    const v = Number.isFinite(value) && value > 0 ? value : 0;
    if (this.lastBin < 0) {
      this.lastBin = bin;
      this.buf[bin % this.size] = v;
      this.filled = 1;
      return;
    }
    if (bin < this.lastBin) return;
    if (bin === this.lastBin) {
      const i = bin % this.size;
      this.buf[i] = Math.max(this.buf[i], v);
      return;
    }
    const gap = Math.min(this.size, bin - this.lastBin);
    for (let k = 1; k < gap; k++) this.buf[(bin - k) % this.size] = 0;
    this.buf[bin % this.size] = v;
    this.filled = Math.min(this.size, this.filled + (bin - this.lastBin));
    this.lastBin = bin;
  }

  /** Instant (ms) de la dernière case. */
  get endMs(): number {
    return ((this.lastBin + 1) * 1000) / this.fps;
  }

  /** Cases remplies, de la plus ancienne à la plus récente. */
  values(): Float32Array {
    const out = new Float32Array(this.filled);
    for (let k = 0; k < this.filled; k++) out[k] = this.buf[(this.lastBin - this.filled + 1 + k + this.size * 4) % this.size];
    return out;
  }
}

export type TempoEstimate = {
  bpm: number;
  /** 0..1 : autocorrélation normalisée à la période trouvée. */
  confidence: number;
  /** Secondes écoulées entre le dernier temps estimé et la fin de l'enveloppe. */
  lastBeatAgo: number;
};

export type TempoOptions = { minBpm?: number; maxBpm?: number; /** BPM préféré en cas d'ambiguïté d'octave (défaut 120). */ prefer?: number };

/** BPM d'une fonction d'attaque échantillonnée à `fps` ; null si trop courte ou plate. */
export function estimateTempo(env: ArrayLike<number>, fps: number, opts: TempoOptions = {}): TempoEstimate | null {
  const minBpm = Math.max(20, opts.minBpm ?? 60);
  const maxBpm = Math.max(minBpm + 1, opts.maxBpm ?? 200);
  const prefer = opts.prefer ?? 120;
  const n = env.length;
  if (n < fps * 2.5) return null;
  // lissage léger (gigue des images) puis centrage
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.25 * (env[Math.max(0, i - 1)] ?? 0) + 0.5 * env[i] + 0.25 * (env[Math.min(n - 1, i + 1)] ?? 0);
  const smooth = Float32Array.from(x);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  for (let i = 0; i < n; i++) x[i] -= mean;

  const lagMin = (60 * fps) / maxBpm;
  const lagMax = (60 * fps) / minBpm;
  const maxLag = Math.min(n - 2, Math.ceil(lagMax * 4) + 2);
  const r = new Float32Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    r[lag] = s / (n - lag);
  }
  if (!(r[0] > 1e-12)) return null;
  for (let lag = maxLag; lag >= 0; lag--) r[lag] /= r[0];
  const at = (p: number) => {
    const i = Math.floor(p);
    if (i < 0 || i + 1 > maxLag) return 0;
    const f = p - i;
    return r[i] * (1 - f) + r[i + 1] * f;
  };
  const comb = (p: number) => {
    let s = 0;
    let k = 0;
    for (let m = 1; m <= 4 && m * p <= maxLag - 1; m++, k++) s += at(m * p);
    return k ? s / k : 0;
  };
  const weight = (p: number) => Math.exp(-0.5 * Math.pow(Math.log2((60 * fps) / p / prefer), 2));

  let best = -1;
  let bestScore = -Infinity;
  // pas fractionnaire : une période entière fausse de 0,4 case décale ses multiples hors du pic
  for (let lag = lagMin; lag <= lagMax && lag <= maxLag - 1; lag += 0.25) {
    const s = comb(lag) * weight(lag);
    if (s > bestScore) {
      bestScore = s;
      best = lag;
    }
  }
  if (best < 0) return null;
  // ambiguïté d'octave : si la moitié de la période est aussi marquée (pulsation deux fois plus rapide dans la plage), on la garde
  while (best / 2 >= lagMin && comb(best / 2) >= 0.85 * comb(best)) best /= 2;
  // affinage fractionnaire : les multiples de la période précisent la mesure
  let p = best;
  let pScore = comb(best);
  for (let q = best - 0.3; q <= best + 0.3; q += 0.02) {
    if (q < lagMin * 0.98 || q > lagMax * 1.02) continue;
    const s = comb(q);
    if (s > pScore) {
      pScore = s;
      p = q;
    }
  }
  const confidence = Math.max(0, Math.min(1, at(p)));

  // phase : décalage qui aligne le mieux un peigne de période p sur les attaques récentes
  let bestO = 0;
  let bestS = -Infinity;
  const span = Math.ceil(p);
  for (let o = 0; o < span; o++) {
    let s = 0;
    for (let pos = n - 1 - o; pos >= 0; pos -= p) {
      const i = Math.floor(pos);
      const f = pos - i;
      s += smooth[i] * (1 - f) + (smooth[i + 1] ?? 0) * f;
    }
    if (s > bestS) {
      bestS = s;
      bestO = o;
    }
  }
  return { bpm: +((60 * fps) / p).toFixed(1), confidence: +confidence.toFixed(3), lastBeatAgo: (bestO + 0.5) / fps };
}

/** Compteur de temps : avance au rythme estimé, recalé à chaque nouvelle estimation. */
export class BeatClock {
  count = 0;
  private anchor = 0;
  private period = 0;
  private lastBeat = -Infinity;

  reset(): void {
    this.count = 0;
    this.period = 0;
    this.lastBeat = -Infinity;
  }

  /** Nouvelle estimation : `anchorMs` = instant d'un temps, `bpm`. */
  sync(anchorMs: number, bpm: number): void {
    if (!(bpm > 0)) return;
    this.anchor = anchorMs;
    this.period = 60000 / bpm;
  }

  /** À appeler à chaque image : `beat` vrai quand un temps est passé depuis l'appel précédent. */
  update(nowMs: number): { beat: boolean; count: number; phase: number } {
    const p = this.period;
    if (!p) return { beat: false, count: this.count, phase: 0 };
    const k = Math.ceil((Math.max(this.lastBeat + p * 0.5, nowMs - p * 0.5) - this.anchor) / p);
    const next = this.anchor + k * p;
    let beat = false;
    if (nowMs >= next) {
      beat = true;
      this.count++;
      this.lastBeat = next;
    }
    const phase = (((nowMs - this.anchor) / p) % 1 + 1) % 1;
    return { beat, count: this.count, phase: +phase.toFixed(3) };
  }
}
