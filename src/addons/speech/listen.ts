import { customElement, property } from "lit/decorators.js";
import { dispatch } from "../interactive";
import { listenDp } from "../../shared/audio/dp";
import { num } from "../../shared/media/control";
import { DeviceElement, policyAllows, type CommandMap, type DeviceBaseState } from "../../shared/device/base";
import { matchPhrase, parsePhrases, recognitionError, restartDelay } from "./core";

const tagName = "sonic-listen";

/** Une écoute plus courte que ceci compte comme une coupure rapide (backoff). */
const QUICK_MS = 1500;
/** Coupures rapides d'affilée avant d'abandonner. */
const MAX_QUICK = 6;

export type ListenSettings = { lang: string; continuous: boolean; interim: boolean; maxAlternatives: number; phrases: string[] };

export type ListenMatch = { phrase: string; text: string; n: number };

export type ListenState = DeviceBaseState & {
  /** Le micro capte (entre le début et la fin d'une session du navigateur). */
  listening: boolean;
  /** Texte provisoire de la phrase en cours (avec `interim`). */
  interim: string;
  /** Dernière phrase reconnue définitivement. */
  final: string;
  /** Toutes les phrases définitives depuis le dernier `clear`, séparées par des espaces. */
  transcript: string;
  /** Confiance de la dernière phrase définitive, 0..1 (0 si le navigateur ne la donne pas). */
  confidence: number;
  alternatives: Array<{ text: string; confidence: number }>;
  /** Dernier mot-clé reconnu ; `n` augmente à chaque reconnaissance. */
  match: ListenMatch | null;
  /** Relances automatiques après une coupure du navigateur (mode continu). */
  restarts: number;
  settings: ListenSettings;
};

type Alt = { transcript: string; confidence: number };
type Result = { isFinal: boolean; length: number; [i: number]: Alt };
type ResultEvent = { resultIndex: number; results: { length: number; [i: number]: Result } };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onresult: ((e: ResultEvent) => void) | null;
};
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  const g = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  const C = g.SpeechRecognition ?? g.webkitSpeechRecognition;
  return typeof C === "function" ? C : null;
}

function readParams(v: unknown): Partial<ListenSettings> {
  const p = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const out: Partial<ListenSettings> = {};
  if (typeof p.lang === "string") out.lang = p.lang;
  if (typeof p.continuous === "boolean") out.continuous = p.continuous;
  if (typeof p.interim === "boolean") out.interim = p.interim;
  const alt = num(p.maxAlternatives, 1, 10);
  if (alt !== undefined) out.maxAlternatives = Math.round(alt);
  if (p.phrases !== undefined) out.phrases = parsePhrases(p.phrases);
  return out;
}

/**
 * Reconnaissance vocale du navigateur (`SpeechRecognition`, `webkitSpeechRecognition`).
 *
 * - Réglages `lang`, `continuous`, `interim`, `max-alternatives`, `phrases` (mots-clés), en direct par `params`.
 * - `control {start, stop, abort, toggle, clear}` (compteurs) ; `for="bouton"` bascule l'écoute dans le clic.
 * - État `<id>State` ; actions `listen:result`, `listen:match` vers `target`.
 *
 * En continu, le navigateur coupe l'écoute de lui-même (silence, ~60 s) : elle est relancée tant
 * qu'elle est voulue, avec un délai qui double à chaque coupure rapide, et abandonnée après
 * plusieurs échecs d'affilée. Chrome envoie l'audio aux serveurs de Google.
 */
@customElement(tagName)
export class SonicListen extends DeviceElement<ListenState> {
  @property({ type: String }) lang = "";
  @property({ type: Boolean }) continuous = false;
  @property({ type: Boolean }) interim = false;
  @property({ type: Number, attribute: "max-alternatives" }) maxAlternatives = 1;
  /** Mots-clés séparés par des virgules : `match` et `listen:match` quand l'un est reconnu. */
  @property({ type: String }) phrases = "";
  /** DP de réglages en direct `{lang, continuous, interim, maxAlternatives, phrases}`. */
  @property({ type: String }) params = "";
  /** Store qui reçoit les actions. */
  @property({ type: String }) target = "";

  protected feature = "microphone";
  protected state: ListenState = {
    status: "idle",
    error: null,
    supported: false,
    allowed: "unknown",
    active: false,
    listening: false,
    interim: "",
    final: "",
    transcript: "",
    confidence: 0,
    alternatives: [],
    match: null,
    restarts: 0,
    settings: { lang: "", continuous: false, interim: false, maxAlternatives: 1, phrases: [] },
  };

  private live: Partial<ListenSettings> = {};
  private offParams: (() => void) | null = null;
  private rec: Recognition | null = null;
  /** L'écoute est voulue (commande `start`), indépendamment des coupures du navigateur. */
  private wanted = false;
  private fatal = false;
  private quickFails = 0;
  /** Début de la session en cours (`performance.now()`), -1 si elle n'a jamais démarré. */
  private startedAt = -1;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Mots-clés déjà signalés pour un résultat (`index:phrase`) : un seul `listen:match` par phrase dite. */
  private matched = new Set<string>();
  private matchCount = 0;

  protected commands(): CommandMap {
    return {
      start: () => this.start(),
      stop: () => this.stop(),
      abort: () => this.abort(),
      toggle: () => (this.wanted ? this.stop() : this.start()),
      clear: () => this.clear(),
    };
  }

  connectedCallback(): void {
    super.connectedCallback();
    const supported = !!recognitionCtor();
    this.patch({
      supported,
      status: supported ? "idle" : "unsupported",
      error: supported ? null : "reconnaissance vocale non disponible dans ce navigateur (Firefox : pas de reconnaissance ; essayer sonic-hugging-face-infer avec Whisper)",
      allowed: policyAllows(this.feature),
      settings: this.settings(),
    });
  }

  disconnectedCallback(): void {
    this.offParams?.();
    this.offParams = null;
    this.wanted = false;
    this.clearTimer();
    const r = this.rec;
    this.rec = null;
    try {
      r?.abort();
    } catch {
      /* déjà arrêtée */
    }
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    super.updated(changed);
    if (changed.has("params")) {
      this.offParams?.();
      this.live = {};
      this.offParams = this.params
        ? listenDp(this.params, (v) => {
            this.live = readParams(v);
            this.patch({ settings: this.settings() });
          })
        : null;
    }
    if (["lang", "continuous", "interim", "maxAlternatives", "phrases"].some((k) => changed.has(k))) this.patch({ settings: this.settings() });
  }

  /** Réglages effectifs : attributs, puis `params`. */
  settings(): ListenSettings {
    const base: ListenSettings = {
      lang: this.lang || "",
      continuous: !!this.continuous,
      interim: !!this.interim,
      maxAlternatives: Math.round(num(this.maxAlternatives, 1, 10) ?? 1),
      phrases: parsePhrases(this.phrases),
    };
    return { ...base, ...this.live };
  }

  start(): boolean {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      this.patch({ status: "unsupported", supported: false, error: "reconnaissance vocale non disponible dans ce navigateur" });
      return false;
    }
    if (this.wanted && this.rec) return true;
    this.wanted = true;
    this.fatal = false;
    this.quickFails = 0;
    this.clearTimer();
    this.patch({ status: "requesting", error: null, active: true, restarts: 0 });
    return this.open(Ctor);
  }

  stop(): boolean {
    this.wanted = false;
    this.clearTimer();
    const r = this.rec;
    // stop() laisse le navigateur livrer la dernière phrase ; onend termine.
    try {
      r?.stop();
    } catch {
      /* déjà arrêtée */
    }
    if (!r) this.patch({ active: false, listening: false, interim: "", status: this.state.supported ? "ready" : "unsupported" });
    else this.patch({ active: false });
    return true;
  }

  abort(): boolean {
    this.wanted = false;
    this.clearTimer();
    const r = this.rec;
    this.rec = null;
    try {
      r?.abort();
    } catch {
      /* déjà arrêtée */
    }
    this.patch({ active: false, listening: false, interim: "", status: this.state.supported ? "ready" : "unsupported" });
    return true;
  }

  clear(): boolean {
    this.matched.clear();
    this.patch({ interim: "", final: "", transcript: "", confidence: 0, alternatives: [], match: null });
    return true;
  }

  private open(Ctor: RecognitionCtor): boolean {
    const s = this.settings();
    let r: Recognition;
    try {
      r = new Ctor();
      if (s.lang) r.lang = s.lang;
      r.continuous = s.continuous;
      r.interimResults = s.interim || s.phrases.length > 0;
      r.maxAlternatives = s.maxAlternatives;
    } catch (e) {
      this.wanted = false;
      this.fail(e, "reconnaissance vocale");
      return false;
    }
    this.rec = r;
    this.matched.clear();
    r.onstart = () => {
      if (this.rec !== r) return;
      this.startedAt = performance.now();
      this.patch({ status: "ready", listening: true, active: true, error: null });
    };
    r.onresult = (e) => {
      if (this.rec === r) this.onResult(e, s);
    };
    r.onerror = (e) => {
      if (this.rec !== r) return;
      const code = e?.error ?? "";
      if (code === "aborted") return;
      const info = recognitionError(code);
      if (info.fatal) {
        this.fatal = true;
        this.wanted = false;
      }
      this.patch({ error: info.error, ...(info.fatal || code === "network" ? { status: info.status } : {}) });
    };
    r.onend = () => {
      if (this.rec !== r) return;
      this.rec = null;
      this.patch({ listening: false, interim: "" });
      if (this.wanted && s.continuous && !this.fatal) this.scheduleRestart();
      else {
        this.wanted = false;
        const keep = this.state.status === "denied" || this.state.status === "unsupported" || (this.fatal && this.state.status === "error");
        this.patch({ active: false, ...(keep ? {} : { status: "ready" }) });
      }
    };
    try {
      r.start();
      return true;
    } catch (e) {
      this.rec = null;
      this.wanted = false;
      this.fail(e, "reconnaissance vocale");
      return false;
    }
  }

  private scheduleRestart(): void {
    const lasted = performance.now() - this.startedAt;
    this.quickFails = this.startedAt >= 0 && lasted >= QUICK_MS ? 0 : this.quickFails + 1;
    if (this.quickFails > MAX_QUICK) {
      this.wanted = false;
      this.patch({ active: false, status: "error", error: "reconnaissance vocale coupée sans cesse par le navigateur : écoute arrêtée" });
      return;
    }
    this.startedAt = -1;
    const delay = this.quickFails ? restartDelay(this.quickFails - 1) : 0;
    this.clearTimer();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      const Ctor = recognitionCtor();
      if (!this.wanted || !this.isConnected || !Ctor) return;
      this.patch({ restarts: this.state.restarts + 1 });
      this.open(Ctor);
    }, delay);
  }

  private clearTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private onResult(e: ResultEvent, s: ListenSettings): void {
    let interim = "";
    const results = e.results;
    for (let i = e.resultIndex ?? 0; i < results.length; i++) {
      const res = results[i];
      if (!res || !res.length) continue;
      const best = res[0];
      const text = (best.transcript ?? "").trim();
      if (s.phrases.length && text) this.checkMatch(i, text, s.phrases);
      if (res.isFinal) {
        const alternatives: Array<{ text: string; confidence: number }> = [];
        for (let k = 0; k < res.length; k++) alternatives.push({ text: (res[k].transcript ?? "").trim(), confidence: res[k].confidence || 0 });
        const transcript = text ? (this.state.transcript ? `${this.state.transcript} ${text}` : text) : this.state.transcript;
        this.patch({ final: text, transcript, confidence: best.confidence || 0, alternatives });
        this.action("listen:result", { text, confidence: best.confidence || 0, isFinal: true });
      } else {
        interim += `${best.transcript ?? ""}`;
      }
    }
    interim = interim.trim();
    if (s.interim) {
      if (interim !== this.state.interim) {
        this.patch({ interim }, false);
        if (interim) this.action("listen:result", { text: interim, confidence: 0, isFinal: false });
      }
    }
  }

  private checkMatch(index: number, text: string, phrases: string[]): void {
    const phrase = matchPhrase(text, phrases);
    if (!phrase) return;
    const key = `${index}:${phrase}`;
    if (this.matched.has(key)) return;
    this.matched.add(key);
    const match = { phrase, text, n: ++this.matchCount };
    this.patch({ match });
    this.action("listen:match", { phrase, text });
  }

  private action(type: string, payload: Record<string, unknown>): void {
    const target = this.target.trim();
    if (target) dispatch(target, { type, payload });
    this.emit(type.replace(":", "-"), payload);
  }
}

export default SonicListen;
