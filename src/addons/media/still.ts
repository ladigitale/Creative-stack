import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { safeMediaUrl } from "../../shared/media/urls";
import type { SonicFrameConsumerHost, SonicFrameSource, SonicMediaRef } from "../../shared/mediaRef";

const tagName = "sonic-still";

export type StillStatus = "idle" | "loading" | "ready" | "error";

export type StillState = {
  status: StillStatus;
  error: string | null;
  src: string | null;
  width: number;
  height: number;
  mime: string | null;
};

/**
 * Image fixe comme source d'images : fichier (via `sonic-file-open`), URL, `data:`, `blob:`
 * ou `SonicMediaRef` d'un DataProvider. Comme `sonic-camera`, elle se lit par `#id` :
 * `sonic-shader channel0="#photo"`, trackers de vision (`for="#photo"`), vectorisation, OCR.
 *
 * Origines : https, blob:, data:image, chemins relatifs (voir `safeMediaUrl`). Une image
 * https doit autoriser CORS pour rester lisible (sinon l'affichage marche, pas l'analyse).
 */
@customElement(tagName)
export class SonicStill extends LitElement implements SonicFrameSource, SonicFrameConsumerHost {
  static styles = css`
    :host {
      display: block;
      position: relative;
      overflow: hidden;
      line-height: 0;
    }
    :host([hidden-preview]) {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
    }
    :host(.drag) {
      outline: 2px dashed var(--sc-primary, currentColor);
      outline-offset: -2px;
    }
    canvas {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: var(--sonic-still-fit, contain);
    }
    ::slotted(*) {
      line-height: normal;
    }
  `;

  @property({ type: String })
  src = "";

  /** DP portant un `SonicMediaRef` (ou une URL) : remplace l'image à chaque publication. */
  @property({ type: String, attribute: "in-data-provider" })
  inDataProvider = "";

  /** Dépôt d'un fichier image sur l'élément. */
  @property({ type: Boolean })
  drop = false;

  /** Côté max (px) de l'image décodée ; l'image plus grande est réduite. */
  @property({ type: Number, attribute: "max-size" })
  maxSize = 4096;

  @property({ type: String })
  fit = "contain";

  @property({ type: Boolean, attribute: "hidden-preview" })
  hiddenPreview = false;

  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  /** Reçoit le `SonicMediaRef` de l'image chargée (blob inclus pour un fichier). */
  @property({ type: String, attribute: "ref-provider" })
  refProvider = "";

  @query("canvas")
  private canvasEl!: HTMLCanvasElement;

  private seq = 0;
  private token = 0;
  private current: SonicMediaRef | null = null;
  private ownedUrl: string | null = null;
  private unsub: (() => void) | null = null;
  private consumers = new Set<object>();
  private state: StillState = { status: "idle", error: null, src: null, width: 0, height: 0, mime: null };

  get frameSeq(): number {
    return this.seq;
  }

  getFrameCanvas(): HTMLCanvasElement | null {
    return this.state.status === "ready" ? (this.canvasEl ?? null) : null;
  }

  registerFrameConsumer(token: object = {}): void {
    this.consumers.add(token);
  }

  unregisterFrameConsumer(token: object = {}): void {
    this.consumers.delete(token);
  }

  getState(): StillState {
    return { ...this.state };
  }

  getRef(): SonicMediaRef | null {
    return this.current ? { ...this.current } : null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("dragover", this.onDragOver);
    this.addEventListener("dragleave", this.onDragLeave);
    this.addEventListener("drop", this.onDrop);
    this.publish();
  }

  disconnectedCallback(): void {
    this.unsub?.();
    this.unsub = null;
    this.token++;
    this.removeEventListener("dragover", this.onDragOver);
    this.removeEventListener("dragleave", this.onDragLeave);
    this.removeEventListener("drop", this.onDrop);
    this.releaseOwned();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("src") && this.src) void this.loadUrl(this.src);
    if (changed.has("inDataProvider")) this.listenIn();
    if (changed.has("fit")) this.style.setProperty("--sonic-still-fit", this.fit === "cover" ? "cover" : "contain");
  }

  /** Charge un fichier local (l'image garde le blob et une URL `blob:` à elle). */
  async loadFile(file: Blob): Promise<boolean> {
    if (!file.type.startsWith("image/")) {
      this.fail("ce fichier n'est pas une image");
      return false;
    }
    const url = URL.createObjectURL(file);
    return this.decode(url, { blob: file, mime: file.type }, url);
  }

  /** Charge une URL (soumise à `safeMediaUrl`). */
  async loadUrl(url: string): Promise<boolean> {
    if (!safeMediaUrl(url, "image")) {
      this.fail("adresse d'image refusée (https, blob:, data:image ou chemin relatif)");
      return false;
    }
    return this.decode(url, {}, null);
  }

  /** Charge un `SonicMediaRef` ou une URL (forme DataProvider). */
  async loadRef(value: unknown): Promise<boolean> {
    if (typeof value === "string") return value ? this.loadUrl(value) : false;
    if (!value || typeof value !== "object") return false;
    const r = value as SonicMediaRef;
    if (r.blob instanceof Blob) return this.loadFile(r.blob);
    const url = r.url || r.blobUrl;
    return url ? this.loadUrl(url) : false;
  }

  private async decode(url: string, extra: Partial<SonicMediaRef>, owned: string | null): Promise<boolean> {
    const token = ++this.token;
    this.patch({ status: "loading", error: null, src: owned ? null : url });
    let img: HTMLImageElement;
    try {
      img = await loadImage(url);
    } catch {
      if (owned) URL.revokeObjectURL(owned);
      if (token === this.token) this.fail("image illisible ou inaccessible");
      return false;
    }
    if (token !== this.token) {
      if (owned) URL.revokeObjectURL(owned);
      return false;
    }
    const nw = img.naturalWidth || img.width;
    const nh = img.naturalHeight || img.height;
    if (!nw || !nh) {
      if (owned) URL.revokeObjectURL(owned);
      this.fail("image vide");
      return false;
    }
    const k = Math.min(1, Math.max(16, this.maxSize) / Math.max(nw, nh));
    const w = Math.max(1, Math.round(nw * k));
    const h = Math.max(1, Math.round(nh * k));
    const c = this.canvasEl;
    c.width = w;
    c.height = h;
    c.getContext("2d")?.drawImage(img, 0, 0, w, h);
    this.releaseOwned();
    this.ownedUrl = owned;
    this.seq++;
    this.current = { url, width: w, height: h, mime: extra.mime, ...(extra.blob ? { blob: extra.blob } : {}) };
    this.patch({ status: "ready", error: null, width: w, height: h, mime: extra.mime ?? null });
    if (this.refProvider) set(this.refProvider, { ...this.current });
    this.dispatchEvent(new CustomEvent("sonic-still-load", { detail: this.getState(), bubbles: true, composed: true }));
    return true;
  }

  private fail(message: string): void {
    this.patch({ status: "error", error: message });
  }

  private releaseOwned(): void {
    if (this.ownedUrl) URL.revokeObjectURL(this.ownedUrl);
    this.ownedUrl = null;
  }

  private listenIn(): void {
    this.unsub?.();
    this.unsub = null;
    if (!this.inDataProvider) return;
    this.unsub = listenDp(this.inDataProvider, (v) => void this.loadRef(v));
  }

  private onDragOver = (e: DragEvent): void => {
    if (!this.drop) return;
    e.preventDefault();
    this.classList.add("drag");
  };

  private onDragLeave = (): void => {
    this.classList.remove("drag");
  };

  private onDrop = (e: DragEvent): void => {
    this.classList.remove("drag");
    if (!this.drop) return;
    e.preventDefault();
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (file) void this.loadFile(file);
  };

  private patch(p: Partial<StillState>): void {
    this.state = { ...this.state, ...p };
    this.publish();
  }

  private publishQueued = false;
  private publish(): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (!out || this.publishQueued) return;
    this.publishQueued = true;
    queueMicrotask(() => {
      this.publishQueued = false;
      set(out, this.getState());
    });
  }

  render() {
    return html`<canvas part="canvas"></canvas><slot></slot>`;
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (/^https?:/i.test(url)) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("load"));
    img.src = url;
  });
}

export default SonicStill;
