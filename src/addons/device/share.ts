import { customElement, property } from "lit/decorators.js";
import { DeviceElement, policyAllows, type CommandMap, type DeviceBaseState } from "../../shared/device/base";

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
};

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
 * L'annulation par l'utilisateur est comptée dans `cancelled`, sans erreur. Dans une iframe, l'hôte doit
 * autoriser `web-share`. Partage de fichiers : non pris en charge ici.
 */
@customElement(tagName)
export class SonicShare extends DeviceElement<ShareState> {
  @property({ type: String }) title = "";
  @property({ type: String }) text = "";
  @property({ type: String }) url = "";
  @property({ type: String }) fallback: "copy" | "none" = "copy";

  protected feature = "web-share";
  protected readonly defaultCommand: string = "share";
  protected state: ShareState = { status: "idle", error: null, supported: false, allowed: "unknown", active: false, canShare: false, shared: 0, cancelled: 0, via: null };

  protected commands(): CommandMap {
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return { share: (a) => this.share({ title: str(a.title), text: str(a.text), url: str(a.url) }) };
  }

  connectedCallback(): void {
    super.connectedCallback();
    const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
    const copy = typeof navigator !== "undefined" && !!navigator.clipboard?.writeText && this.fallback === "copy";
    const supported = canShare || copy;
    this.patch({ canShare, supported, status: supported ? "idle" : "unsupported", allowed: policyAllows(this.feature) });
  }

  async share(data: { title?: string; text?: string; url?: string } = {}): Promise<boolean> {
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
}

export default SonicShare;
