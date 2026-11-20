/**
 * Code morse : texte → suite d'états allumé / éteint, et fronts observés → texte.
 * Logique pure : `sonic-morse` séquence l'émission et alimente le décodeur.
 *
 * Unité = durée d'un point. Trait = 3 unités ; silence entre deux signes d'une lettre = 1,
 * entre deux lettres = 3, entre deux mots = 7.
 */

export const MORSE: Record<string, string> = {
  A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....", I: "..", J: ".---",
  K: "-.-", L: ".-..", M: "--", N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-",
  U: "..-", V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..",
  "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-", "5": ".....",
  "6": "-....", "7": "--...", "8": "---..", "9": "----.",
  ".": ".-.-.-", ",": "--..--", "?": "..--..", "'": ".----.", "!": "-.-.--", "/": "-..-.",
  "(": "-.--.", ")": "-.--.-", ":": "---...", "=": "-...-", "+": ".-.-.", "-": "-....-", "@": ".--.-.",
};

const REVERSE: Record<string, string> = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));

/** Texte ramené aux caractères du code : majuscules, accents retirés, autres caractères ôtés, espaces réduits. */
export function morseNormalize(text: string): string {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’`]/g, "'")
    .toUpperCase()
    .split("")
    .filter((c) => c === " " || MORSE[c] !== undefined)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Texte → signes : lettres séparées par une espace, mots par « / ». */
export function morseEncode(text: string): string {
  return morseNormalize(text)
    .split(" ")
    .filter(Boolean)
    .map((w) => w.split("").map((c) => MORSE[c]).join(" "))
    .join(" / ");
}

/** Signes (« ... --- ... / .- ») → texte ; un signe inconnu donne « ? ». */
export function morseDecode(signs: string): string {
  return String(signs ?? "")
    .trim()
    .split(/\s*\/\s*/)
    .map((w) => w.split(/\s+/).filter(Boolean).map((s) => REVERSE[s] ?? "?").join(""))
    .join(" ")
    .trim();
}

export type MorseStep = { on: boolean; ms: number; /** Caractères entièrement émis à la fin de ce pas. */ chars: number };

/**
 * Suite des états à tenir pour émettre `text`. `trim` raccourcit chaque éclat et allonge d'autant le
 * silence qui suit : compense une lampe qui reste allumée un peu plus longtemps que commandé.
 */
export function morseTimeline(text: string, unit: number, trim = 0): MorseStep[] {
  const clean = morseNormalize(text);
  const u = Math.max(1, unit);
  const cut = Math.min(Math.max(0, trim), u * 0.8);
  const steps: MorseStep[] = [];
  let chars = 0;
  const gap = (units: number) => {
    const last = steps[steps.length - 1];
    if (last && !last.on) last.ms = Math.max(last.ms, units * u + cut);
  };
  for (const c of clean) {
    if (c === " ") {
      gap(7);
      chars++;
      if (steps.length) steps[steps.length - 1].chars = chars;
      continue;
    }
    const signs = MORSE[c];
    for (let i = 0; i < signs.length; i++) {
      steps.push({ on: true, ms: (signs[i] === "-" ? 3 : 1) * u - cut, chars });
      steps.push({ on: false, ms: u + cut, chars });
    }
    gap(3);
    chars++;
    steps[steps.length - 1].chars = chars;
  }
  return steps;
}

export type MorseDecoderOptions = {
  /** Durée du point attendue, en ms. */
  unit: number;
  /** Ajuste l'unité aux durées observées dès que points et traits ont été vus. */
  autoUnit: boolean;
};

/**
 * Décode des durées d'éclats et de silences. `light(ms)` : un éclat vient de se terminer ;
 * `silence(ms)` : le silence en cours dure depuis `ms` (appelé à la fin du silence, ou en cours
 * de silence par une horloge : idempotent).
 */
export class MorseDecoder {
  opts: MorseDecoderOptions;
  /** Texte décodé du message en cours. */
  text = "";
  /** Signes de la lettre en cours (« .- »). */
  signs = "";
  /** Unité utilisée (ajustée si `autoUnit`). */
  unit: number;
  private lights: number[] = [];

  constructor(opts: Partial<MorseDecoderOptions> = {}) {
    this.opts = { unit: 300, autoUnit: false, ...opts };
    this.unit = this.opts.unit;
  }

  reset(): void {
    this.text = "";
    this.signs = "";
    this.lights = [];
    this.unit = this.opts.unit;
  }

  setUnit(unit: number): void {
    this.opts.unit = unit;
    this.unit = unit;
    this.lights = [];
  }

  light(ms: number): void {
    if (!(ms > 0)) return;
    if (this.opts.autoUnit) this.learn(ms);
    this.signs += ms < 2 * this.unit ? "." : "-";
  }

  silence(ms: number): void {
    if (ms >= 2 * this.unit && this.signs) {
      this.text += REVERSE[this.signs] ?? "?";
      this.signs = "";
    }
    if (ms >= 5 * this.unit && this.text && !this.text.endsWith(" ")) this.text += " ";
  }

  /** Unité = moyenne des éclats courts, une fois que courts et longs se distinguent nettement. */
  private learn(ms: number): void {
    this.lights.push(ms);
    if (this.lights.length > 16) this.lights.shift();
    const min = Math.min(...this.lights);
    const max = Math.max(...this.lights);
    if (max < 2.2 * min) return;
    const split = Math.sqrt(min * max);
    const dots = this.lights.filter((d) => d < split);
    const unit = dots.reduce((a, b) => a + b, 0) / dots.length;
    if (unit > 0) this.unit = unit;
  }
}
