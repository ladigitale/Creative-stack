import { customElement, property } from "lit/decorators.js";
import { listenDp } from "../../shared/audio/dp";
import { DeviceElement, policyAllows, type CommandMap, type DeviceBaseState } from "../../shared/device/base";
import { extensionFor } from "../../shared/media/record";

const tagName = "sonic-share";

export type ShareState = DeviceBaseState & {
  /** Le navigateur peut ouvrir la feuille de partage native. */
  canShare: boolean;
  /** Partages réussis. */
  shared: number;
  /** Partages annulés par l'utilisateur (pas une erreur). */
  cancelled: number;
  /** Comment le dernier partage est passé : feuille native ou copie dans le presse-papiers. */
  via: "share" | "clipboard" | null;
  /** La feuille native accepte un fichier joint (du type de `file-from`, image PNG à défaut). */
  canShareFiles: boolean;
  /** Fichier de `file-from` prêt à partager (`wait` : le geste était trop ancien, le prochain clic partage). */
  ready: boolean;
};

/** Délais : attente du média produit après un clic (`wait`) ; validité d'un fichier `ready`. */
const WAIT_MS = 20000;
const READY_MS = 30000;

type FileNavigator = Navigator & { userActivation?: { isActive: boolean } };

/** La feuille de partage du système accepte-t-elle un fichier de ce type ? */
export function canShareFileType(mime: string): boolean {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function" || typeof navigator.canShare !== "function" || typeof File === "undefined") return false;
  try {
    return navigator.canShare({ files: [new File([""], `x.${extensionFor(mime)}`, { type: mime })] });
  } catch {
    return false;
  }
}

/** Seules les URL http(s) sont partagées (jamais `javascript:` ni `data:`). */
export function safeShareUrl(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  try {
    const u = new URL(v, typeof location !== "undefined" ? location.href : undefined);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Partage natif (Web Share) d'un titre, d'un texte et d'une URL, avec repli sur la copie dans le presse-papiers.
 *
 * - `title`, `text`, `url` : contenu par défaut ; `for="bouton"` : le clic sur cet id partage.
 * - `fallback` : `copy` (défaut, copie `texte + url` quand le partage natif manque) ou `none`.
 * - `control` (DP) : compteurs `{ share: { n, title, text, url } }` (champs absents : les attributs).
 * - État `<id>State` : `{ status, error, supported, allowed, active, canShare, shared, cancelled, via }`.
 *
 * - `file-from` (DP d'un SonicMediaRef, URL `blob:` seulement : ce que la page a créé — export, photo, prise) :
 *   le fichier est joint au partage (`filename` sans extension). Il est préparé d'avance, pour que la feuille de
 *   partage s'ouvre dans le geste. `canShareFiles` dit si le système accepte ce type de fichier.
 * - `wait` : le clic (`for`) attend le PROCHAIN média publié dans `file-from`, produit par une action autour du
 *   bouton (ex. un export). Si le navigateur juge alors le geste trop ancien, `ready` passe à vrai et le clic
 *   suivant partage aussitôt le fichier prêt (30 s), sans attendre de nouvel export.
 *
 * L'annulation par l'utilisateur est comptée dans `cancelled`, sans erreur. Dans une iframe, l'hôte doit
 * autoriser `web-share`.
 */
@customElement(tagName)
export class SonicShare extends DeviceElement<ShareState> {
  @property({ type: String }) title = "";
  @property({ type: String }) text = "";
  @property({ type: String }) url = "";
  @property({ type: String }) fallback: "copy" | "none" = "copy";
  @property({ type: String, attribute: "file-from" }) fileFrom = "";
  @property({ type: String }) filename = "creation";
  @property({ type: Boolean }) wait = false;

  private fileRef: { url: string; mime: string } | null = null;
  private file: File | null = null;
  private fileSeen: string | null | undefined = undefined;
  private pendingUntil = 0;
  private readyUntil = 0;
  private unsubFile: (() => void) | null = null;

  protected feature = "web-share";
  protected readonly defaultCommand: string = "share";
  protected state: ShareState = { status: "idle", error: null, supported: false, allowed: "unknown", active: false, canShare: false, shared: 0, cancelled: 0, via: null, canShareFiles: false, ready: false };

  protected commands(): CommandMap {
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return { share: (a) => this.share({ title: str(a.title), text: str(a.text), url: str(a.url) }) };
  }

  connectedCallback(): void {
    super.connectedCallback();
    const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
    const copy = typeof navigator !== "undefined" && !!navigator.clipboard?.writeText && this.fallback === "copy";
    const supported = canShare || copy;
    this.patch({ canShare, supported, canShareFiles: canShareFileType("image/png"), status: supported ? "idle" : "unsupported", allowed: policyAllows(this.feature) });
  }

  disconnectedCallback(): void {
    this.unsubFile?.();
    this.unsubFile = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    super.updated(changed);
    if (changed.has("fileFrom")) this.listenFile();
  }

  private listenFile(): void {
    this.unsubFile?.();
    this.fileSeen = undefined;
    this.unsubFile = this.fileFrom
      ? listenDp(this.fileFrom, (v) => {
          const r = v as { url?: unknown; mime?: unknown } | null;
          this.fileRef = r && typeof r.url === "string" && /^blob:/.test(r.url) ? { url: r.url, mime: String(r.mime ?? "") } : null;
          const url = this.fileRef?.url ?? null;
          const first = this.fileSeen === undefined;
          const fresh = url !== this.fileSeen;
          this.fileSeen = url;
          if (!this.fileRef) { this.file = null; return; }
          if (fresh) this.file = null;
          const ref = this.fileRef;
          void this.prepare(ref).then((file) => {
            if (!file || this.fileRef?.url !== ref.url) return;
            if (this.state.canShareFiles !== canShareFileType(file.type)) this.patch({ canShareFiles: canShareFileType(file.type) });
            if (!this.wait || first || !fresh || Date.now() >= this.pendingUntil) return;
            this.pendingUntil = 0;
            // Export arrivé : partage si le geste compte encore, sinon au prochain clic.
            const act = (navigator as FileNavigator).userActivation;
            if (act && !act.isActive) this.markReady();
            else void this.shareFile({}, true);
          });
        })
      : null;
  }

  /** Fichier du média (lu depuis son URL `blob:`), gardé pour un partage sans attente. */
  private async prepare(ref: { url: string; mime: string }): Promise<File | null> {
    if (this.file && this.fileRef?.url === ref.url) return this.file;
    try {
      const blob = await (await fetch(ref.url)).blob();
      const mime = ref.mime || blob.type || "application/octet-stream";
      const name = `${(this.filename || "creation").replace(/[^\w.-]+/g, "-")}.${extensionFor(mime)}`;
      const file = new File([blob], name, { type: mime });
      if (this.fileRef?.url === ref.url) this.file = file;
      return file;
    } catch {
      return null;
    }
  }

  private markReady(): void {
    this.readyUntil = Date.now() + READY_MS;
    this.patch({ ready: true, status: "idle", error: null });
  }

  async share(data: { title?: string; text?: string; url?: string } = {}): Promise<boolean> {
    if (this.fileFrom) return this.shareFile(data);
    const title = data.title ?? this.title;
    const text = data.text ?? this.text;
    const rawUrl = data.url ?? this.url;
    let url: string | undefined;
    if (rawUrl) {
      const safe = safeShareUrl(rawUrl);
      if (!safe) {
        this.patch({ status: "error", error: "partage refusé : seule une URL http(s) est acceptée" });
        return false;
      }
      url = safe;
    }
    if (!title && !text && !url) {
      this.patch({ status: "error", error: "rien à partager (title, text ou url)" });
      return false;
    }
    const payload: ShareData = {};
    if (title) payload.title = title;
    if (text) payload.text = text;
    if (url) payload.url = url;
    if (typeof navigator.share === "function" && (typeof navigator.canShare !== "function" || navigator.canShare(payload))) {
      try {
        await navigator.share(payload);
        this.patch({ status: "idle", error: null, shared: this.state.shared + 1, via: "share" });
        return true;
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError") {
          this.patch({ status: "idle", error: null, cancelled: this.state.cancelled + 1 });
          return false;
        }
        // Refus de geste ou de politique : le repli par copie ne passerait pas mieux sans geste, mais on le tente.
        if (this.fallback !== "copy" || !navigator.clipboard?.writeText) {
          this.fail(e, "partage");
          return false;
        }
      }
    }
    if (this.fallback === "copy" && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText([text, url].filter(Boolean).join(" ") || title);
        this.patch({ status: "idle", error: null, shared: this.state.shared + 1, via: "clipboard" });
        return true;
      } catch (e) {
        this.fail(e, "partage");
        return false;
      }
    }
    this.patch({ status: "unsupported", error: "partage non disponible dans ce navigateur" });
    return false;
  }

  /** Partage du fichier de `file-from` (avec titre, texte et URL s'il y en a). */
  private async shareFile(data: { title?: string; text?: string; url?: string }, now = false): Promise<boolean> {
    const ready = this.state.ready && Date.now() < this.readyUntil;
    if (this.wait && !ready && !now) {
      // Le clic arme le partage ; l'action autour du bouton produit le média attendu.
      this.pendingUntil = Date.now() + WAIT_MS;
      if (this.state.ready) this.patch({ ready: false });
      this.patch({ status: "requesting", error: null });
      return true;
    }
    const file = this.file;
    if (!file) {
      this.patch({ status: "error", error: "rien à partager : aucun fichier prêt dans file-from", ready: false });
      return false;
    }
    const payload: ShareData = { files: [file] };
    const title = data.title ?? this.title, text = data.text ?? this.text;
    if (title) payload.title = title;
    if (text) payload.text = text;
    const rawUrl = data.url ?? this.url;
    if (rawUrl) {
      const safe = safeShareUrl(rawUrl);
      if (safe) payload.url = safe;
    }
    if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function" || !navigator.canShare(payload)) {
      this.patch({ status: "unsupported", error: "partage de ce fichier non disponible dans ce navigateur", ready: false, canShareFiles: false });
      return false;
    }
    this.patch({ ready: false, active: true });
    try {
      await navigator.share(payload);
      this.patch({ status: "idle", error: null, active: false, shared: this.state.shared + 1, via: "share" });
      return true;
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === "AbortError") {
        this.patch({ status: "idle", error: null, active: false, cancelled: this.state.cancelled + 1 });
        return false;
      }
      // Geste trop ancien (export long) : le fichier reste prêt pour le prochain clic.
      if (name === "NotAllowedError" && this.wait) {
        this.patch({ active: false });
        this.markReady();
        return false;
      }
      this.fail(e, "partage");
      return false;
    }
  }
}

export default SonicShare;
