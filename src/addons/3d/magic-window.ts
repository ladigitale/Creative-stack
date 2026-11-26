import * as THREE from "three";
import type { Sonic3dXrHost } from "./3d";

/**
 * « Fenêtre magique » : regarder autour de soi dans une scène `sonic-3d`, sans casque ni WebXR.
 *
 * La caméra est posée au centre de la scène, à hauteur des yeux, et tourne avec le téléphone
 * (capteurs d'orientation, `deviceorientation`) ; sans capteurs (ordinateur), glisser le doigt ou la
 * souris tourne la vue. Marche partout, iPhone compris (permission des capteurs demandée dans le geste).
 */

/** Orientation de l'appareil (degrés) → quaternion de caméra three.js (repère écran, comme DeviceOrientationControls). */
export function deviceQuaternion(alpha: number, beta: number, gamma: number, screenAngle: number, out = new THREE.Quaternion()): THREE.Quaternion {
  const d = THREE.MathUtils.DEG2RAD;
  const euler = new THREE.Euler(beta * d, alpha * d, -gamma * d, "YXZ");
  out.setFromEuler(euler);
  // la caméra regarde le long de -Z, l'appareil le long de son dos : -90° autour de X
  out.multiply(new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2));
  // orientation de l'écran (paysage)
  out.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -screenAngle * d));
  return out;
}

/** Cap (rad, autour de Y) vers lequel regarde un quaternion de caméra. */
export function headingOf(q: THREE.Quaternion): number {
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  return Math.atan2(-dir.x, -dir.z);
}

/** Position de l'œil : centre de la boîte au sol + hauteur des yeux (bornée par la hauteur de la scène). */
export function eyePosition(bounds: { center: [number, number, number]; min: [number, number, number]; max: [number, number, number] } | null, eye = 1.6): [number, number, number] {
  if (!bounds) return [0, eye, 0];
  const h = bounds.max[1] - bounds.min[1];
  const y = bounds.min[1] + Math.min(eye, Math.max(0.1, h * 0.64));
  return [bounds.center[0], y, bounds.center[2]];
}

type OrientationEvt = { alpha: number | null; beta: number | null; gamma: number | null };
type PermissionCtor = { requestPermission?: () => Promise<"granted" | "denied"> };

/** Demande la permission des capteurs (iOS 13+) : à appeler DANS le geste. Ailleurs : accordé d'office. */
export function requestOrientationPermission(): Promise<boolean> {
  const ctor = (typeof window !== "undefined" ? (window as unknown as { DeviceOrientationEvent?: PermissionCtor }).DeviceOrientationEvent : undefined) ?? undefined;
  if (!ctor || typeof ctor.requestPermission !== "function") return Promise.resolve(true);
  try {
    return ctor.requestPermission().then(
      (r) => r === "granted",
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

export class MagicWindow {
  /** Les capteurs ont donné au moins une mesure. */
  sensors = false;
  private yaw = 0;
  private pitch = 0;
  private yawOffset: number | null = null;
  private device: THREE.Quaternion | null = null;
  private raf = 0;
  private drag: { id: number; x: number; y: number } | null = null;
  private running = false;

  constructor(
    private host: Sonic3dXrHost,
    private el: HTMLElement,
    private eye = 1.6,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const cam = this.host.camera as THREE.PerspectiveCamera;
    // cap de départ = celui de la vue actuelle : on regarde la scène là où on la regardait
    this.yaw = headingOf(cam.quaternion);
    this.pitch = 0;
    this.host.pause();
    cam.position.set(...eyePosition(this.host.bounds(), this.eye));
    if (cam.isPerspectiveCamera && cam.fov < 60) {
      cam.fov = 70;
      cam.updateProjectionMatrix();
    }
    window.addEventListener("deviceorientation", this.onOrientation);
    this.el.addEventListener("pointerdown", this.onDown);
    this.el.addEventListener("pointermove", this.onMove);
    this.el.addEventListener("pointerup", this.onUp);
    this.el.addEventListener("pointercancel", this.onUp);
    this.el.style.touchAction = "none";
    this.tick();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("deviceorientation", this.onOrientation);
    this.el.removeEventListener("pointerdown", this.onDown);
    this.el.removeEventListener("pointermove", this.onMove);
    this.el.removeEventListener("pointerup", this.onUp);
    this.el.removeEventListener("pointercancel", this.onUp);
    this.el.style.touchAction = "";
    this.host.resume();
  }

  /** Orientation de caméra pour l'image courante (public pour les tests). */
  orientation(out = new THREE.Quaternion()): THREE.Quaternion {
    if (this.device) {
      // cap des capteurs recalé sur la vue de départ, puis le glisser ajoute son propre cap
      const yawFix = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (this.yawOffset ?? 0) + this.yaw);
      return out.copy(yawFix).multiply(this.device);
    }
    return out.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
  }

  private tick = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    const cam = this.host.camera;
    this.orientation(cam.quaternion);
    cam.updateMatrixWorld();
    this.host.render();
  };

  private onOrientation = (e: Event): void => {
    const { alpha, beta, gamma } = e as unknown as OrientationEvt;
    if (alpha === null || beta === null || gamma === null) return;
    // ordinateur sans capteurs : certains navigateurs envoient des zéros exacts, jamais un vrai téléphone
    if (!this.device && alpha === 0 && beta === 0 && gamma === 0) return;
    const angle = (typeof screen !== "undefined" && screen.orientation?.angle) || (window as unknown as { orientation?: number }).orientation || 0;
    const q = deviceQuaternion(alpha, beta, gamma, Number(angle) || 0);
    if (this.yawOffset === null) {
      // première mesure : le téléphone regarde dans la direction de la vue de départ
      this.yawOffset = 0 - headingOf(q);
      this.yaw = headingOf(this.host.camera.quaternion);
    }
    this.device = q;
    this.sensors = true;
  };

  private onDown = (e: PointerEvent): void => {
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom */
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    const k = Math.PI / Math.max(200, this.el.clientWidth || 600);
    this.yaw += dx * k;
    // avec les capteurs, le glisser ne fait que tourner autour de soi
    if (!this.device) this.pitch = THREE.MathUtils.clamp(this.pitch + dy * k, -1.4, 1.4);
  };

  private onUp = (): void => {
    this.drag = null;
  };
}
