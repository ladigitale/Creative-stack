import { customElement, property } from "lit/decorators.js";
import { dp } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { dispatch } from "../interactive";
import { listenDp } from "../../shared/audio/dp";
import { num } from "../../shared/media/control";
import { mediaDevicesAvailable, openStream, stopStream } from "../../shared/media/capture";
import { DeviceElement, policyAllows, type CommandMap, type DeviceBaseState } from "../../shared/device/base";
import { matchPhrase, parsePhrases, recognitionError, restartDelay } from "./core";
import {
  asrText,
  DEFAULT_SILENCE_MS,
  DEFAULT_THRESHOLD,
  DEFAULT_WHISPER_MODEL,
  downmix,
  hfApiNow,
  isWhisperNoise,
  loadHfApi,
  resample,
  SpeechSegmenter,
  whisperLanguage,
  whisperProblem,
  type HfApi,
  type HfModelState,
} from "./whisper";

const tagName = "sonic-listen";

/** Une écoute plus courte que ceci compte comme une coupure rapide (backoff). */
const QUICK_MS = 1500;
/** Coupures rapides d'affilée avant d'abandonner. */
const MAX_QUICK = 6;

export type ListenSettings = { lang: string; continuous: boolean; interim: boolean; maxAlternatives: number; phrases: string[] };

export type ListenMatch = { phrase: string; text: string; n: number };

/** Moteur effectif : reconnaissance du navigateur ou Whisper sur l'appareil. */
export type ListenEngine = "native" | "whisper";

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
  /** Moteur effectif (`engine="auto"` résolu). */
  engine: ListenEngine;
  /** Whisper : progression 0..100 du téléchargement ou du chargement du modèle, `null` hors chargement. */
  loading: number | null;
  /** Whisper : modèle chargé, prêt à transcrire. */
  modelReady: boolean;
  /** Whisper : phase du modèle (idle, checking, awaiting-consent, declined, downloading, loading, ready, error, unsupported). */
  modelPhase: string;
  /** Whisper : taille du modèle à télécharger (octets), `null` si inconnue. */
  modelSize: number | null;
  /** Whisper : une phrase est en cours de transcription. */
  transcribing: boolean;
  /** Whisper : niveau du micro 0..1 (vumètre, ~10 fois par seconde), 0 hors écoute. */
  micLevel: number;
  /** Whisper : de la parole est en train d'être captée (phrase en cours). */
  voice: boolean;
  /** Whisper : état du moteur audio du navigateur (`running`, `suspended`, `interrupted`, `closed`), `null` hors écoute. */
  audioState: string | null;
  /** Whisper : blocs de son reçus du micro depuis le début de l'écoute (0 = le micro ne délivre rien). */
  audioBlocks: number;
};

/** Phrases en attente de transcription au plus (les plus anciennes sont abandonnées au-delà). */
const MAX_QUEUE = 4;

type AudioCtor = new () => AudioContext;
function audioCtor(): AudioCtor | null {
  const g = globalThis as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  const C = g.AudioContext ?? g.webkitAudioContext;
  return typeof C === "function" ? C : null;
}
const micOk = () => mediaDevicesAvailable() && !!audioCtor();

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
 *
 * `engine="whisper"` : reconnaissance sur l'appareil (modèle Whisper de la liste blanche de l'addon
 * hugging-face-infer, exécuté dans son worker) ; le micro est découpé en phrases par détection de
 * silence, chaque phrase est rééchantillonnée en 16 kHz mono puis transcrite. Mêmes état et actions.
 * `engine="auto"` : Whisper si l'application l'a configuré (modèle autorisé), sinon le navigateur.
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
  /** `native` (défaut, SpeechRecognition), `whisper` (sur l'appareil), `auto` (Whisper s'il est configuré, sinon natif). */
  @property({ type: String }) engine = "native";
  /** Whisper : alias du modèle dans la liste blanche de l'application. */
  @property({ type: String }) model = DEFAULT_WHISPER_MODEL;
  /** Whisper : silence (ms) qui termine une phrase. */
  @property({ type: Number, attribute: "silence-ms" }) silenceMs = DEFAULT_SILENCE_MS;
  /** Whisper : seuil d'énergie RMS (0..1) de la parole. */
  @property({ type: Number }) threshold = DEFAULT_THRESHOLD;
  /** Whisper : `first-use` (défaut, au premier démarrage), `auto` (dès le chargement de la page), `consent` (toujours demander). */
  @property({ type: String }) load = "first-use";
  /** Whisper : DP du consentement au téléchargement (`"accepted"`/`true` accepte, `"declined"`/`false` refuse). */
  @property({ type: String, attribute: "consent-provider" }) consentProvider = "";

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
    engine: "native",
    loading: null,
    modelReady: false,
    modelPhase: "idle",
    modelSize: null,
    transcribing: false,
    micLevel: 0,
    voice: false,
    audioState: null,
    audioBlocks: 0,
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

  // ── Whisper ──
  private setupKey = "";
  private hfTried = false;
  private offModel: (() => void) | null = null;
  private offConfig: (() => void) | null = null;
  private offConsent: (() => void) | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private proc: ScriptProcessorNode | null = null;
  private segmenter: SpeechSegmenter | null = null;
  private queue: Float32Array[] = [];
  private busy = false;
  /** Génération de l'écoute Whisper : un `abort` ou un nouveau départ invalide les traitements en cours. */
  private gen = 0;
  private segIndex = 0;
  private whisperSettings: ListenSettings | null = null;

  protected commands(): CommandMap {
    return {
      start: () => this.start(),
      stop: () => this.stop(),
      abort: () => this.abort(),
      toggle: () => (this.wanted ? this.stop() : this.start()),
      clear: () => this.clear(),
      load: () => this.preload(),
      accept: () => this.accept(),
      decline: () => this.decline(),
    };
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.patch({ allowed: policyAllows(this.feature), settings: this.settings() });
    this.setupEngine(true);
  }

  disconnectedCallback(): void {
    this.unwatchModel();
    this.closeMic();
    this.queue = [];
    this.gen++;
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
    if (["engine", "model", "load", "consentProvider"].some((k) => changed.has(k)) && this.isConnected) this.setupEngine();
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
    if (this.engineChoice() !== "native") {
      if (this.resolveEngine(hfApiNow()) !== this.state.engine) this.setupEngine(true);
      if (this.state.engine === "whisper") return this.startWhisper();
    }
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
    if (this.state.engine === "whisper") return this.stopWhisper();
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
    if (this.state.engine === "whisper") return this.abortWhisper();
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

  // ─── Moteur ───────────────────────────────────────────────────────────────────────────────────────────────────

  private engineChoice(): "native" | "whisper" | "auto" {
    const e = (this.engine || "").trim().toLowerCase();
    return e === "whisper" || e === "auto" ? e : "native";
  }

  /** `auto` : Whisper quand l'application l'a configuré (modèle autorisé) et que le micro existe, sinon natif. */
  private resolveEngine(api: HfApi | null): ListenEngine {
    const choice = this.engineChoice();
    if (choice !== "auto") return choice;
    return micOk() && !whisperProblem(api, this.model) ? "whisper" : "native";
  }

  /** (Re)câble le moteur effectif : support, suivi du modèle, consentement, préchargement. */
  private setupEngine(force = false): void {
    const key = `${this.engineChoice()}|${this.model}|${this.load}|${this.consentProvider}`;
    if (!force && key === this.setupKey) return;
    this.setupKey = key;
    this.unwatchModel();
    const api = hfApiNow();
    if (!api && this.engineChoice() !== "native" && !this.hfTried) {
      this.hfTried = true;
      // Module de l'addon hugging-face-infer importé à la demande (aucun réseau : seul le modèle se télécharge, plus tard).
      void loadHfApi().then(() => {
        if (this.isConnected) this.setupEngine(true);
      });
    }
    const engine = this.resolveEngine(api);
    if (engine === "native") {
      const supported = !!recognitionCtor();
      const waiting = this.engineChoice() === "auto" && !api && this.hfTried && !supported;
      this.patch({
        engine,
        supported,
        status: supported ? (this.wanted ? this.state.status : "idle") : "unsupported",
        error: supported || waiting ? null : "reconnaissance vocale non disponible dans ce navigateur (Firefox : pas de reconnaissance ; essayer engine=\"whisper\", sur l'appareil)",
        loading: null,
        modelReady: false,
        modelPhase: "idle",
        modelSize: null,
      });
      return;
    }
    const problem = !micOk() ? "micro non disponible dans ce navigateur (getUserMedia ou Web Audio absent, ou page non sécurisée)" : whisperProblem(api, this.model);
    if (problem) {
      // Module encore en cours de chargement : pas d'erreur tant qu'il n'a pas répondu.
      const pendingApi = !api && !!micOk();
      this.patch({ engine, supported: false, status: pendingApi ? "idle" : "unsupported", error: pendingApi ? null : problem, loading: null, modelReady: false, modelSize: null });
      return;
    }
    const reg = api!.getHuggingFaceRegistry()!;
    const alias = this.model;
    this.patch({ engine, supported: true, status: this.wanted ? this.state.status : "idle", error: null, modelSize: reg.model(alias).sizeBytes ?? null });
    this.offModel = reg.subscribe(alias, (s) => this.onModelState(s));
    this.offConfig = api!.onHuggingFaceConfig(() => queueMicrotask(() => this.isConnected && this.setupEngine(true)));
    const cp = this.consentProvider.trim();
    if (cp) {
      const consent = (v: unknown) => {
        if (v === true || v === "accepted" || v === "true" || v === alias) this.accept();
        else if (v === false || v === "declined" || v === "false") this.decline();
      };
      this.offConsent = listenDp(cp, consent);
      const now = dp(cp).get();
      if (now !== undefined && now !== null && now !== "") consent(now);
    }
    if (this.load.trim() === "auto") void this.preload();
  }

  private unwatchModel(): void {
    this.offModel?.();
    this.offConfig?.();
    this.offConsent?.();
    this.offModel = this.offConfig = this.offConsent = null;
  }

  private registry() {
    return hfApiNow()?.getHuggingFaceRegistry() ?? null;
  }

  private onModelState(s: HfModelState): void {
    const busy = s.phase === "checking" || s.phase === "downloading" || s.phase === "loading";
    this.patch(
      {
        modelPhase: s.phase,
        modelReady: s.phase === "ready",
        loading: busy ? Math.max(0, Math.min(100, Math.round(s.progress?.percent ?? 0))) : null,
        ...(s.size?.totalBytes ? { modelSize: s.size.totalBytes } : {}),
      },
      s.phase !== "downloading",
    );
  }

  /** Charge le modèle Whisper maintenant (sans attendre le premier démarrage), consentement compris. */
  preload(): Promise<boolean> {
    if (this.state.engine !== "whisper" || !this.state.supported) return Promise.resolve(false);
    return this.ensureModel().then(
      () => true,
      (e) => {
        this.modelFailed(e);
        return false;
      },
    );
  }

  accept(): boolean {
    const reg = this.registry();
    if (!reg?.hasModel(this.model)) return false;
    reg.accept(this.model);
    return true;
  }

  decline(): boolean {
    const reg = this.registry();
    if (!reg?.hasModel(this.model)) return false;
    reg.decline(this.model);
    return true;
  }

  private ensureModel(): Promise<void> {
    const reg = this.registry();
    if (!reg) return Promise.reject(new Error("reconnaissance locale indisponible : modèles non configurés"));
    // Jamais « manual » : un artefact ne contourne pas le consentement de l'application.
    return reg.ensureLoaded(this.model, this.load.trim() === "consent" ? "consent" : "first-use");
  }

  private modelFailed(e: unknown): void {
    const code = (e as { code?: string })?.code ?? "";
    const message = e instanceof Error ? e.message : String(e);
    const info =
      code === "declined"
        ? { status: "denied" as const, error: "téléchargement du modèle de reconnaissance refusé" }
        : code === "unsupported"
          ? { status: "unsupported" as const, error: `reconnaissance locale non prise en charge sur cet appareil : ${message}` }
          : code === "quota"
            ? { status: "error" as const, error: `modèle de reconnaissance : ${message}` }
            : { status: "error" as const, error: `reconnaissance locale : ${message}` };
    this.wanted = false;
    this.closeMic();
    this.queue = [];
    this.patch({ ...info, active: false, listening: false, interim: "", transcribing: false });
  }

  // ─── Whisper : micro, phrases, transcription ──────────────────────────────────────────────────────────────────

  private levelAt = 0;
  private audioBlocks = 0;

  private startWhisper(): boolean {
    if (!this.state.supported) return false;
    if (this.wanted && this.ctx) return true;
    const Ctx = audioCtor()!;
    const gen = ++this.gen;
    let ctx: AudioContext;
    try {
      // Créé et relancé dans le geste (Safari, Chrome) ; le micro est demandé juste après.
      ctx = new Ctx();
      void ctx.resume?.()?.catch?.(() => undefined);
    } catch (e) {
      this.fail(e, "reconnaissance vocale");
      return false;
    }
    this.ctx = ctx;
    this.wanted = true;
    this.whisperSettings = this.settings();
    this.matched.clear();
    this.patch({ status: "requesting", error: null, active: true, restarts: 0 });
    // Le modèle se charge pendant que le micro s'ouvre (consentement d'abord si l'application l'exige).
    void this.ensureModel().catch((e) => {
      if (gen === this.gen) this.modelFailed(e);
    });
    void this.openMic(ctx, gen);
    return true;
  }

  private async openMic(ctx: AudioContext, gen: number): Promise<void> {
    const r = await openStream({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }, "micro");
    if (gen !== this.gen || !this.wanted || this.ctx !== ctx) {
      if ("stream" in r) stopStream(r.stream);
      return;
    }
    if (!("stream" in r)) {
      this.wanted = false;
      this.closeMic();
      this.patch({ status: r.status === "paused" ? "error" : r.status, error: r.error, active: false, listening: false });
      return;
    }
    this.stream = r.stream;
    try {
      const src = ctx.createMediaStreamSource(r.stream);
      // ScriptProcessor : aucun module de worklet à charger (pas d'URL de script), suffisant pour 16 kHz.
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      this.nodes = [src, proc, mute];
      this.proc = proc;
      this.segmenter = new SpeechSegmenter({
        sampleRate: ctx.sampleRate,
        silenceMs: Math.round(num(this.silenceMs, 100, 10_000) ?? DEFAULT_SILENCE_MS),
        threshold: num(this.threshold, 0.0005, 1) ?? DEFAULT_THRESHOLD,
      });
      proc.onaudioprocess = (e) => this.onAudio(e, gen);
      // Moteur audio resté en pause (mobile : demande de permission du micro, appel, autre appli) : relancé, état publié.
      const syncState = () => {
        if (gen !== this.gen) return;
        this.patch({ audioState: ctx.state });
        if (ctx.state !== "running" && ctx.state !== "closed" && this.wanted) void ctx.resume?.()?.catch?.(() => undefined);
      };
      ctx.onstatechange = syncState;
      this.audioBlocks = 0;
      syncState();
    } catch (e) {
      this.wanted = false;
      this.closeMic();
      this.fail(e, "reconnaissance vocale");
      return;
    }
    for (const t of r.stream.getAudioTracks?.() ?? []) {
      t.addEventListener?.("ended", () => {
        if (gen !== this.gen || !this.wanted) return;
        this.stopWhisper();
        this.patch({ status: "error", error: "micro coupé (débranché ou repris par une autre application)" });
      });
    }
    this.patch({ status: "ready", listening: true, error: this.state.error });
  }

  private onAudio(e: AudioProcessingEvent, gen: number): void {
    const seg = this.segmenter;
    if (gen !== this.gen || !seg || !this.wanted) return;
    const ib = e.inputBuffer;
    const channels: Float32Array[] = [];
    for (let c = 0; c < ib.numberOfChannels; c++) channels.push(ib.getChannelData(c));
    const segments = seg.push(downmix(channels));
    this.audioBlocks++;
    // vumètre : niveau (RMS ramené à 0..1, échelle racine pour voir les voix faibles) et parole captée
    const now = performance.now();
    if (now - this.levelAt > 100) {
      this.levelAt = now;
      const lvl = Math.round(Math.min(1, Math.sqrt(seg.lastEnergy * 4)) * 100) / 100;
      if (lvl !== this.state.micLevel || seg.inSpeech !== this.state.voice || this.audioBlocks !== this.state.audioBlocks) this.patch({ micLevel: lvl, voice: seg.inSpeech, audioBlocks: this.audioBlocks }, false);
    }
    for (const s of segments) {
      this.enqueue(s, seg.sampleRate, gen);
      if (!this.whisperSettings?.continuous) {
        // Une seule phrase hors mode continu, comme la reconnaissance du navigateur.
        this.wanted = false;
        this.closeMic();
        this.patch({ listening: false });
        break;
      }
    }
  }

  private enqueue(segment: Float32Array, rate: number, gen: number): void {
    this.queue.push(resample(segment, rate));
    if (this.queue.length > MAX_QUEUE) this.queue.shift();
    void this.drain(gen);
  }

  private async drain(gen: number): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const s = this.whisperSettings ?? this.settings();
    try {
      while (this.queue.length && gen === this.gen) {
        const pcm = this.queue.shift()!;
        this.patch({ transcribing: true, interim: "…" });
        if (s.interim) this.action("listen:result", { text: "…", confidence: 0, isFinal: false });
        await this.ensureModel();
        const reg = this.registry();
        if (gen !== this.gen || !reg) break;
        const repo = reg.model(this.model).repo;
        const language = /\.en$/i.test(repo) ? "" : whisperLanguage(s.lang || (globalThis.navigator?.language ?? ""));
        const call: Record<string, unknown> = /\.en$/i.test(repo) ? {} : { task: "transcribe", ...(language ? { language } : {}) };
        const out = await reg.run({ alias: this.model, inputs: [pcm], call, batch: false }, reg.resolvedConfig.defaults.timeoutMs);
        if (gen !== this.gen) break;
        this.deliver(asrText(out[0]), s);
      }
    } catch (e) {
      if (gen === this.gen) this.modelFailed(e);
    } finally {
      this.busy = false;
      if (gen === this.gen) {
        this.patch({ transcribing: false, interim: "" });
        if (!this.wanted && this.state.active) this.patch({ active: false, ...(this.state.status === "ready" || this.state.status === "requesting" ? { status: "ready" } : {}) });
      } else if (this.queue.length) void this.drain(this.gen);
    }
  }

  private deliver(text: string, s: ListenSettings): void {
    if (isWhisperNoise(text)) return;
    const index = ++this.segIndex;
    if (s.phrases.length) this.checkMatch(index, text, s.phrases);
    const transcript = this.state.transcript ? `${this.state.transcript} ${text}` : text;
    this.patch({ final: text, transcript, confidence: 0, alternatives: [{ text, confidence: 0 }], interim: "" });
    this.action("listen:result", { text, confidence: 0, isFinal: true });
  }

  private stopWhisper(): boolean {
    const gen = this.gen;
    const seg = this.segmenter;
    const rate = seg?.sampleRate ?? 0;
    // La phrase en cours est livrée (comme stop() du navigateur), l'écoute s'arrête.
    const last = this.wanted ? seg?.flush() : null;
    this.wanted = false;
    this.closeMic();
    if (last) this.enqueue(last, rate, gen);
    const pending = this.busy || this.queue.length > 0;
    this.patch({ active: false, listening: false, ...(pending ? {} : { interim: "", status: this.state.supported ? "ready" : "unsupported" }) });
    return true;
  }

  private abortWhisper(): boolean {
    this.wanted = false;
    this.gen++;
    this.queue = [];
    this.closeMic();
    this.patch({ active: false, listening: false, interim: "", transcribing: false, micLevel: 0, voice: false, audioState: null, status: this.state.supported ? "ready" : "unsupported" });
    return true;
  }

  private closeMic(): void {
    if (this.proc) this.proc.onaudioprocess = null;
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* déjà débranché */
      }
    }
    this.nodes = [];
    this.proc = null;
    this.segmenter = null;
    stopStream(this.stream);
    this.stream = null;
    const ctx = this.ctx;
    this.ctx = null;
    void ctx?.close?.()?.catch?.(() => undefined);
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
