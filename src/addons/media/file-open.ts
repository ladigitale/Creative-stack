import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { revokeMediaUrls, type SonicMediaRef } from "../../shared/mediaRef";

const tagName = "sonic-file-open";

export type FileKind = "image" | "audio" | "video" | "text" | "other";

export type FileOpenState = {
  name: string | null;
  size: number;
  mime: string | null;
  kind: FileKind | null;
  /** Contenu pour les fichiers texte / CSV / JSON (limité par `max-text`). */
  text: string | null;
  files: number;
  error: string | null;
};

export function fileKind(mime: string, name = ""): FileKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/") || mime === "application/json" || /\.(csv|tsv|txt|json)$/i.test(name)) return "text";
  return "other";
}

/**
 * Ouvre un fichier du disque (clic ou dépôt) et le publie en `SonicMediaRef` :
 * `ref-provider` reçoit `{ url (blob:), blob, mime, width/height pour une image }`.
 * Branchez ce DataProvider sur `sonic-image in-data-provider`, un lecteur audio, un tableau…
 * Les fichiers texte (CSV, JSON) exposent aussi leur contenu dans l'état (`text`).
 */
@customElement(tagName)
export class SonicFileOpen extends LitElement {
  static styles = css`
    :host {
      display: inline-block;
    }
    :host(.drag) {
      outline: 2px dashed var(--sc-primary, currentColor);
    }
    input {
      display: none;
    }
  `;

  /** Types acceptés (attribut `accept` de l'input : `image/*`, `.csv`…). */
  @property({ type: String })
  accept = "";

  @property({ type: String })
  label = "Ouvrir un fichier";

  @property({ type: Boolean })
  drop = false;

  /** Taille max (octets) ; au-delà le fichier est refusé. */
  @property({ type: Number, attribute: "max-bytes" })
  maxBytes = 200 * 1024 * 1024;

  /** Taille max (caractères) du texte exposé dans l'état. */
  @property({ type: Number, attribute: "max-text" })
  maxText = 2_000_000;

  @property({ type: String, attribute: "ref-provider" })
  refProvider = "";

  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private ref: SonicMediaRef | null = null;
  private state: FileOpenState = { name: null, size: 0, mime: null, kind: null, text: null, files: 0, error: null };

  getState(): FileOpenState {
    return { ...this.state };
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("dragover", this.onDragOver);
    this.addEventListener("dragleave", this.onDragLeave);
    this.addEventListener("drop", this.onDrop);
    this.publish();
  }

  disconnectedCallback(): void {
    this.removeEventListener("dragover", this.onDragOver);
    this.removeEventListener("dragleave", this.onDragLeave);
    this.removeEventListener("drop", this.onDrop);
    revokeMediaUrls([this.ref?.url ?? ""]);
    this.ref = null;
    super.disconnectedCallback();
  }

  /** Ouvre le sélecteur (à appeler dans un clic). */
  pick(): void {
    this.renderRoot.querySelector("input")?.click();
  }

  async openFile(file: File): Promise<boolean> {
    if (file.size > this.maxBytes) {
      this.patch({ error: "fichier trop volumineux" });
      return false;
    }
    const mime = file.type || "";
    const kind = fileKind(mime, file.name);
    const url = URL.createObjectURL(file);
    const ref: SonicMediaRef = { url, blob: file, mime };
    if (kind === "image") {
      const dims = await imageSize(url);
      if (!dims) {
        URL.revokeObjectURL(url);
        this.patch({ error: "image illisible" });
        return false;
      }
      ref.width = dims.width;
      ref.height = dims.height;
    }
    let text: string | null = null;
    if (kind === "text") text = (await readText(file)).slice(0, Math.max(0, this.maxText));
    revokeMediaUrls([this.ref?.url ?? ""]);
    this.ref = ref;
    this.patch({ name: file.name, size: file.size, mime, kind, text, files: this.state.files + 1, error: null });
    if (this.refProvider) set(this.refProvider, { ...ref });
    this.dispatchEvent(new CustomEvent("sonic-file-open", { detail: this.getState(), bubbles: true, composed: true }));
    return true;
  }

  private onChange = (e: Event): void => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void this.openFile(file);
    input.value = "";
  };

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
    const file = e.dataTransfer?.files?.[0];
    if (file) void this.openFile(file);
  };

  private patch(p: Partial<FileOpenState>): void {
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
    return html`<input type="file" accept=${this.accept} @change=${this.onChange} /><slot @click=${() => this.pick()}><button type="button" part="button">${this.label}</button></slot>${this.state.error ? html`<span part="error" role="alert">${this.state.error}</span>` : ""}`;
  }
}

function readText(file: Blob): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

function imageSize(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export default SonicFileOpen;
