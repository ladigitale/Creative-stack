import { customElement, property } from "lit/decorators.js";
import { DeviceElement, policyAllows, type CommandMap, type DeviceBaseState } from "../../shared/device/base";

const tagName = "sonic-wake-lock";

export type WakeLockState = DeviceBaseState & {
  /** L'utilisateur (ou `auto`) veut garder l'écran allumé ; `active` dit si le verrou est réellement tenu. */
  wanted: boolean;
  /** Nombre de réacquisitions après une perte (onglet masqué puis revenu). */
  reacquired: number;
};

type Sentinel = { released: boolean; release(): Promise<void>; addEventListener(type: "release", handler: () => void): void };
type WakeLockApi = { request(type: "screen"): Promise<Sentinel> };

/**
 * Wake Lock : empêche la mise en veille de l'écran (séquenceur, live, présentation, jeu).
 *
 * - `auto` : tente de prendre le verrou au chargement ; s'il est refusé, nouvelle tentative au premier geste.
 * - `control` (DP) : compteurs `{ acquire: n, release: n, toggle: n }`.
 * - `for="bouton"` : le clic sur cet id bascule le verrou.
 * - État `<id>State` : `{ status, error, supported, allowed, active, wanted, reacquired }`.
 *
 * Le navigateur relâche le verrou quand l'onglet passe en arrière-plan : tant que l'intention
 * (`wanted`) reste, il est repris au retour de l'onglet. Dans une iframe, l'hôte doit autoriser
 * `allow="screen-wake-lock"`.
 */
@customElement(tagName)
export class SonicWakeLock extends DeviceElement<WakeLockState> {
  /** Prend le verrou dès que possible. */
  @property({ type: Boolean }) auto = false;

  protected feature = "screen-wake-lock";
  protected state: WakeLockState = { status: "idle", error: null, supported: false, allowed: "unknown", active: false, wanted: false, reacquired: 0 };

  private sentinel: Sentinel | null = null;
  private busy = false;
  private heldBefore = false;

  protected commands(): CommandMap {
    return { acquire: () => this.acquire(), release: () => this.release(), toggle: () => this.toggle() };
  }

  private api(): WakeLockApi | null {
    const w = typeof navigator !== "undefined" ? (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock : undefined;
    return w && typeof w.request === "function" ? w : null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.onVisibility);
    const supported = !!this.api();
    this.patch({ supported, status: supported ? "idle" : "unsupported", allowed: policyAllows(this.feature) });
    if (this.auto && supported) {
      void this.acquire().then((ok) => {
        // Refusé sans geste : on réessaie une fois au premier appui.
        if (!ok && this.isConnected) window.addEventListener("pointerdown", this.onFirstGesture, { once: true, capture: true });
      });
    }
  }

  disconnectedCallback(): void {
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pointerdown", this.onFirstGesture, true);
    const s = this.sentinel;
    this.sentinel = null;
    this.state = { ...this.state, wanted: false };
    void s?.release().catch(() => undefined);
    super.disconnectedCallback();
  }

  async acquire(): Promise<boolean> {
    const api = this.api();
    if (!api) {
      this.patch({ status: "unsupported", error: "wake lock non disponible dans ce navigateur", supported: false });
      return false;
    }
    this.patch({ wanted: true });
    if (this.sentinel && !this.sentinel.released) return true;
    // Onglet masqué : refusé par le navigateur ; l'intention reste, la reprise se fait au retour.
    if (document.visibilityState === "hidden") return false;
    if (this.busy) return false;
    this.busy = true;
    try {
      const sentinel = await api.request("screen");
      sentinel.addEventListener("release", () => this.onReleased(sentinel));
      this.sentinel = sentinel;
      // Si l'utilisateur a relâché pendant l'attente, on rend le verrou aussitôt.
      if (!this.state.wanted) {
        await sentinel.release();
        return false;
      }
      const again = this.heldBefore;
      this.heldBefore = true;
      this.patch({ status: "ready", error: null, active: true, reacquired: this.state.reacquired + (again ? 1 : 0) });
      return true;
    } catch (e) {
      this.fail(e, "wake lock");
      return false;
    } finally {
      this.busy = false;
    }
  }

  async release(): Promise<boolean> {
    const s = this.sentinel;
    this.sentinel = null;
    this.heldBefore = false;
    this.patch({ wanted: false, active: false, status: this.state.supported ? "idle" : "unsupported", error: null });
    try {
      await s?.release();
      return true;
    } catch (e) {
      this.fail(e, "wake lock");
      return false;
    }
  }

  toggle(): Promise<boolean> {
    return this.state.wanted ? this.release() : this.acquire();
  }

  /** Le navigateur a repris le verrou (onglet masqué, batterie faible…). */
  private onReleased(sentinel: Sentinel): void {
    if (this.sentinel !== sentinel) return;
    this.sentinel = null;
    this.patch({ active: false, status: "idle" });
  }

  private onVisibility = (): void => {
    if (document.visibilityState === "visible" && this.state.wanted && !this.sentinel) void this.acquire();
  };

  private onFirstGesture = (): void => {
    if (!this.state.active) void this.acquire();
  };
}

export default SonicWakeLock;
