import { LitElement, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { dispatch } from "../interactive";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import { QrStreamAssembler } from "./stream";

const tagName = "sonic-qr-receiver";

export type QrReceivedFile = { url: string; mime: string; name: string; size: number };

export type QrReceiverState = {
  status: "idle" | "receiving" | "done" | "error";
  error: string | null;
  /** Trames reçues / attendues. */
  received: number;
  total: number;
  progress: number;
  percent: number;
  mime: string;
  name: string;
  size: number;
  /** Fichier reçu (URL `blob:`), lisible par `sonic-still`, `sonic-media-download`… */
  file: QrReceivedFile | null;
  /** Contenu d'un fichier texte reçu. */
  text: string;
  /** Durée de la réception en secondes. */
  seconds: number;
  /** Fichiers reçus depuis le chargement. */
  count: number;
};

/**
 * Récepteur d'un flux de QR codes : écoute les textes lus par un `sonic-qr-reader`
 * (`source="lecteurState.text"`), rassemble les trames dans n'importe quel ordre, vérifie
 * l'empreinte et publie le fichier en URL `blob:` (`file`, aussi dans `file-provider`).
 * Action `qr:received {name, mime, size}` vers le store `target`. Un nouvel envoi remplace le
 * précédent ; `control {reset: compteur}` oublie tout.
 */
@customElement(tagName)
export class SonicQrReceiver extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** Chemin de DataProvider du texte lu (ex. `lecteurState.text`). */
  @property({ type: String })
  source = "";

  /** Store qui reçoit `qr:received` à la fin d'un fichier. */
  @property({ type: String })
  target = "";

  /** DataProvider qui reçoit le fichier seul, en SonicMediaRef `{url, mime}` (ex. pour `sonic-still in-data-provider`). */
  @property({ type: String, attribute: "file-provider" })
  fileProvider = "";

  /** DataProvider de pilotage : `{reset: compteur}`. */
  @property({ type: String })
  control = "";

  /** DataProvider de sortie (défaut `<id>State`). */
  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private assembler = new QrStreamAssembler();
  private unsubs: (() => void)[] = [];
  private resetTrigger = new CounterTrigger();
  private file: QrReceivedFile | null = null;
  private text = "";
  private count = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.listen();
    this.publish();
  }

  disconnectedCallback(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.release();
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("source") || c.has("control")) this.listen();
  }

  getState(): QrReceiverState {
    const a = this.assembler;
    const status: QrReceiverState["status"] = a.error ? "error" : a.done ? "done" : a.total ? "receiving" : "idle";
    return {
      status,
      error: a.error,
      received: a.received,
      total: a.total,
      progress: Math.round(a.progress * 100) / 100,
      percent: Math.round(a.progress * 100),
      mime: a.meta?.mime ?? "",
      name: a.meta?.name ?? "",
      size: a.meta?.size ?? 0,
      file: this.file,
      text: this.text,
      seconds: a.startedAt ? Math.round(((a.finishedAt || Date.now()) - a.startedAt) / 100) / 10 : 0,
      count: this.count,
    };
  }

  /** Oublie le fichier en cours ou reçu. */
  reset(): void {
    this.assembler.reset();
    this.release();
    this.publish();
  }

  /** Texte lu par le lecteur. */
  feed(text: unknown): void {
    const before = this.assembler.id;
    const result = this.assembler.feed(text);
    if (result === "ignored" || result === "known") return;
    if (this.assembler.id !== before) this.release();
    if (result === "done") this.complete();
    this.publish();
  }

  private complete(): void {
    const f = this.assembler.file;
    if (!f) return;
    this.release();
    const blob = new Blob([f.bytes as BlobPart], { type: f.mime });
    this.file = { url: URL.createObjectURL(blob), mime: f.mime, name: f.name, size: f.size };
    this.text = f.mime.startsWith("text/") ? new TextDecoder().decode(f.bytes).slice(0, 20000) : "";
    this.count++;
    if (this.fileProvider) set(this.fileProvider, { url: this.file.url, mime: f.mime });
    const target = this.target.trim();
    if (target) dispatch(target, { type: "qr:received", payload: { name: f.name, mime: f.mime, size: f.size } });
    this.dispatchEvent(new CustomEvent("qr-received", { detail: { ...this.file }, bubbles: true, composed: true }));
  }

  private release(): void {
    if (this.file) URL.revokeObjectURL(this.file.url);
    this.file = null;
    this.text = "";
  }

  private listen(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.resetTrigger.reset();
    if (this.source) this.unsubs.push(listenDp(this.source, (v) => this.feed(v)));
    if (this.control) {
      this.unsubs.push(
        listenDp(this.control, (v) => {
          if (this.resetTrigger.feed((v as { reset?: unknown } | null)?.reset)) this.reset();
        }),
      );
    }
  }

  private publish(): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (out) set(out, this.getState());
  }
}

export default SonicQrReceiver;
