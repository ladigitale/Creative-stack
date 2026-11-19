import type { Pt } from "./homography";

/**
 * Direction « haut » (gravité) dans l'image caméra, repère y vers le bas, à partir de
 * l'accélération avec gravité (`ax`, `ay` de `sonic-orientation`, repère de l'appareil).
 *
 * Convention de la spécification (Android, Chrome) : appareil debout en portrait, `ay ≈ +9.8`
 * (réaction du support, dirigée vers le haut). iOS publie historiquement le signe inverse :
 * `ios` le corrige. L'image caméra suit l'écran : on tourne de `-screenAngle`.
 * Renvoie `null` quand le téléphone est presque à plat (pas de « haut » fiable dans l'image).
 */
export function upInImage(ax: unknown, ay: unknown, screenAngle: unknown = 0, ios = false): Pt | null {
  let x = Number(ax), y = Number(ay);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (ios) { x = -x || 0; y = -y || 0; }
  if (Math.hypot(x, y) < 3) return null;
  // Repère appareil (y vers le haut) → repère image (y vers le bas).
  let ix = x, iy = -y;
  const a = ((Number(screenAngle) || 0) * Math.PI) / 180;
  if (a) {
    const c = Math.cos(-a), s = Math.sin(-a);
    [ix, iy] = [c * ix - s * iy, s * ix + c * iy];
  }
  const l = Math.hypot(ix, iy);
  return { x: ix / l, y: iy / l };
}

/** iOS 13+ expose `DeviceMotionEvent.requestPermission` : sert de détection pour le signe. */
export function isIosMotion(): boolean {
  const D = (globalThis as { DeviceMotionEvent?: { requestPermission?: unknown } }).DeviceMotionEvent;
  return !!D && typeof D.requestPermission === "function";
}
