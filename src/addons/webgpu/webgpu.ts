/// <reference types="@webgpu/types" />

import { css, html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { PublisherManager } from "@supersoniks/concorde/utils";
import {
  lookupLiveElement,
  FrameConsumerRegistry,
} from "../../shared/mediaRef";
import { Canvas2dFallbackRuntime } from "./canvas2d-fallback";
import { formBind } from "./form-bind";
import { WebGl2FallbackRuntime } from "./gl-fallback";
import { WebGpuRuntime } from "./gpu-runtime";
import { CHANNEL_FORM_KEYS, LOG_PREFIX, prefersReducedMotion } from "./helpers";
import { outFrame } from "./out-frame";
import { ParticlesRuntime } from "./particles-runtime";
import { pointer } from "./pointer";
import { listenDp } from "../../shared/audio/dp";
import {
  WEBGPU_IDLE,
  WEBGPU_STATE_KEYS,
  describeWebGpuError,
  readWebGpuParams,
  type WebGpuLiveParams,
} from "./state";
import type {
  SonicWebGpuBackend,
  SonicWebGpuBackendPrefer,
  SonicWebGpuKernel,
  SonicWebGpuState,
} from "./types";
import { parseBackendPrefer, parseKernel, WebGpuCompileError } from "./types";

const tagName = "sonic-webgpu";

type GpuRuntime =
  | WebGpuRuntime
  | WebGl2FallbackRuntime
  | Canvas2dFallbackRuntime
  | ParticlesRuntime;

/**
 * Renderer WebGPU (passe fullscreen WGSL / kernel particles), fallback WebGL2 puis Canvas2D.
 * Opt-in: import `@supersoniks/concorde/webgpu`.
 *
 * Glue : `dataProvider` → `channel0…3` + `param0…3` (string | SonicMediaRef).
 * Snapshot DP (`frameUrl` / `snapshot`) uniquement si `frame-out` (3d accepte aussi un listener seul).
 * Défaut `backend="auto"` : WGSL custom → WebGPU puis WebGL2 ; sinon WebGL2 puis WebGPU ; Canvas2D en dernier.
 */
@customElement(tagName)
export class SonicWebGpu extends LitElement {
  static styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
      max-width: 100%;
      height: auto;
      aspect-ratio: var(--sonic-webgpu-ar, 16 / 9);
      overflow: hidden;
      background: #0a0a0a;
      color: #f87171;
      font: 12px/1.4 ui-monospace, monospace;
    }
    canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
      touch-action: none;
    }
    .stage {
      position: absolute;
      inset: 0;
    }
    .err {
      position: absolute;
      inset: 0;
      z-index: 1;
      padding: 0.75rem;
      background: rgba(0, 0, 0, 0.85);
      white-space: pre-wrap;
      overflow: auto;
    }
    .notice {
      position: absolute;
      left: 0.5rem;
      bottom: 0.5rem;
      z-index: 1;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      background: rgba(0, 0, 0, 0.65);
      color: #fbbf24;
      font-size: 11px;
      pointer-events: none;
    }
  `;

  /** Corps WGSL avec `fn mainImage(uv, fragCoord) -> vec4f` (kernel image). */
  @property() shader = "";

  /**
   * `particles` — simulation compute (démarque de sonic-shader).
   * `image` / vide — fullscreen + canaux.
   */
  @property({ type: String }) kernel: SonicWebGpuKernel | string = "";

  /**
   * `auto` (défaut) | `webgpu` | `webgl2`.
   * En `auto`, fallback WebGL2 si adapter WebGPU absent.
   */
  @property({ type: String, attribute: "backend" })
  backendPrefer: SonicWebGpuBackendPrefer = "auto";

  /** Backend réellement utilisé (reflect). */
  @property({ type: String, reflect: true, attribute: "active-backend" })
  activeBackend: SonicWebGpuBackend | "" = "";

  @property() channel0 = "";
  @property() channel1 = "";
  @property() channel2 = "";
  @property() channel3 = "";

  @property({ type: Boolean, reflect: true }) play = true;
  @property({ type: Boolean }) mouse = true;
  @property({ type: Boolean, attribute: "release-offscreen" })
  releaseOffscreen = false;
  @property({ type: Number, attribute: "dpr-max" }) dprMax = 2;

  @property({ type: Number, attribute: "param0" }) param0 = 0;
  @property({ type: Number, attribute: "param1" }) param1 = 0;
  @property({ type: Number, attribute: "param2" }) param2 = 0;
  @property({ type: Number, attribute: "param3" }) param3 = 0;

  @property({ type: String }) dataProvider = "";
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";
  @property({ type: Number, attribute: "out-interval" }) outInterval = 80;
  /** Publie `frameUrl` + `snapshot` (SonicMediaRef) vers le out-DP. */
  @property({ type: Boolean, attribute: "frame-out" }) frameOut = false;
  @property({ type: String, attribute: "aspect-ratio" }) aspectRatio = "";
  /**
   * DP de réglages en direct, prioritaires sur les attributs : `{ play, mouse, backend, dprMax, shader }`.
   * `backend` redémarre le rendu, `shader` recompile (regroupés sur ~150 ms).
   * Une clé absente ou invalide rend la main à l'attribut.
   */
  @property({ type: String }) params = "";

  @state() private errorMessage = "";
  @state() private fallbackNotice = "";

  /** État standard (`status`, `error`, `errors`…), publié dans le DP de sortie. */
  stateValue: SonicWebGpuState = { ...WEBGPU_IDLE, errors: [], backendLog: [] };
  private lastStateJson = "";
  private live: WebGpuLiveParams = {};
  private liveInvalidKey = "";
  private unsubParams: (() => void) | null = null;
  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  private liveRestart = false;
  private liveRecompile = false;
  /** Backend demandé pendant un démarrage en vol : redémarrer à la fin. */
  private rebootPending = false;

  /** Canvas hors template Lit — évite destroy/recreate du contexte GL. */
  private canvasEl: HTMLCanvasElement | null = null;
  /** État partagé avec form-bind / out-frame / pointer (pattern sonic-3d). */
  runtime: GpuRuntime | null = null;
  raf = 0;
  startTime = 0;
  frame = 0;
  /** Contrat SonicFrameSource — incrémenté après chaque draw. */
  frameSeq = 0;
  mouseVec: [number, number, number, number] = [0, 0, 0, 0];
  /** Cible normalisée (0–1, origine haut-gauche) depuis dataProvider — tracking / DP. */
  remoteTarget: { x: number; y: number } | null = null;
  hovering = false;
  outEventListeners = 0;
  private releasing = false;
  private inView = true;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private rebuildToken = 0;
  private frameConsumers = new FrameConsumerRegistry();
  ready = false;
  /** Évite deux boots concurrents (IO + rAF) qui disposent le fallback. */
  private boot: Promise<void> | null = null;
  formPublisher: ReturnType<typeof PublisherManager.get> | null = null;
  outPublisher: ReturnType<typeof PublisherManager.get> | null = null;
  lastOutAt = 0;
  lastFrameUrl = "";
  frameOutBusy = false;
  frameOutSeq = 0;
  onFormMutation = () => {
    const data = (this.formPublisher?.get() ?? {}) as Record<string, unknown>;
    formBind.applyFormParams(this as never, data);
  };

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener("pointermove", this.onPointerMove as EventListener);
    this.addEventListener("pointerdown", this.onPointerDown as EventListener);
    this.addEventListener("pointerup", this.onPointerUp as EventListener);
    this.addEventListener("pointerleave", this.onPointerLeave);
    this.addEventListener("pointerenter", this.onPointerEnter);
    this.bindFormProvider();
    this.bindOutPublisher();
    this.listenParams();
    this.lastStateJson = "";
    this.publishState({});
  }

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (type === "out" && listener) this.outEventListeners++;
    super.addEventListener(type, listener as never, options);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (type === "out" && listener) {
      this.outEventListeners = Math.max(0, this.outEventListeners - 1);
    }
    super.removeEventListener(type, listener as never, options);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("pointermove", this.onPointerMove as EventListener);
    this.removeEventListener("pointerdown", this.onPointerDown as EventListener);
    this.removeEventListener("pointerup", this.onPointerUp as EventListener);
    this.removeEventListener("pointerleave", this.onPointerLeave);
    this.removeEventListener("pointerenter", this.onPointerEnter);
    this.unbindFormProvider();
    this.unsubParams?.();
    this.unsubParams = null;
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = null;
    this.liveRestart = false;
    this.liveRecompile = false;
    this.rebootPending = false;
    this.revokeFrameUrl();
    this.frameConsumers.clear();
    this.frameOutSeq++;
    this.frameOutBusy = false;
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.rebuildToken++;
    this.releasing = true;
    this.releaseRuntime();
    this.outPublisher = null;
    this.releasing = false;
  }

  protected firstUpdated() {
    this.ensureCanvas();
    this.resizeObserver = new ResizeObserver(() => {
      this.syncSize();
      // Taille souvent 0 au premier layout docs — relancer la boucle dès que OK
      if (this.ready && this.runtime) this.syncPlayback();
    });
    this.resizeObserver.observe(this);
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        this.inView = entries.some((e) => e.isIntersecting);
        this.syncVisibility();
      },
      // Anticiper un peu le viewport docs (évite écran noir avant le 1er pixel visible)
      { threshold: 0, rootMargin: "80px 0px" },
    );
    this.intersectionObserver.observe(this);
    this.bindFormProvider();
    this.bindOutPublisher();
    // Toujours booter : la boucle RAF attend inView, pas le device
    requestAnimationFrame(() => {
      void this.ensureRuntime();
    });
  }

  protected updated(changed: Map<string, unknown>) {
    if (changed.has("params") && changed.get("params") !== undefined && this.isConnected) {
      this.listenParams();
    }
    if (
      (changed.has("dataProvider") || changed.has("outDataProvider")) &&
      this.isConnected
    ) {
      this.bindOutPublisher();
      this.lastStateJson = "";
      this.publishState({});
    }
    if (changed.has("fallbackNotice")) {
      this.publishState({ notice: this.fallbackNotice || null });
    }
    if (changed.has("mouse")) this.syncCursor();
    if (
      (changed.has("backendPrefer") || changed.has("kernel")) &&
      (this.runtime || this.boot)
    ) {
      this.restartRuntime();
      return;
    }
    if (!this.runtime) return;
    const keys = ["shader", ...CHANNEL_FORM_KEYS];
    if (keys.some((k) => changed.has(k))) {
      if (changed.has("shader")) this.noteShaderOnFallback();
      void this.rebuild();
    }
    if (changed.has("play")) this.syncPlayback();
    if (changed.has("dataProvider") || changed.has("outDataProvider")) {
      this.bindFormProvider();
      this.bindOutPublisher();
    }
    if (changed.has("aspectRatio")) this.applyAspectRatio();
  }

  // ── Réglages en direct (DP `params`) ─────────────────────────────────────

  private listenParams() {
    this.unsubParams?.();
    this.unsubParams = null;
    const path = this.params?.trim();
    if (!path) {
      if (Object.keys(this.live).length) this.applyLive({});
      return;
    }
    this.unsubParams = listenDp(path, (v) => {
      const { live, invalid } = readWebGpuParams(v);
      const key = invalid.join(",");
      if (key && key !== this.liveInvalidKey) {
        console.warn(`${LOG_PREFIX} params : valeur refusée pour ${key}`);
      }
      this.liveInvalidKey = key;
      this.applyLive(live);
    });
  }

  private applyLive(next: WebGpuLiveParams) {
    const before = {
      play: this.effPlay,
      mouse: this.mouseActive,
      backend: this.effBackend,
      dprMax: this.effDprMax,
      shader: this.effShader,
    };
    this.live = next;
    if (before.play !== this.effPlay) this.syncPlayback();
    if (before.mouse !== this.mouseActive) {
      this.syncCursor();
      if (!this.mouseActive) pointer.onUp(this as never);
    }
    if (before.dprMax !== this.effDprMax) this.syncSize();
    if (before.backend !== this.effBackend) this.liveRestart = true;
    if (before.shader !== this.effShader) this.liveRecompile = true;
    if (this.liveRestart || this.liveRecompile) {
      // Regroupe une rafale (saisie clavier, curseur) en un seul redémarrage / une compilation.
      if (this.liveTimer) clearTimeout(this.liveTimer);
      this.liveTimer = setTimeout(() => this.flushLive(), 150);
    }
  }

  private flushLive() {
    this.liveTimer = null;
    const restart = this.liveRestart;
    const recompile = this.liveRecompile;
    this.liveRestart = false;
    this.liveRecompile = false;
    if (!this.isConnected) return;
    if (restart) {
      this.restartRuntime();
      return;
    }
    if (recompile && this.runtime) {
      this.noteShaderOnFallback();
      void this.rebuild();
    }
  }

  /** Change de backend / kernel : libère puis redémarre (ou après le démarrage en vol). */
  private restartRuntime() {
    if (this.boot && !this.runtime) {
      this.rebootPending = true;
      return;
    }
    this.releaseRuntime();
    this.activeBackend = "";
    this.publishState({
      status: "compiling",
      error: null,
      errors: [],
      activeBackend: null,
      notice: null,
      playing: false,
    });
    void this.ensureRuntime();
  }

  private noteShaderOnFallback() {
    if (this.runtime?.backend === "webgl2") {
      this.fallbackNotice = this.effShader.trim()
        ? "WebGL2 (fallback) — WGSL ignoré, canaux/params OK"
        : "WebGL2 (fallback)";
    }
  }

  private syncCursor() {
    if (this.canvasEl) this.canvasEl.style.cursor = this.mouseActive ? "crosshair" : "default";
  }

  private get effPlay(): boolean {
    return this.live.play ?? this.play;
  }

  /** Pointeur → `iMouse` (attribut `mouse`, sinon `params.mouse`). Lu par pointer / form-bind. */
  get mouseActive(): boolean {
    return this.live.mouse ?? this.mouse;
  }

  private get effBackend(): SonicWebGpuBackendPrefer {
    return this.live.backend ?? parseBackendPrefer(this.backendPrefer);
  }

  private get effDprMax(): number {
    const v = this.live.dprMax ?? this.dprMax;
    return Number.isFinite(v) && v > 0 ? v : 2;
  }

  private get effShader(): string {
    return this.live.shader ?? this.shader;
  }

  // ── État publié ──────────────────────────────────────────────────────────

  /**
   * Met à jour l'état et le publie (seulement s'il change) dans le DP de sortie, fusionné à la
   * racine, et en event `webgpu-state`. Les publications par frame (`out-frame`) le recopient.
   */
  private publishState(patch: Partial<SonicWebGpuState>) {
    const next: SonicWebGpuState = { ...this.stateValue, ...patch };
    const json = JSON.stringify(next);
    this.stateValue = next;
    if (json === this.lastStateJson) return;
    this.lastStateJson = json;
    if (!this.outPublisher) this.bindOutPublisher();
    const pub = this.outPublisher;
    if (pub) {
      const plainState = JSON.parse(json) as Record<string, unknown>;
      try {
        const prev =
          ((pub as { get?: () => Record<string, unknown> }).get?.() as
            | Record<string, unknown>
            | null
            | undefined) ?? {};
        const base = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
        (pub as { set: (v: unknown) => void }).set({ ...base, ...plainState });
      } catch {
        for (const key of WEBGPU_STATE_KEYS) {
          try {
            (pub as Record<string, { set: (v: unknown) => void }>)[key].set(plainState[key]);
          } catch {
            /* ignore */
          }
        }
      }
    }
    this.dispatchEvent(
      new CustomEvent("webgpu-state", { detail: next, bubbles: true, composed: true }),
    );
  }

  private notePlaying(playing: boolean) {
    if (this.stateValue.playing !== playing) this.publishState({ playing });
  }

  private applyAspectRatio(textureUrl?: string) {
    const forced = this.aspectRatio.trim();
    if (forced) {
      this.style.setProperty(
        "--sonic-webgpu-ar",
        forced.includes("/") ? forced : forced.replace(":", " / "),
      );
      return;
    }
    const url = textureUrl || this.channel0;
    const size = url ? this.runtime?.getTextureSize(url) : null;
    if (size) {
      this.style.setProperty(
        "--sonic-webgpu-ar",
        `${size.width} / ${size.height}`,
      );
      return;
    }
    this.style.removeProperty("--sonic-webgpu-ar");
  }

  private unbindFormProvider() {
    formBind.unbindFormProvider(this as never);
  }

  private bindFormProvider() {
    formBind.bindFormProvider(this as never);
  }

  private bindOutPublisher() {
    formBind.bindOutPublisher(this as never);
  }

  private applyRemoteMouse() {
    formBind.applyRemoteMouse(this as never);
  }

  private ensureRuntime() {
    if (this.runtime || this.releasing) return this.boot ?? Promise.resolve();
    if (!this.boot) {
      this.boot = this.bootRuntime().finally(() => {
        this.boot = null;
        if (this.rebootPending) {
          this.rebootPending = false;
          if (this.isConnected) this.restartRuntime();
        }
      });
    }
    return this.boot;
  }

  private async bootRuntime() {
    this.ensureCanvas();
    this.publishState({ status: "compiling", error: null, errors: [] });
    const prefer = this.effBackend;
    const kernel = parseKernel(this.kernel);
    const log: string[] = [];
    try {
      let runtime: GpuRuntime | null = null;

      if (kernel === "particles") {
        try {
          runtime = await ParticlesRuntime.create(this.ensureCanvas());
          log.push(`particles:${runtime.backend}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`particles:${msg}`);
        }
      } else {
        const tryWebgl2 = (): boolean => {
          try {
            runtime = WebGl2FallbackRuntime.create(this.ensureCanvas());
            log.push("webgl2:ok");
            return true;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log.push(`webgl2:${msg}`);
            console.warn(`${LOG_PREFIX} WebGL2 failed:`, msg);
            this.replaceCanvas();
            return false;
          }
        };

        const tryWebgpu = async (): Promise<boolean> => {
          if (typeof navigator.gpu === "undefined") {
            log.push("webgpu:no-navigator.gpu");
            return false;
          }
          const probe = await WebGpuRuntime.probe();
          if (probe) {
            log.push(`webgpu:probe:${probe}`);
            return false;
          }
          try {
            runtime = await WebGpuRuntime.create(this.ensureCanvas());
            log.push("webgpu:ok");
            return true;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log.push(`webgpu:create:${msg}`);
            console.warn(`${LOG_PREFIX} WebGPU failed:`, msg);
            this.replaceCanvas();
            return false;
          }
        };

        if (prefer === "webgpu") {
          if (!(await tryWebgpu())) {
            throw new Error(log.join(" → ") || "WebGPU indisponible");
          }
        } else if (prefer === "webgl2") {
          if (!tryWebgl2()) {
            throw new Error(log.join(" → ") || "WebGL2 indisponible");
          }
        } else {
          // auto : WGSL custom → WebGPU d’abord (sinon fallback GLSL ignore le shader)
          const preferWgpuFirst = !!this.effShader.trim();
          const ok = preferWgpuFirst
            ? (await tryWebgpu()) || tryWebgl2()
            : tryWebgl2() || (await tryWebgpu());
          if (!ok) {
            try {
              runtime = Canvas2dFallbackRuntime.create(this.ensureCanvas());
              log.push("canvas2d:ok");
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              throw new Error([...log, `canvas2d:${msg}`].join(" → "));
            }
          }
        }
      }

      if (!runtime) {
        throw new Error(log.join(" → ") || "Aucun backend GPU");
      }
      if (this.releasing) {
        runtime.dispose(true);
        return;
      }

      this.runtime = runtime;
      const maybeGl2 = this.runtime as unknown as {
        setElementResolver?: (fn: (key: string) => Element | null) => void;
      };
      maybeGl2.setElementResolver?.((key) => this.lookupElement(key));
      const backend = runtime.backend as SonicWebGpuBackend;
      this.activeBackend = backend;
      let notice = "";
      if (kernel === "particles") {
        notice =
          backend === "webgpu"
            ? "Compute particles (WebGPU)"
            : "Particles (Canvas2D fallback)";
      } else if (backend === "webgl2" && this.effShader.trim()) {
        notice = "WebGL2 — WGSL ignoré (canaux/params OK)";
      } else if (backend === "canvas2d") {
        notice = `Canvas2D — ${log.filter((l) => !l.endsWith(":ok")).join(" · ") || "GPU indisponible"}`;
      }
      this.fallbackNotice = notice;
      this.errorMessage = "";
      this.publishState({
        activeBackend: backend,
        backendLog: [...log],
        notice: notice || null,
      });
      console.info(`${LOG_PREFIX} backend:`, backend, "kernel:", kernel, log);
      this.dispatchEvent(
        new CustomEvent("backend", {
          detail: { backend, prefer, kernel, log },
          bubbles: true,
          composed: true,
        }),
      );
      await this.rebuild();
    } catch (e) {
      this.errorMessage = e instanceof Error ? e.message : String(e);
      this.activeBackend = "";
      this.fallbackNotice = "";
      console.error(`${LOG_PREFIX} boot failed:`, this.errorMessage, log);
      this.publishState({
        status: "error",
        ...describeWebGpuError(e),
        activeBackend: null,
        backendLog: [...log],
        notice: null,
        playing: false,
      });
      this.dispatchEvent(
        new CustomEvent("error", {
          detail: { message: this.errorMessage, log },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private ensureCanvas(): HTMLCanvasElement {
    if (this.canvasEl?.isConnected) return this.canvasEl;
    const stage =
      (this.renderRoot.querySelector(".stage") as HTMLElement | null) ??
      (this.renderRoot as unknown as HTMLElement);
    let canvas = stage.querySelector?.("canvas") as HTMLCanvasElement | null;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.setAttribute("part", "canvas");
      stage.appendChild(canvas);
    }
    canvas.style.touchAction = "none";
    canvas.style.cursor = this.mouseActive ? "crosshair" : "default";
    this.canvasEl = canvas;
    return canvas;
  }

  /** Jette le canvas (verrouillé webgpu/webgl) et en crée un neuf. */
  private replaceCanvas(): HTMLCanvasElement {
    const stage =
      (this.renderRoot.querySelector(".stage") as HTMLElement | null) ??
      (this.renderRoot as unknown as HTMLElement);
    if (this.canvasEl?.parentNode) {
      this.canvasEl.parentNode.removeChild(this.canvasEl);
    }
    const canvas = document.createElement("canvas");
    canvas.setAttribute("part", "canvas");
    stage.appendChild(canvas);
    this.canvasEl = canvas;
    return canvas;
  }

  /** Résout `#id` dans getRootNode() puis document ; clés live `__sonic_frame_`. */
  private lookupElement(key: string): Element | null {
    if (!key.startsWith("#")) return null;
    const live = lookupLiveElement(key);
    if (live) return live;
    const id = key.slice(1);
    if (!id || id.startsWith("__sonic_frame_")) return null;
    const root = this.getRootNode();
    if (root instanceof Document || root instanceof ShadowRoot) {
      const el = root.getElementById(id);
      if (el) return el;
    }
    return typeof document !== "undefined" ? document.getElementById(id) : null;
  }

  private releaseRuntime() {
    this.stopLoop();
    this.ready = false;
    this.runtime?.dispose(true);
    this.runtime = null;
    if (this.canvasEl?.parentNode) {
      this.canvasEl.parentNode.removeChild(this.canvasEl);
    }
    this.canvasEl = null;
  }

  /** Enregistre les producteurs live pour play-offscreen auto. */
  private syncFrameConsumers() {
    const keys = [this.channel0, this.channel1, this.channel2, this.channel3];
    this.frameConsumers.sync(
      keys.filter((k) => k.startsWith("#")).map((k) => this.lookupElement(k)),
    );
  }

  private async rebuild() {
    if (!this.runtime) return;
    const token = ++this.rebuildToken;
    this.ready = false;
    this.publishState({ status: "compiling", error: null, errors: [] });
    try {
      await this.runtime.setShader(this.effShader);
      if (token !== this.rebuildToken) return;
      if (this.runtime instanceof WebGl2FallbackRuntime) {
        await this.runtime.setChannels([
          this.channel0,
          this.channel1,
          this.channel2,
          this.channel3,
        ]);
      } else {
        await Promise.all([
          this.runtime.setChannel(0, this.channel0),
          this.runtime.setChannel(1, this.channel1),
          this.runtime.setChannel(2, this.channel2),
          this.runtime.setChannel(3, this.channel3),
        ]);
      }
      if (token !== this.rebuildToken) return;
      this.syncFrameConsumers();
      this.errorMessage = "";
      this.ready = true;
      this.publishState({ status: "ready", error: null, errors: [] });
      this.syncSize();
      this.applyAspectRatio(this.channel0);
      this.startTime = performance.now();
      this.frame = 0;
      this.syncPlayback();
    } catch (e) {
      const message =
        e instanceof WebGpuCompileError
          ? e.infoLog
            ? `${e.message}\n${e.infoLog}`
            : e.message
          : e instanceof Error
            ? e.message
            : String(e);
      if (token !== this.rebuildToken) return;
      this.errorMessage = message;
      const described = describeWebGpuError(e);
      this.publishState({ status: "error", ...described, playing: false });
      this.dispatchEvent(
        new CustomEvent("error", {
          detail: {
            message,
            infoLog: e instanceof WebGpuCompileError ? e.infoLog : undefined,
            errors: described.errors,
          },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private syncSize() {
    if (!this.runtime) return;
    const rect = this.getBoundingClientRect();
    const dpr = Math.min(
      typeof devicePixelRatio === "number" ? devicePixelRatio : 1,
      this.effDprMax,
    );
    this.runtime.resize(rect.width * dpr, rect.height * dpr);
  }

  private syncVisibility() {
    if (!this.inView && this.releaseOffscreen) {
      this.stopLoop();
      this.notePlaying(false);
      return;
    }
    if (!this.runtime) {
      void this.ensureRuntime();
      return;
    }
    this.syncSize();
    this.syncPlayback();
  }

  private shouldPlay(): boolean {
    return (
      this.effPlay &&
      !!this.runtime &&
      this.ready &&
      !this.errorMessage &&
      !prefersReducedMotion() &&
      (this.inView || !this.releaseOffscreen)
    );
  }

  private syncPlayback() {
    if (!this.ready || !this.runtime) {
      this.notePlaying(false);
      return;
    }
    if (this.shouldPlay()) this.startLoop();
    else this.stopLoop();
    this.notePlaying(this.shouldPlay());
  }

  private startLoop() {
    if (this.raf) return;
    const tick = (now: number) => {
      this.raf = 0;
      if (this.runtime && this.ready) {
        this.syncSize();
        const w = this.runtime.canvas.width;
        const h = this.runtime.canvas.height;
        if (w >= 2 && h >= 2) {
          try {
            if (!this.startTime) this.startTime = now;
            const time = (now - this.startTime) / 1000;
            this.applyRemoteMouse();
            if (this.runtime instanceof WebGpuRuntime) {
              this.runtime.updateLiveChannels((key) => this.lookupElement(key));
            }
            this.runtime.draw({
              width: w,
              height: h,
              time,
              frame: this.frame,
              mouse: this.mouseVec,
              params: [this.param0, this.param1, this.param2, this.param3],
            });
            this.frame++;
            this.frameSeq++;
            this.maybePublishOut(now, time);
          } catch (e) {
            console.warn(`${LOG_PREFIX} frame skip:`, e);
          }
        }
      }
      if (this.shouldPlay()) {
        this.raf = requestAnimationFrame(tick);
      } else {
        this.notePlaying(false);
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopLoop() {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private maybePublishOut(now: number, time: number) {
    outFrame.maybePublishOut(this as never, now, time);
  }

  /** Contrat SonicFrameSource — canvas WebGPU / fallback. */
  getFrameCanvas(): HTMLCanvasElement | null {
    if (!this.ready || this.errorMessage) return null;
    return this.canvasEl;
  }

  private revokeFrameUrl() {
    outFrame.revokeFrameUrl(this as never);
  }

  private onPointerMove = (e: PointerEvent) =>
    pointer.onMove(this as never, e);
  private onPointerDown = (e: PointerEvent) =>
    pointer.onDown(this as never, e);
  private onPointerUp = () => pointer.onUp(this as never);
  private onPointerEnter = () => pointer.onEnter(this as never);
  private onPointerLeave = () => pointer.onLeave(this as never);

  render() {
    return html`
      <div class="stage" part="stage"></div>
      ${this.errorMessage
        ? html`<div class="err" part="error">${this.errorMessage}</div>`
        : this.fallbackNotice
          ? html`<div class="notice" part="notice">${this.fallbackNotice}</div>`
          : null}
    `;
  }
}

export type {
  SonicWebGpuBackend,
  SonicWebGpuBackendPrefer,
  SonicWebGpuConfig,
  SonicWebGpuKernel,
  SonicWebGpuOutput,
  SonicWebGpuState,
  WebGpuErrorItem,
} from "./types";
export { describeWebGpuError, readWebGpuParams } from "./state";
export type { WebGpuLiveParams } from "./state";
export { parseBackendPrefer, parseKernel, WebGpuCompileError } from "./types";
export { buildWgslSource, DEFAULT_MAIN_IMAGE, wgslUserLine } from "./wgsl-prelude";
export { WebGpuRuntime, channelTextureNeedsRecreate } from "./gpu-runtime";
export { WebGl2FallbackRuntime } from "./gl-fallback";
export { Canvas2dFallbackRuntime } from "./canvas2d-fallback";
export { ParticlesRuntime } from "./particles-runtime";
export { channelFormValue } from "./helpers";
