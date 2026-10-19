import { customElement } from "lit/decorators.js";
import { DeviceElement, type CommandMap, type DeviceBaseState } from "../../shared/device/base";

const tagName = "sonic-page-state";

export type PageStateValue = DeviceBaseState & {
  /** Onglet visible (`false` : en arrière-plan, rendu et son à suspendre). */
  visible: boolean;
  /** La page a le focus clavier. */
  focused: boolean;
  online: boolean;
  /** Taille de la fenêtre (px CSS). */
  width: number;
  height: number;
  /** Densité de pixels (devicePixelRatio). */
  dpr: number;
  /** L'utilisateur demande moins d'animations. */
  reducedMotion: boolean;
  colorScheme: "light" | "dark";
  /** Pointeur principal tactile (doigt) plutôt que souris. */
  touch: boolean;
  /** Le pointeur principal peut survoler. */
  hover: boolean;
};

const QUERIES = {
  reducedMotion: "(prefers-reduced-motion: reduce)",
  dark: "(prefers-color-scheme: dark)",
  touch: "(pointer: coarse)",
  hover: "(hover: hover)",
} as const;

/**
 * État de la page, en DataProvider : visibilité de l'onglet, focus, connexion, taille, densité de pixels,
 * préférences (mouvement réduit, thème sombre), type de pointeur.
 *
 * Sert à suspendre le rendu, le son ou les boucles quand `visible` vaut `false`, et à adapter une scène
 * au tactile ou au thème sans écrire de JS.
 *
 * - État `<id>State` : `{ status, error, supported, allowed, active, visible, focused, online, width, height, dpr,
 *   reducedMotion, colorScheme, touch, hover }` (`active` = `visible`), plafonné à `rate` publications par seconde.
 * - Aucune commande, aucune permission, aucune demande au navigateur.
 */
@customElement(tagName)
export class SonicPageState extends DeviceElement<PageStateValue> {
  protected feature = null;
  protected state: PageStateValue = {
    status: "ready", error: null, supported: true, allowed: true, active: true,
    visible: true, focused: true, online: true, width: 0, height: 0, dpr: 1,
    reducedMotion: false, colorScheme: "light", touch: false, hover: true,
  };

  private mqls: { mql: MediaQueryList; handler: () => void }[] = [];

  protected commands(): CommandMap {
    return {};
  }

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.read);
    window.addEventListener("focus", this.read);
    window.addEventListener("blur", this.read);
    window.addEventListener("online", this.read);
    window.addEventListener("offline", this.read);
    window.addEventListener("resize", this.read);
    if (typeof window.matchMedia === "function") {
      for (const q of Object.values(QUERIES)) {
        const mql = window.matchMedia(q);
        mql.addEventListener?.("change", this.read);
        this.mqls.push({ mql, handler: this.read });
      }
    }
    this.read(true);
  }

  disconnectedCallback(): void {
    document.removeEventListener("visibilitychange", this.read);
    window.removeEventListener("focus", this.read);
    window.removeEventListener("blur", this.read);
    window.removeEventListener("online", this.read);
    window.removeEventListener("offline", this.read);
    window.removeEventListener("resize", this.read);
    for (const { mql, handler } of this.mqls) mql.removeEventListener?.("change", handler);
    this.mqls = [];
    super.disconnectedCallback();
  }

  private media(q: string, fallback: boolean): boolean {
    return typeof window.matchMedia === "function" ? window.matchMedia(q).matches : fallback;
  }

  /** Relit la page (public pour les tests). */
  read = (arg?: unknown): void => {
    const visible = document.visibilityState !== "hidden";
    this.patch(
      {
        visible,
        active: visible,
        focused: typeof document.hasFocus === "function" ? document.hasFocus() : true,
        online: typeof navigator.onLine === "boolean" ? navigator.onLine : true,
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
        reducedMotion: this.media(QUERIES.reducedMotion, false),
        colorScheme: this.media(QUERIES.dark, false) ? "dark" : "light",
        touch: this.media(QUERIES.touch, false),
        hover: this.media(QUERIES.hover, true),
      },
      // Le premier relevé et un changement de visibilité partent tout de suite ; le redimensionnement est plafonné.
      arg === true || document.visibilityState === "hidden" || !this.state.visible,
    );
  };
}

export default SonicPageState;
