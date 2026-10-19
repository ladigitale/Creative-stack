import { customElement, property } from "lit/decorators.js";
import { DeviceElement, describeElement, policyAllows, type CommandMap, type DeviceBaseState } from "../../shared/device/base";

const tagName = "sonic-pointer-lock";

export type PointerLockState = DeviceBaseState & {
  /** Élément verrouillé (`canvas#vue`), `null` sinon. */
  element: string | null;
  /** Déplacement cumulé depuis la publication précédente (px). Remis à 0 quand la souris s'arrête. */
  dx: number;
  dy: number;
  /** Position virtuelle cumulée depuis le verrouillage (px), remise à 0 à chaque verrouillage ou `reset`. */
  x: number;
  y: number;
  /** Mouvement brut (sans accélération du système) effectivement obtenu. */
  raw: boolean;
};

type LockOptions = { unadjustedMovement?: boolean };
type LockEl = Element & { requestPointerLock?: (opts?: LockOptions) => Promise<void> | void };

/**
 * Pointer Lock : le curseur disparaît et la souris envoie des déplacements relatifs
 * (visée à la première personne, caméra orbitale, potentiomètre infini).
 *
 * - `target` : sélecteur CSS de l'élément verrouillé (défaut : `body`).
 * - `unadjusted-movement` : demande le mouvement brut ; repli automatique sans l'option (`raw: false`).
 * - `control` (DP) : compteurs `{ lock: n, unlock: n, toggle: n, reset: n }`.
 * - `for="bouton"` : le clic sur cet id bascule le verrou (le navigateur exige un geste).
 * - État `<id>State` : `{ status, error, supported, allowed, active, element, dx, dy, x, y, raw }`,
 *   publié au plus `rate` fois par seconde (`dx` / `dy` = somme depuis la publication précédente).
 * - Événements : `sonic-pointerlock-change` (état) et `sonic-pointerlock-move` (`{ dx, dy }`, à chaque mouvement).
 *
 * Échap rend toujours la souris ; un nouveau verrouillage est parfois refusé environ 1 s après. Dans une
 * iframe, l'hôte doit ajouter `allow-pointer-lock` à son `sandbox`.
 */
@customElement(tagName)
export class SonicPointerLock extends DeviceElement<PointerLockState> {
  @property({ type: String }) target = "";
  @property({ type: Boolean, attribute: "unadjusted-movement" }) unadjustedMovement = false;

  protected feature = null;
  protected state: PointerLockState = { status: "idle", error: null, supported: false, allowed: "unknown", active: false, element: null, dx: 0, dy: 0, x: 0, y: 0, raw: false };

  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  protected commands(): CommandMap {
    return { lock: () => this.lock(), unlock: () => this.unlock(), toggle: () => this.toggle(), reset: () => this.reset() };
  }

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("pointerlockchange", this.onChange);
    document.addEventListener("pointerlockerror", this.onError);
    document.addEventListener("mousemove", this.onMove);
    this.patch({ supported: this.canLock(this.targetEl()), status: this.canLock(this.targetEl()) ? "idle" : "unsupported", allowed: policyAllows(this.feature) });
  }

  disconnectedCallback(): void {
    document.removeEventListener("pointerlockchange", this.onChange);
    document.removeEventListener("pointerlockerror", this.onError);
    document.removeEventListener("mousemove", this.onMove);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.isLocked()) document.exitPointerLock?.();
    super.disconnectedCallback();
  }

  async lock(): Promise<boolean> {
    const el = this.targetEl() as LockEl | null;
    if (!el) {
      this.patch({ status: "error", error: "cible du verrouillage introuvable" });
      return false;
    }
    if (!this.canLock(el)) {
      this.patch({ status: "unsupported", error: "pointer lock non disponible ici", supported: false });
      return false;
    }
    if (document.pointerLockElement === el) return true;
    try {
      let raw = false;
      let awaited: boolean;
      if (this.unadjustedMovement) {
        try {
          awaited = await this.request(el, { unadjustedMovement: true });
          raw = true;
        } catch (e) {
          // Le brut n'est pas partout : repli sans l'option (hors refus de geste, qui se répéterait).
          if ((e as { name?: string })?.name !== "NotSupportedError") throw e;
          awaited = await this.request(el);
        }
      } else {
        awaited = await this.request(el);
      }
      this.state = { ...this.state, raw };
      // Avec une promesse, la réussite est connue ; sinon l'événement pointerlockchange (ou pointerlockerror) tranche.
      if (awaited) this.syncState(true);
      return true;
    } catch (e) {
      this.fail(e, "pointer lock");
      return false;
    }
  }

  async unlock(): Promise<boolean> {
    try {
      document.exitPointerLock?.();
      this.syncState(true);
      return true;
    } catch (e) {
      this.fail(e, "sortie du pointer lock");
      return false;
    }
  }

  toggle(): Promise<boolean> {
    return this.isLocked() ? this.unlock() : this.lock();
  }

  /** Remet la position cumulée à zéro. */
  reset(): boolean {
    this.patch({ x: 0, y: 0, dx: 0, dy: 0 });
    return true;
  }

  /** Retourne vrai si le navigateur a répondu par une promesse (sinon le résultat arrive par événement). */
  private async request(el: LockEl, opts?: LockOptions): Promise<boolean> {
    const ret = (opts ? el.requestPointerLock?.(opts) : el.requestPointerLock?.()) as unknown;
    if (ret && typeof (ret as Promise<void>).then === "function") {
      await (ret as Promise<void>);
      return true;
    }
    return false;
  }

  private targetEl(): Element | null {
    if (!this.target.trim()) return document.body;
    try {
      return document.querySelector(this.target);
    } catch {
      return null;
    }
  }

  private canLock(el: Element | null): boolean {
    return !!el && typeof (el as LockEl).requestPointerLock === "function";
  }

  private isLocked(): boolean {
    return !!document.pointerLockElement;
  }

  private syncState(clearError = false): void {
    const active = this.isLocked();
    const keep = !clearError && !active && (this.state.status === "denied" || this.state.status === "error");
    this.patch({
      status: !this.state.supported ? "unsupported" : active ? "ready" : keep ? this.state.status : "idle",
      error: keep ? this.state.error : null,
      active,
      element: describeElement(document.pointerLockElement),
      // Nouveau verrouillage : la position cumulée repart de zéro.
      ...(active && !this.state.active ? { x: 0, y: 0, dx: 0, dy: 0 } : {}),
    });
  }

  private onChange = (): void => {
    this.syncState(true);
    this.emit("sonic-pointerlock-change", this.getState());
  };

  private onError = (): void => {
    this.patch({ status: "denied", error: "pointer lock refusé : geste de l'utilisateur requis, refus récent (Échap) ou iframe sans allow-pointer-lock", active: false });
  };

  private onMove = (e: MouseEvent): void => {
    if (!this.isLocked()) return;
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    if (!dx && !dy) return;
    this.emit("sonic-pointerlock-move", { dx, dy });
    // Cumul dans l'état : la publication (plafonnée par `rate`) envoie la somme, rien n'est perdu.
    this.patch({ dx: this.state.dx + dx, dy: this.state.dy + dy, x: this.state.x + dx, y: this.state.y + dy }, false);
  };

  protected onPublished(): void {
    if (!this.state.dx && !this.state.dy) return;
    // Les deltas sont remis à zéro après envoi ; si la souris s'arrête, un dernier envoi publie ce zéro.
    this.state = { ...this.state, dx: 0, dy: 0 };
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.publish(true);
    }, 1000 / Math.max(1, Math.min(60, this.rate)) + 16);
  }
}

export default SonicPointerLock;
