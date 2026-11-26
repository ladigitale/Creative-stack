import { customElement, property } from "lit/decorators.js";
import { dispatch } from "../interactive";
import { listenDp } from "../../shared/audio/dp";
import { num } from "../../shared/media/control";
import { DeviceElement, type CommandArg, type CommandMap, type DeviceBaseState } from "../../shared/device/base";
import { pickVoice, splitSpeech, synthesisError, wordAt, type SpeechChunk } from "./core";

const tagName = "sonic-speak";

export type SpeakSettings = { lang: string; voice: string; rate: number; pitch: number; volume: number };

export type SpeakVoice = { name: string; lang: string; local: boolean };

export type SpeakState = DeviceBaseState & {
  /** En train de parler (morceau en cours, éventuellement en pause). */
  speaking: boolean;
  paused: boolean;
  /** Des morceaux attendent encore après celui en cours. */
  pending: boolean;
  voices: SpeakVoice[];
  /** Position du mot prononcé dans le texte complet (−1 hors lecture). */
  charIndex: number;
  /** Mot prononcé (si le navigateur envoie les limites de mots). */
  word: string;
  /** Texte en cours de lecture, ou le dernier lu. */
  spoken: string;
  /** Voix effectivement utilisée (`null` : choix du navigateur). */
  voice: string | null;
  settings: SpeakSettings;
};

type Utterance = {
  text: string;
  lang: string;
  voice: unknown;
  rate: number;
  pitch: number;
  volume: number;
  onstart: ((e: unknown) => void) | null;
  onend: ((e: unknown) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onboundary: ((e: { charIndex?: number; charLength?: number; name?: string }) => void) | null;
};
type Voice = { name: string; lang: string; localService?: boolean; default?: boolean };
type Synth = {
  speak(u: Utterance): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  getVoices(): Voice[];
  speaking?: boolean;
  addEventListener?(type: "voiceschanged", h: () => void): void;
  removeEventListener?(type: "voiceschanged", h: () => void): void;
};

function synth(): Synth | null {
  const g = globalThis as unknown as { speechSynthesis?: Synth; SpeechSynthesisUtterance?: unknown };
  return g.speechSynthesis && typeof g.SpeechSynthesisUtterance === "function" ? g.speechSynthesis : null;
}

function readParams(v: unknown): Partial<SpeakSettings> {
  const p = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const out: Partial<SpeakSettings> = {};
  if (typeof p.lang === "string") out.lang = p.lang;
  if (typeof p.voice === "string") out.voice = p.voice;
  const rate = num(p.rate, 0.1, 10);
  if (rate !== undefined) out.rate = rate;
  const pitch = num(p.pitch, 0, 2);
  if (pitch !== undefined) out.pitch = pitch;
  const volume = num(p.volume, 0, 1);
  if (volume !== undefined) out.volume = volume;
  return out;
}

const asText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

/**
 * Synthèse vocale du navigateur (`speechSynthesis`), sans service tiers ajouté.
 *
 * - Texte : `text`, ou `text-from` (DataProvider ou `dp.chemin` lu en direct, l'emporte), ou la
 *   commande `control {say: {n, text}}`. `auto` parle à chaque nouvelle valeur de `text-from`.
 * - Réglages `lang`, `voice` (nom ou partie de nom), `rate`, `pitch`, `volume`, en direct par `params`.
 * - `control {say, stop, pause, resume, toggle}` (compteurs) ; `for="bouton"` dit le texte dans le clic.
 * - État `<id>State` ; actions `speak:start`, `speak:word` (avec `boundary`), `speak:end` vers `target`.
 *
 * Chrome coupe les longs textes : ils sont lus phrase par phrase (morceaux de 180 caractères au plus).
 * La première lecture exige un geste de l'utilisateur (Chrome, Safari).
 */
@customElement(tagName)
export class SonicSpeak extends DeviceElement<SpeakState> {
  @property({ type: String }) text = "";
  @property({ type: String, attribute: "text-from" }) textFrom = "";
  @property({ type: String }) lang = "";
  @property({ type: String }) voice = "";
  @property({ type: Number }) rate = 1;
  @property({ type: Number }) pitch = 1;
  @property({ type: Number }) volume = 1;
  /** DP de réglages en direct `{lang, voice, rate, pitch, volume}`, prioritaires sur les attributs. */
  @property({ type: String }) params = "";
  /** Parle à chaque nouvelle valeur de `text-from`. */
  @property({ type: Boolean }) auto = false;
  /** Envoie aussi `speak:word` à chaque mot (beaucoup d'actions). */
  @property({ type: Boolean }) boundary = false;
  /** Store qui reçoit les actions. */
  @property({ type: String }) target = "";

  protected feature = null;
  protected readonly defaultCommand = "say";
  protected state: SpeakState = {
    status: "idle",
    error: null,
    supported: false,
    allowed: "unknown",
    active: false,
    speaking: false,
    paused: false,
    pending: false,
    voices: [],
    charIndex: -1,
    word: "",
    spoken: "",
    voice: null,
    settings: { lang: "", voice: "", rate: 1, pitch: 1, volume: 1 },
  };

  private live: Partial<SpeakSettings> = {};
  private fromValue: string | null = null;
  private offs: Array<() => void> = [];
  /** Numéro de la lecture en cours : les événements d'une lecture annulée sont ignorés. */
  private generation = 0;
  private queue: SpeechChunk[] = [];
  private current: SpeechChunk | null = null;
  /** Gardée en mémoire : Chrome perd `onend` si l'objet est ramassé pendant la lecture. */
  private utterance: Utterance | null = null;
  private fullText = "";
  private watchedVoices: Synth | null = null;

  protected commands(): CommandMap {
    return {
      say: (a) => this.say(a),
      stop: () => this.stop(),
      pause: () => this.pause(),
      resume: () => this.resume(),
      toggle: () => (this.state.speaking ? this.stop() : this.say({})),
    };
  }

  connectedCallback(): void {
    super.connectedCallback();
    const s = synth();
    this.patch({ supported: !!s, status: s ? "idle" : "unsupported", error: s ? null : "synthèse vocale non disponible dans ce navigateur", settings: this.settings() });
    if (s) {
      this.watchedVoices = s;
      if (s.addEventListener) s.addEventListener("voiceschanged", this.onVoices);
      this.onVoices();
    }
  }

  disconnectedCallback(): void {
    this.offs.forEach((f) => f());
    this.offs = [];
    this.watchedVoices?.removeEventListener?.("voiceschanged", this.onVoices);
    this.watchedVoices = null;
    if (this.state.speaking) {
      this.generation++;
      synth()?.cancel();
    }
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    super.updated(changed);
    if (changed.has("params") || changed.has("textFrom")) this.listen();
    if (["lang", "voice", "rate", "pitch", "volume"].some((k) => changed.has(k))) this.patch({ settings: this.settings() });
  }

  /** Réglages effectifs : attributs, puis `params`. */
  settings(): SpeakSettings {
    const base: SpeakSettings = {
      lang: this.lang || "",
      voice: this.voice || "",
      rate: num(this.rate, 0.1, 10) ?? 1,
      pitch: num(this.pitch, 0, 2) ?? 1,
      volume: num(this.volume, 0, 1) ?? 1,
    };
    return { ...base, ...this.live };
  }

  /** Texte courant : `text-from` s'il est donné, sinon `text`. */
  currentText(): string {
    return (this.textFrom ? this.fromValue ?? "" : this.text ?? "").trim();
  }

  private listen(): void {
    this.offs.forEach((f) => f());
    this.offs = [];
    this.live = {};
    if (this.params) {
      this.offs.push(
        listenDp(this.params, (v) => {
          this.live = readParams(v);
          this.patch({ settings: this.settings() });
        }),
      );
    }
    this.fromValue = null;
    if (this.textFrom) {
      // La valeur présente au branchement n'est pas lue : seule une nouvelle valeur parle (`auto`).
      let seeding = true;
      this.offs.push(
        listenDp(this.textFrom, (v) => {
          const next = asText(v);
          const changed = next !== this.fromValue;
          this.fromValue = next;
          if (!seeding && changed && this.auto && next.trim()) void this.say({});
        }),
      );
      seeding = false;
    }
  }

  private onVoices = (): void => {
    const s = synth();
    if (!s) return;
    let list: Voice[] = [];
    try {
      list = s.getVoices() ?? [];
    } catch {
      list = [];
    }
    const voices = list.map((v) => ({ name: v.name, lang: v.lang, local: v.localService !== false }));
    const partial: Partial<SpeakState> = { voices };
    if (voices.length && this.state.status === "idle") partial.status = "ready";
    this.patch(partial);
  };

  /** Dit un texte (celui de l'argument, sinon le texte courant). Annule la lecture en cours. */
  say(arg: CommandArg = {}): boolean {
    const s = synth();
    if (!s) {
      this.patch({ status: "unsupported", supported: false, error: "synthèse vocale non disponible dans ce navigateur" });
      return false;
    }
    const text = (asText(arg.text) || this.currentText()).trim();
    if (!text) {
      this.patch({ error: "rien à dire : text, text-from ou {say: {n, text}}" });
      return false;
    }
    const over = readParams(arg);
    const settings = { ...this.settings(), ...over };
    const wasSpeaking = this.state.speaking;
    const gen = ++this.generation;
    if (wasSpeaking) this.finish(false, true);
    s.cancel();
    this.fullText = text;
    this.queue = splitSpeech(text);
    let voices: Voice[] = [];
    try {
      voices = s.getVoices() ?? [];
    } catch {
      voices = [];
    }
    const voice = pickVoice(voices, settings.voice, settings.lang);
    this.patch({
      status: "ready",
      error: null,
      active: true,
      speaking: true,
      paused: false,
      pending: this.queue.length > 1,
      charIndex: 0,
      word: "",
      spoken: text,
      voice: voice?.name ?? null,
      settings: this.settings(),
    });
    // Premier morceau dans le geste en cours (Safari, Chrome) ; les suivants à la fin du précédent.
    this.next(gen, settings, voice, true);
    return true;
  }

  stop(): boolean {
    const wasSpeaking = this.state.speaking;
    this.generation++;
    this.queue = [];
    this.current = null;
    synth()?.cancel();
    if (wasSpeaking) this.finish(false, true);
    else this.patch({ active: false, speaking: false, paused: false, pending: false });
    return true;
  }

  pause(): boolean {
    const s = synth();
    if (!s || !this.state.speaking) return false;
    s.pause();
    this.patch({ paused: true });
    return true;
  }

  resume(): boolean {
    const s = synth();
    if (!s || !this.state.speaking) return false;
    s.resume();
    this.patch({ paused: false });
    return true;
  }

  private next(gen: number, settings: SpeakSettings, voice: Voice | null, first: boolean): void {
    const s = synth();
    const Ctor = (globalThis as unknown as { SpeechSynthesisUtterance?: new (t: string) => Utterance }).SpeechSynthesisUtterance;
    const chunk = this.queue.shift();
    if (!s || !Ctor || !chunk) return;
    this.current = chunk;
    const u = new Ctor(chunk.text);
    if (settings.lang) u.lang = settings.lang;
    if (voice) {
      u.voice = voice;
      if (!settings.lang) u.lang = voice.lang;
    }
    u.rate = settings.rate;
    u.pitch = settings.pitch;
    u.volume = settings.volume;
    u.onstart = () => {
      if (gen !== this.generation) return;
      this.patch({ charIndex: chunk.offset, pending: this.queue.length > 0 });
      if (first) this.action("speak:start", { text: this.fullText, lang: settings.lang || voice?.lang || "", voice: voice?.name ?? null });
    };
    u.onboundary = (e) => {
      if (gen !== this.generation || (e.name && e.name !== "word")) return;
      const local = typeof e.charIndex === "number" ? e.charIndex : 0;
      const charIndex = chunk.offset + local;
      const word = wordAt(chunk.text, local, e.charLength);
      this.patch({ charIndex, word }, false);
      if (this.boundary) this.action("speak:word", { word, charIndex });
    };
    u.onend = () => {
      if (gen !== this.generation) return;
      if (this.queue.length) this.next(gen, settings, voice, false);
      else this.finish(true, false);
    };
    u.onerror = (e) => {
      if (gen !== this.generation) return;
      const info = synthesisError(e?.error ?? "");
      if (!info) return; // interruption voulue (stop, nouvelle lecture)
      this.generation++;
      this.queue = [];
      this.current = null;
      this.finish(false, true, info);
    };
    this.utterance = u;
    s.speak(u);
  }

  private finish(complete: boolean, interrupted: boolean, err?: { status: SpeakState["status"]; error: string }): void {
    const text = this.fullText;
    this.current = null;
    this.utterance = null;
    this.patch({
      active: false,
      speaking: false,
      paused: false,
      pending: false,
      charIndex: -1,
      word: "",
      ...(err ? { status: err.status, error: err.error } : {}),
    });
    this.action("speak:end", { text, complete, interrupted, error: err?.error ?? null });
  }

  private action(type: string, payload: Record<string, unknown>): void {
    const target = this.target.trim();
    if (target) dispatch(target, { type, payload });
    this.emit(type.replace(":", "-"), payload);
  }
}

export default SonicSpeak;
