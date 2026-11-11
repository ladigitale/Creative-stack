import { css, html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import HTML from "@supersoniks/concorde/core/utils/HTML";
import { revokeMediaUrls, toMediaUrl, mediaElementKey, lookupLiveElement, FrameConsumerRegistry, isFrameSource } from "../../shared/mediaRef";
import { CounterTrigger } from "../../shared/media/control";
import { PublisherManager } from "@supersoniks/concorde/utils";
import { listenDp } from "../../shared/audio/dp";
import { describeShaderError } from "./errors";
import {
  SHADER_IDLE,
  SHADER_STATE_KEYS,
  SOURCE_KEYS,
  readShaderParams,
  type ShaderLiveParams,
  type SonicShaderState,
} from "./state";
import {
  parseChannelSource,
  ShaderToyRuntime,
} from "./gl-runtime";
import {
  PassChannels,
  ReleaseOffscreen,
  ShaderBufferFormat,
  ShaderCompileError,
  ShaderExtractItem,
  ShaderExtractOutput,
  ShaderHoverParam,
  ShaderMouseMode,
  ShaderPassId,
  ShaderRoi,
  ShaderSources,
  SonicShaderOutput,
  channelsUseSelf,
  findPeaks,
  meanRgba,
  parseBufferFormat,
  parseExtractPass,
  parseHoverParam,
  parseReleaseOffscreen,
  roiToPixels,
  rgbaToUint8,
  shouldReleaseWhenOffscreen,
} from "./types";

const tagName = "sonic-shader";

const MAX_PATCH_PX = 128;

/** Clés qui forcent une recompilation / recreate FBO. */
const PROGRAM_KEYS = [
  "image",
  "bufferA",
  "bufferB",
  "bufferC",
  "bufferD",
  "common",
  "bufferFormat",
] as const;

/** Clés qui ne font que re-lier les textures (pas de rebuild). */
const CHANNEL_KEYS = [
  "channel0",
  "channel1",
  "channel2",
  "channel3",
  "imageCh0",
  "imageCh1",
  "imageCh2",
  "imageCh3",
  "bufferACh0",
  "bufferACh1",
  "bufferACh2",
  "bufferACh3",
  "bufferBCh0",
  "bufferBCh1",
  "bufferBCh2",
  "bufferBCh3",
  "bufferCCh0",
  "bufferCCh1",
  "bufferCCh2",
  "bufferCCh3",
  "bufferDCh0",
  "bufferDCh1",
  "bufferDCh2",
  "bufferDCh3",
] as const;

/**
 * Champs méta publiés vers le out-dataProvider.
 * `param0…3` sont exclus du gate « consommateur » : un `sonic-input name="param0"`
 * ne doit pas activer la publication (sinon write-back → reset des champs form).
 */
const OUT_META_KEYS = [
  "time",
  "frame",
  "mouseX",
  "mouseY",
  "hovering",
] as const;

const OUT_PARAM_KEYS = ["param0", "param1", "param2", "param3"] as const;

/** Champs canaux lisibles depuis dataProvider (string | SonicMediaRef). */
const CHANNEL_FORM_KEYS = [
  "channel0",
  "channel1",
  "channel2",
  "channel3",
  "imageCh0",
  "imageCh1",
  "imageCh2",
  "imageCh3",
  "bufferACh0",
  "bufferACh1",
  "bufferACh2",
  "bufferACh3",
  "bufferBCh0",
  "bufferBCh1",
  "bufferBCh2",
  "bufferBCh3",
  "bufferCCh0",
  "bufferCCh1",
  "bufferCCh2",
  "bufferCCh3",
  "bufferDCh0",
  "bufferDCh1",
  "bufferDCh2",
  "bufferDCh3",
] as const;

/** Champs sample (coûteux : readPixels). */
const OUT_SAMPLE_KEYS = [
  "sampleR",
  "sampleG",
  "sampleB",
  "sampleA",
  "sampleLuma",
] as const;

const EXTRACT_OUT_KEYS = ["extracts", "extractCount", "extractSeq"] as const;

type OutPublisherLike = {
  _proxies_?: Map<string, { hasListener?: () => boolean }>;
  get?: () => Record<string, unknown>;
};

function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function toNum(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** Valeur canal depuis DP : string (url, buffer-a, #id) | MediaRef → url | { element }. */
function channelFormValue(value: unknown): string | undefined {
  if (value === null || value === "") return "";
  if (typeof value === "string") return value.trim();
  const url = toMediaUrl(value);
  if (url) return url;
  if (value && typeof value === "object") {
    const el = (value as { element?: unknown }).element;
    const key = mediaElementKey(el);
    if (key) return key;
    return undefined;
  }
  return "";
}

/** Exposé pour tests. */
export { channelFormValue };

function parseRois(value: unknown): ShaderRoi[] {
  if (!Array.isArray(value)) return [];
  const out: ShaderRoi[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const x = toNum(o.x, NaN);
    const y = toNum(o.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const roi: ShaderRoi = { x, y, source: "manual" };
    if (typeof o.id === "string" && o.id) roi.id = o.id;
    if ("w" in o) roi.w = toNum(o.w, 0);
    if ("h" in o) roi.h = toNum(o.h, 0);
    if ("patch" in o) roi.patch = toNum(o.patch, 16);
    out.push(roi);
  }
  return out;
}

const BYTES_PER_PIXEL = 4;

async function rgbaToBlobUrl(
  data: Uint8Array,
  width: number,
  height: number,
): Promise<string | null> {
  if (typeof document === "undefined" || width < 1 || height < 1) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // WebGL readPixels is bottom-up; flip for canvas display.
    const imageData = ctx.createImageData(width, height);
    const dst = imageData.data;
    for (let y = 0; y < height; y++) {
      const srcRow = (height - 1 - y) * width * BYTES_PER_PIXEL;
      const dstRow = y * width * BYTES_PER_PIXEL;
      for (let i = 0; i < width * BYTES_PER_PIXEL; i++) {
        dst[dstRow + i] = data[srcRow + i];
      }
    }
    ctx.putImageData(imageData, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob((b) => resolve(b), "image/png");
      } catch {
        resolve(null);
      }
    });
    if (blob) return URL.createObjectURL(blob);
    // Fallback (certs navigateurs / contexts bloquent toBlob)
    const dataUrl = canvas.toDataURL("image/png");
    return dataUrl || null;
  } catch {
    return null;
  }
}

/** `"2048x2048"` → [2048, 2048] (côtés bornés à 16..8192) ; autre valeur → null. */
export function parseRenderSize(v: string): [number, number] | null {
  const m = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(v || "");
  if (!m) return null;
  const side = (n: number) => Math.round(Math.min(8192, Math.max(16, n)));
  return [side(Number(m[1])), side(Number(m[2]))];
}

function assignExtractMediaUrls(item: ShaderExtractItem, url: string): void {
  item.blobUrl = url;
  item.url = url;
}

type PendingRoi = ShaderRoi & { score?: number };

/**
 * ShaderToy-compatible multipass renderer (Image + Buffer A–D + Common).
 * Opt-in: import `@supersoniks/concorde/shader`.
 *
 * Optional `dataProvider` (attr or ancestor `dataProvider` / `formDataProvider`):
 * maps form fields `param0`…`param3` → uniforms `uParam0`…`uParam3`.
 */
@customElement(tagName)
export class SonicShader extends LitElement {
  static styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
      max-width: 100%;
      height: auto;
      aspect-ratio: var(--sonic-shader-ar, 16 / 9);
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
    .err {
      position: absolute;
      inset: 0;
      z-index: 1;
      padding: 0.75rem;
      background: rgba(0, 0, 0, 0.85);
      white-space: pre-wrap;
      overflow: auto;
    }
  `;

  @property() image = "";
  @property({ attribute: "buffer-a" }) bufferA = "";
  @property({ attribute: "buffer-b" }) bufferB = "";
  @property({ attribute: "buffer-c" }) bufferC = "";
  @property({ attribute: "buffer-d" }) bufferD = "";
  @property() common = "";

  @property() channel0 = "";
  @property() channel1 = "";
  @property() channel2 = "";
  @property() channel3 = "";

  @property({ attribute: "image-ch0" }) imageCh0 = "";
  @property({ attribute: "image-ch1" }) imageCh1 = "";
  @property({ attribute: "image-ch2" }) imageCh2 = "";
  @property({ attribute: "image-ch3" }) imageCh3 = "";

  @property({ attribute: "buffer-a-ch0" }) bufferACh0 = "";
  @property({ attribute: "buffer-a-ch1" }) bufferACh1 = "";
  @property({ attribute: "buffer-a-ch2" }) bufferACh2 = "";
  @property({ attribute: "buffer-a-ch3" }) bufferACh3 = "";

  @property({ attribute: "buffer-b-ch0" }) bufferBCh0 = "";
  @property({ attribute: "buffer-b-ch1" }) bufferBCh1 = "";
  @property({ attribute: "buffer-b-ch2" }) bufferBCh2 = "";
  @property({ attribute: "buffer-b-ch3" }) bufferBCh3 = "";

  @property({ attribute: "buffer-c-ch0" }) bufferCCh0 = "";
  @property({ attribute: "buffer-c-ch1" }) bufferCCh1 = "";
  @property({ attribute: "buffer-c-ch2" }) bufferCCh2 = "";
  @property({ attribute: "buffer-c-ch3" }) bufferCCh3 = "";

  @property({ attribute: "buffer-d-ch0" }) bufferDCh0 = "";
  @property({ attribute: "buffer-d-ch1" }) bufferDCh1 = "";
  @property({ attribute: "buffer-d-ch2" }) bufferDCh2 = "";
  @property({ attribute: "buffer-d-ch3" }) bufferDCh3 = "";

  @property({ type: Boolean, reflect: true }) play = true;
  /**
   * N’anime que pendant le hover (ou tant que le param hover n’a pas fini
   * sa transition). Utile avec beaucoup d’instances.
   */
  @property({ type: Boolean, attribute: "play-on-hover" }) playOnHover = false;
  @property({ type: Boolean }) mouse = true;
  /**
   * `direct` — `iMouse.xy` = pointeur (ShaderToy).
   * `target` — le pointeur est une cible ; `iMouse.xy` suit (vitesse ∝ distance).
   */
  @property({ type: String, attribute: "mouse-mode" })
  mouseMode: ShaderMouseMode = "direct";
  /**
   * Vitesse de poursuite en mode `target` (1/s). Plus haut = plus snappy.
   * Déplacement ≈ `(cible − pos) * (1 − e^(−speed·dt))`.
   */
  @property({ type: Number, attribute: "mouse-speed" }) mouseSpeed = 8;
  /**
   * Anime `uParamN` au rollover / roll-out (0↔1). Ex. `hover-param="0"` ou `"param0"`.
   * Le shader lit `uParamN` pour mixer l’effet on/off.
   */
  @property({ attribute: "hover-param" }) hoverParam: ShaderHoverParam | string =
    "";
  /** Vitesse d’easing hover on/off (1/s, défaut 10). */
  @property({ type: Number, attribute: "hover-speed" }) hoverSpeed = 10;
  /**
   * Hors viewport : libère textures/FBO (garde le contexte).
   * `auto` (défaut) : ne libère pas si une passe lit `self`.
   * `true` / `false` forcent le comportement.
   */
  @property({
    attribute: "release-offscreen",
    converter: {
      fromAttribute: (value: string | null) => parseReleaseOffscreen(value),
      toAttribute: (value: ReleaseOffscreen) => {
        if (value === "auto") return "auto";
        if (value === false) return "false";
        return "";
      },
    },
  })
  releaseOffscreen: ReleaseOffscreen = "auto";
  @property({ type: Number, attribute: "dpr-max" }) dprMax = 2;
  /**
   * Taille de rendu fixe, indépendante de l'affichage : `"2048x2048"` (16 à 8192 px de côté) ou `channel0`
   * (la taille de l'image de la source branchée sur channel0, suivie quand elle change). Le canvas reste
   * affiché à la taille de l'élément. Pour un post-traitement en pleine résolution (finition d'une toile
   * `sonic-paint`, export) ou une source nette pour `sonic-vectorize`.
   */
  @property({ type: String, attribute: "render-size" }) renderSize = "";
  /** DP de commandes à compteur : `{ save: n }` enregistre l'image rendue en PNG dans `last` (état). */
  @property({ type: String }) control = "";
  /**
   * Format des buffers A–D : `rgba8` (défaut) | `rgba16f` | `rgba32f`.
   * Attribut reflété `active-buffer-format` = format réellement utilisé.
   */
  @property({ attribute: "buffer-format" })
  bufferFormat: ShaderBufferFormat | string = "rgba8";
  /** Format actif après repli éventuel (lecture seule, reflect). */
  @property({ attribute: "active-buffer-format", reflect: true })
  activeBufferFormat: ShaderBufferFormat = "rgba8";

  /** Generic float uniforms `uParam0`…`uParam3` (no shader rebuild). */
  @property({ type: Number, attribute: "param0" }) param0 = 0;
  @property({ type: Number, attribute: "param1" }) param1 = 0;
  @property({ type: Number, attribute: "param2" }) param2 = 0;
  @property({ type: Number, attribute: "param3" }) param3 = 0;

  /**
   * Publisher id. Fields `param0`…`param3` feed `uParam0`…`uParam3`.
   * Falls back to ancestor `dataProvider` or `formDataProvider` when unset.
   * Also used as default out publisher (see `outDataProvider`).
   */
  @property({ type: String })
  dataProvider = "";

  /**
   * Publisher de sortie. Défaut : même id que `dataProvider` / ancêtre.
   * Écrit mouseX/Y, hovering, frame (+ sample* si `sample`).
   * Sur DP partagé form+out : ne réécrit pas param0…3 (sauf slot hover-param).
   * Paresseux : pas de set / readPixels sans lecteur méta/sample ni listener `out`.
   */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  /**
   * DP de réglages en direct, prioritaires sur les attributs :
   * `{ play, playOnHover, mouse, mouseMode, mouseSpeed, hoverSpeed, dprMax,
   *    image, bufferA…bufferD, common, bufferFormat }`.
   * Une source GLSL ou `bufferFormat` modifiés recompilent (regroupés sur ~120 ms).
   * Une clé absente ou invalide rend la main à l'attribut.
   */
  @property({ type: String }) params = "";

  /**
   * Active le sample couleur → sampleR/G/B/A + sampleLuma.
   * `readPixels` uniquement s’il y a un consommateur out (DP ou event `out`).
   */
  @property({ type: Boolean }) sample = false;

  /** Intervalle de publication / event `out` (ms, défaut 80). */
  @property({ type: Number, attribute: "out-interval" }) outInterval = 80;

  /** Active l’extraction de patches / singularités. */
  @property({ type: Boolean }) extract = false;
  /** Throttle extract ms (défaut = `out-interval` ou 100). */
  @property({ type: Number, attribute: "extract-interval" })
  extractInterval = 0;
  /** Pass où lire les pixels couleur : `image` \| `buffer-a`… */
  @property({ type: String, attribute: "extract-source" })
  extractSource = "image";
  /** Pass mask pour détection : `none` \| `buffer-a`… */
  @property({ type: String, attribute: "extract-mask" })
  extractMask = "none";
  /** Seuil 0–1 sur le mask (défaut 0.5). */
  @property({ type: Number, attribute: "extract-threshold" })
  extractThreshold = 0.5;
  /** Cap N items détectés (défaut 8). */
  @property({ type: Number, attribute: "extract-max" }) extractMax = 8;
  /** Taille patch px par défaut pour un point (défaut 16). */
  @property({ type: Number, attribute: "extract-patch" }) extractPatch = 16;
  /** Génère des blob URLs par item. */
  @property({ type: Boolean, attribute: "extract-bitmaps" })
  extractBitmaps = false;
  /** Publisher dédié extract (défaut = out / dataProvider). */
  @property({ type: String, attribute: "extract-data-provider" })
  extractDataProvider = "";

  /**
   * Force CSS aspect-ratio (e.g. `"16/9"`, `"1"`).
   * When empty, uses channel0 (or first texture) dimensions.
   */
  @property({ type: String, attribute: "aspect-ratio" })
  aspectRatio = "";

  @state() private errorMessage = "";

  /** État standard (`status`, `error`, `errors`…), publié dans le DP de sortie. */
  stateValue: SonicShaderState = { ...SHADER_IDLE, errors: [], passes: [] };
  private lastStateJson = "";
  /** Réglages du DP `params` (vide = attributs seuls). */
  private live: ShaderLiveParams = {};
  /** Clés refusées du DP `params` (journal console, une fois par valeur). */
  private liveInvalidKey = "";
  private unsubParams: (() => void) | null = null;
  private liveRebuildTimer: ReturnType<typeof setTimeout> | null = null;

  private runtime: ShaderToyRuntime | null = null;
  private raf = 0;
  private startTime = 0;
  private lastTime = 0;
  private frame = 0;
  /** Incrémenté après chaque render (contrat SonicFrameSource). */
  frameSeq = 0;
  private mouseVec: [number, number, number, number] = [0, 0, 0, 0];
  /** Cible pointeur (px drawing buffer, origine bas-gauche). */
  private mouseTarget: [number, number] = [0, 0];
  /** Position suivie → `iMouse.xy` en mode target. */
  private mouseFollow: [number, number] = [0, 0];
  private mouseHasPointer = false;
  private pointerDown = false;
  private hovering = false;
  private hoverGoal = 0;
  /**
   * Valeur easée 0↔1 pour le slot `hover-param`.
   * Privée (pas une @property) pour éviter un requestUpdate Lit à chaque frame
   * — sinon re-renders / write-back dataProvider → enter/leave en boucle.
   */
  private hoverMix = 0;
  private leaveRaf = 0;
  /** Compteur d’écouteurs `out` (publication paresseuse). */
  private outEventListeners = 0;
  /** Compteur d’écouteurs `extract`. */
  private extractEventListeners = 0;
  private releasing = false;
  private inView = true;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private rebuildToken = 0;
  /** Annule un `rebindChannels` en vol si rebuild / release intervient. */
  private rebindToken = 0;
  private frameConsumers = new FrameConsumerRegistry();
  private ready = false;
  private formPublisher: ReturnType<typeof PublisherManager.get> | null = null;
  private outPublisher: ReturnType<typeof PublisherManager.get> | null = null;
  private extractPublisher: ReturnType<typeof PublisherManager.get> | null =
    null;
  private lastOutAt = 0;
  private lastExtractAt = 0;
  private manualRois: ShaderRoi[] = [];
  private lastBlobUrls: string[] = [];
  private pendingRevokeUrls: string[] = [];
  private extractRunning = false;
  private extractSeq = 0;
  private channelUnsubs: Array<() => void> = [];
  private onFormMutation = () => {
    const data = { ...((this.formPublisher?.get() ?? {}) as Record<string, unknown>) };
    // Canal branché par sonic-mix : la valeur vit dans le sous-publisher (celui de la source), pas forcément
    // dans la valeur racine du DP.
    const pub = this.formPublisher as unknown as Record<string, { get?: () => unknown } | undefined> | null;
    if (pub) {
      for (const key of CHANNEL_FORM_KEYS) {
        const child = pub[key];
        const v = typeof child?.get === "function" ? child.get() : undefined;
        // Un sous-publisher est créé à la volée par le proxy : vide, il ne dit rien (ne pas effacer l'attribut).
        const usable = typeof v === "string" ? v.trim() !== "" : !!v && typeof v === "object" && Object.keys(v as object).length > 0;
        if (usable) data[key] = v;
      }
    }
    this.applyFormParams(data);
  };

  connectedCallback() {
    super.connectedCallback();
    if (this.control && this.hasUpdated) this.listenControl();
    this.addEventListener("pointermove", this.onPointerMove as EventListener);
    this.addEventListener("pointerdown", this.onPointerDown as EventListener);
    this.addEventListener("pointerup", this.onPointerUp as EventListener);
    this.addEventListener("pointerleave", this.onPointerLeave);
    this.addEventListener("pointerenter", this.onPointerEnter);
    this.bindFormProvider();
    this.bindOutPublisher();
    this.bindExtractPublisher();
    this.listenParams();
    this.lastStateJson = "";
    this.publishState({});
  }

  /**
   * Suit les listeners `out` / `extract` pour ne publier (et ne readPixels)
   * que s’il y a un consommateur — zéro coût tant que personne ne lit.
   */
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (type === "out" && listener) this.outEventListeners++;
    if (type === "extract" && listener) this.extractEventListeners++;
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
    if (type === "extract" && listener) {
      this.extractEventListeners = Math.max(0, this.extractEventListeners - 1);
    }
    super.removeEventListener(type, listener as never, options);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.recoverTimer);
    this.controlUnsub?.();
    this.controlUnsub = null;
    this.removeEventListener("pointermove", this.onPointerMove as EventListener);
    this.removeEventListener("pointerdown", this.onPointerDown as EventListener);
    this.removeEventListener("pointerup", this.onPointerUp as EventListener);
    this.removeEventListener("pointerleave", this.onPointerLeave);
    this.removeEventListener("pointerenter", this.onPointerEnter);
    if (this.leaveRaf) {
      cancelAnimationFrame(this.leaveRaf);
      this.leaveRaf = 0;
    }
    this.unbindFormProvider();
    this.unsubParams?.();
    this.unsubParams = null;
    if (this.liveRebuildTimer) clearTimeout(this.liveRebuildTimer);
    this.liveRebuildTimer = null;
    this.unbindContextEvents();
    this.revokeBlobUrls();
    for (const url of this.pendingRevokeUrls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }
    this.pendingRevokeUrls = [];
    this.stopLoop();
    this.frameConsumers.clear();
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.rebuildToken++;
    this.rebindToken++;
    this.ready = false;
    this.releasing = true;
    this.runtime?.dispose(true); // libère le slot navigateur
    this.runtime = null;
    this.outPublisher = null;
    this.releasing = false;
  }

  protected firstUpdated() {
    this.resizeObserver = new ResizeObserver(() => this.syncSize());
    this.resizeObserver.observe(this);
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        this.inView = entries.some((e) => e.isIntersecting);
        this.syncVisibility();
      },
      { threshold: 0 },
    );
    this.intersectionObserver.observe(this);
    this.bindFormProvider();
    this.bindOutPublisher();
    this.bindExtractPublisher();
    requestAnimationFrame(() => {
      if (this.inView || !this.wantsReleaseOffscreen()) {
        void this.ensureRuntime();
      }
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
      // Nouveau DP de sortie : y republier l'état courant.
      this.bindOutPublisher();
      this.lastStateJson = "";
      this.publishState({});
    }
    // Indépendant du runtime (pas encore prêt au premier rendu).
    if (changed.has("control")) this.listenControl();
    if (!this.runtime) return;
    const programChanged = PROGRAM_KEYS.some((k) => changed.has(k));
    const channelChanged = CHANNEL_KEYS.some((k) => changed.has(k));
    if (programChanged) {
      void this.rebuild();
    } else if (channelChanged) {
      void this.rebindChannels();
    }
    if (changed.has("play") || changed.has("playOnHover")) {
      this.syncPlayback();
    }
    if (changed.has("dprMax") || changed.has("renderSize") || (changed.has("channel0") && this.renderSize.trim().toLowerCase() === "channel0")) {
      this.syncSize();
    }
    if (changed.has("releaseOffscreen") || channelChanged) {
      this.syncVisibility();
    }
    if (
      changed.has("dataProvider") ||
      changed.has("outDataProvider") ||
      changed.has("extractDataProvider")
    ) {
      this.bindFormProvider();
      this.bindOutPublisher();
      this.bindExtractPublisher();
    }
    if (changed.has("aspectRatio")) {
      this.applyAspectRatio();
    }
  }

  private applyAspectRatio(textureUrl?: string) {
    const forced = this.aspectRatio.trim();
    if (forced) {
      this.style.setProperty(
        "--sonic-shader-ar",
        forced.includes("/") ? forced : forced.replace(":", " / "),
      );
      return;
    }
    const url = textureUrl || this.channel0;
    const size = url ? this.runtime?.getTextureSize(url) : null;
    if (size) {
      this.style.setProperty(
        "--sonic-shader-ar",
        `${size.width} / ${size.height}`,
      );
      return;
    }
    this.style.removeProperty("--sonic-shader-ar");
  }

  private resolveFormProviderId(): string {
    const own = this.dataProvider?.trim();
    if (own) return own;
    return (
      HTML.getAncestorAttributeValue(this, "dataProvider") ||
      HTML.getAncestorAttributeValue(this, "formDataProvider") ||
      ""
    );
  }

  private unbindFormProvider() {
    if (this.formPublisher) {
      // Nested form fields (sonic-input) mutate children — root onAssign
      // does not fire; onInternalMutation does.
      this.formPublisher.offInternalMutation(this.onFormMutation);
      this.formPublisher = null;
    }
    for (const off of this.channelUnsubs) off();
    this.channelUnsubs = [];
  }

  /**
   * Canaux branchés par `sonic-mix` (composition `{"channel0": "etat.last"}`) : le sous-publisher du canal est
   * celui de la source, rattaché à SON parent. Ses changements ne remontent donc pas jusqu'au DP du shader
   * (`onInternalMutation` muet) : on écoute aussi chaque canal directement, relu en microtâche.
   */
  private bindChannelPublishers() {
    const pub = this.formPublisher as unknown as Record<string, { onAssign?: (fn: () => void, now?: boolean) => void; offAssign?: (fn: () => void) => void } | undefined> | null;
    if (!pub) return;
    let queued = false;
    const reread = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        this.onFormMutation();
      });
    };
    for (const key of CHANNEL_FORM_KEYS) {
      const child = pub[key];
      if (!child || typeof child.onAssign !== "function" || typeof child.offAssign !== "function") continue;
      child.onAssign(reread, false);
      this.channelUnsubs.push(() => child.offAssign?.(reread));
    }
  }

  private bindFormProvider() {
    this.unbindFormProvider();
    const id = this.resolveFormProviderId();
    if (!id) return;
    this.formPublisher = PublisherManager.get(id);
    this.formPublisher.onInternalMutation(this.onFormMutation);
    this.bindChannelPublishers();
    this.onFormMutation();
  }

  private resolveOutProviderId(): string {
    const own = this.outDataProvider?.trim();
    if (own) return own;
    return this.resolveFormProviderId();
  }

  private bindOutPublisher() {
    const id = this.resolveOutProviderId();
    this.outPublisher = id ? PublisherManager.get(id) : null;
  }

  private resolveExtractProviderId(): string {
    const own = this.extractDataProvider?.trim();
    if (own) return own;
    return this.resolveOutProviderId();
  }

  private bindExtractPublisher() {
    const id = this.resolveExtractProviderId();
    this.extractPublisher = id ? PublisherManager.get(id) : null;
  }

  private applyFormParams(value: unknown) {
    const data =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    // Le slot hover-param est piloté en interne : ne pas le réécrire depuis le
    // publisher (évite la boucle out → mutation → param ↔ hoverGoal).
    const hoverSlot = parseHoverParam(this.hoverParam);
    if (hoverSlot !== 0) this.param0 = toNum(data.param0, this.param0);
    if (hoverSlot !== 1) this.param1 = toNum(data.param1, this.param1);
    if (hoverSlot !== 2) this.param2 = toNum(data.param2, this.param2);
    if (hoverSlot !== 3) this.param3 = toNum(data.param3, this.param3);
    if ("mouseSpeed" in data) {
      this.mouseSpeed = toNum(data.mouseSpeed, this.mouseSpeed);
    }
    if ("hoverSpeed" in data) {
      this.hoverSpeed = toNum(data.hoverSpeed, this.hoverSpeed);
    }
    if ("extractThreshold" in data) {
      this.extractThreshold = toNum(data.extractThreshold, this.extractThreshold);
    }
    if ("extractMax" in data) {
      this.extractMax = toNum(data.extractMax, this.extractMax);
    }
    if ("extractPatch" in data) {
      this.extractPatch = toNum(data.extractPatch, this.extractPatch);
    }
    if ("rois" in data) {
      this.manualRois = parseRois(data.rois);
    }
    for (const key of CHANNEL_FORM_KEYS) {
      if (!(key in data)) continue;
      // Vide (null, "") : clé créée à la volée par le proxy du DP (sous-publisher), pas une consigne. L'attribut reste.
      if (data[key] === null || data[key] === undefined || data[key] === "") continue;
      const next = channelFormValue(data[key]);
      if (next === undefined) continue;
      if ((this as unknown as Record<string, string>)[key] !== next) {
        (this as unknown as Record<string, string>)[key] = next;
      }
    }
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
      const { live, invalid } = readShaderParams(v);
      const key = invalid.join(",");
      if (key && key !== this.liveInvalidKey) {
        console.warn(`[sonic-shader] params : valeur refusée pour ${key}`);
      }
      this.liveInvalidKey = key;
      this.applyLive(live);
    });
  }

  /** Remplace les réglages en direct et applique ce qui change. */
  private applyLive(next: ShaderLiveParams) {
    const before = this.liveSnapshot();
    this.live = next;
    const after = this.liveSnapshot();
    if (
      before.play !== after.play ||
      before.playOnHover !== after.playOnHover
    ) {
      this.syncPlayback();
    }
    if (before.dprMax !== after.dprMax) this.syncSize();
    if (
      before.mouseMode !== after.mouseMode &&
      after.mouseMode === "direct" &&
      this.mouseHasPointer
    ) {
      // Passage en direct : iMouse rejoint tout de suite le pointeur.
      this.setPointerTarget(this.mouseTarget[0], this.mouseTarget[1], true);
    }
    if (!after.mouse && before.mouse) this.pointerDown = false;
    if (before.program !== after.program) this.scheduleLiveRebuild();
  }

  private liveSnapshot() {
    return {
      play: this.effPlay,
      playOnHover: this.effPlayOnHover,
      mouse: this.effMouse,
      mouseMode: this.effMouseMode,
      dprMax: this.effDprMax,
      program: JSON.stringify([this.effSources(), this.effBufferFormat]),
    };
  }

  /** Recompilation différée : une saisie au clavier ne recompile pas à chaque touche. */
  private scheduleLiveRebuild() {
    if (this.liveRebuildTimer) clearTimeout(this.liveRebuildTimer);
    this.liveRebuildTimer = setTimeout(() => {
      this.liveRebuildTimer = null;
      if (!this.isConnected) return;
      if (!this.runtime) {
        // Pas encore (ou plus) de runtime : il compilera les sources effectives à sa création.
        if (!this.effSources().image.trim()) this.publishState({ status: "idle", error: null, errors: [], passes: [] });
        return;
      }
      void this.rebuild();
    }, 120);
  }

  private get effPlay(): boolean {
    return this.live.play ?? this.play;
  }

  private get effPlayOnHover(): boolean {
    return this.live.playOnHover ?? this.playOnHover;
  }

  private get effMouse(): boolean {
    return this.live.mouse ?? this.mouse;
  }

  private get effMouseMode(): ShaderMouseMode {
    return this.live.mouseMode ?? this.mouseMode;
  }

  private get effMouseSpeed(): number {
    return this.live.mouseSpeed ?? this.mouseSpeed;
  }

  private get effHoverSpeed(): number {
    return this.live.hoverSpeed ?? this.hoverSpeed;
  }

  private get effDprMax(): number {
    const v = this.live.dprMax ?? this.dprMax;
    return Number.isFinite(v) && v > 0 ? v : 2;
  }

  private get effBufferFormat(): ShaderBufferFormat {
    return this.live.bufferFormat ?? parseBufferFormat(this.bufferFormat);
  }

  /** Sources GLSL effectives (attribut / propriété, sinon `params`). */
  private effSources(): ShaderSources {
    const out = {} as ShaderSources;
    for (const k of SOURCE_KEYS) {
      out[k] = this.live[k] ?? this[k];
    }
    return out;
  }

  // ── État publié ──────────────────────────────────────────────────────────

  /**
   * Met à jour l'état et le publie (seulement s'il change) dans le DP de sortie
   * — fusion à la racine, comme `extracts`, pour ne rien écraser du formulaire —
   * et en event `shader-state`.
   */
  private publishState(patch: Partial<SonicShaderState>) {
    const next: SonicShaderState = {
      ...this.stateValue,
      ...patch,
      activeBufferFormat: this.activeBufferFormat,
    };
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
        for (const key of SHADER_STATE_KEYS) {
          try {
            (pub as Record<string, { set: (v: unknown) => void }>)[key].set(
              plainState[key],
            );
          } catch {
            /* ignore */
          }
        }
      }
    }
    this.dispatchEvent(
      new CustomEvent("shader-state", {
        detail: next,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private notePlaying(playing: boolean) {
    if (this.stateValue.playing !== playing) this.publishState({ playing });
  }

  /** Params GPU : remplace le slot `hover-param` par `hoverMix`. */
  private effectiveParams(): [number, number, number, number] {
    const params: [number, number, number, number] = [
      this.param0,
      this.param1,
      this.param2,
      this.param3,
    ];
    const slot = parseHoverParam(this.hoverParam);
    if (slot !== null) params[slot] = this.hoverMix;
    return params;
  }

  /**
   * Hors viewport : libère textures / FBO / programmes, **sans** loseContext
   * (sinon le même canvas ne peut plus compiler au retour).
   * Le slot navigateur est libéré au disconnect (`dispose(true)`).
   */
  private releaseRuntime() {
    this.rebuildToken++;
    this.rebindToken++;
    this.stopLoop();
    this.ready = false;
    this.releasing = true;
    this.unbindContextEvents();
    this.runtime?.dispose(false);
    this.runtime = null;
    this.releasing = false;
    if (this.stateValue.status !== "error") {
      this.publishState({ status: "idle", passes: [], playing: false });
    } else {
      this.notePlaying(false);
    }
  }

  private getCanvas(): HTMLCanvasElement | null {
    return (
      (this.renderRoot?.querySelector("canvas") as HTMLCanvasElement | null) ??
      null
    );
  }

  /** Contrat SonicFrameSource — canvas lisible pour un autre sonic-shader. */
  getFrameCanvas(): HTMLCanvasElement | null {
    if (!this.ready || !this.runtime || this.runtime.isLost) return null;
    return this.getCanvas();
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

  private bindContextEvents() {
    const canvas = this.getCanvas();
    canvas?.addEventListener("webglcontextlost", this.onContextLost);
    canvas?.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  private unbindContextEvents() {
    const canvas = this.getCanvas();
    canvas?.removeEventListener("webglcontextlost", this.onContextLost);
    canvas?.removeEventListener(
      "webglcontextrestored",
      this.onContextRestored,
    );
  }

  private onContextLost = (e: Event) => {
    e.preventDefault();
    if (this.releasing) return;
    this.rebuildToken++;
    this.rebindToken++;
    this.stopLoop();
    this.ready = false;
    this.runtime = null;
    this.publishState({ status: "idle", error: null, errors: [], passes: [], playing: false });
    // Le navigateur ne rend pas toujours le contexte (trop de contextes, plantage du GPU) : passé un délai,
    // on repart d'une toile neuve, quelques fois au plus.
    clearTimeout(this.recoverTimer);
    this.recoverTimer = window.setTimeout(() => this.recover(), 1500);
  };

  private onContextRestored = () => {
    clearTimeout(this.recoverTimer);
    this.recoverTries = 0;
    if (this.releasing || !this.inView) return;
    void this.ensureRuntime();
  };

  private recoverTimer = 0;
  private recoverTries = 0;

  /** Remplace la toile par une neuve (nouveau contexte WebGL possible). */
  private freshCanvas(old: HTMLCanvasElement): HTMLCanvasElement {
    this.unbindContextEvents();
    const fresh = document.createElement("canvas");
    fresh.setAttribute("part", "canvas");
    old.replaceWith(fresh);
    return fresh;
  }

  /** Remplace la toile perdue par une neuve (nouveau contexte) et relance le rendu. */
  private recover(): void {
    if (!this.isConnected || this.releasing || (this.runtime && !this.runtime.isLost)) return;
    if (this.recoverTries >= 3) {
      this.emitError(new Error("WebGL indisponible : contexte perdu (mémoire graphique) ; recharger la page"));
      return;
    }
    this.recoverTries++;
    const old = this.getCanvas();
    if (old) this.freshCanvas(old);
    if (this.inView || !this.wantsReleaseOffscreen()) void this.ensureRuntime();
    // Si le nouveau contexte n'arrive pas non plus, on réessaie plus tard.
    this.recoverTimer = window.setTimeout(() => { if (!this.runtime || this.runtime.isLost) this.recover(); }, 2000 * this.recoverTries);
  }

  private async ensureRuntime() {
    if (this.runtime && !this.runtime.isLost) return;
    this.runtime = null;
    await this.updateComplete;
    if (!this.isConnected || (!this.inView && this.wantsReleaseOffscreen()))
      return;

    const canvas = this.getCanvas();
    if (!canvas) return;

    try {
      this.errorMessage = "";
      try {
        this.runtime = new ShaderToyRuntime(canvas);
      } catch {
        // Toile dont le contexte a été perdu (rendu au navigateur à un débranchement, `dispose(true)`, puis
        // élément rebranché : déplacé par une pop, un sonic-if…) : getContext rend ce contexte perdu. Toile neuve.
        this.runtime = new ShaderToyRuntime(this.freshCanvas(canvas));
      }
      this.runtime.setElementResolver((key) => this.lookupElement(key));
      this.activeBufferFormat = this.runtime.setBufferFormat(
        this.effBufferFormat,
      );
      this.bindContextEvents();
      this.syncSize();
      await this.rebuild();
      if (this.runtime && !this.runtime.isLost) this.recoverTries = 0;
    } catch (err) {
      this.emitError(err);
    }
  }

  private syncVisibility() {
    if (!this.inView && this.wantsReleaseOffscreen()) {
      this.releaseRuntime();
      return;
    }
    if (this.inView && (!this.runtime || this.runtime.isLost)) {
      void this.ensureRuntime();
      return;
    }
    this.syncPlayback();
  }

  /** Taille de rendu imposée par `render-size`, ou null (taille d'affichage). */
  private fixedRenderSize(): [number, number] | null {
    const v = (this.renderSize || "").trim().toLowerCase();
    if (!v) return null;
    const clampSide = (n: number) => Math.round(Math.min(8192, Math.max(16, n)));
    if (v === "channel0") {
      const ref = this.channel0 as unknown;
      // Image venue d'un DP (SonicMediaRef { url, width, height }, ex. `last` d'un export) : ses dimensions.
      if (ref && typeof ref === "object") {
        const { width, height } = ref as { width?: unknown; height?: unknown };
        if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) return [clampSide(width), clampSide(height)];
      }
      const key = typeof ref === "string" ? ref.trim() : "";
      if (!key) return null;
      if (!key.startsWith("#")) {
        // URL (image chargée) : dimensions de la texture une fois chargée.
        const size = this.runtime?.getTextureSize(key);
        return size && size.width > 0 && size.height > 0 ? [clampSide(size.width), clampSide(size.height)] : null;
      }
      const el = this.lookupElement(key);
      const c = el && isFrameSource(el) ? el.getFrameCanvas() : null;
      return c && c.width > 0 && c.height > 0 ? [clampSide(c.width), clampSide(c.height)] : null;
    }
    return parseRenderSize(v);
  }

  private renderedSize = "";
  private controlUnsub: (() => void) | null = null;
  private saveTrigger = new CounterTrigger();
  private lastUrl: string | null = null;

  private listenControl(): void {
    this.controlUnsub?.();
    this.controlUnsub = null;
    this.saveTrigger.reset();
    if (!this.control) return;
    this.controlUnsub = listenDp(this.control, (v) => {
      const c = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
      // Clé absente = 0 : le premier `save: 1` déclenche bien.
      if (this.saveTrigger.feed(c.save ?? 0)) void this.save();
    });
  }

  /**
   * Enregistre l'image rendue (à la taille de rendu : `render-size` le cas échéant) en PNG dans `last` :
   * `{ url (blob:), mime, width, height, size }`, à brancher sur `sonic-media-download source="…last"`.
   * Retourne l'URL, ou null si le shader n'est pas prêt.
   */
  async save(): Promise<string | null> {
    const canvas = this.getFrameCanvas();
    if (!canvas) return null;
    this.drawFrame(performance.now());
    const blob = await new Promise<Blob | null>((resolve) => {
      try { canvas.toBlob((b) => resolve(b), "image/png"); } catch { resolve(null); }
    });
    if (!blob) return null;
    if (this.lastUrl) URL.revokeObjectURL(this.lastUrl);
    this.lastUrl = URL.createObjectURL(blob);
    this.publishState({ last: { url: this.lastUrl, mime: "image/png", width: canvas.width, height: canvas.height, size: blob.size } });
    return this.lastUrl;
  }

  private syncSize() {
    if (!this.runtime) return;
    const fixed = this.fixedRenderSize();
    if (fixed) {
      this.renderedSize = fixed.join("x");
      this.runtime.resize(fixed[0], fixed[1]);
      if (this.ready) this.drawFrame(performance.now());
      return;
    }
    this.renderedSize = "";
    const rect = this.getBoundingClientRect();
    const cssW = Math.max(rect.width, this.clientWidth, 1);
    const cssH = Math.max(rect.height, this.clientHeight, 1);
    const dpr = Math.min(window.devicePixelRatio || 1, this.effDprMax);
    this.runtime.resize(cssW * dpr, cssH * dpr);
    if (this.ready) {
      this.drawFrame(performance.now());
    }
  }

  private buildChannels(pass: ShaderPassId): PassChannels {
    const fallbacks = [
      this.channel0,
      this.channel1,
      this.channel2,
      this.channel3,
    ];
    const overrides: (string | undefined)[] =
      pass === "image"
        ? [this.imageCh0, this.imageCh1, this.imageCh2, this.imageCh3]
        : pass === "bufferA"
          ? [
              this.bufferACh0,
              this.bufferACh1,
              this.bufferACh2,
              this.bufferACh3,
            ]
          : pass === "bufferB"
            ? [
                this.bufferBCh0,
                this.bufferBCh1,
                this.bufferBCh2,
                this.bufferBCh3,
              ]
            : pass === "bufferC"
              ? [
                  this.bufferCCh0,
                  this.bufferCCh1,
                  this.bufferCCh2,
                  this.bufferCCh3,
                ]
              : [
                  this.bufferDCh0,
                  this.bufferDCh1,
                  this.bufferDCh2,
                  this.bufferDCh3,
                ];
    return [0, 1, 2, 3].map((i) =>
      parseChannelSource(overrides[i], fallbacks[i]),
    ) as PassChannels;
  }

  private collectUrls(channels: Map<ShaderPassId, PassChannels>): string[] {
    const urls: string[] = [];
    for (const chs of channels.values()) {
      for (const c of chs) {
        if (c.kind === "url") urls.push(c.url);
      }
    }
    return urls;
  }

  private collectElementKeys(
    channels: Map<ShaderPassId, PassChannels>,
  ): string[] {
    const keys: string[] = [];
    for (const chs of channels.values()) {
      for (const c of chs) {
        if (c.kind === "element") keys.push(c.key);
      }
    }
    return [...new Set(keys)];
  }

  /** Enregistre les producteurs live (`sonic-3d`…) pour play-offscreen auto. */
  private syncFrameConsumers(channels: Map<ShaderPassId, PassChannels>) {
    const els = this.collectElementKeys(channels).map((k) =>
      this.lookupElement(k),
    );
    this.frameConsumers.sync(els);
  }

  /** Map canaux courante (tous les passes). */
  private collectPassChannels(): Map<ShaderPassId, PassChannels> {
    const channels = new Map<ShaderPassId, PassChannels>();
    for (const pass of [
      "bufferA",
      "bufferB",
      "bufferC",
      "bufferD",
      "image",
    ] as ShaderPassId[]) {
      channels.set(pass, this.buildChannels(pass));
    }
    return channels;
  }

  /** `true` si hors viewport on doit libérer textures/FBO. */
  private wantsReleaseOffscreen(): boolean {
    return shouldReleaseWhenOffscreen(
      this.releaseOffscreen,
      channelsUseSelf(this.collectPassChannels().values()),
    );
  }

  /**
   * Re-lie les canaux sans recompiler ni vider les FBO (Vague A Lot 2).
   */
  private async rebindChannels() {
    if (!this.runtime || this.runtime.isLost || !this.effSources().image.trim())
      return;
    if (!this.ready) {
      void this.rebuild();
      return;
    }
    const token = ++this.rebindToken;
    const channels = this.collectPassChannels();
    try {
      const urls = this.collectUrls(channels);
      await this.runtime.ensureTextures(urls);
      for (const key of this.collectElementKeys(channels)) {
        this.runtime.ensureElementTexture(key);
      }
      if (token !== this.rebindToken || !this.runtime || this.runtime.isLost) {
        return;
      }
      this.syncFrameConsumers(channels);
      const aspectHint =
        this.channel0.startsWith("#") ? "" : this.channel0 || urls[0];
      this.applyAspectRatio(aspectHint);
      this.runtime.setPassChannels(channels);
      this.syncSize();
    } catch (err) {
      if (token !== this.rebindToken) return;
      this.emitError(err);
    }
  }

  private async rebuild() {
    if (!this.runtime || this.runtime.isLost) return;
    const sources = this.effSources();
    if (!sources.image.trim()) {
      if (this.stateValue.status !== "ready") {
        this.publishState({ status: "idle", error: null, errors: [], passes: [] });
      }
      return;
    }
    this.rebindToken++;
    const token = ++this.rebuildToken;
    this.errorMessage = "";
    this.publishState({ status: "compiling", error: null, errors: [], passes: [] });
    const channels = this.collectPassChannels();
    try {
      this.syncSize();
      this.activeBufferFormat = this.runtime.setBufferFormat(
        this.effBufferFormat,
      );
      const urls = this.collectUrls(channels);
      await this.runtime.ensureTextures(urls);
      for (const key of this.collectElementKeys(channels)) {
        this.runtime.ensureElementTexture(key);
      }
      if (token !== this.rebuildToken || !this.runtime || this.runtime.isLost) {
        return;
      }
      this.syncFrameConsumers(channels);
      const aspectHint =
        this.channel0.startsWith("#") ? "" : this.channel0 || urls[0];
      this.applyAspectRatio(aspectHint);
      this.syncSize();
      this.runtime.setSources(sources, channels);
      if (token !== this.rebuildToken || !this.runtime || this.runtime.isLost) {
        return;
      }
      this.staticKeys = staticFrameKeys(sources, channels);
      this.lastFrameSig = "";
      this.ready = true;
      this.publishState({
        status: "ready",
        error: null,
        errors: [],
        passes: this.runtime.getActivePasses?.() ?? [],
      });
      this.startTime = performance.now();
      this.lastTime = this.startTime;
      this.frame = 0;
      this.drawFrame(this.startTime);
      this.syncPlayback();
    } catch (err) {
      if (token !== this.rebuildToken) return;
      this.ready = false;
      this.stopLoop();
      this.notePlaying(false);
      this.emitError(err, sources.common);
    }
  }

  private emitError(err: unknown, common = this.effSources().common) {
    const message =
      err instanceof ShaderCompileError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    this.errorMessage = message;
    const described = describeShaderError(err, common || "");
    this.publishState({
      status: "error",
      error: described.error,
      errors: described.errors,
      passes: [],
    });
    this.dispatchEvent(
      new CustomEvent("error", {
        detail: {
          message,
          pass: err instanceof ShaderCompileError ? err.pass : undefined,
          infoLog: err instanceof ShaderCompileError ? err.infoLog : undefined,
          errors: described.errors,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private shouldAnimate(): boolean {
    if (
      !this.effPlay ||
      !this.ready ||
      !this.inView ||
      prefersReducedMotion() ||
      !this.runtime
    ) {
      return false;
    }
    if (this.effPlayOnHover) {
      return this.hovering || !this.hoverSettled();
    }
    return true;
  }

  private hoverSettled(): boolean {
    if (parseHoverParam(this.hoverParam) === null) return true;
    return Math.abs(this.hoverMix - this.hoverGoal) < 0.002;
  }

  private syncPlayback() {
    if (this.shouldAnimate()) {
      this.runtime?.setVideosPlaying(true);
      if (!this.raf) {
        this.lastTime = performance.now();
        this.loop();
      }
      this.notePlaying(true);
    } else {
      this.stopLoop();
      this.runtime?.setVideosPlaying(false);
      if (this.ready) this.drawFrame(performance.now());
      this.notePlaying(false);
    }
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    // render-size="channel0" : suit la taille de la source.
    if (this.renderSize.trim().toLowerCase() === "channel0") {
      const f = this.fixedRenderSize();
      if (f && f.join("x") !== this.renderedSize) this.syncSize();
    }
    // Image fixe (ni temps ni rétroaction) : on ne redessine que si une entrée a changé.
    if (this.staticKeys) {
      const sig = this.frameSig(this.staticKeys);
      if (sig !== this.lastFrameSig) { this.lastFrameSig = sig; this.drawFrame(performance.now()); }
    } else this.drawFrame(performance.now());
    // play-on-hover : arrêter une fois la transition terminée
    if (this.effPlayOnHover && !this.hovering && this.hoverSettled()) {
      this.stopLoop();
      this.runtime?.setVideosPlaying(false);
      this.notePlaying(false);
    }
  };

  /** Clés des sources d'images du shader quand il est fixe (voir `staticFrameKeys`), sinon null. */
  private staticKeys: string[] | null = null;
  private lastFrameSig = "";

  /** Signature des entrées d'une image fixe : réglages, souris, survol, taille, images des sources vivantes. */
  private frameSig(extra: string[]): string {
    const live = this.runtime?.liveSources?.() ?? { keys: [], video: false };
    if (live.video) return String(Math.random());
    const keys = [...new Set([...extra, ...live.keys])];
    const seqs = keys.map((k) => {
      const el = this.lookupElement(k);
      // Élément sans compteur d'images (vidéo, <img> changeante…) : toujours redessiner.
      return el && isFrameSource(el) ? el.frameSeq : NaN;
    });
    if (seqs.some((n) => Number.isNaN(n))) return String(Math.random());
    const c = this.getCanvas();
    return JSON.stringify([this.effectiveParams(), this.mouseVec, this.hoverMix, c?.width, c?.height, seqs]);
  }

  private stopLoop() {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private drawFrame(now: number) {
    if (!this.runtime || !this.ready) return;
    const time = (now - this.startTime) / 1000;
    const timeDelta = Math.max(0, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.advanceMouseFollow(timeDelta);
    this.advanceHover(timeDelta);
    const params = this.effectiveParams();
    this.runtime.render({
      time,
      timeDelta,
      frame: this.frame++,
      mouse: this.mouseVec,
      params,
    });
    this.frameSeq++;
    this.maybePublishOut(now, time, params);
    void this.maybeExtract(now, time);
  }

  private round3(n: number): number {
    return Math.round(n * 1000) / 1000;
  }

  private buildOutput(
    time: number,
    params?: [number, number, number, number],
    wantSample = false,
  ): SonicShaderOutput {
    const { width, height } = this.runtime?.size ?? { width: 1, height: 1 };
    const hasPtr = this.mouseHasPointer;
    const mx = hasPtr && width > 0 ? this.mouseVec[0] / width : 0.5;
    const my = hasPtr && height > 0 ? this.mouseVec[1] / height : 0.5;
    const p = params ?? this.effectiveParams();
    const out: SonicShaderOutput = {
      time: this.round3(time),
      frame: this.frame,
      mouseX: this.round3(mx),
      mouseY: this.round3(my),
      hovering: this.hovering ? 1 : 0,
      param0: this.round3(p[0]),
      param1: this.round3(p[1]),
      param2: this.round3(p[2]),
      param3: this.round3(p[3]),
    };
    if (wantSample && this.runtime) {
      const sx = hasPtr ? this.mouseVec[0] : width * 0.5;
      const sy = hasPtr ? this.mouseVec[1] : height * 0.5;
      const [r8, g8, b8, a8] = this.runtime.readPixel(sx, sy);
      const r = r8 / 255;
      const g = g8 / 255;
      const b = b8 / 255;
      const a = a8 / 255;
      out.sampleR = this.round3(r);
      out.sampleG = this.round3(g);
      out.sampleB = this.round3(b);
      out.sampleA = this.round3(a);
      out.sampleLuma = this.round3(0.2126 * r + 0.7152 * g + 0.0722 * b);
    }
    return out;
  }

  /** Un champ out du publisher a-t-il un listener (sonic-value, @subscribe…) ? */
  private publisherFieldHasListener(key: string): boolean {
    const pub = this.outPublisher as OutPublisherLike | null;
    const child = pub?._proxies_?.get(key);
    return !!child?.hasListener?.();
  }

  /**
   * Publication paresseuse : uniquement s’il y a un event `out` ou un lecteur
   * DP sur un champ de sortie. Sinon aucun coût (pas de set, pas de readPixels).
   */
  private hasOutConsumers(): boolean {
    if (this.outEventListeners > 0) return true;
    if (!this.outPublisher) return false;
    for (const key of OUT_META_KEYS) {
      if (this.publisherFieldHasListener(key)) return true;
    }
    for (const key of OUT_SAMPLE_KEYS) {
      if (this.publisherFieldHasListener(key)) return true;
    }
    return false;
  }

  /**
   * Même DP pour form (entrée param*) et out : ne pas réécrire les params
   * pilotés par le formulaire (sinon sortie viewport / hoverMix → champs à 0).
   * Seul le slot `hover-param` reste écrit (piloté par le shader).
   */
  private shouldSkipParamOutWrite(key: string): boolean {
    if (!(OUT_PARAM_KEYS as readonly string[]).includes(key)) return false;
    if (!this.formPublisher || this.formPublisher !== this.outPublisher) {
      return false;
    }
    const slot = parseHoverParam(this.hoverParam);
    if (slot === null) return true;
    return Number(key.slice(5)) !== slot;
  }

  /**
   * `readPixels` si `sample` et au moins un consommateur out.
   * (Un `@handle(frame)` + `get(dp)` massif doit recevoir les samples.)
   */
  private needsSampleRead(): boolean {
    return this.sample && this.hasOutConsumers();
  }

  private maybePublishOut(
    now: number,
    time: number,
    params?: [number, number, number, number],
  ) {
    if (!this.outPublisher) this.bindOutPublisher();
    if (!this.hasOutConsumers()) return;
    const interval = Math.max(16, this.outInterval || 80);
    if (now - this.lastOutAt < interval) return;
    this.lastOutAt = now;
    const payload = this.buildOutput(time, params, this.needsSampleRead());
    const pub = this.outPublisher;
    if (pub) {
      for (const [key, value] of Object.entries(payload)) {
        if (value === undefined) continue;
        if (this.shouldSkipParamOutWrite(key)) continue;
        try {
          // Champs individuels pour ne pas écraser le reste du form
          (pub as Record<string, { set: (v: unknown) => void }>)[key].set(
            value,
          );
        } catch {
          /* publisher leaf manquant / non settable */
        }
      }
    }
    this.dispatchEvent(
      new CustomEvent("out", {
        detail: payload,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private revokeBlobUrls() {
    for (const url of this.lastBlobUrls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }
    this.lastBlobUrls = [];
  }

  /** Révoque les URLs du batch précédent après un court délai (évite img cassées). */
  private scheduleRevokePreviousBlobs(urls: string[]) {
    const objectUrls = urls.filter((u) => u.startsWith("blob:"));
    if (objectUrls.length === 0) return;
    this.pendingRevokeUrls.push(...objectUrls);
    const toRevoke = objectUrls;
    window.setTimeout(() => {
      for (const url of toRevoke) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
        const i = this.pendingRevokeUrls.indexOf(url);
        if (i >= 0) this.pendingRevokeUrls.splice(i, 1);
      }
    }, 1500);
  }

  private publisherHasFieldListener(
    pub: OutPublisherLike | null,
    key: string,
  ): boolean {
    const child = pub?._proxies_?.get(key);
    return !!child?.hasListener?.();
  }

  private hasExtractConsumers(): boolean {
    if (this.extractEventListeners > 0) return true;
    const pub = this.extractPublisher as OutPublisherLike | null;
    if (!pub) return false;
    for (const key of EXTRACT_OUT_KEYS) {
      if (this.publisherHasFieldListener(pub, key)) return true;
    }
    return false;
  }

  private syncManualRoisFromPublishers() {
    const tryGet = (pub: OutPublisherLike | null) => {
      if (!pub?.get) return;
      try {
        const data = pub.get() ?? {};
        if ("rois" in data) this.manualRois = parseRois(data.rois);
      } catch {
        /* ignore */
      }
    };
    tryGet(this.formPublisher as OutPublisherLike | null);
    if (this.extractPublisher && this.extractPublisher !== this.formPublisher) {
      tryGet(this.extractPublisher as OutPublisherLike | null);
    }
  }

  private resolveExtractInterval(): number {
    if (this.extractInterval > 0) return Math.max(16, this.extractInterval);
    return Math.max(16, this.outInterval || 100);
  }

  /**
   * Lit une ROI à la demande (hors throttle). Nécessite un runtime prêt.
   */
  async readRegion(roi: ShaderRoi): Promise<ShaderExtractItem | null> {
    if (!this.runtime || !this.ready) return null;
    const item = await this.buildExtractItem(roi, "manual", undefined);
    return item;
  }

  /** Lance une extraction complète immédiatement. */
  async extractNow(): Promise<ShaderExtractOutput> {
    const time = (performance.now() - this.startTime) / 1000;
    return this.runExtract(time);
  }

  private async maybeExtract(now: number, time: number) {
    if (!this.extract || !this.ready || !this.runtime) return;
    if (!this.extractPublisher) this.bindExtractPublisher();
    if (!this.hasExtractConsumers()) return;
    if (now - this.lastExtractAt < this.resolveExtractInterval()) return;
    if (this.extractRunning) return;
    this.lastExtractAt = now;
    await this.runExtract(time);
  }

  private async runExtract(time: number): Promise<ShaderExtractOutput> {
    const empty: ShaderExtractOutput = {
      frame: this.frame,
      time: this.round3(time),
      items: [],
    };
    if (!this.runtime || !this.ready) return empty;
    this.extractRunning = true;
    try {
      this.syncManualRoisFromPublishers();
      const { width: bufW, height: bufH } = this.runtime.size;
      const rois: PendingRoi[] = this.manualRois.map((r) => ({
        ...r,
        source: "manual" as const,
      }));

      const maskPass = parseExtractPass(this.extractMask);
      if (maskPass) {
        const full = this.runtime.readBufferRect(maskPass, 0, 0, bufW, bufH);
        if (full) {
          const peaks = findPeaks(full.data, full.width, full.height, {
            threshold: this.extractThreshold,
            maxCount: Math.max(0, Math.floor(this.extractMax)),
            // Défaut ≈ patch/3 plafonné à 16 (doc) — laisse assez de coins espacés
            minDistance: Math.max(
              8,
              Math.floor(Math.min(this.extractPatch / 3, 16)),
            ),
          });
          // Score relatif au meilleur peak du batch (ordre inchangé, UI lisible)
          const topScore = peaks[0]?.score || 1;
          for (let i = 0; i < peaks.length; i++) {
            const p = peaks[i];
            rois.push({
              id: `detect-${i}`,
              x: (p.x + 0.5) / bufW,
              y: (p.y + 0.5) / bufH,
              patch: this.extractPatch,
              source: "detect",
              score: topScore > 0 ? p.score / topScore : p.score,
            });
          }
        }
      }

      // Phase sync : tous les readPixels AVANT tout await
      // (preserveDrawingBuffer=false → buffer Image vidé dès qu’on yield).
      type PendingItem = {
        item: ShaderExtractItem;
        rgba: Uint8Array;
        width: number;
        height: number;
      };
      const pending: PendingItem[] = [];
      let detectIdx = 0;
      const pass = parseExtractPass(this.extractSource) ?? "image";

      for (const roi of rois) {
        const source = roi.source === "detect" ? "detect" : "manual";
        if (source === "detect") {
          if (detectIdx >= Math.max(0, Math.floor(this.extractMax))) continue;
          detectIdx++;
        }
        const px = roiToPixels(
          roi,
          bufW,
          bufH,
          this.extractPatch,
          MAX_PATCH_PX,
        );
        if (!px) continue;
        const rect =
          pass === "image"
            ? this.runtime.readRect(px.x, px.y, px.w, px.h)
            : this.runtime.readBufferRect(pass, px.x, px.y, px.w, px.h);
        if (!rect) continue;
        // Copie : le buffer WebGL peut être réutilisé / invalidé ensuite
        const rgba = rgbaToUint8(rect.data);
        const mean = meanRgba(rect.data);
        const item: ShaderExtractItem = {
          id: roi.id || `${source}-${px.x}-${px.y}`,
          x: this.round3(rect.x / bufW),
          y: this.round3(rect.y / bufH),
          w: this.round3(rect.width / bufW),
          h: this.round3(rect.height / bufH),
          meanR: this.round3(mean.r),
          meanG: this.round3(mean.g),
          meanB: this.round3(mean.b),
          meanA: this.round3(mean.a),
          meanLuma: this.round3(mean.luma),
          source,
        };
        if (typeof roi.score === "number") item.score = this.round3(roi.score);
        pending.push({
          item,
          rgba,
          width: rect.width,
          height: rect.height,
        });
      }

      // Phase async : bitmaps (après copies CPU)
      if (this.extractBitmaps) {
        const token = this.rebuildToken;
        for (const p of pending) {
          if (token !== this.rebuildToken || !this.isConnected) {
            for (const q of pending) {
              if (q.item.blobUrl) revokeMediaUrls([q.item.blobUrl]);
            }
            return empty;
          }
          const url = await rgbaToBlobUrl(p.rgba, p.width, p.height);
          if (token !== this.rebuildToken || !this.isConnected) {
            if (url) revokeMediaUrls([url]);
            for (const q of pending) {
              if (q.item.blobUrl) revokeMediaUrls([q.item.blobUrl]);
            }
            return empty;
          }
          if (url) assignExtractMediaUrls(p.item, url);
        }
      }

      if (!this.isConnected) {
        for (const p of pending) {
          if (p.item.blobUrl) revokeMediaUrls([p.item.blobUrl]);
        }
        return empty;
      }

      const items = pending.map((p) => p.item);
      const payload: ShaderExtractOutput = {
        frame: this.frame,
        time: this.round3(time),
        items,
      };
      this.publishExtract(payload);
      return payload;
    } finally {
      this.extractRunning = false;
    }
  }

  private async buildExtractItem(
    roi: ShaderRoi,
    source: "manual" | "detect",
    score?: number,
  ): Promise<ShaderExtractItem | null> {
    if (!this.runtime) return null;
    const { width: bufW, height: bufH } = this.runtime.size;
    const px = roiToPixels(roi, bufW, bufH, this.extractPatch, MAX_PATCH_PX);
    if (!px) return null;
    const pass = parseExtractPass(this.extractSource) ?? "image";
    const rect =
      pass === "image"
        ? this.runtime.readRect(px.x, px.y, px.w, px.h)
        : this.runtime.readBufferRect(pass, px.x, px.y, px.w, px.h);
    if (!rect) return null;
    const mean = meanRgba(rect.data);
    const item: ShaderExtractItem = {
      id: roi.id || `${source}-${px.x}-${px.y}`,
      x: this.round3(rect.x / bufW),
      y: this.round3(rect.y / bufH),
      w: this.round3(rect.width / bufW),
      h: this.round3(rect.height / bufH),
      meanR: this.round3(mean.r),
      meanG: this.round3(mean.g),
      meanB: this.round3(mean.b),
      meanA: this.round3(mean.a),
      meanLuma: this.round3(mean.luma),
      source,
    };
    if (typeof score === "number") item.score = this.round3(score);
    if (this.extractBitmaps) {
      const token = this.rebuildToken;
      const url = await rgbaToBlobUrl(
        rgbaToUint8(rect.data),
        rect.width,
        rect.height,
      );
      if (token !== this.rebuildToken || !this.isConnected) {
        if (url) revokeMediaUrls([url]);
        return null;
      }
      if (url) assignExtractMediaUrls(item, url);
    }
    return item;
  }

  private publishExtract(payload: ShaderExtractOutput) {
    // Ne pas révoquer tout de suite : les <img> du batch précédent casseraient.
    this.scheduleRevokePreviousBlobs(this.lastBlobUrls);
    this.lastBlobUrls = [];
    for (const it of payload.items) {
      if (it.blobUrl) this.lastBlobUrls.push(it.blobUrl);
    }
    this.extractSeq++;
    if (!this.extractPublisher) this.bindExtractPublisher();
    const pub = this.extractPublisher;
    if (pub) {
      // Set atomique sur la racine : invalide `_cachedGet_` du parent.
      // (pub.extracts.set(...) seul laisse un snapshot périmé → 1 seul item en get()).
      try {
        const prev =
          ((pub as { get?: () => Record<string, unknown> }).get?.() as
            | Record<string, unknown>
            | null
            | undefined) ?? {};
        (pub as { set: (v: unknown) => void }).set({
          ...prev,
          rois: Array.isArray(prev.rois) ? prev.rois : this.manualRois,
          extracts: payload.items,
          extractCount: payload.items.length,
          extractSeq: this.extractSeq,
        });
      } catch {
        try {
          (pub as Record<string, { set: (v: unknown) => void }>).extracts.set(
            payload.items,
          );
          (
            pub as Record<string, { set: (v: unknown) => void }>
          ).extractCount.set(payload.items.length);
          (
            pub as Record<string, { set: (v: unknown) => void }>
          ).extractSeq.set(this.extractSeq);
        } catch {
          /* ignore */
        }
      }
    }
    this.dispatchEvent(
      new CustomEvent("extract", {
        detail: payload,
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Mode target : poursuite exponentielle (vitesse proportionnelle à la distance).
   * Frame-rate indépendant via `1 - exp(-speed * dt)`.
   */
  private advanceMouseFollow(dt: number) {
    if (!this.effMouse || this.effMouseMode !== "target" || !this.mouseHasPointer) {
      return;
    }
    const speed = Math.max(0, this.effMouseSpeed);
    const t = speed <= 0 || dt <= 0 ? 1 : 1 - Math.exp(-speed * dt);
    this.mouseFollow[0] += (this.mouseTarget[0] - this.mouseFollow[0]) * t;
    this.mouseFollow[1] += (this.mouseTarget[1] - this.mouseFollow[1]) * t;
    this.mouseVec[0] = this.mouseFollow[0];
    this.mouseVec[1] = this.mouseFollow[1];
  }

  /** Rollover / roll-out → easing de `hoverMix` (0↔1) pour le slot choisi. */
  private advanceHover(dt: number) {
    if (parseHoverParam(this.hoverParam) === null) return;
    const speed = Math.max(0, this.effHoverSpeed);
    const t = speed <= 0 || dt <= 0 ? 1 : 1 - Math.exp(-speed * dt);
    const next = this.hoverMix + (this.hoverGoal - this.hoverMix) * t;
    // Snap pour éviter une micro-animation infinie (play-on-hover qui redémarre).
    this.hoverMix =
      Math.abs(next - this.hoverGoal) < 0.002 ? this.hoverGoal : next;
  }

  private localPointer(e: PointerEvent): { x: number; y: number } {
    const rect = this.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, this.effDprMax);
    const x = (e.clientX - rect.left) * dpr;
    const y = (rect.height - (e.clientY - rect.top)) * dpr;
    return { x, y };
  }

  private setPointerTarget(x: number, y: number, snap = false) {
    this.mouseTarget[0] = x;
    this.mouseTarget[1] = y;
    if (!this.mouseHasPointer || snap || this.effMouseMode === "direct") {
      this.mouseHasPointer = true;
      this.mouseFollow[0] = x;
      this.mouseFollow[1] = y;
      this.mouseVec[0] = x;
      this.mouseVec[1] = y;
    }
  }

  private onPointerMove = (e: PointerEvent) => {
    if (!this.effMouse) return;
    const { x, y } = this.localPointer(e);
    this.setPointerTarget(x, y);
    if (this.pointerDown) {
      this.mouseVec[2] = x;
      this.mouseVec[3] = y;
    }
  };

  private onPointerDown = (e: PointerEvent) => {
    if (!this.effMouse) return;
    this.pointerDown = true;
    this.setPointerCapture?.(e.pointerId);
    const { x, y } = this.localPointer(e);
    this.setPointerTarget(x, y, true);
    this.mouseVec[2] = x;
    this.mouseVec[3] = y;
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.effMouse) return;
    this.pointerDown = false;
    const { x, y } = this.localPointer(e);
    this.setPointerTarget(x, y);
    this.mouseVec[2] = -Math.abs(this.mouseVec[2]);
    this.mouseVec[3] = -Math.abs(this.mouseVec[3]);
  };

  private onPointerEnter = () => {
    if (this.leaveRaf) {
      cancelAnimationFrame(this.leaveRaf);
      this.leaveRaf = 0;
    }
    this.hovering = true;
    this.hoverGoal = 1;
    this.syncPlayback();
  };

  private onPointerLeave = () => {
    // Différer : un leave parasite (re-render / enfant shadow) suivi d’un
    // re-enter immédiat provoquait activation↔désactivation en boucle.
    if (this.leaveRaf) cancelAnimationFrame(this.leaveRaf);
    this.leaveRaf = requestAnimationFrame(() => {
      this.leaveRaf = 0;
      if (!this.isConnected || this.matches(":hover")) return;
      this.hovering = false;
      this.hoverGoal = 0;
      this.pointerDown = false;
      this.syncPlayback();
    });
  };

  render() {
    return html`
      <canvas part="canvas"></canvas>
      ${this.errorMessage
        ? html`<div class="err" part="error">${this.errorMessage}</div>`
        : null}
    `;
  }
}

export { parseChannelSource, ShaderToyRuntime, shouldUploadElementFrame, resolveBufferGlFormat, resetBufferFormatWarnFlag } from "./gl-runtime";
export { buildFragmentSource } from "./shadertoy-prelude";
export { describeShaderError, mapGlslLine, parseGlslInfoLog } from "./errors";
export type { ShaderErrorItem } from "./errors";
export { readShaderParams } from "./state";
export type { SonicShaderState, ShaderLiveParams } from "./state";
export type {
  ChannelSource,
  ReleaseOffscreen,
  ShaderBufferFormat,
  ShaderExtractItem,
  ShaderExtractOutput,
  ShaderExtractPass,
  ShaderHoverParam,
  ShaderMouseMode,
  ShaderParamSlot,
  ShaderPassError,
  ShaderPassId,
  ShaderPeak,
  ShaderRoi,
  ShaderSources,
  SonicShaderConfig,
  SonicShaderOutput,
} from "./types";
export type {
  SonicMediaRef,
  SonicFrameSource,
} from "../../shared/mediaRef";
export {
  toMediaUrl,
  cloneMediaRef,
  isFrameSource,
  mediaElementKey,
} from "../../shared/mediaRef";
export {
  channelsUseSelf,
  findPeaks,
  meanRgba,
  parseBufferFormat,
  parseExtractPass,
  parseHoverParam,
  parseReleaseOffscreen,
  roiToPixels,
  rgbaToUint8,
  shouldReleaseWhenOffscreen,
  ShaderCompileError,
} from "./types";

declare global {
  interface HTMLElementTagNameMap {
    [tagName]: SonicShader;
  }
}

const DYNAMIC_UNIFORMS = /\b(iTime|iTimeDelta|iFrame|iFrameRate|iDate|iChannelTime)\b/;
const VIDEO_URL = /\.(mp4|webm|mov|m4v|ogv|m3u8)(\?|#|$)/i;

/**
 * Le shader donne-t-il une image fixe pour des entrées fixes ? Oui sans uniforme de temps, sans passes tampons
 * (rétroaction) ni vidéo. Renvoie alors les clés `#id` des sources vivantes (leur `frameSeq` dit quand
 * redessiner), sinon null (on redessine à chaque image).
 */
export function staticFrameKeys(sources: ShaderSources, channels: Map<ShaderPassId, PassChannels>): string[] | null {
  if (DYNAMIC_UNIFORMS.test(sources.common) || DYNAMIC_UNIFORMS.test(sources.image)) return null;
  if ([sources.bufferA, sources.bufferB, sources.bufferC, sources.bufferD].some((b) => b && b.trim())) return null;
  const keys: string[] = [];
  for (const c of channels.get("image") ?? []) {
    if (c.kind === "buffer" || c.kind === "self") return null;
    if (c.kind === "url" && (VIDEO_URL.test(c.url) || /^(mic|camera|webcam)/i.test(c.url))) return null;
    if (c.kind === "element") keys.push(c.key);
  }
  return keys;
}
