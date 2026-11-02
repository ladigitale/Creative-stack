import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { compileMap, type CompiledMap } from "../../shared/ml/map-expr";
import { fetchModel, ModelFetchError } from "../../shared/ml/model-fetch";
import { decideTrust, getConsentStore, getMlPolicy, readConsentValue, type TrustDecision } from "../../shared/ml/trust";
import { createMediaPipeEngine, getVisionConfig, type HandEngine } from "./hand-engine";
import { HandTrackerCore, type HandsOutput } from "./hand-state";

const tagName = "sonic-hand-tracker";

export type HandTrackerPhase =
  | "idle"
  | "awaiting-consent"
  | "declined"
  | "downloading"
  | "loading"
  | "ready"
  | "error"
  | "unsupported";

export type HandTrackerStatus = {
  phase: HandTrackerPhase;
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
};

type FrameSource = Element & {
  getFrameCanvas?: () => HTMLCanvasElement | null;
  getFrameSource?: () => HTMLVideoElement | null;
  frameSeq?: number;
};

type Frame = { image: CanvasImageSource; native: boolean; token: number };

const RELOAD_KEYS = ["model", "modelSha256", "gestures", "maxHands", "delegate", "minScore", "engine", "thread"];
const CORE_KEYS = ["smooth", "holdMs", "mirror", "map"];

/**
 * Suit jusqu'à deux mains dans un flux d'images (`for="cam"`) et publie dans un DataProvider leurs
 * points, ouverture, pince, rotation et geste, par rôle `left` / `right` (repère écran).
 * Inférence locale : aucune image ne quitte l'appareil. Le modèle est une donnée : alias, ou URL
 * https soumise aux niveaux de confiance de `shared/ml/trust` (consentement affiché via `statusProvider`).
 */
@customElement(tagName)
export class SonicHandTracker extends LitElement {
  /** Id de la source d'images (`sonic-camera`, `sonic-video`). */
  @property({ type: String, attribute: "for" })
  for = "";

  /** Alias ou URL https du modèle. Vide : `gesture-recognizer` (ou `hand-landmarker` si `gestures="false"`). */
  @property({ type: String })
  model = "";

  /** Empreinte sha256 attendue du modèle (hex, `sha256-` accepté) : refus si elle diffère. */
  @property({ type: String, attribute: "model-sha256" })
  modelSha256 = "";

  /** `auto` (défaut) : worker puis repli sur le fil principal ; `worker` ; `main`. */
  @property({ type: String })
  thread: "auto" | "worker" | "main" = "auto";

  /** `mediapipe` (défaut). Un autre moteur doit être fourni par `configureVision({ createEngine })`. */
  @property({ type: String })
  engine = "mediapipe";

  @property({ type: Number, attribute: "max-hands" })
  maxHands = 2;

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

  /** Une main perdue garde sa dernière valeur (`present` 1) pendant cette durée. */
  @property({ type: Number, attribute: "hold-ms" })
  holdMs = 150;

  @property({ type: Number, attribute: "min-score" })
  minScore = 0.5;

  /** `"false"` : points seuls (HandLandmarker), sans reconnaissance de gestes. */
  @property({ type: String })
  gestures: "true" | "false" = "true";

  /** Clés dérivées calculées avant publication, sans latence : `cents=right.x*3600; gain=left.present ? 1-left.y : 0`. */
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

  private core = new HandTrackerCore({ smooth: 0.5, holdMs: 150, mirror: true });
  private compiledMap: CompiledMap | null = null;
  private handEngine: HandEngine | null = null;
  private loading = false;
  private busy = false;
  private raf = 0;
  private idleHandle: number | ReturnType<typeof setTimeout> | null = null;
  private lastRun = -Infinity;
  private lastToken: number | null = null;
  private lastTs = 0;
  private fpsEma = 0;
  private lastOutput: HandsOutput | null = null;
  private unlistenConsent: (() => void) | null = null;
  private decision: Extract<TrustDecision, { allowed: true }> | null = null;
  private status: HandTrackerStatus = {
    phase: "idle",
    error: null,
    backend: null,
    thread: null,
    download: null,
    fps: 0,
    latencyMs: 0,
    model: null,
    consent: null,
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "none";
    this.syncCore();
    this.syncConsentListener();
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
    this.closeEngine();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (!this.isConnected) return;
    if ([...changed.keys()].some((k) => CORE_KEYS.includes(String(k)))) this.syncCore();
    if (changed.has("consentProvider")) this.syncConsentListener();
    if (this.handEngine && [...changed.keys()].some((k) => RELOAD_KEYS.includes(String(k)))) {
      this.closeEngine();
      void this.loadModel();
    }
  }

  /* ---------------- API ---------------- */

  getState(): HandTrackerStatus {
    return { ...this.status };
  }

  /** Dernière sortie publiée. */
  getOutput(): HandsOutput | null {
    return this.lastOutput;
  }

  /** Charge le modèle (consentement compris) ; sans effet s'il est déjà chargé ou en cours. */
  async loadModel(): Promise<void> {
    if (this.handEngine || this.loading) return;
    const withGestures = this.gestures !== "false";
    const model = this.model.trim() || (withGestures ? "gesture-recognizer" : "hand-landmarker");
    const decision = decideTrust(model, getMlPolicy());
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

    if (this.engine !== "mediapipe" && !getVisionConfig().createEngine) {
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
      const cfg = getVisionConfig();
      const model = await fetchModel(ref.url, {
        maxBytes: getMlPolicy().maxBytes,
        sha256: this.modelSha256.trim() || undefined,
        fetchImpl: cfg.fetchImpl,
        onProgress: (download) => this.patch({ download }),
      });
      if (!this.isConnected) return;
      this.patch({ phase: "loading", download: null });
      const factory = cfg.createEngine ?? createMediaPipeEngine;
      const engine = await factory({
        model,
        gestures: withGestures,
        maxHands: Math.max(1, Math.min(2, Math.round(this.maxHands) || 2)),
        minScore: this.minScore,
        delegate: this.delegate,
        thread: this.thread,
      });
      if (!this.isConnected) {
        engine.close();
        return;
      }
      this.handEngine = engine;
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
  }

  /** Accepte le consentement en attente (mémorisé pour cette origine / ce modèle). */
  accept(): void {
    this.answerConsent("accepted");
  }

  decline(): void {
    this.answerConsent("declined");
  }

  /** Traite une image (public pour les tests) ; `now` en ms. Retourne la sortie publiée, ou `null` si rien à faire. */
  async processFrame(now: number): Promise<HandsOutput | null> {
    const engine = this.handEngine;
    if (!engine || this.busy) return null;
    const frame = this.frame();
    if (!frame || frame.token === this.lastToken) return null;
    this.lastToken = frame.token;
    const ts = Math.max(Math.round(now), this.lastTs + 1);
    this.lastTs = ts;
    this.busy = true;
    const t0 = performance.now();
    let hands;
    try {
      hands = await engine.detect(frame.image, ts);
    } catch (e) {
      if (engine === this.handEngine) {
        this.patch({ phase: "error", error: { code: "detect-failed", message: e instanceof Error ? e.message : String(e) } });
        this.closeEngine();
      }
      return null;
    } finally {
      this.busy = false;
    }
    if (engine !== this.handEngine) return null; // fermé ou rechargé pendant la détection
    const latency = performance.now() - t0;
    const mirror = this.mirror === "true" || (this.mirror === "auto" && frame.native);
    this.core.configure({ mirror });
    const output = this.core.update(hands, now);
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
    if (this.load === "first-use" || this.load === "visible") {
      if (!this.handEngine && !this.loading && this.status.phase === "idle" && this.frame()) void this.loadModel();
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
      return { image: video, native: true, token: video.currentTime };
    }
    const canvas = src.getFrameCanvas?.();
    if (canvas && typeof src.frameSeq === "number" && canvas.width > 0) {
      return { image: canvas, native: false, token: src.frameSeq };
    }
    return null;
  }

  private syncCore(): void {
    const compiled = this.map.trim() ? compileMap(this.map) : null;
    this.compiledMap = compiled;
    if (compiled && !compiled.ok) {
      this.patch({ error: { code: "invalid-map", message: `map : ${compiled.error}` } });
    } else if (this.status.error?.code === "invalid-map") {
      this.patch({ error: null });
    }
    this.core.configure({ smooth: this.smooth, holdMs: this.holdMs, map: compiled });
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
    if (!this.handEngine) void this.loadModel();
  }

  private closeEngine(): void {
    try {
      this.handEngine?.close();
    } catch {
      /* ignoré */
    }
    this.handEngine = null;
    this.lastToken = null;
    this.core.reset();
    if (this.status.phase === "ready") this.status = { ...this.status, phase: "idle" };
  }

  private patch(p: Partial<HandTrackerStatus>): void {
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

export default SonicHandTracker;
