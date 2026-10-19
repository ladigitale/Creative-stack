import { customElement, property } from "lit/decorators.js";
import { DeviceElement, policyAllows, type CommandMap, type DeviceBaseState } from "../../shared/device/base";

const tagName = "sonic-vibrate";

export type VibrateState = DeviceBaseState & {
  /** Vibrations demandées avec succès. */
  count: number;
};

const MAX_ITEMS = 20;
const MAX_MS = 5000;

/** `200`, `"200,100,200"` ou `[200, 100, 200]` → motif (durées alternées vibration / pause), borné. */
export function parsePattern(value: unknown): number[] {
  let items: unknown[] = [];
  if (typeof value === "number") items = [value];
  else if (typeof value === "string") items = value.split(/[\s,;]+/).filter(Boolean);
  else if (Array.isArray(value)) items = value;
  return items
    .slice(0, MAX_ITEMS)
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.min(MAX_MS, Math.max(0, Math.round(n))));
}

/**
 * Vibration (Vibration API) : retour haptique sur mobile Android (absente sous iOS : `supported: false`).
 *
 * - `pattern` : motif par défaut (`"200"` ou `"100,50,100"` : vibration, pause, vibration…).
 * - `control` (DP) : compteurs `{ vibrate: { n, pattern }, stop: n }` (`pattern` : nombre, texte ou liste).
 * - `for="bouton"` : le clic sur cet id fait vibrer (le navigateur exige un geste récent).
 * - État `<id>State` : `{ status, error, supported, allowed, active, count }` (`active` pendant le motif).
 *
 * Durées bornées (5 s par élément, 20 éléments). Un appel sans geste est ignoré par le navigateur : l'état passe en `denied`.
 */
@customElement(tagName)
export class SonicVibrate extends DeviceElement<VibrateState> {
  @property({ type: String }) pattern = "200";

  protected feature = "vibrate";
  protected readonly defaultCommand: string = "vibrate";
  protected state: VibrateState = { status: "idle", error: null, supported: false, allowed: "unknown", active: false, count: 0 };

  private endTimer: ReturnType<typeof setTimeout> | null = null;

  protected commands(): CommandMap {
    return { vibrate: (a) => this.vibrate(a.pattern), stop: () => this.stop() };
  }

  connectedCallback(): void {
    super.connectedCallback();
    const supported = typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
    this.patch({ supported, status: supported ? "idle" : "unsupported", allowed: policyAllows(this.feature) });
  }

  disconnectedCallback(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    if (this.state.active) navigator.vibrate?.(0);
    super.disconnectedCallback();
  }

  vibrate(pattern?: unknown): boolean {
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
      this.patch({ status: "unsupported", error: "vibration non disponible sur cet appareil", supported: false });
      return false;
    }
    const p = parsePattern(pattern ?? this.pattern);
    if (!p.length) {
      this.patch({ status: "error", error: "motif de vibration invalide" });
      return false;
    }
    const ok = navigator.vibrate(p);
    if (!ok) {
      this.patch({ status: "denied", error: "vibration refusée : geste récent requis ou interdit par la page hôte", active: false });
      return false;
    }
    if (this.endTimer) clearTimeout(this.endTimer);
    const total = p.reduce((a, b) => a + b, 0);
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      this.patch({ active: false, status: "idle" });
    }, total);
    this.patch({ status: "ready", error: null, active: true, count: this.state.count + 1 });
    return true;
  }

  stop(): boolean {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    navigator.vibrate?.(0);
    this.patch({ active: false, status: this.state.supported ? "idle" : "unsupported", error: null });
    return true;
  }
}

export default SonicVibrate;
