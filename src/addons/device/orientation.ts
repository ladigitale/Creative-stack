import { customElement, property } from "lit/decorators.js";
import { DeviceElement, type CommandMap, type DeviceBaseState } from "../../shared/device/base";

const tagName = "sonic-orientation";

export type OrientationState = DeviceBaseState & {
  /** Orientation de l'écran : `portrait-primary`, `landscape-secondary`… */
  type: string | null;
  /** Rotation de l'écran en degrés (0, 90, 180, 270). */
  angle: number | null;
  /** Orientation verrouillée par `lock`. */
  locked: boolean;
  /** Capteurs de mouvement en écoute. */
  sensors: boolean;
  /** Permission des capteurs : `n/a` (pas de demande nécessaire), `prompt`, `granted`, `denied`. */
  permission: "n/a" | "prompt" | "granted" | "denied";
  /** Orientation de l'appareil (degrés) : alpha 0..360 (boussole), beta -180..180 (avant/arrière), gamma -90..90 (gauche/droite). */
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  /** Accélération avec gravité (m/s²). */
  ax: number | null;
  ay: number | null;
  az: number | null;
  /** Vitesse de rotation (°/s). */
  ra: number | null;
  rb: number | null;
  rg: number | null;
};

type PermissionApi = { requestPermission?: () => Promise<"granted" | "denied"> };
type LockableOrientation = ScreenOrientation & { lock?: (type: string) => Promise<void>; unlock?: () => void };

const VALID_LOCKS = ["any", "natural", "landscape", "portrait", "portrait-primary", "portrait-secondary", "landscape-primary", "landscape-secondary"];
const SENSOR_KEYS = ["alpha", "beta", "gamma", "ax", "ay", "az", "ra", "rb", "rg"] as const;

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Orientation de l'écran (lecture, verrouillage) et capteurs de mouvement (inclinaison, accélération).
 *
 * - `sensors` : écoute les capteurs dès que possible. Sous iOS, la permission exige un geste : utiliser
 *   `for="bouton"` (clic direct) ou le compteur `control.sensors`.
 * - `smoothing` : lissage 0..0.95 des valeurs des capteurs (0 = brut).
 * - `control` (DP) : compteurs `{ lock: { n, type }, unlock: n, sensors: n, stop: n }`
 *   (`type` : `landscape`, `portrait`, `natural`, `any`…).
 * - État `<id>State` : `{ status, error, supported, allowed, active, type, angle, locked, sensors, permission,
 *   alpha, beta, gamma, ax, ay, az, ra, rb, rg }`, plafonné à `rate` publications par seconde. Valeurs `null`
 *   tant que l'appareil n'en envoie pas (ordinateur de bureau).
 *
 * Le verrouillage d'orientation exige souvent le plein écran sur mobile (`sonic-fullscreen`). Dans une iframe,
 * l'hôte doit autoriser `accelerometer; gyroscope; magnetometer`.
 */
@customElement(tagName)
export class SonicOrientation extends DeviceElement<OrientationState> {
  @property({ type: Boolean }) sensors = false;
  @property({ type: Number }) smoothing = 0;

  protected feature = "gyroscope";
  protected readonly defaultCommand: string = "sensors";
  protected state: OrientationState = {
    status: "idle", error: null, supported: false, allowed: "unknown", active: false,
    type: null, angle: null, locked: false, sensors: false, permission: "n/a",
    alpha: null, beta: null, gamma: null, ax: null, ay: null, az: null, ra: null, rb: null, rg: null,
  };

  private listening = false;

  protected commands(): CommandMap {
    return {
      lock: (a) => this.lock(typeof a.type === "string" ? a.type : "landscape"),
      unlock: () => this.unlock(),
      sensors: () => this.startSensors(),
      stop: () => this.stopSensors(),
    };
  }

  connectedCallback(): void {
    super.connectedCallback();
    const so = this.screenOrientation();
    so?.addEventListener?.("change", this.onScreenChange);
    const supported = !!so || typeof window.DeviceOrientationEvent !== "undefined";
    this.patch({ supported, status: supported ? "idle" : "unsupported", type: so?.type ?? null, angle: so?.angle ?? null });
    if (this.sensors && supported) void this.startSensors();
  }

  disconnectedCallback(): void {
    this.screenOrientation()?.removeEventListener?.("change", this.onScreenChange);
    this.detach();
    super.disconnectedCallback();
  }

  async lock(type = "landscape"): Promise<boolean> {
    const so = this.screenOrientation() as LockableOrientation | null;
    if (!so || typeof so.lock !== "function") {
      this.patch({ status: "unsupported", error: "verrouillage d'orientation non disponible ici" });
      return false;
    }
    if (!VALID_LOCKS.includes(type)) {
      this.patch({ status: "error", error: `orientation « ${type} » inconnue (${VALID_LOCKS.join(", ")})` });
      return false;
    }
    try {
      await so.lock(type);
      this.patch({ locked: true, status: "ready", error: null, active: true });
      return true;
    } catch (e) {
      const name = (e as { name?: string })?.name;
      // Sur mobile le verrou n'est accordé qu'en plein écran : message dédié.
      if (name === "SecurityError" || name === "NotAllowedError") {
        this.patch({ status: "denied", error: "verrouillage d'orientation refusé : passer en plein écran d'abord (sonic-fullscreen), ou interdit par la page hôte", locked: false });
      } else {
        this.fail(e, "verrouillage d'orientation");
      }
      return false;
    }
  }

  unlock(): boolean {
    const so = this.screenOrientation() as LockableOrientation | null;
    try {
      so?.unlock?.();
      this.patch({ locked: false, active: this.state.sensors, status: this.state.sensors ? "ready" : "idle" });
      return true;
    } catch (e) {
      this.fail(e, "déverrouillage d'orientation");
      return false;
    }
  }

  /** Démarre les capteurs. Sous iOS, à appeler directement dans un geste (la demande de permission passe en premier). */
  async startSensors(): Promise<boolean> {
    if (typeof window.DeviceOrientationEvent === "undefined" && typeof window.DeviceMotionEvent === "undefined") {
      this.patch({ status: "unsupported", error: "capteurs de mouvement non disponibles ici", supported: !!this.screenOrientation() });
      return false;
    }
    if (this.listening) return true;
    try {
      const doe = window.DeviceOrientationEvent as unknown as PermissionApi | undefined;
      const dme = window.DeviceMotionEvent as unknown as PermissionApi | undefined;
      const asks = [doe?.requestPermission, dme?.requestPermission].filter((f): f is () => Promise<"granted" | "denied"> => typeof f === "function");
      if (asks.length) {
        // Les deux demandes partent dans la même pile d'appels que le geste (contrainte iOS).
        const results = await Promise.all([doe?.requestPermission?.call(doe), dme?.requestPermission?.call(dme)].filter(Boolean) as Promise<string>[]);
        if (results.some((r) => r !== "granted")) {
          this.patch({ permission: "denied", status: "denied", error: "capteurs refusés par l'utilisateur", sensors: false });
          return false;
        }
        this.patch({ permission: "granted" });
      }
      window.addEventListener("deviceorientation", this.onDeviceOrientation);
      window.addEventListener("devicemotion", this.onDeviceMotion);
      this.listening = true;
      this.patch({ sensors: true, active: true, status: "ready", error: null });
      return true;
    } catch (e) {
      this.fail(e, "capteurs");
      return false;
    }
  }

  stopSensors(): boolean {
    this.detach();
    const nulls = Object.fromEntries(SENSOR_KEYS.map((k) => [k, null])) as Partial<OrientationState>;
    this.patch({ ...nulls, sensors: false, active: this.state.locked, status: this.state.locked ? "ready" : "idle" });
    return true;
  }

  private detach(): void {
    window.removeEventListener("deviceorientation", this.onDeviceOrientation);
    window.removeEventListener("devicemotion", this.onDeviceMotion);
    this.listening = false;
  }

  private screenOrientation(): ScreenOrientation | null {
    return typeof screen !== "undefined" && screen.orientation ? screen.orientation : null;
  }

  private onScreenChange = (): void => {
    const so = this.screenOrientation();
    this.patch({ type: so?.type ?? null, angle: so?.angle ?? null });
  };

  /** Lissage exponentiel ; la première valeur passe telle quelle. Les angles ne sont pas lissés à travers 0/360 (alpha). */
  private smooth(key: (typeof SENSOR_KEYS)[number], value: number | null | undefined): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const prev = this.state[key];
    const s = Math.min(0.95, Math.max(0, this.smoothing));
    if (typeof prev !== "number" || s === 0) return r1(value);
    if (key === "alpha") {
      // Plus court chemin sur le cercle.
      let d = value - prev;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      return r1((prev + d * (1 - s) + 360) % 360);
    }
    return r1(prev + (value - prev) * (1 - s));
  }

  private onDeviceOrientation = (e: DeviceOrientationEvent): void => {
    this.patch({ alpha: this.smooth("alpha", e.alpha), beta: this.smooth("beta", e.beta), gamma: this.smooth("gamma", e.gamma) }, false);
  };

  private onDeviceMotion = (e: DeviceMotionEvent): void => {
    const a = e.accelerationIncludingGravity;
    const r = e.rotationRate;
    this.patch(
      {
        ax: this.smooth("ax", a?.x), ay: this.smooth("ay", a?.y), az: this.smooth("az", a?.z),
        ra: this.smooth("ra", r?.alpha), rb: this.smooth("rb", r?.beta), rg: this.smooth("rg", r?.gamma),
      },
      false,
    );
  };
}

export default SonicOrientation;
