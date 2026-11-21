import { LitElement, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { dispatch } from "../interactive";
import { listenDp } from "../../shared/audio/dp";
import { bool, num } from "../../shared/media/control";
import { isFrameSource } from "../../shared/mediaRef";

const tagName = "sonic-qr-reader";

/** Décodeur de repli, version exacte servie par jsDelivr avec empreinte d'intégrité. */
export const JSQR_VERSION = "1.4.0";
export const JSQR_SCRIPT = `https://cdn.jsdelivr.net/npm/jsqr@${JSQR_VERSION}/dist/jsQR.js`;
export const JSQR_SRI = "sha384-b5Ya4Bq3qCyz39m2ISh+4DxjAIljdeFwK/BsXLuj9gugaNwAcj/ia15fxNZL9Nlx";

type JsQr = (data: Uint8ClampedArray, width: number, height: number, options?: { inversionAttempts?: string }) => { data: string } | null;
type Detector = { detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>> };
type DetectorClass = { new (options: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> };

let jsQrPromise: Promise<JsQr> | null = null;

/** Charge le décodeur de repli épinglé (une seule fois par page). */
export function loadJsQr(): Promise<JsQr> {
  const w = window as unknown as { jsQR?: JsQr };
  if (w.jsQR) return Promise.resolve(w.jsQR);
  jsQrPromise ??= new Promise<JsQr>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = JSQR_SCRIPT;
    s.integrity = JSQR_SRI;
    s.crossOrigin = "anonymous";
    s.async = true;
    s.onload = () => (w.jsQR ? resolve(w.jsQR) : reject(new Error("décodeur de QR indisponible")));
    s.onerror = () => {
      jsQrPromise = null;
      reject(new Error("chargement du décodeur de QR impossible (réseau ou CSP)"));
    };
    document.head.append(s);
  });
  return jsQrPromise;
}

export type QrReaderSettings = { active: boolean; interval: number; maxSize: number };

export type QrReaderState = {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  /** native : détecteur du navigateur ; jsqr : décodeur de repli. */
  engine: "native" | "jsqr" | null;
  active: boolean;
  /** Dernier texte lu. */
  text: string;
  /** Nombre de lectures d'un texte différent du précédent. */
  count: number;
  /** Images analysées, et analyses par seconde. */
  scans: number;
  rate: number;
  /** Durée moyenne d'une analyse en ms. */
  ms: number;
  settings: QrReaderSettings;
};

type ReadableSource = Element & { getFrameSource?: () => CanvasImageSource | null };

/**
 * Lecteur de QR codes : analyse en continu les images d'une source (`source="#cam"`) et publie le
 * texte du code vu (`text`, `count`). Action `{type: "qr", payload: {text}}` vers le store `target`
 * à chaque nouveau texte. Utilise le détecteur du navigateur quand il existe (Chrome sur Android),
 * sinon un décodeur chargé à la demande. Rien ne quitte l'appareil.
 */
@customElement(tagName)
export class SonicQrReader extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** `#id` d'une source d'images (sonic-camera, sonic-still, sonic-video…). */
  @property({ type: String })
  source = "";

  /** ms entre deux analyses (16..2000, défaut 50). */
  @property({ type: Number })
  interval = 50;

  /** `auto` (défaut), `native` ou `jsqr`. */
  @property({ type: String })
  engine: "auto" | "native" | "jsqr" = "auto";

  /** Plus grand côté de l'image analysée par le décodeur de repli, en px (défaut 640). */
  @property({ type: Number, attribute: "max-size" })
  maxSize = 640;

  /** Store qui reçoit une action par nouveau texte lu. */
  @property({ type: String })
  target = "";

  /** Type de l'action (défaut `qr`). */
  @property({ type: String })
  type = "qr";

  /** DataProvider de réglages en direct {active, interval, maxSize}. */
  @property({ type: String })
  params = "";

  /** DataProvider de sortie (défaut `<id>State`). */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private live: Partial<QrReaderSettings> = {};
  private unsubs: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private status: QrReaderState["status"] = "idle";
  private error: string | null = null;
  private used: QrReaderState["engine"] = null;
  private detector: Detector | null = null;
  private jsqr: JsQr | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private lastSeq = -1;
  private text = "";
  private count = 0;
  private scans = 0;
  private rate = 0;
  private ms = 0;
  private lastScanAt = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    this.running = true;
    this.publish();
    void this.loop();
  }

  disconnectedCallback(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("params")) this.listen();
  }

  settings(): QrReaderSettings {
    const base: QrReaderSettings = {
      active: true,
      interval: num(this.interval, 16, 2000) ?? 50,
      maxSize: Math.round(num(this.maxSize, 120, 1920) ?? 640),
    };
    return { ...base, ...this.live };
  }

  getState(): QrReaderState {
    return {
      status: this.status,
      error: this.error,
      engine: this.used,
      active: this.settings().active,
      text: this.text,
      count: this.count,
      scans: this.scans,
      rate: Math.round(this.rate * 10) / 10,
      ms: Math.round(this.ms * 10) / 10,
      settings: this.settings(),
    };
  }

  private resolve(): ReadableSource | null {
    if (!this.source.startsWith("#")) return null;
    const id = this.source.slice(1);
    const root = this.getRootNode() as unknown as Document;
    const el = root.getElementById?.(id) ?? document.getElementById(id);
    return el && isFrameSource(el) ? (el as ReadableSource) : null;
  }

  /** Prépare le moteur au premier besoin : détecteur du navigateur s'il lit les QR, sinon décodeur de repli. */
  private async ready(): Promise<boolean> {
    if (this.detector || this.jsqr) return true;
    if (this.status === "error") return false;
    this.status = "loading";
    this.publish();
    try {
      const Native = (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
      if (this.engine !== "jsqr" && Native) {
        const formats = Native.getSupportedFormats ? await Native.getSupportedFormats() : ["qr_code"];
        if (formats.includes("qr_code")) {
          this.detector = new Native({ formats: ["qr_code"] });
          this.used = "native";
        }
      }
      if (!this.detector) {
        if (this.engine === "native") throw new Error("ce navigateur ne lit pas les QR codes");
        this.jsqr = await loadJsQr();
        this.used = "jsqr";
      }
      this.status = "ready";
      this.error = null;
      this.publish();
      return true;
    } catch (e) {
      this.status = "error";
      this.error = e instanceof Error ? e.message : String(e);
      this.publish();
      return false;
    }
  }

  /** Texte du QR code visible dans l'image de `el`, ou null. */
  protected async detect(el: ReadableSource, s: QrReaderSettings): Promise<string | null> {
    const direct = typeof el.getFrameSource === "function" ? el.getFrameSource() : null;
    const src = direct ?? (isFrameSource(el) ? el.getFrameCanvas() : null);
    if (!src) return null;
    if (this.detector) {
      const found = await this.detector.detect(src);
      return found.length ? found[0].rawValue : null;
    }
    if (!this.jsqr) return null;
    const sw = (src as HTMLVideoElement).videoWidth || (src as HTMLCanvasElement).width || 0;
    const sh = (src as HTMLVideoElement).videoHeight || (src as HTMLCanvasElement).height || 0;
    if (!sw || !sh) return null;
    const scale = Math.min(1, s.maxSize / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const c = (this.canvas ??= document.createElement("canvas"));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(src, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    return this.jsqr(img.data, w, h, { inversionAttempts: "dontInvert" })?.data || null;
  }

  private async loop(): Promise<void> {
    if (!this.running) return;
    const s = this.settings();
    try {
      await this.scan(s);
    } catch {
      /* image illisible : on réessaie à l'analyse suivante */
    }
    if (this.running) this.timer = setTimeout(() => void this.loop(), s.interval);
  }

  /** Une analyse, si la source a une nouvelle image. */
  async scan(s: QrReaderSettings = this.settings()): Promise<void> {
    if (!s.active) return;
    const el = this.resolve();
    if (!el || !isFrameSource(el)) return;
    const seq = el.frameSeq;
    if (seq === this.lastSeq) return;
    if (!(await this.ready())) return;
    this.lastSeq = seq;
    const t0 = performance.now();
    const text = await this.detect(el, s);
    const t1 = performance.now();
    this.scans++;
    this.ms = this.ms ? this.ms + (t1 - t0 - this.ms) * 0.1 : t1 - t0;
    if (this.lastScanAt && t1 > this.lastScanAt) {
      const inst = 1000 / (t1 - this.lastScanAt);
      this.rate = this.rate ? this.rate + (inst - this.rate) * 0.1 : inst;
    }
    this.lastScanAt = t1;
    if (text && text !== this.text) {
      this.text = text;
      this.count++;
      const target = this.target.trim();
      if (target) dispatch(target, { type: this.type.trim() || "qr", payload: { text } });
      this.dispatchEvent(new CustomEvent("qr-read", { detail: { text }, bubbles: true, composed: true }));
      this.publish();
    } else if (this.scans % 10 === 0) {
      this.publish();
    }
  }

  private listen(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.live = {};
    if (!this.params) return;
    this.unsubs.push(
      listenDp(this.params, (v) => {
        const p = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
        const out: Partial<QrReaderSettings> = {};
        const active = bool(p.active);
        if (active !== undefined) out.active = active;
        const interval = num(p.interval, 16, 2000);
        if (interval !== undefined) out.interval = interval;
        const maxSize = num(p.maxSize, 120, 1920);
        if (maxSize !== undefined) out.maxSize = Math.round(maxSize);
        this.live = out;
        this.publish();
      }),
    );
  }

  private publish(): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (out) set(out, this.getState());
  }
}

export default SonicQrReader;
