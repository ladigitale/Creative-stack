/**
 * Stylets : lecture normalisée d'un PointerEvent et comportements standard des applications de dessin.
 *
 * - bout gomme (Wacom, Surface Pen…) : `buttons & 32` (ou `button === 5`) ;
 * - bouton latéral : `button === 2` / `buttons & 2` ;
 * - inclinaison : `altitudeAngle` / `azimuthAngle` (Safari, Chrome récents), sinon déduite de `tiltX` / `tiltY` ;
 * - rotation du stylet (`twist`, 0..359°) quand le matériel la donne ;
 * - rejet de la paume : une fois un stylet vu, un doigt seul ne dessine plus (il déplace la vue).
 */

export type PenSample = {
  pointerType: string;
  /** Pression 0..1 (1 pour la souris et le doigt). */
  pressure: number;
  /** Inclinaison : 0 = stylet couché, π/2 = vertical. */
  altitude: number;
  /** Direction de l'inclinaison dans le plan de l'écran (radians, 0 = vers la droite, sens horaire). */
  azimuth: number;
  /** L'inclinaison est-elle connue (stylet qui la donne) ? */
  hasTilt: boolean;
  /** Rotation du stylet sur lui-même (°), quand le matériel la donne. */
  twist: number | null;
  /** Pression tangentielle (molette d'aérographe), -1..1. */
  tangential: number;
  eraser: boolean;
  barrel: boolean;
};

const HALF_PI = Math.PI / 2;

/** Azimut et altitude à partir de tiltX / tiltY (degrés, -90..90). */
export function tiltToSpherical(tiltX: number, tiltY: number): { azimuth: number; altitude: number } {
  if (!tiltX && !tiltY) return { azimuth: 0, altitude: HALF_PI };
  const tx = Math.tan((tiltX * Math.PI) / 180), ty = Math.tan((tiltY * Math.PI) / 180);
  const azimuth = Math.atan2(ty, tx);
  const altitude = Math.atan(1 / Math.hypot(tx, ty));
  return { azimuth: azimuth < 0 ? azimuth + 2 * Math.PI : azimuth, altitude };
}

export function readPen(e: PointerEvent): PenSample {
  const pen = e.pointerType === "pen";
  const ev = e as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
  let altitude = HALF_PI, azimuth = 0, hasTilt = false;
  if (pen) {
    if (typeof ev.altitudeAngle === "number" && typeof ev.azimuthAngle === "number" && (ev.altitudeAngle !== HALF_PI || ev.azimuthAngle !== 0)) {
      altitude = ev.altitudeAngle; azimuth = ev.azimuthAngle; hasTilt = true;
    } else if (e.tiltX || e.tiltY) {
      ({ altitude, azimuth } = tiltToSpherical(e.tiltX || 0, e.tiltY || 0)); hasTilt = true;
    }
  }
  const twist = pen && typeof e.twist === "number" && e.twist > 0 ? e.twist : null;
  return {
    pointerType: e.pointerType,
    pressure: pen ? (e.pressure > 0 ? e.pressure : 0.5) : 1,
    altitude, azimuth, hasTilt, twist,
    tangential: pen && typeof e.tangentialPressure === "number" ? e.tangentialPressure : 0,
    eraser: pen && ((e.buttons & 32) !== 0 || e.button === 5),
    barrel: pen && ((e.buttons & 2) !== 0 || e.button === 2),
  };
}

/** Courbe de pression : `min + (1 - min) · p^gamma` (gamma > 1 : plus doux, < 1 : plus ferme). */
export function pressureCurve(p: number, gamma = 1, min = 0): number {
  const g = Number.isFinite(gamma) && gamma > 0 ? Math.min(5, Math.max(0.2, gamma)) : 1;
  const m = Number.isFinite(min) ? Math.min(0.95, Math.max(0, min)) : 0;
  const q = Math.min(1, Math.max(0, p));
  return m + (1 - m) * Math.pow(q, g);
}

/**
 * Pression simulée par la vitesse (souris, doigt) : lent = appuyé, rapide = léger, lissée pour éviter les
 * à-coups. `speed` : vitesse (px/ms) à laquelle la pression tombe au minimum.
 */
export class VelocityPressure {
  private last: { x: number; y: number; t: number } | null = null;
  private value = 1;
  constructor(private speed = 2.5, private min = 0.3, private smoothing = 0.75) {}
  reset(): void { this.last = null; this.value = 1; }
  feed(x: number, y: number, t: number): number {
    const l = this.last;
    this.last = { x, y, t };
    if (!l) { this.value = 1; return this.value; }
    const dt = Math.max(1, t - l.t);
    const v = Math.hypot(x - l.x, y - l.y) / dt;
    const target = Math.max(this.min, 1 - (1 - this.min) * Math.min(1, v / this.speed));
    this.value = this.value * this.smoothing + target * (1 - this.smoothing);
    return this.value;
  }
}

export type TouchMode = "draw" | "navigate" | "auto";

/** Rejet de la paume : en `auto`, dès qu'un stylet a servi, un doigt seul déplace la vue au lieu de dessiner. */
export class PalmGuard {
  private penSeen = false;
  constructor(public mode: TouchMode = "auto") {}
  note(e: PointerEvent): void { if (e.pointerType === "pen") this.penSeen = true; }
  /** Ce contact doit-il servir à la navigation plutôt qu'au dessin ? */
  navigates(e: PointerEvent): boolean {
    if (e.pointerType !== "touch") return false;
    return this.mode === "navigate" || (this.mode === "auto" && this.penSeen);
  }
  get pen(): boolean { return this.penSeen; }
}

export const sanitizeTouchMode = (v: unknown): TouchMode => (v === "draw" || v === "navigate" ? v : "auto");
