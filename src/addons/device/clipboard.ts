import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { DeviceElement, policyAllows, type CommandMap, type DeviceBaseState } from "../../shared/device/base";
import { revokeMediaUrls, type SonicMediaRef } from "../../shared/mediaRef";
import { dispatch } from "../interactive";

const tagName = "sonic-clipboard";

export type ClipboardState = DeviceBaseState & {
  /** Nombre de copies réussies. */
  copied: number;
  /** Dernier texte lu par `read` (tronqué à 10 000 caractères), `null` avant toute lecture. */
  text: string | null;
  /** Images reçues du presse-papiers (collage ou commande `readImage`). */
  images: number;
  /** Dernière image reçue. */
  image: { mime: string; size: number; width: number; height: number } | null;
  /** Images copiées dans le presse-papiers (`file-from`). */
  imagesCopied: number;
};

const MAX_TEXT = 10_000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
/** Attente du média produit après un clic (`wait`). */
const WAIT_MS = 20000;

type ItemCtor = new (items: Record<string, Blob | Promise<Blob>>) => ClipboardItem;

/** Première image d'un collage (`paste`) : fichier image du presse-papiers, sinon `null`. */
export function pastedImage(data: DataTransfer | null | undefined): File | null {
  if (!data) return null;
  for (const f of Array.from(data.files ?? [])) if (f.type.startsWith("image/")) return f;
  for (const it of Array.from(data.items ?? [])) {
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

async function imageDims(blob: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const d = { width: bmp.width, height: bmp.height };
    bmp.close?.();
    return d.width > 0 && d.height > 0 ? d : null;
  } catch {
    return null;
  }
}

/** Le presse-papiers n'accepte partout que le PNG : toute autre image est réencodée. */
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d")?.drawImage(bmp, 0, 0);
  bmp.close?.();
  return new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("encodage PNG impossible"))), "image/png"));
}

/**
 * Presse-papiers : copier un texte, lire le presse-papiers sur demande, recevoir une image collée, copier une image.
 *
 * - `text` : texte copié par défaut (`for="bouton"` : le clic sur cet id copie ce texte).
 * - `control` (DP) : compteurs `{ copy: { n, text }, read: n }` (`copy` sans `text` : l'attribut `text`).
 * - État `<id>State` : `{ status, error, supported, allowed, active, copied, text }`.
 *
 * La lecture ne se fait **jamais** d'elle-même : seulement par la commande `read`, sur geste, et le navigateur
 * demande lui-même la permission. Ne rien en faire de sensible (le texte lu est publié dans le DataProvider).
 * Dans une iframe, l'hôte doit autoriser `clipboard-write` (et `clipboard-read` pour la lecture).
 *
 * Images :
 * - `paste` : une image collée dans la page (Ctrl + V, capture d'écran comprise) est publiée en `SonicMediaRef`
 *   (`{ url blob:, blob, mime, width, height }`) dans `ref-provider`, et annoncée au store `target` :
 *   `{type: action-type (défaut paste), payload: {...payload, image: {mime, size, width, height}}}`. Aucune
 *   permission : c'est l'utilisateur qui colle. Un collage sans image est laissé au navigateur.
 * - commande `readImage` (bouton « Coller », sur geste, permission du navigateur) : même publication.
 * - `file-from` (DP d'un SonicMediaRef, URL `blob:` seulement) : la commande `copyImage` (ou `copy` sans texte,
 *   donc `for`) copie cette image, en PNG. `wait` : le clic attend le PROCHAIN média publié dans `file-from`
 *   (produit par une action autour du bouton, ex. `save` d'un sonic-paint) ; le presse-papiers est réservé dans le
 *   geste, l'image y arrive quand elle est prête.
 */
@customElement(tagName)
export class SonicClipboard extends DeviceElement<ClipboardState> {
  @property({ type: String }) text = "";
  /** Reçoit les images collées dans la page. */
  @property({ type: Boolean }) paste = false;
  @property({ type: String, attribute: "ref-provider" }) refProvider = "";
  /** Store qui reçoit une action à chaque image reçue. */
  @property({ type: String }) target = "";
  @property({ type: String, attribute: "action-type" }) actionType = "paste";
  /** Charge utile JSON (objet) de l'action, complétée par `image`. */
  @property({ type: String }) payload = "";
  /** DP d'un SonicMediaRef (URL `blob:`) : l'image à copier. */
  @property({ type: String, attribute: "file-from" }) fileFrom = "";
  @property({ type: Boolean }) wait = false;

  private ref: SonicMediaRef | null = null;
  private fileUrl: string | null = null;
  private fileSeen: string | null | undefined = undefined;
  private waiter: { resolve: (url: string) => void; reject: (e: Error) => void } | null = null;
  private unsubFile: (() => void) | null = null;

  protected feature = "clipboard-write";
  protected readonly defaultCommand: string = "copy";
  protected state: ClipboardState = { status: "idle", error: null, supported: false, allowed: "unknown", active: false, copied: 0, text: null, images: 0, image: null, imagesCopied: 0 };

  protected commands(): CommandMap {
    return {
      copy: (a) => (this.fileFrom && typeof a.text !== "string" ? this.copyImage() : this.copy(typeof a.text === "string" ? a.text : undefined)),
      read: () => this.read(),
      readImage: () => this.readImage(),
      copyImage: () => this.copyImage(),
    };
  }

  connectedCallback(): void {
    super.connectedCallback();
    const supported = typeof navigator !== "undefined" && !!navigator.clipboard;
    this.patch({ supported, status: supported ? "idle" : "unsupported", allowed: policyAllows(this.feature) });
    document.addEventListener("paste", this.onPaste);
  }

  disconnectedCallback(): void {
    document.removeEventListener("paste", this.onPaste);
    this.unsubFile?.();
    this.unsubFile = null;
    this.waiter?.reject(new Error("composant retiré"));
    this.waiter = null;
    revokeMediaUrls([this.ref?.url ?? ""]);
    this.ref = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    super.updated(changed);
    if (changed.has("fileFrom")) {
      this.unsubFile?.();
      this.fileSeen = undefined;
      this.fileUrl = null;
      this.unsubFile = this.fileFrom
        ? listenDp(this.fileFrom, (v) => {
            const r = v as { url?: unknown } | null;
            const url = r && typeof r.url === "string" && /^blob:/.test(r.url) ? r.url : null;
            const first = this.fileSeen === undefined;
            const fresh = url !== this.fileSeen;
            this.fileSeen = url;
            this.fileUrl = url;
            if (url && fresh && !first && this.waiter) {
              this.waiter.resolve(url);
              this.waiter = null;
            }
          })
        : null;
    }
  }

  private onPaste = (e: Event): void => {
    if (!this.paste) return;
    const file = pastedImage((e as ClipboardEvent).clipboardData);
    if (!file) return;
    e.preventDefault();
    void this.receive(file);
  };

  /** Publie une image reçue du presse-papiers (public pour les tests). */
  async receive(blob: Blob): Promise<boolean> {
    if (blob.size > MAX_IMAGE_BYTES) {
      this.patch({ status: "error", error: "image trop volumineuse" });
      return false;
    }
    const dims = await imageDims(blob);
    if (!dims) {
      this.patch({ status: "error", error: "image illisible" });
      return false;
    }
    const mime = blob.type || "image/png";
    const ref: SonicMediaRef = { url: URL.createObjectURL(blob), blob, mime, width: dims.width, height: dims.height };
    revokeMediaUrls([this.ref?.url ?? ""]);
    this.ref = ref;
    const image = { mime, size: blob.size, width: dims.width, height: dims.height };
    this.patch({ status: "idle", error: null, images: this.state.images + 1, image });
    if (this.refProvider) set(this.refProvider, { ...ref });
    this.emit("sonic-clipboard-image", image);
    if (this.target.trim()) dispatch(this.target.trim(), { type: (this.actionType || "paste").trim(), payload: { ...parsePayload(this.payload), image } });
    return true;
  }

  /** Lit une image du presse-papiers (sur geste ; le navigateur demande la permission). */
  async readImage(): Promise<boolean> {
    if (!navigator.clipboard?.read) {
      this.patch({ status: "unsupported", error: "lecture d'image du presse-papiers non disponible ici" });
      return false;
    }
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) return await this.receive(await item.getType(type));
      }
      this.patch({ status: "error", error: "pas d'image dans le presse-papiers" });
      return false;
    } catch (e) {
      this.fail(e, "lecture du presse-papiers");
      return false;
    }
  }

  /** Copie l'image de `file-from` (PNG). Avec `wait` : celle du prochain média publié. */
  async copyImage(): Promise<boolean> {
    const Item = (globalThis as { ClipboardItem?: ItemCtor }).ClipboardItem;
    if (!navigator.clipboard?.write || typeof Item !== "function") {
      this.patch({ status: "unsupported", error: "copie d'image non disponible dans ce navigateur" });
      return false;
    }
    let source: Promise<string>;
    if (this.wait) {
      this.waiter?.reject(new Error("remplacé"));
      source = new Promise<string>((resolve, reject) => {
        this.waiter = { resolve, reject };
        setTimeout(() => reject(new Error("aucune image produite")), WAIT_MS);
      });
      source.catch(() => undefined);
    } else if (this.fileUrl) {
      source = Promise.resolve(this.fileUrl);
    } else {
      this.patch({ status: "error", error: "rien à copier : aucune image dans file-from" });
      return false;
    }
    const png = source.then(async (url) => toPng(await (await fetch(url)).blob()));
    png.catch(() => undefined);
    this.patch({ status: "requesting", error: null });
    try {
      // Écriture lancée dans le geste, l'image arrive ensuite (promesse) : tient le temps d'un export.
      let item: ClipboardItem;
      try {
        item = new Item({ "image/png": png });
      } catch {
        item = new Item({ "image/png": await png });
      }
      await navigator.clipboard.write([item]);
      this.patch({ status: "idle", error: null, imagesCopied: this.state.imagesCopied + 1 });
      this.emit("sonic-clipboard-copied", { kind: "image" });
      return true;
    } catch (e) {
      this.fail(e, "copie de l'image");
      return false;
    }
  }

  async copy(text?: string): Promise<boolean> {
    const value = String(text ?? this.text ?? "");
    if (!navigator.clipboard?.writeText) {
      this.patch({ status: "unsupported", error: "presse-papiers non disponible (page non sécurisée ?)", supported: false });
      return false;
    }
    try {
      await navigator.clipboard.writeText(value);
      this.patch({ status: "idle", error: null, copied: this.state.copied + 1 });
      return true;
    } catch (e) {
      this.fail(e, "copie");
      return false;
    }
  }

  async read(): Promise<boolean> {
    if (!navigator.clipboard?.readText) {
      this.patch({ status: "unsupported", error: "lecture du presse-papiers non disponible ici" });
      return false;
    }
    try {
      const t = await navigator.clipboard.readText();
      this.patch({ status: "idle", error: null, text: t.slice(0, MAX_TEXT) });
      return true;
    } catch (e) {
      this.fail(e, "lecture du presse-papiers");
      return false;
    }
  }
}

export default SonicClipboard;

function parsePayload(raw: string): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
