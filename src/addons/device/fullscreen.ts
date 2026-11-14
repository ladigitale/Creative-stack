import { css, html } from "lit";
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
  /** Plein écran simulé (API absente ou refusée) : la cible couvre la fenêtre en `position: fixed`. */
  simulated: boolean;
};

type Fallback = "simulate" | "none";

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

/** Propriétés posées en ligne sur la cible en plein écran simulé (restaurées à la sortie). */
const SIMULATED_STYLE: [string, string][] = [
  ["position", "fixed"],
  ["inset", "0"],
  ["top", "0"],
  ["left", "0"],
  ["width", "100vw"],
  ["height", "100vh"],
  ["height", "100svh"],
  ["max-width", "none"],
  ["max-height", "none"],
  ["margin", "0"],
  ["box-sizing", "border-box"],
  ["overflow", "auto"],
  ["z-index", "2147483000"],
  ["background", "var(--sonic-fullscreen-background, var(--sc-base, Canvas))"],
];

/**
 * Plein écran (Fullscreen API, préfixe WebKit en repli, plein écran simulé en dernier recours).
 *
 * - Contenu slotté (un `sonic-button`) : un clic bascule le plein écran. Le bouton reçoit `aria-pressed`
 *   et, si c'est un `sonic-button`, l'attribut `active` (ses enfants `swap="on"` / `swap="off"` changent d'icône).
 *   L'hôte reflète aussi `active`.
 * - `target` : id (`scene` ou `#scene`) ou sélecteur CSS, cherché dans le même arbre que le composant
 *   (shadow root du viewer compris) ; absent : l'ancêtre le plus proche marqué `data-fullscreen-root`, sinon la page.
 * - `control` (DP) : compteurs `{ enter: n, exit: n, toggle: n }` ; forme objet `{ enter: { n, navigationUI: "hide" } }`
 *   pour une entrée ponctuelle, ou clé de réglage `navigationUI` (`auto` | `hide` | `show`) qui recouvre l'attribut.
 * - `for="bouton"` : le clic sur cet id bascule le plein écran (le navigateur exige un geste).
 * - État `<id>State` : `{ status, error, supported, allowed, active, element, supportsVideoOnly, navigationUI }`.
 * - Événement `sonic-fullscreen-change` (`detail` : l'état).
 *
 * - `fallback` : `simulate` (défaut) — si l'API manque ou refuse (iPhone Safari hors `<video>`, iframe sans
 *   `allow="fullscreen"`), la cible passe en `position: fixed; inset: 0; height: 100svh` au-dessus de la page,
 *   attribut `data-fullscreen-simulated` posé ; Échap ou une nouvelle bascule en sort. `none` : échec publié.
 *
 * La sortie par Échap ou par le système est suivie par l'événement `fullscreenchange`, jamais supposée.
 * iPhone Safari : vrai plein écran seulement sur une `<video>` (`target="#ma-video"`), sinon simulé.
 */
@customElement(tagName)
export class SonicFullscreen extends DeviceElement<FullscreenState> {
  static styles = css`
    :host {
      display: contents;
    }
  `;

  /** Id ou sélecteur CSS de l'élément à passer en plein écran (défaut : `[data-fullscreen-root]` parent, sinon la page). */
  @property({ type: String }) target = "";
  /** Barres du navigateur : `auto`, `hide`, `show`. */
  @property({ type: String, attribute: "navigation-ui" }) navigationUI: NavigationUI = "auto";
  /** Repli quand le vrai plein écran est impossible : `simulate` (défaut) ou `none`. */
  @property({ type: String }) fallback: Fallback = "simulate";

  protected feature = "fullscreen";
  protected state: FullscreenState = { status: "idle", error: null, supported: false, allowed: "unknown", active: false, element: null, supportsVideoOnly: false, navigationUI: "auto", simulated: false };
  /** Cible en plein écran simulé et son attribut `style` d'origine. */
  private simulatedEl: HTMLElement | null = null;
  private simulatedStyle: string | null = null;
  private rootOverflow = "";
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
    this.addEventListener("click", this.onHostClick);
    this.sync();
  }

  disconnectedCallback(): void {
    document.removeEventListener("fullscreenchange", this.onChange);
    document.removeEventListener("webkitfullscreenchange", this.onChange);
    document.removeEventListener("fullscreenerror", this.onError);
    this.removeEventListener("click", this.onHostClick);
    // Retiré de la page : la cible ne reste pas collée en plein écran simulé.
    this.stopSimulated();
    this.unlistenSettings?.();
    this.unlistenSettings = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    // Réglage lu avant les compteurs du socle : `{ toggle: n, <réglage> }` écrit d'un coup s'applique à cette commande.
    if (changed.has("control")) this.listenSettings();
    super.updated(changed);
    if (changed.has("target")) {
      if (this.simulatedEl && this.simulatedEl !== this.targetEl()) this.stopSimulated();
      this.sync();
    }
    if (changed.has("fallback")) this.sync();
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
    if (this.isActive(el)) return true;
    if (!this.canEnter(el)) {
      if (this.simulate(el)) return true;
      this.patch({ status: "unsupported", error: "plein écran non disponible ici", supported: false });
      return false;
    }
    try {
      if (typeof el.requestFullscreen === "function") await el.requestFullscreen({ navigationUI: readNavigationUI(arg.navigationUI) ?? this.effectiveNavigationUI() });
      else if (typeof el.webkitRequestFullscreen === "function") await el.webkitRequestFullscreen();
      else if (typeof el.webkitEnterFullscreen === "function") el.webkitEnterFullscreen();
      this.sync(true);
      return true;
    } catch (e) {
      if (this.simulate(el)) return true;
      this.fail(e, "plein écran");
      return false;
    }
  }

  async exit(): Promise<boolean> {
    if (this.simulatedEl) {
      this.stopSimulated();
      this.sync(true);
      this.emit("sonic-fullscreen-change", this.getState());
      return true;
    }
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

  /** Arbre du composant (shadow root du viewer ou document). */
  private root(): Document | ShadowRoot {
    const r = this.isConnected ? this.getRootNode() : document;
    return r instanceof ShadowRoot || r instanceof Document ? r : document;
  }

  private targetEl(): Element | null {
    const t = this.target.trim();
    if (!t) return this.closestRoot() ?? document.documentElement;
    const scopes = this.root() === document ? [document] : [this.root(), document];
    const id = t.replace(/^#/, "");
    for (const scope of scopes) {
      if (/^[\w-]+$/.test(id)) {
        const byId = scope.getElementById(id);
        if (byId) return byId;
        if (t.startsWith("#")) continue;
      }
      try {
        const found = scope.querySelector(t);
        if (found) return found;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Ancêtre le plus proche marqué `data-fullscreen-root` (en traversant les shadow roots). */
  private closestRoot(): Element | null {
    let node: Element | null = this;
    while (node) {
      const hit: Element | null = node.closest("[data-fullscreen-root]");
      if (hit) return hit;
      const r = node.getRootNode();
      node = r instanceof ShadowRoot ? r.host : null;
    }
    return null;
  }

  /** Élément en plein écran, au plus profond (une cible dans un shadow root est vue comme son hôte par `document`). */
  private currentEl(): Element | null {
    const d = document as FsDoc;
    const top = d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
    const r = this.root();
    const inner = r instanceof ShadowRoot ? (r as ShadowRoot & { fullscreenElement?: Element | null }).fullscreenElement ?? null : null;
    return inner ?? top;
  }

  private canEnter(el: FsEl): boolean {
    const d = document as FsDoc;
    if (d.fullscreenEnabled === false || d.webkitFullscreenEnabled === false) return false;
    return typeof el.requestFullscreen === "function" || typeof el.webkitRequestFullscreen === "function" || (el instanceof HTMLVideoElement && typeof (el as FsEl).webkitEnterFullscreen === "function");
  }

  private isActive(el: FsEl): boolean {
    return this.simulatedEl === el || this.currentEl() === el || el.webkitDisplayingFullscreen === true;
  }

  /** Plein écran simulé sur la cible (si `fallback` le permet). */
  private simulate(el: Element): boolean {
    if (this.fallback === "none" || !(el instanceof HTMLElement || el instanceof SVGElement)) return false;
    if (this.simulatedEl === el) return true;
    this.stopSimulated();
    const target = el as HTMLElement;
    const html = document.documentElement;
    this.simulatedEl = target;
    this.simulatedStyle = target.getAttribute("style");
    this.rootOverflow = html.style.overflow;
    // La page entière : rien à déplacer, seulement bloquer le défilement.
    if (target !== html && target !== document.body) {
      for (const [k, v] of SIMULATED_STYLE) target.style.setProperty(k, v, "important");
    }
    html.style.overflow = "hidden";
    target.setAttribute("data-fullscreen-simulated", "");
    document.addEventListener("keydown", this.onKey, true);
    this.sync(true);
    this.emit("sonic-fullscreen-change", this.getState());
    return true;
  }

  private stopSimulated(): void {
    const el = this.simulatedEl;
    if (!el) return;
    this.simulatedEl = null;
    document.removeEventListener("keydown", this.onKey, true);
    if (this.simulatedStyle === null) el.removeAttribute("style");
    else el.setAttribute("style", this.simulatedStyle);
    this.simulatedStyle = null;
    el.removeAttribute("data-fullscreen-simulated");
    document.documentElement.style.overflow = this.rootOverflow;
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
    const simulated = !!el && this.simulatedEl === el;
    const possible = supported || this.fallback !== "none";
    const keep = !clearError && !active && (this.state.status === "denied" || this.state.status === "error");
    this.patch({
      status: active ? "ready" : !possible ? "unsupported" : keep ? this.state.status : "idle",
      error: keep ? this.state.error : null,
      supported,
      allowed: policyAllows(this.feature),
      active,
      element: describeElement(simulated ? el : this.currentEl()),
      supportsVideoOnly: videoOnly,
      simulated,
    });
  }

  /** Reflète `active` sur l'hôte, et `aria-pressed` (+ `active` d'un sonic-button) sur les boutons. */
  protected patch(partial: Partial<FullscreenState>, force = true): void {
    super.patch(partial, force);
    const on = this.state.active;
    this.toggleAttribute("active", on);
    for (const b of this.buttons()) {
      b.setAttribute("aria-pressed", String(on));
      if (b.localName.endsWith("-button")) b.toggleAttribute("active", on);
    }
  }

  /** Boutons pilotés : enfants slottés et ids de `for`. */
  private buttons(): Element[] {
    const out = new Set<Element>(Array.from(this.children));
    const r = this.isConnected ? this.root() : null;
    for (const id of this.forIds()) {
      const b = r?.getElementById(id) ?? null;
      if (b) out.add(b);
    }
    return [...out];
  }

  private forIds(): string[] {
    return this.targets
      .split(/\s+/)
      .map((s) => s.replace(/^#/, ""))
      .filter(Boolean);
  }

  /** Clic sur le contenu slotté : bascule (sauf s'il vise déjà un id de `for`, géré par le socle). */
  private onHostClick = (e: Event): void => {
    if (e.target === this) return;
    const ids = this.forIds();
    if (ids.length && e.composedPath().some((n) => n instanceof Element && !!n.id && ids.includes(n.id))) return;
    void this.run("toggle");
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !this.simulatedEl) return;
    e.preventDefault();
    void this.exit();
  };

  render() {
    return html`<slot></slot>`;
  }

  private onChange = (): void => {
    // Vrai plein écran obtenu ailleurs : le simulé n'a plus lieu d'être.
    if (this.simulatedEl && this.currentEl()) this.stopSimulated();
    // Une sortie ou une entrée réussie efface l'erreur précédente.
    this.sync(true);
    this.emit("sonic-fullscreen-change", this.getState());
  };

  private onError = (): void => {
    // Refus déjà rattrapé par le plein écran simulé.
    if (this.simulatedEl) return;
    this.patch({ status: "denied", error: "plein écran refusé : geste de l'utilisateur requis ou interdit par la page hôte (allow=\"fullscreen\")", active: false });
  };
}

export default SonicFullscreen;
