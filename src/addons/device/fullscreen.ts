import { customElement, property } from "lit/decorators.js";
import { listenDp } from "../../shared/audio/dp";
import { DeviceElement, describeElement, policyAllows, type CommandArg, type CommandMap, type DeviceBaseState } from "../../shared/device/base";

const tagName = "sonic-fullscreen";

export type FullscreenState = DeviceBaseState & {
  /** Élément actuellement en plein écran (`div#scene`), `null` sinon. */
  element: string | null;
  /** Plein écran possible seulement sur une `<video>` (iPhone Safari) : cibler la vidéo. */
  supportsVideoOnly: boolean;
  /** Barres du navigateur demandées à la prochaine entrée (attribut, puis `control`). */
  navigationUI: NavigationUI;
};

type NavigationUI = "auto" | "hide" | "show";

function readNavigationUI(v: unknown): NavigationUI | undefined {
  return v === "auto" || v === "hide" || v === "show" ? v : undefined;
}

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void; webkitFullscreenEnabled?: boolean };
type FsEl = Element & {
  webkitRequestFullscreen?: (opts?: FullscreenOptions) => Promise<void> | void;
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
};

/**
 * Plein écran (Fullscreen API, préfixe WebKit en repli).
 *
 * - `target` : sélecteur CSS de l'élément à passer en plein écran (défaut : la page entière).
 * - `control` (DP) : compteurs `{ enter: n, exit: n, toggle: n }` ; forme objet `{ enter: { n, navigationUI: "hide" } }`
 *   pour une entrée ponctuelle, ou clé de réglage `navigationUI` (`auto` | `hide` | `show`) qui recouvre l'attribut.
 * - `for="bouton"` : le clic sur cet id bascule le plein écran (le navigateur exige un geste).
 * - État `<id>State` : `{ status, error, supported, allowed, active, element, supportsVideoOnly, navigationUI }`.
 * - Événement `sonic-fullscreen-change` (`detail` : l'état).
 *
 * La sortie par Échap ou par le système est suivie par l'événement `fullscreenchange`, jamais supposée.
 * iPhone Safari : pas de plein écran sur autre chose qu'une `<video>` (`target="#ma-video"`).
 * Dans une iframe : l'hôte doit autoriser `allow="fullscreen"`.
 */
@customElement(tagName)
export class SonicFullscreen extends DeviceElement<FullscreenState> {
  /** Sélecteur CSS de l'élément à passer en plein écran (défaut : toute la page). */
  @property({ type: String }) target = "";
  /** Barres du navigateur : `auto`, `hide`, `show`. */
  @property({ type: String, attribute: "navigation-ui" }) navigationUI: NavigationUI = "auto";

  protected feature = "fullscreen";
  protected state: FullscreenState = { status: "idle", error: null, supported: false, allowed: "unknown", active: false, element: null, supportsVideoOnly: false, navigationUI: "auto" };
  /** `navigationUI` lu dans `control` (clé retirée : retour à l'attribut). */
  private controlNav: NavigationUI | undefined;
  private unlistenSettings: (() => void) | null = null;

  protected commands(): CommandMap {
    return { enter: (a) => this.enter(a), exit: () => this.exit(), toggle: (a) => this.toggle(a) };
  }

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("fullscreenchange", this.onChange);
    document.addEventListener("webkitfullscreenchange", this.onChange);
    document.addEventListener("fullscreenerror", this.onError);
    this.sync();
  }

  disconnectedCallback(): void {
    document.removeEventListener("fullscreenchange", this.onChange);
    document.removeEventListener("webkitfullscreenchange", this.onChange);
    document.removeEventListener("fullscreenerror", this.onError);
    this.unlistenSettings?.();
    this.unlistenSettings = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    // Réglage lu avant les compteurs du socle : `{ toggle: n, <réglage> }` écrit d'un coup s'applique à cette commande.
    if (changed.has("control")) this.listenSettings();
    super.updated(changed);
    if (changed.has("target")) this.sync();
    if (changed.has("navigationUI")) this.patch({ navigationUI: this.effectiveNavigationUI() });
  }

  /** Barres du navigateur effectives : `control.navigationUI`, sinon l'attribut. */
  effectiveNavigationUI(): NavigationUI {
    return this.controlNav ?? readNavigationUI(this.navigationUI) ?? "auto";
  }

  /** Réglage `navigationUI` du DP `control` (les compteurs restent gérés par le socle). */
  private listenSettings(): void {
    this.unlistenSettings?.();
    this.unlistenSettings = null;
    this.controlNav = undefined;
    if (this.control) {
      this.unlistenSettings = listenDp(this.control, (v) => {
        this.controlNav = v && typeof v === "object" ? readNavigationUI((v as Record<string, unknown>).navigationUI) : undefined;
        this.patch({ navigationUI: this.effectiveNavigationUI() });
      });
    }
    this.patch({ navigationUI: this.effectiveNavigationUI() });
  }

  /** `arg.navigationUI` (argument de commande) prime pour cette entrée seulement. */
  async enter(arg: CommandArg = {}): Promise<boolean> {
    const el = this.targetEl() as FsEl | null;
    if (!el) {
      this.patch({ status: "error", error: "cible du plein écran introuvable" });
      return false;
    }
    if (!this.canEnter(el)) {
      this.patch({ status: "unsupported", error: "plein écran non disponible ici", supported: false });
      return false;
    }
    if (this.isActive(el)) return true;
    try {
      if (typeof el.requestFullscreen === "function") await el.requestFullscreen({ navigationUI: readNavigationUI(arg.navigationUI) ?? this.effectiveNavigationUI() });
      else if (typeof el.webkitRequestFullscreen === "function") await el.webkitRequestFullscreen();
      else if (typeof el.webkitEnterFullscreen === "function") el.webkitEnterFullscreen();
      this.sync(true);
      return true;
    } catch (e) {
      this.fail(e, "plein écran");
      return false;
    }
  }

  async exit(): Promise<boolean> {
    const d = document as FsDoc;
    try {
      if (this.currentEl()) {
        if (typeof d.exitFullscreen === "function") await d.exitFullscreen();
        else if (typeof d.webkitExitFullscreen === "function") await d.webkitExitFullscreen();
      } else {
        const el = this.targetEl() as FsEl | null;
        if (el?.webkitDisplayingFullscreen) el.webkitExitFullscreen?.();
      }
      this.sync(true);
      return true;
    } catch (e) {
      this.fail(e, "sortie du plein écran");
      return false;
    }
  }

  toggle(arg: CommandArg = {}): Promise<boolean> {
    const el = this.targetEl() as FsEl | null;
    return el && this.isActive(el) ? this.exit() : this.enter(arg);
  }

  private targetEl(): Element | null {
    if (!this.target.trim()) return document.documentElement;
    try {
      return document.querySelector(this.target);
    } catch {
      return null;
    }
  }

  private currentEl(): Element | null {
    const d = document as FsDoc;
    return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
  }

  private canEnter(el: FsEl): boolean {
    const d = document as FsDoc;
    if (d.fullscreenEnabled === false || d.webkitFullscreenEnabled === false) return false;
    return typeof el.requestFullscreen === "function" || typeof el.webkitRequestFullscreen === "function" || (el instanceof HTMLVideoElement && typeof (el as FsEl).webkitEnterFullscreen === "function");
  }

  private isActive(el: FsEl): boolean {
    return this.currentEl() === el || el.webkitDisplayingFullscreen === true;
  }

  /** Relit le navigateur et publie (jamais par supposition). */
  private sync(clearError = false): void {
    const el = this.targetEl() as FsEl | null;
    const probe = (el ?? document.documentElement) as FsEl;
    const videoOnly =
      typeof HTMLVideoElement !== "undefined" &&
      "webkitEnterFullscreen" in HTMLVideoElement.prototype &&
      typeof probe.requestFullscreen !== "function" &&
      typeof probe.webkitRequestFullscreen !== "function";
    const supported = this.canEnter(probe);
    const active = el ? this.isActive(el) : false;
    const keep = !clearError && !active && (this.state.status === "denied" || this.state.status === "error");
    this.patch({
      status: !supported ? "unsupported" : active ? "ready" : keep ? this.state.status : "idle",
      error: keep ? this.state.error : null,
      supported,
      allowed: policyAllows(this.feature),
      active,
      element: describeElement(this.currentEl()),
      supportsVideoOnly: videoOnly,
    });
  }

  private onChange = (): void => {
    // Une sortie ou une entrée réussie efface l'erreur précédente.
    this.sync(true);
    this.emit("sonic-fullscreen-change", this.getState());
  };

  private onError = (): void => {
    this.patch({ status: "denied", error: "plein écran refusé : geste de l'utilisateur requis ou interdit par la page hôte (allow=\"fullscreen\")", active: false });
  };
}

export default SonicFullscreen;
