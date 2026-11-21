import { LitElement, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger, num } from "../../shared/media/control";
import { QR_STREAM_CHUNK, QR_STREAM_MAX_BYTES, parseDataUrl, qrStreamFrames } from "./stream";

const tagName = "sonic-qr-sender";

export type QrSenderSettings = { fps: number; chunk: number; imageMax: number; imageQuality: number };

export type QrSenderState = {
  status: "idle" | "preparing" | "sending" | "error";
  error: string | null;
  /** Texte de la trame à afficher maintenant (pour `sonic-qr text-from`). */
  frame: string;
  /** Numéro de la trame affichée (1…frames) et nombre de trames. */
  index: number;
  frames: number;
  /** Tours complets déjà affichés. */
  loops: number;
  bytes: number;
  mime: string;
  name: string;
  /** Secondes pour un tour complet. */
  loopSeconds: number;
  settings: QrSenderSettings;
};

type Payload = { bytes: Uint8Array; mime: string };

/**
 * Émetteur d'un flux de QR codes : découpe un fichier (photo, dessin, texte) en trames et les publie
 * tour à tour, en boucle, dans son état (`frame`). Un `sonic-qr text-from="<id>State.frame"` les
 * affiche ; en face, `sonic-qr-reader` + `sonic-qr-receiver` les lisent et rassemblent le fichier.
 *
 * Source (`from`, chemin de DataProvider) : URL `blob:` ou `data:`, SonicMediaRef `{url, mime}`
 * (photo de `sonic-camera`, export de `sonic-sketch`…) ou texte brut. Une image est réduite avant
 * l'envoi (`image-max`, `image-quality`). Envoi à chaque changement de la source (`auto`) ou à
 * chaque hausse d'un compteur (`send-from`).
 */
@customElement(tagName)
export class SonicQrSender extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** Chemin de DataProvider du fichier à envoyer. */
  @property({ type: String })
  from = "";

  /** Envoie à chaque changement de la source. */
  @property({ type: Boolean })
  auto = false;

  /** Chemin d'un compteur : chaque hausse (re)lance l'envoi de la source. */
  @property({ type: String, attribute: "send-from" })
  sendFrom = "";

  /** Trames par seconde (1..30, défaut 8). */
  @property({ type: Number })
  fps = 8;

  /** Octets par trame (20..800, défaut 300) : plus il y en a, plus le code est dense. */
  @property({ type: Number })
  chunk = QR_STREAM_CHUNK;

  /** Plus grand côté d'une image envoyée, en px (défaut 320 ; 0 : image envoyée telle quelle). */
  @property({ type: Number, attribute: "image-max" })
  imageMax = 320;

  /** Qualité JPEG d'une image réduite (0.1..1, défaut 0.6). */
  @property({ type: Number, attribute: "image-quality" })
  imageQuality = 0.6;

  /** Nom du fichier annoncé au récepteur. */
  @property({ type: String })
  name = "";

  /** DataProvider de réglages en direct {fps, chunk, imageMax, imageQuality}. */
  @property({ type: String })
  params = "";

  /** DataProvider de pilotage : `{cancel: compteur}` arrête l'envoi. */
  @property({ type: String })
  control = "";

  /** DataProvider de sortie (défaut `<id>State`). */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private live: Partial<QrSenderSettings> = {};
  private unsubs: (() => void)[] = [];
  private sendTrigger = new CounterTrigger();
  private cancelTrigger = new CounterTrigger();
  private frames: string[] = [];
  private index = 0;
  private loops = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextAt = 0;
  private status: QrSenderState["status"] = "idle";
  private error: string | null = null;
  private bytes = 0;
  private mime = "";
  private job = 0;
  private lastSource: unknown = undefined;

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    this.publish();
  }

  disconnectedCallback(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.stop();
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (["params", "control", "from", "sendFrom", "auto"].some((k) => c.has(k))) this.listen();
  }

  settings(): QrSenderSettings {
    const base: QrSenderSettings = {
      fps: num(this.fps, 1, 30) ?? 8,
      chunk: Math.round(num(this.chunk, 20, 800) ?? QR_STREAM_CHUNK),
      imageMax: Math.round(num(this.imageMax, 0, 4096) ?? 320),
      imageQuality: num(this.imageQuality, 0.1, 1) ?? 0.6,
    };
    return { ...base, ...this.live };
  }

  getState(): QrSenderState {
    const s = this.settings();
    return {
      status: this.status,
      error: this.error,
      frame: this.frames[this.index] ?? "",
      index: this.frames.length ? this.index + 1 : 0,
      frames: this.frames.length,
      loops: this.loops,
      bytes: this.bytes,
      mime: this.mime,
      name: this.name,
      loopSeconds: Math.round((this.frames.length / s.fps) * 10) / 10,
      settings: s,
    };
  }

  /** Envoie `source` (URL blob: / data:, SonicMediaRef, ou texte). */
  async send(source: unknown): Promise<void> {
    const job = ++this.job;
    this.stop();
    this.status = "preparing";
    this.error = null;
    this.publish();
    try {
      const s = this.settings();
      let payload = await this.load(source);
      if (job !== this.job) return;
      if (!payload) throw new Error("rien à envoyer");
      if (s.imageMax > 0 && payload.mime.startsWith("image/") && payload.mime !== "image/svg+xml") {
        payload = (await this.shrink(payload, s.imageMax, s.imageQuality)) ?? payload;
        if (job !== this.job) return;
      }
      if (payload.bytes.length > QR_STREAM_MAX_BYTES) throw new Error(`fichier trop gros (${Math.round(payload.bytes.length / 1000)} ko, ${QR_STREAM_MAX_BYTES / 1000} ko au plus)`);
      this.frames = qrStreamFrames(payload.bytes, { mime: payload.mime, name: this.name }, { chunk: s.chunk });
      this.bytes = payload.bytes.length;
      this.mime = payload.mime;
      this.index = 0;
      this.loops = 0;
      this.status = "sending";
      this.nextAt = performance.now();
      this.publish();
      this.schedule();
    } catch (e) {
      if (job !== this.job) return;
      this.frames = [];
      this.status = "error";
      this.error = e instanceof Error ? e.message : String(e);
      this.publish();
    }
  }

  /** Arrête l'envoi. */
  cancel(): void {
    this.job++;
    this.stop();
    this.frames = [];
    this.status = "idle";
    this.error = null;
    this.publish();
  }

  /** Octets et type de la source ; null si elle est vide. */
  protected async load(source: unknown): Promise<Payload | null> {
    const ref = source && typeof source === "object" ? (source as { url?: unknown; blobUrl?: unknown; blob?: unknown; mime?: unknown }) : null;
    if (ref?.blob instanceof Blob) return { bytes: new Uint8Array(await ref.blob.arrayBuffer()), mime: ref.blob.type || String(ref.mime ?? "") || "application/octet-stream" };
    const value = ref ? (ref.url ?? ref.blobUrl) : source;
    if (typeof value !== "string" || !value) return null;
    if (value.startsWith("data:")) {
      const parsed = parseDataUrl(value);
      if (!parsed) throw new Error("URL data: illisible");
      return parsed;
    }
    if (value.startsWith("blob:")) {
      const blob = await (await fetch(value)).blob();
      return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || String(ref?.mime ?? "") || "application/octet-stream" };
    }
    if (ref) throw new Error("source non prise en charge (URL blob: ou data: attendue)");
    return { bytes: new TextEncoder().encode(value), mime: "text/plain" };
  }

  /** Réduit une image à `max` px de plus grand côté et la recode en JPEG ; null si le navigateur ne sait pas. */
  protected async shrink(p: Payload, max: number, quality: number): Promise<Payload | null> {
    if (typeof createImageBitmap !== "function") return null;
    try {
      const bmp = await createImageBitmap(new Blob([p.bytes as BlobPart], { type: p.mime }));
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close?.();
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", quality));
      if (!blob) return null;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return scale < 1 || bytes.length < p.bytes.length ? { bytes, mime: "image/jpeg" } : null;
    } catch {
      return null;
    }
  }

  private schedule(): void {
    const period = 1000 / this.settings().fps;
    this.nextAt += period;
    this.timer = setTimeout(() => {
      this.index++;
      if (this.index >= this.frames.length) {
        this.index = 0;
        this.loops++;
      }
      this.publish();
      // Onglet resté en arrière-plan : on repart de maintenant plutôt que de rattraper le retard.
      if (performance.now() - this.nextAt > 1000) this.nextAt = performance.now();
      this.schedule();
    }, Math.max(0, this.nextAt - performance.now()));
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private listen(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.sendTrigger.reset();
    this.cancelTrigger.reset();
    this.live = {};
    if (this.params) {
      this.unsubs.push(
        listenDp(this.params, (v) => {
          this.live = readParams(v);
          this.publish();
        }),
      );
    }
    if (this.control) {
      this.unsubs.push(
        listenDp(this.control, (v) => {
          if (this.cancelTrigger.feed((v as { cancel?: unknown } | null)?.cancel)) this.cancel();
        }),
      );
    }
    if (this.sendFrom) {
      this.sendTrigger.feed(dp(this.sendFrom).get());
      this.unsubs.push(
        listenDp(this.sendFrom, (v) => {
          if (this.sendTrigger.feed(v) && this.from) void this.send(dp(this.from).get());
        }),
      );
    }
    if (this.from && this.auto) {
      this.lastSource = sourceKey(dp(this.from).get());
      this.unsubs.push(
        listenDp(this.from, (v) => {
          const key = sourceKey(v);
          if (key === this.lastSource) return;
          this.lastSource = key;
          if (key) void this.send(v);
        }),
      );
    }
  }

  private publish(): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (out) set(out, this.getState());
  }
}

/** Ce qui identifie une source : son URL, ou son texte. */
function sourceKey(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const r = v as { url?: unknown; blobUrl?: unknown };
    return typeof r.url === "string" ? r.url : typeof r.blobUrl === "string" ? r.blobUrl : "";
  }
  return "";
}

function readParams(v: unknown): Partial<QrSenderSettings> {
  const p = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const out: Partial<QrSenderSettings> = {};
  const fps = num(p.fps, 1, 30);
  if (fps !== undefined) out.fps = fps;
  const chunk = num(p.chunk, 20, 800);
  if (chunk !== undefined) out.chunk = Math.round(chunk);
  const imageMax = num(p.imageMax, 0, 4096);
  if (imageMax !== undefined) out.imageMax = Math.round(imageMax);
  const imageQuality = num(p.imageQuality, 0.1, 1);
  if (imageQuality !== undefined) out.imageQuality = imageQuality;
  return out;
}

export default SonicQrSender;
