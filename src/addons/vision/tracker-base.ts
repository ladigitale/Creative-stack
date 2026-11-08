import { LitElement } from "lit";
import { property } from "lit/decorators.js";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import { compileMap, type CompiledMap } from "../../shared/ml/map-expr";
import { fetchModel, ModelFetchError } from "../../shared/ml/model-fetch";
import { decideTrust, getConsentStore, getMlPolicy, readConsentValue, type TrustDecision } from "../../shared/ml/trust";
import { getVisionConfig } from "./mp-engine";
import { MIRROR, ParamOverlay, flag, readParams, realChanges, snapshot, type ParamSpecs } from "./live-params";

export type TrackerPhase =
  | "idle"
  | "awaiting-consent"
  | "declined"
  | "downloading"
  | "loading"
  | "ready"
  | "error"
  | "unsupported";

/** Statut standard de creative-stack, dérivé de `phase`. */
export type TrackerStandardStatus = "idle" | "requesting" | "ready" | "denied" | "error" | "unsupported";

export type TrackerStatus = {
  /** `idle`, `requesting` (consentement, téléchargement, chargement), `ready`, `denied` (refusé), `error`, `unsupported`. */
  status: TrackerStandardStatus;
  phase: TrackerPhase;
  error: { code: string; message: string } | null;
  backend: "gpu" | "cpu" | null;
  /** `worker` (hors du fil principal) ou `main` (repli). */
  thread: "worker" | "main" | null;
  /** Progression du téléchargement du modèle (octets), en phase `downloading`. */
  download: { loaded: number; total: number | null } | null;
  /** Cadence d'inférence mesurée (images / s). */
  fps: number;
  /** Durée de la dernière détection (ms). */
  latencyMs: number;
  model: { url: string; origin: string } | null;
  /** Renseigné en `awaiting-consent` : ce que l'utilisateur doit accepter. */
  consent: { key: string; origin: string; url: string } | null;
  /** `false` : inférence en pause (`control.active`). */
  active: boolean;
  /** Réglages effectifs (attributs recouverts par `control` puis `params`). */
  settings: Record<string, unknown>;
};

type InnerStatus = Omit<TrackerStatus, "status" | "settings">;

const STANDARD: Record<TrackerPhase, TrackerStandardStatus> = {
  idle: "idle",
  "awaiting-consent": "requesting",
  downloading: "requesting",
  loading: "requesting",
  declined: "denied",
  ready: "ready",
  error: "error",
  unsupported: "unsupported",
};

/** Délai de regroupement des rechargements du modèle (réglages qui exigent de recréer le moteur). */
const RELOAD_DELAY_MS = 150;

/** Moteur vu par la base : détecte sur une image, résultat propre à la tâche. */
export type TrackerEngine<R> = {
  detect(frame: CanvasImageSource, tsMs: number): Promise<R>;
  readonly backend: "gpu" | "cpu";
  readonly thread: "worker" | "main";
  close(): void;
};

type FrameSource = Element & {
  getFrameCanvas?: () => HTMLCanvasElement | null;
  getFrameSource?: () => HTMLVideoElement | null;
  frameSeq?: number;
};

type Frame = {
  image: CanvasImageSource;
  native: boolean;
  token: number;
  /** `frameSeq` de la source au moment de la prise (identité exacte de l'image analysée). */
  seq: number | null;
  /** `currentTime` (s) de la `<video>` analysée, `null` pour une source canvas. */
  time: number | null;
};

/**
 * Clés ajoutées à chaque sortie publiée : elles disent QUELLE image de la source a été analysée.
 * `sonic-frame-sync sync="<dp du tracker>"` s'en sert pour afficher exactement cette image,
 * de sorte que vidéo et effet restent alignés malgré le temps de calcul.
 */
export type TrackerFrameMeta = {
  /** `frameSeq` de la source (caméra, vidéo, écran) pour l'image analysée. */
  frameSeq: number | null;
  /** `currentTime` de la vidéo analysée (secondes), `null` hors `<video>`. */
  frameTime: number | null;
  /** `performance.now()` (ms) au moment où l'image a été envoyée au modèle. */
  capturedAt: number;
  /** Durée de l'inférence pour cette image (ms) : `capturedAt + latencyMs` = arrivée du résultat. */
  latencyMs: number;
};

const BASE_RELOAD_KEYS = ["model", "modelSha256", "delegate", "minScore", "engine", "thread"];
const BASE_CORE_KEYS = ["smooth", "holdMs", "mirror", "map"];

/**
 * Socle des composants de suivi ML (`sonic-hand-tracker`, `sonic-face-tracker`, `sonic-pose-tracker`) :
 * source d'images (`for`), modèle (alias / URL, confiance, consentement, téléchargement vérifié),
 * moteur (worker + repli), boucle d'inférence à cadence plafonnée, statut et sortie en DataProvider.
 * Les sous-classes fournissent le modèle par défaut, la création du moteur et la conversion du
 * résultat en clés de sortie.
 *
 * `R` = résultat du moteur ; `O` = sortie publiée.
 */
export abstract class SonicMlTracker<R, O> extends LitElement {
  /** Id de la source d'images (`sonic-camera`, `sonic-video`). */
  @property({ type: String, attribute: "for" })
  for = "";

  /** Alias ou URL https du modèle (vide : modèle par défaut du composant). */
  @property({ type: String })
  model = "";

  /** Empreinte sha256 attendue du modèle (hex, `sha256-` accepté) : refus si elle diffère. */
  @property({ type: String, attribute: "model-sha256" })
  modelSha256 = "";

  /** `auto` (défaut) : worker puis repli sur le fil principal ; `worker` ; `main`. */
  @property({ type: String })
  thread: "auto" | "worker" | "main" = "auto";

  /** `mediapipe` (défaut). Un autre moteur doit être fourni par `configureVision`. */
  @property({ type: String })
  engine = "mediapipe";

  /** Cadence maximale d'inférence (images / s). */
  @property({ type: Number })
  fps = 30;

  @property({ type: String })
  delegate: "gpu" | "cpu" | "auto" = "auto";

  /** `auto` (défaut) : miroir seulement pour la source native (`<video>` non retournée) ; `true` / `false` forcent. */
  @property({ type: String })
  mirror: "auto" | "true" | "false" = "auto";

  /** Lissage One Euro, 0 (aucun) à 1. */
  @property({ type: Number })
  smooth = 0.5;

  /** Une entité perdue garde sa dernière valeur (`present` 1) pendant cette durée. */
  @property({ type: Number, attribute: "hold-ms" })
  holdMs = 150;

  @property({ type: Number, attribute: "min-score" })
  minScore = 0.5;

  /** Clés dérivées calculées avant publication, sans latence (voir `shared/ml/map-expr`). */
  @property({ type: String })
  map = "";

  /** DataProvider de sortie (défaut : l'id de l'élément). */
  @property({ type: String })
  outputProvider = "";

  /** DataProvider du statut (défaut : `<id>State`). */
  @property({ type: String })
  statusProvider = "";

  /** Consentement : `accepted` / `true` ou `declined` / `false`. */
  @property({ type: String })
  consentProvider = "";

  /** `auto` | `idle` | `first-use` (défaut) | `visible` | `manual`. */
  @property({ type: String })
  load: "auto" | "idle" | "first-use" | "visible" | "manual" = "first-use";

  /**
   * DataProvider de réglages en direct (clés de `paramSpecs()` : `minScore`, `smooth`, `holdMs`, `fps`, `mirror`,
   * plus celles du composant). Prioritaire sur les attributs et sur `control`.
   */
  @property({ type: String })
  params = "";

  /**
   * DataProvider de pilotage : `active` (`false` met l'inférence en pause), `load` (compteur : une hausse charge
   * le modèle, utile en `load="manual"`) ; accepte aussi les clés de réglage (sous `params`).
   */
  @property({ type: String })
  control = "";

  /* ---------- à fournir par les sous-classes ---------- */

  /** Alias du modèle quand `model` est vide. */
  protected abstract defaultModel(): string;
  /** Crée le moteur à partir du modèle téléchargé. */
  protected abstract createEngine(model: Uint8Array): Promise<TrackerEngine<R>>;
  /** Convertit le résultat du moteur en sortie publiée. `mirror` : retourner x. */
  protected abstract toOutput(result: R, now: number, mirror: boolean): O;
  /** Applique lissage, maintien et `map` au cœur de la sous-classe. */
  protected abstract configureCore(opts: { smooth: number; holdMs: number; map: CompiledMap | null }): void;
  protected abstract resetCore(): void;
  /** Propriétés dont le changement exige de recharger le moteur (en plus de celles de la base). */
  protected extraReloadKeys(): string[] {
    return [];
  }
  /** Moteur personnalisé de l'hôte pour ce composant, si `configureVision` en fournit un. */
  protected hasCustomEngine(): boolean {
    return false;
  }
  /**
   * Clés de réglage lues dans `params` / `control` (nom de propriété → validation). Les sous-classes ajoutent les
   * leurs : `return { ...super.paramSpecs(), maxHands: { kind: "number", min: 1, max: 2, int: true } }`.
   * Une clé listée dans les clés de rechargement recrée le moteur (regroupé, voir `RELOAD_DELAY_MS`).
   */
  protected paramSpecs(): ParamSpecs {
    return {
      minScore: { kind: "number", min: 0, max: 1 },
      smooth: { kind: "number", min: 0, max: 1 },
      holdMs: { kind: "number", min: 0, max: 10000, int: true },
      fps: { kind: "number", min: 1, max: 120 },
      mirror: MIRROR,
    };
  }

  private trackerEngine: TrackerEngine<R> | null = null;
  private loading = false;
  private busy = false;
  private raf = 0;
  private idleHandle: number | ReturnType<typeof setTimeout> | null = null;
  private lastRun = -Infinity;
  private lastToken: number | null = null;
  private lastTs = 0;
  private fpsEma = 0;
  private lastOutput: O | null = null;
  private unlistenConsent: (() => void) | null = null;
  private decision: Extract<TrustDecision, { allowed: true }> | null = null;
  private overlay = new ParamOverlay(this);
  private fromControl: Record<string, unknown> = {};
  private fromParams: Record<string, unknown> = {};
  private unlistenDp: Array<() => void> = [];
  private loadTrigger = new CounterTrigger();
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private reloadPending = false;
  private settled = false;
  private status: InnerStatus = {
    phase: "idle",
    error: null,
    backend: null,
    thread: null,
    download: null,
    fps: 0,
    latencyMs: 0,
    model: null,
    consent: null,
    active: true,
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "none";
    this.syncCore();
    this.syncConsentListener();
    this.listenSettings();
    if (this.load === "auto") void this.loadModel();
    else if (this.load === "idle") this.scheduleIdle();
    this.publishStatus();
    this.raf = requestAnimationFrame(this.onFrame);
  }

  disconnectedCallback(): void {
    cancelAnimationFrame(this.raf);
    if (this.idleHandle !== null) {
      if (typeof cancelIdleCallback === "function" && typeof this.idleHandle === "number") cancelIdleCallback(this.idleHandle);
      else clearTimeout(this.idleHandle as ReturnType<typeof setTimeout>);
      this.idleHandle = null;
    }
    this.unlistenConsent?.();
    this.unlistenConsent = null;
    this.unlistenSettings();
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
    this.reloadPending = false;
    this.closeEngine();
    super.disconnectedCallback();
  }

  protected willUpdate(changed: Map<PropertyKey, unknown>): void {
    super.willUpdate(changed);
    this.overlay.guard(changed);
  }

  protected updated(changed: Map<string, unknown>): void {
    if (!this.isConnected) return;
    const keys = realChanges(this, changed);
    if (keys.some((k) => BASE_CORE_KEYS.includes(k))) this.syncCore();
    if (changed.has("consentProvider")) this.syncConsentListener();
    if (changed.has("params") || changed.has("control")) this.listenSettings();
    const reload = [...BASE_RELOAD_KEYS, ...this.extraReloadKeys()];
    // Premier rendu : toutes les propriétés figurent dans `changed`, le chargement en cours les lit déjà.
    if (this.settled && (this.trackerEngine || this.loading) && keys.some((k) => reload.includes(k))) this.scheduleReload();
    this.settled = true;
    const specs = this.paramSpecs();
    if (keys.some((k) => k in specs)) this.publishStatus();
  }

  /* ---------------- API ---------------- */

  getState(): TrackerStatus {
    return { ...this.status, status: STANDARD[this.status.phase], settings: snapshot(this, this.paramSpecs()) };
  }

  /** Met l'inférence en pause (`false`) ou la reprend (comme `control.active`). */
  setActive(active: boolean): void {
    if (this.status.active === active) return;
    this.patch({ active });
  }

  /** Dernière sortie publiée. */
  getOutput(): O | null {
    return this.lastOutput;
  }

  /** Charge le modèle (consentement compris) ; sans effet s'il est déjà chargé ou en cours. */
  async loadModel(): Promise<void> {
    if (this.trackerEngine || this.loading) return;
    const modelRef = this.model.trim() || this.defaultModel();
    const decision = decideTrust(modelRef, getMlPolicy());
    if (!decision.allowed) {
      this.patch({ phase: "error", error: { code: decision.code, message: decision.message }, consent: null });
      return;
    }
    this.decision = decision;
    const ref = decision.ref;
    this.patch({ model: { url: ref.url, origin: new URL(ref.url).origin }, error: null });

    if (decision.needsConsent) {
      const store = getConsentStore();
      const provided = this.consentProvider ? readConsentValue(readDp(this.consentProvider)) : null;
      if (provided) store.set(decision.consentKey, provided);
      const answer = provided ?? store.get(decision.consentKey);
      if (answer === "declined") {
        this.patch({ phase: "declined", consent: null });
        return;
      }
      if (answer !== "accepted") {
        this.patch({
          phase: "awaiting-consent",
          consent: { key: decision.consentKey, origin: new URL(ref.url).origin, url: ref.url },
        });
        return;
      }
    }

    if (this.engine !== "mediapipe" && !this.hasCustomEngine()) {
      this.patch({
        phase: "unsupported",
        error: { code: "unsupported-engine", message: `Moteur « ${this.engine} » non disponible.` },
        consent: null,
      });
      return;
    }

    this.loading = true;
    try {
      this.patch({ phase: "downloading", consent: null, download: { loaded: 0, total: null } });
      const model = await fetchModel(ref.url, {
        maxBytes: getMlPolicy().maxBytes,
        sha256: this.modelSha256.trim() || undefined,
        fetchImpl: getVisionConfig().fetchImpl,
        onProgress: (download) => this.patch({ download }),
      });
      if (!this.isConnected) return;
      this.patch({ phase: "loading", download: null });
      const engine = await this.createEngine(model);
      if (!this.isConnected) {
        engine.close();
        return;
      }
      this.trackerEngine = engine;
      this.patch({ phase: "ready", backend: engine.backend, thread: engine.thread, error: null });
    } catch (e) {
      const code = e instanceof ModelFetchError ? e.code : "load-failed";
      this.patch({
        phase: "error",
        download: null,
        error: { code, message: e instanceof Error ? e.message : String(e) },
      });
    } finally {
      this.loading = false;
    }
    // Réglage modifié pendant le chargement : le moteur créé peut l'ignorer, on le recrée.
    if (this.reloadPending && this.isConnected) {
      this.reloadPending = false;
      this.scheduleReload();
    }
  }

  /** Accepte le consentement en attente (mémorisé pour cette origine / ce modèle). */
  accept(): void {
    this.answerConsent("accepted");
  }

  decline(): void {
    this.answerConsent("declined");
  }

  /** Traite une image (public pour les tests) ; `now` en ms. Retourne la sortie publiée, ou `null` si rien à faire. */
  async processFrame(now: number): Promise<O | null> {
    const engine = this.trackerEngine;
    if (!engine || this.busy || !this.status.active) return null;
    const frame = this.frame();
    if (!frame || frame.token === this.lastToken) return null;
    this.lastToken = frame.token;
    const ts = Math.max(Math.round(now), this.lastTs + 1);
    this.lastTs = ts;
    this.busy = true;
    const t0 = performance.now();
    let result: R;
    try {
      result = await engine.detect(frame.image, ts);
    } catch (e) {
      if (engine === this.trackerEngine) {
        this.patch({ phase: "error", error: { code: "detect-failed", message: e instanceof Error ? e.message : String(e) } });
        this.closeEngine();
      }
      return null;
    } finally {
      this.busy = false;
    }
    if (engine !== this.trackerEngine) return null; // fermé ou rechargé pendant la détection
    const latency = performance.now() - t0;
    const mirror = this.mirror === "true" || (this.mirror === "auto" && frame.native);
    const meta: TrackerFrameMeta = {
      frameSeq: frame.seq,
      frameTime: frame.time,
      capturedAt: t0,
      latencyMs: Math.round(latency * 10) / 10,
    };
    const output = Object.assign({}, this.toOutput(result, now, mirror), meta) as O;
    this.lastOutput = output;
    const dt = now - this.lastRun;
    if (Number.isFinite(dt) && dt > 0) this.fpsEma = this.fpsEma ? this.fpsEma * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;
    this.lastRun = now;
    this.status = { ...this.status, fps: Math.round(this.fpsEma * 10) / 10, latencyMs: Math.round(latency * 10) / 10 };
    const out = (this.outputProvider || this.id).trim();
    if (out) set(out, output);
    this.publishStatus();
    return output;
  }

  /* ---------------- interne ---------------- */

  private onFrame = (now: number) => {
    this.raf = requestAnimationFrame(this.onFrame);
    if (!this.status.active) return;
    if (this.load === "first-use" || this.load === "visible") {
      if (!this.trackerEngine && !this.loading && this.status.phase === "idle" && this.frame()) void this.loadModel();
    }
    if (now - this.lastRun < 1000 / Math.max(1, this.fps) - 2) return;
    void this.processFrame(now);
  };

  private scheduleIdle(): void {
    const run = () => {
      this.idleHandle = null;
      void this.loadModel();
    };
    this.idleHandle =
      typeof requestIdleCallback === "function" ? requestIdleCallback(run, { timeout: 2000 }) : setTimeout(run, 200);
  }

  private source(): FrameSource | null {
    const id = this.for.trim().replace(/^#/, "");
    if (!id) return null;
    const root = this.getRootNode() as Document | ShadowRoot;
    return (root.getElementById?.(id) ?? document.getElementById(id)) as FrameSource | null;
  }

  private frame(): Frame | null {
    const src = this.source();
    if (!src) return null;
    const video = src.getFrameSource?.();
    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      return {
        image: video,
        native: true,
        token: video.currentTime,
        seq: typeof src.frameSeq === "number" ? src.frameSeq : null,
        time: video.currentTime,
      };
    }
    const canvas = src.getFrameCanvas?.();
    if (canvas && typeof src.frameSeq === "number" && canvas.width > 0) {
      return { image: canvas, native: false, token: src.frameSeq, seq: src.frameSeq, time: null };
    }
    return null;
  }

  private syncCore(): void {
    const compiled = this.map.trim() ? compileMap(this.map) : null;
    if (compiled && !compiled.ok) {
      this.patch({ error: { code: "invalid-map", message: `map : ${compiled.error}` } });
    } else if (this.status.error?.code === "invalid-map") {
      this.patch({ error: null });
    }
    this.configureCore({ smooth: this.smooth, holdMs: this.holdMs, map: compiled });
  }

  /** Écoute `params` et `control`. */
  private listenSettings(): void {
    this.unlistenSettings();
    this.loadTrigger.reset();
    const ctl = this.control.trim();
    if (ctl) {
      this.unlistenDp.push(
        listenDp(ctl, (v) => {
          const c = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
          const active = flag(c.active);
          if (active !== undefined) this.setActive(active);
          if (this.loadTrigger.feed(c.load)) void this.loadModel();
          this.fromControl = readParams(this.paramSpecs(), c);
          this.applySettings();
        }),
      );
    }
    const prm = this.params.trim();
    if (prm) {
      this.unlistenDp.push(
        listenDp(prm, (v) => {
          this.fromParams = readParams(this.paramSpecs(), v);
          this.applySettings();
        }),
      );
    }
  }

  private unlistenSettings(): void {
    this.unlistenDp.forEach((u) => u());
    this.unlistenDp = [];
  }

  private applySettings(): void {
    this.overlay.set({ ...this.fromControl, ...this.fromParams });
  }

  /**
   * Recrée le moteur avec les réglages courants. Regroupé : plusieurs changements rapprochés (curseur) ne
   * rechargent qu'une fois ; pendant un chargement, le rechargement attend sa fin. L'ancien moteur tourne
   * jusqu'au rechargement.
   */
  private scheduleReload(): void {
    if (this.loading) {
      this.reloadPending = true;
      return;
    }
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      if (!this.isConnected) return;
      if (this.loading) {
        this.reloadPending = true;
        return;
      }
      if (!this.trackerEngine) return;
      this.closeEngine();
      void this.loadModel();
    }, RELOAD_DELAY_MS);
  }

  private syncConsentListener(): void {
    this.unlistenConsent?.();
    this.unlistenConsent = null;
    if (!this.consentProvider) return;
    this.unlistenConsent = listenDp(this.consentProvider, (v) => {
      const answer = readConsentValue(v);
      if (answer) this.answerConsent(answer);
    });
  }

  private answerConsent(answer: "accepted" | "declined"): void {
    const key = this.status.consent?.key ?? this.decision?.consentKey;
    if (key) getConsentStore().set(key, answer);
    if (answer === "declined") {
      this.patch({ phase: "declined", consent: null });
      return;
    }
    if (!this.trackerEngine) void this.loadModel();
  }

  private closeEngine(): void {
    try {
      this.trackerEngine?.close();
    } catch {
      /* ignoré */
    }
    this.trackerEngine = null;
    this.lastToken = null;
    this.resetCore();
    if (this.status.phase === "ready") this.status = { ...this.status, phase: "idle" };
  }

  private patch(p: Partial<InnerStatus>): void {
    this.status = { ...this.status, ...p };
    this.publishStatus();
  }

  private publishQueued = false;
  private publishStatus(): void {
    const out = (this.statusProvider || (this.id ? `${this.id}State` : "")).trim();
    if (!out || this.publishQueued) return;
    this.publishQueued = true;
    queueMicrotask(() => {
      this.publishQueued = false;
      set(out, this.getState());
    });
  }

  render() {
    return null;
  }
}

function readDp(path: string): unknown {
  try {
    return dp(path).get();
  } catch {
    return undefined;
  }
}
