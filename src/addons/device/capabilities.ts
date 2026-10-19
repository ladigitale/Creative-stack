import { customElement } from "lit/decorators.js";
import { DeviceElement, policyAllows, type CommandMap, type DeviceBaseState } from "../../shared/device/base";

const tagName = "sonic-capabilities";

export type CapabilityPermission = "granted" | "denied" | "prompt" | "n/a" | "unknown";
export type Capability = {
  /** L'API existe dans ce navigateur. */
  supported: boolean;
  /** Autorisée par la Permissions Policy de la page hôte ; `"unknown"` si indétectable. */
  allowed: boolean | "unknown";
  /** État de la permission utilisateur ; `n/a` quand l'API n'en demande pas, `unknown` si le navigateur ne le dit pas. */
  permission: CapabilityPermission;
};

export const CAPABILITY_KEYS = [
  "fullscreen", "pointerLock", "wakeLock", "gamepad", "midi", "orientation", "clipboard", "share", "vibrate", "camera", "microphone", "audio", "screen",
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export type CapabilitiesState = DeviceBaseState & {
  /** La page tourne dans une iframe (artefact, aperçu). */
  embedded: boolean;
  /** Contexte sécurisé (https ou localhost) : requis par la plupart de ces API. */
  secureContext: boolean;
} & Record<CapabilityKey, Capability>;

/** Nom dans la Permissions Policy, et nom pour `navigator.permissions.query` (si l'API de permission existe). */
const META: Record<CapabilityKey, { policy: string | null; query: string | null }> = {
  fullscreen: { policy: "fullscreen", query: null },
  pointerLock: { policy: null, query: null },
  wakeLock: { policy: "screen-wake-lock", query: "screen-wake-lock" },
  gamepad: { policy: "gamepad", query: null },
  midi: { policy: "midi", query: "midi" },
  orientation: { policy: "gyroscope", query: "gyroscope" },
  clipboard: { policy: "clipboard-write", query: "clipboard-write" },
  share: { policy: "web-share", query: null },
  vibrate: { policy: "vibrate", query: null },
  camera: { policy: "camera", query: "camera" },
  microphone: { policy: "microphone", query: "microphone" },
  audio: { policy: null, query: null },
  screen: { policy: "display-capture", query: null },
};

type Nav = Navigator & { wakeLock?: unknown; requestMIDIAccess?: unknown; share?: unknown; vibrate?: unknown; getGamepads?: unknown };

/** Détection par présence de l'API, sans rien appeler qui ouvre une demande de permission. */
function detectSupport(): Record<CapabilityKey, boolean> {
  const n = (typeof navigator !== "undefined" ? navigator : {}) as Nav;
  const d = (typeof document !== "undefined" ? document : {}) as Document & { webkitFullscreenEnabled?: boolean };
  const w = (typeof window !== "undefined" ? window : {}) as Window & { webkitAudioContext?: unknown };
  return {
    fullscreen: !!(d.fullscreenEnabled ?? d.webkitFullscreenEnabled),
    pointerLock: typeof Element !== "undefined" && "requestPointerLock" in Element.prototype,
    wakeLock: "wakeLock" in n,
    gamepad: typeof n.getGamepads === "function",
    midi: typeof n.requestMIDIAccess === "function",
    orientation: (typeof screen !== "undefined" && !!screen.orientation) || typeof (w as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent !== "undefined",
    clipboard: !!n.clipboard,
    share: typeof n.share === "function",
    vibrate: typeof n.vibrate === "function",
    camera: !!n.mediaDevices?.getUserMedia,
    microphone: !!n.mediaDevices?.getUserMedia,
    audio: typeof (w as { AudioContext?: unknown }).AudioContext !== "undefined" || typeof w.webkitAudioContext !== "undefined",
    screen: !!n.mediaDevices?.getDisplayMedia,
  };
}

/**
 * Ce que l'environnement autorise, en un seul DataProvider : pour chaque fonction (`fullscreen`, `pointerLock`,
 * `wakeLock`, `gamepad`, `midi`, `orientation`, `clipboard`, `share`, `vibrate`, `camera`, `microphone`, `audio`,
 * `screen`) : `{ supported, allowed, permission }`, plus `embedded` (iframe) et `secureContext`.
 *
 * Aucune demande de permission n'est déclenchée : détection par présence de l'API, lecture de la Permissions
 * Policy de la page et `navigator.permissions.query` quand le navigateur connaît le nom. Un artefact lit
 * `capabilities.wakeLock.supported`, ou un `sonic-if`, pour dégrader proprement.
 *
 * - État `<id>State` (ou `out-data-provider`) : `{ status: "ready", embedded, secureContext, fullscreen: {…}, … }`.
 * - `control` (DP) : compteur `{ refresh: n }` pour relire (les permissions bougent aussi seules, par événement).
 */
@customElement(tagName)
export class SonicCapabilities extends DeviceElement<CapabilitiesState> {
  protected feature = null;
  protected state: CapabilitiesState = initial();

  private watched: { status: PermissionStatus; handler: () => void }[] = [];
  private token = 0;

  protected commands(): CommandMap {
    return { refresh: () => this.refresh() };
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
  }

  disconnectedCallback(): void {
    this.unwatch();
    this.token++;
    super.disconnectedCallback();
  }

  /** Relit les capacités (public pour les tests). */
  async refresh(): Promise<boolean> {
    const mine = ++this.token;
    const support = detectSupport();
    const next = initial();
    for (const key of CAPABILITY_KEYS) {
      next[key] = { supported: support[key], allowed: policyAllows(META[key].policy), permission: META[key].query ? "unknown" : "n/a" };
    }
    next.embedded = typeof window !== "undefined" && window.self !== window.top;
    next.secureContext = typeof window !== "undefined" && window.isSecureContext !== false;
    this.state = next;
    this.publish(true);

    // Permissions : lecture sans demande ; un nom inconnu du navigateur reste `unknown`.
    const perms = typeof navigator !== "undefined" ? navigator.permissions : undefined;
    if (perms?.query) {
      this.unwatch();
      const done = await Promise.all(
        CAPABILITY_KEYS.filter((k) => META[k].query && support[k]).map(async (key) => {
          try {
            const status = await perms.query({ name: META[key].query as PermissionName });
            return { key, status };
          } catch {
            return null;
          }
        }),
      );
      if (mine !== this.token) return true;
      const caps: Partial<Record<CapabilityKey, Capability>> = {};
      for (const r of done) {
        if (!r) continue;
        caps[r.key] = { ...next[r.key], permission: r.status.state as CapabilityPermission };
        const handler = () => void this.refresh();
        r.status.addEventListener?.("change", handler);
        this.watched.push({ status: r.status, handler });
      }
      this.state = { ...this.state, ...caps };
      this.publish(true);
    }
    return true;
  }

  private unwatch(): void {
    for (const { status, handler } of this.watched) status.removeEventListener?.("change", handler);
    this.watched = [];
  }
}

function initial(): CapabilitiesState {
  const blank: Capability = { supported: false, allowed: "unknown", permission: "n/a" };
  const caps = Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, { ...blank }])) as Record<CapabilityKey, Capability>;
  return { status: "ready", error: null, supported: true, allowed: true, active: true, embedded: false, secureContext: true, ...caps };
}

export default SonicCapabilities;
