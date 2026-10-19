import { customElement, property } from "lit/decorators.js";
import { DeviceElement, policyAllows, type CommandMap, type DeviceBaseState } from "../../shared/device/base";

const tagName = "sonic-clipboard";

export type ClipboardState = DeviceBaseState & {
  /** Nombre de copies réussies. */
  copied: number;
  /** Dernier texte lu par `read` (tronqué à 10 000 caractères), `null` avant toute lecture. */
  text: string | null;
};

const MAX_TEXT = 10_000;

/**
 * Presse-papiers (texte) : copier un texte, lire le presse-papiers sur demande.
 *
 * - `text` : texte copié par défaut (`for="bouton"` : le clic sur cet id copie ce texte).
 * - `control` (DP) : compteurs `{ copy: { n, text }, read: n }` (`copy` sans `text` : l'attribut `text`).
 * - État `<id>State` : `{ status, error, supported, allowed, active, copied, text }`.
 *
 * La lecture ne se fait **jamais** d'elle-même : seulement par la commande `read`, sur geste, et le navigateur
 * demande lui-même la permission. Ne rien en faire de sensible (le texte lu est publié dans le DataProvider).
 * Dans une iframe, l'hôte doit autoriser `clipboard-write` (et `clipboard-read` pour la lecture).
 */
@customElement(tagName)
export class SonicClipboard extends DeviceElement<ClipboardState> {
  @property({ type: String }) text = "";

  protected feature = "clipboard-write";
  protected readonly defaultCommand: string = "copy";
  protected state: ClipboardState = { status: "idle", error: null, supported: false, allowed: "unknown", active: false, copied: 0, text: null };

  protected commands(): CommandMap {
    return { copy: (a) => this.copy(typeof a.text === "string" ? a.text : undefined), read: () => this.read() };
  }

  connectedCallback(): void {
    super.connectedCallback();
    const supported = typeof navigator !== "undefined" && !!navigator.clipboard;
    this.patch({ supported, status: supported ? "idle" : "unsupported", allowed: policyAllows(this.feature) });
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
