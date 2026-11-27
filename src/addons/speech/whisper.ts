/**
 * Reconnaissance locale de `sonic-listen engine="whisper"` : découpage du micro en phrases
 * (détection de silence sur l'énergie), rééchantillonnage en 16 kHz mono, accès au registre
 * de modèles de l'addon hugging-face-infer (liste blanche, consentement, téléchargement, cache,
 * worker), sans dupliquer ce module.
 */
import type { HfModelState, HuggingFaceRegistry } from "../hugging-face-infer";

/** Fréquence attendue par Whisper. */
export const WHISPER_RATE = 16_000;
/** Alias par défaut : le plus petit Whisper multilingue de la liste blanche de l'application. */
export const DEFAULT_WHISPER_MODEL = "whisper-tiny";
/** Silence (ms) qui termine une phrase. */
export const DEFAULT_SILENCE_MS = 700;
/** Durée maximale d'un segment envoyé au modèle (Whisper travaille par fenêtres de 30 s). */
export const MAX_SEGMENT_MS = 15_000;
/** Seuil RMS par défaut (0..1) au-dessus duquel une trame compte comme de la parole. */
export const DEFAULT_THRESHOLD = 0.01;
/**
 * Marge du seuil adaptatif au-dessus du bruit de fond : bruit × 2, ou bruit + `NOISE_MARGIN` si c'est moins. Sur
 * téléphone, le gain automatique du micro remonte le bruit dans les silences : avec bruit × 3, le seuil passait
 * au-dessus de la voix et plus rien n'était détecté.
 */
export const NOISE_MARGIN = 0.02;
/** Bruit de fond retenu au plus pendant l'écoute de démarrage (au-delà, c'est déjà de la voix). */
const WARMUP_NOISE_MAX = 0.04;

/* ------------------------------------------------------------------ */
/* Signal                                                              */
/* ------------------------------------------------------------------ */

/** Énergie efficace (RMS) d'une trame, 0..1 pour un signal normalisé. */
export function rms(frame: Float32Array, start = 0, end = frame.length): number {
  const n = end - start;
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / n);
}

/** Moyenne des canaux → mono. */
export function downmix(channels: readonly Float32Array[]): Float32Array {
  if (!channels.length) return new Float32Array(0);
  if (channels.length === 1) return channels[0].slice();
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i];
  for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}

/**
 * Rééchantillonne `input` de `from` Hz vers `to` Hz (16 kHz par défaut). En descente, chaque
 * échantillon est la moyenne de la fenêtre qu'il couvre (filtre anti-repliement simple, fréquences
 * non entières comprises : 44,1 kHz) ; en montée, interpolation linéaire.
 */
export function resample(input: Float32Array, from: number, to = WHISPER_RATE): Float32Array {
  if (!(from > 0) || !(to > 0) || !input.length) return new Float32Array(0);
  if (from === to) return input.slice();
  const ratio = from / to;
  const len = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(len);
  if (ratio > 1) {
    for (let i = 0; i < len; i++) {
      const a = Math.floor(i * ratio);
      const b = Math.min(input.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let k = a; k < b; k++) sum += input[k];
      out[i] = sum / (b - a);
    }
  } else {
    for (let i = 0; i < len; i++) {
      const x = i * ratio;
      const a = Math.floor(x);
      const b = Math.min(input.length - 1, a + 1);
      const t = x - a;
      out[i] = input[a] * (1 - t) + input[b] * t;
    }
  }
  return out;
}

function concat(chunks: readonly Float32Array[]): Float32Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export type SegmenterOptions = {
  sampleRate: number;
  /** Silence qui termine une phrase (ms), défaut 700. */
  silenceMs?: number;
  /** Longueur maximale d'un segment (ms), défaut 15 000 : coupé au-delà, l'écoute continue. */
  maxMs?: number;
  /** Seuil RMS de parole, défaut 0,015 ; relevé si le bruit de fond est plus fort. */
  threshold?: number;
  /** Parole minimale (ms) d'un segment : en dessous (clic, souffle), il est ignoré. Défaut 200. */
  minSpeechMs?: number;
  /** Audio gardé avant le début détecté (ms), pour ne pas couper la première syllabe. Défaut 300. */
  preRollMs?: number;
  /** Trame d'analyse (ms), défaut 30. */
  frameMs?: number;
  /** Écoute du bruit de fond avant de chercher la parole (ms, 300). */
  warmupMs?: number;
};

/**
 * Détection d'activité vocale (VAD) sur l'énergie RMS, par trames de 30 ms : une phrase commence
 * à la première trame au-dessus du seuil et se termine après `silenceMs` de silence, ou à
 * `maxMs`. Le seuil effectif suit le bruit de fond (2 fois son niveau moyen, ou + `NOISE_MARGIN` si c'est moins,
 * au moins `threshold`), mesuré pendant `warmupMs` avant de chercher la parole. `push` rend les segments terminés, à la fréquence d'entrée.
 */
export class SpeechSegmenter {
  readonly sampleRate: number;
  private readonly frame: number;
  private readonly silenceMax: number;
  private readonly segmentMax: number;
  private readonly minSpeech: number;
  private readonly preRollMax: number;
  private readonly threshold: number;
  private noise = 0;
  /** Trames d'écoute du bruit de fond au démarrage (aucune parole cherchée pendant ce temps). */
  private warm = 0;
  private readonly warmFrames: number;
  /** Énergie RMS de la dernière trame (niveau du micro, pour un vumètre). */
  lastEnergy = 0;
  private speaking = false;
  private chunks: Float32Array[] = [];
  private length = 0;
  private voiced = 0;
  private silence = 0;
  private preRoll: Float32Array[] = [];
  private preRollLen = 0;
  /** Reste d'un bloc qui ne remplit pas une trame entière. */
  private carry = new Float32Array(0);

  constructor(o: SegmenterOptions) {
    this.sampleRate = o.sampleRate;
    const ms = (v: number) => Math.max(1, Math.round((v / 1000) * o.sampleRate));
    this.frame = ms(o.frameMs ?? 30);
    this.silenceMax = ms(Math.max(100, o.silenceMs ?? DEFAULT_SILENCE_MS));
    this.segmentMax = ms(Math.min(MAX_SEGMENT_MS * 2, Math.max(1000, o.maxMs ?? MAX_SEGMENT_MS)));
    this.minSpeech = ms(o.minSpeechMs ?? 200);
    this.preRollMax = ms(o.preRollMs ?? 300);
    this.threshold = Math.max(0.0005, o.threshold ?? DEFAULT_THRESHOLD);
    // 300 ms de bruit de fond mesuré avant de chercher la parole : sinon, dans une pièce bruyante, le bruit des
    // premières trames ouvrait une « phrase » qui ne se fermait qu'au bout de maxMs (15 s).
    this.warmFrames = Math.max(1, Math.round((o.warmupMs ?? 300) / (o.frameMs ?? 30)));
  }

  /** Une phrase est en cours. */
  get inSpeech(): boolean {
    return this.speaking;
  }

  /** Seuil effectif (bruit de fond compris). */
  get level(): number {
    return Math.max(this.threshold, Math.min(this.noise * 2, this.noise + NOISE_MARGIN));
  }

  push(block: Float32Array): Float32Array[] {
    const out: Float32Array[] = [];
    const data = this.carry.length ? concat([this.carry, block]) : block;
    let i = 0;
    for (; i + this.frame <= data.length; i += this.frame) {
      const seg = this.step(data.subarray(i, i + this.frame));
      if (seg) out.push(seg);
    }
    this.carry = data.slice(i);
    return out;
  }

  /** Termine la phrase en cours (arrêt de l'écoute) ; `null` s'il n'y avait pas assez de parole. */
  flush(): Float32Array | null {
    if (this.carry.length && this.speaking) this.append(this.carry.slice());
    this.carry = new Float32Array(0);
    return this.speaking ? this.end() : null;
  }

  reset(): void {
    this.speaking = false;
    this.chunks = [];
    this.length = this.voiced = this.silence = 0;
    this.preRoll = [];
    this.preRollLen = 0;
    this.carry = new Float32Array(0);
  }

  private step(frame: Float32Array): Float32Array | null {
    const e = rms(frame);
    this.lastEnergy = e;
    const copy = frame.slice();
    if (this.warm < this.warmFrames) {
      this.warm++;
      // trame la plus calme (on peut déjà parler), jamais au-delà d'un niveau de voix : bruit de fond, pas parole
      this.noise = Math.min(this.warm === 1 ? e : this.noise, e, WARMUP_NOISE_MAX);
      this.preRoll.push(copy);
      this.preRollLen += copy.length;
      while (this.preRollLen - this.preRoll[0].length >= this.preRollMax) this.preRollLen -= this.preRoll.shift()!.length;
      return null;
    }
    const loud = e >= this.level;
    if (!this.speaking) {
      if (!loud) {
        this.noise = this.noise ? this.noise * 0.95 + e * 0.05 : e;
        this.preRoll.push(copy);
        this.preRollLen += copy.length;
        while (this.preRollLen - this.preRoll[0].length >= this.preRollMax) this.preRollLen -= this.preRoll.shift()!.length;
        return null;
      }
      this.speaking = true;
      this.chunks = this.preRoll;
      this.length = this.preRollLen;
      this.preRoll = [];
      this.preRollLen = 0;
      this.voiced = this.silence = 0;
    }
    this.append(copy);
    if (loud) {
      this.voiced += copy.length;
      this.silence = 0;
    } else this.silence += copy.length;
    if (this.silence >= this.silenceMax) return this.end();
    if (this.length >= this.segmentMax) {
      const seg = this.end();
      // Phrase trop longue : coupée, la parole continue dans un nouveau segment.
      this.speaking = loud;
      return seg;
    }
    return null;
  }

  private append(c: Float32Array): void {
    this.chunks.push(c);
    this.length += c.length;
  }

  private end(): Float32Array | null {
    const enough = this.voiced >= this.minSpeech;
    const seg = enough ? concat(this.chunks) : null;
    this.speaking = false;
    this.chunks = [];
    this.length = this.voiced = this.silence = 0;
    return seg;
  }
}

/* ------------------------------------------------------------------ */
/* Modèle                                                              */
/* ------------------------------------------------------------------ */

/** Langue BCP 47 (`fr-FR`) → code Whisper (`fr`) ; vide si inconnue. */
export function whisperLanguage(lang: string): string {
  const base = lang.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return /^[a-z]{2,3}$/.test(base) ? base : "";
}

/**
 * Sorties de Whisper à jeter : vide, bruit entre crochets ou parenthèses (« [Musique] »,
 * « (applaudissements) »), ponctuation seule, ou les génériques de sous-titres qu'il invente sur
 * un silence.
 */
export function isWhisperNoise(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^[\s[(*♪].*[\])*♪]\s*$/u.test(t)) return true;
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  return /sous-titr|amara\.org|merci d'avoir regardé|subtitles by/i.test(t) && t.length < 80;
}

/** Texte d'une sortie `automatic-speech-recognition` (`{text}` ou liste de `{text}`). */
export function asrText(out: unknown): string {
  if (Array.isArray(out)) return out.map(asrText).join(" ").trim();
  if (out && typeof out === "object" && typeof (out as { text?: unknown }).text === "string") return (out as { text: string }).text.trim();
  return typeof out === "string" ? out.trim() : "";
}

/* ------------------------------------------------------------------ */
/* Accès à l'addon hugging-face-infer                                   */
/* ------------------------------------------------------------------ */

export type HfApi = {
  getHuggingFaceRegistry(): HuggingFaceRegistry | null;
  onHuggingFaceConfig(listener: (config: unknown) => void): () => void;
};
export type { HfModelState, HuggingFaceRegistry };

const HOLDER = "__creativeStackHuggingFace";

declare global {
  interface ImportMeta {
    readonly env?: { readonly CS_IIFE?: boolean };
  }
}

/** API déjà chargée par la page (addon hugging-face-infer importé), sinon `null`. */
export function hfApiNow(): HfApi | null {
  const api = (globalThis as Record<string, unknown>)[HOLDER] as HfApi | undefined;
  return api && typeof api.getHuggingFaceRegistry === "function" ? api : null;
}

let pending: Promise<HfApi | null> | null = null;

/**
 * API du registre de modèles, sans dupliquer l'addon : celle que la page a déjà chargée, sinon
 * import à la demande de son `index.ts` (application, ES). Dans un bundle autonome (IIFE), la page
 * doit charger `creative-stack-hugging-face-infer.bundle.js` : `null` sinon.
 */
export function loadHfApi(): Promise<HfApi | null> {
  const now = hfApiNow();
  if (now) return Promise.resolve(now);
  if (import.meta.env?.CS_IIFE) return Promise.resolve(null);
  pending ??= import("../hugging-face-infer/index")
    .then((m) => hfApiNow() ?? { getHuggingFaceRegistry: m.getHuggingFaceRegistry, onHuggingFaceConfig: m.onHuggingFaceConfig as HfApi["onHuggingFaceConfig"] })
    .catch(() => null)
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Pourquoi la reconnaissance locale est impossible avec ce modèle, ou `null` si elle l'est. */
export function whisperProblem(api: HfApi | null, model: string): string | null {
  if (!api) return "reconnaissance locale indisponible : addon hugging-face-infer non chargé";
  const reg = api.getHuggingFaceRegistry();
  if (!reg) return "reconnaissance locale indisponible : l'application n'a pas configuré les modèles (configureHuggingFace)";
  if (!reg.hasModel(model)) return `modèle de reconnaissance « ${model} » absent de la liste des modèles autorisés`;
  if (reg.model(model).task !== "automatic-speech-recognition") return `« ${model} » n'est pas un modèle de reconnaissance vocale (automatic-speech-recognition)`;
  return null;
}
