/**
 * Renfort gyroscope de `sonic-anchor` : quand l'image ne permet plus de retrouver la zone (flou, mouvement rapide,
 * zone sortie du cadre), sa position est prédite à partir de la rotation du téléphone depuis le dernier repérage.
 *
 * Une rotation pure de la caméra déplace les points de l'image selon une homographie (K · R · K⁻¹) : il suffit de
 * l'orientation du téléphone (capteurs `deviceorientation`, état de `sonic-orientation`) et d'un champ de vision
 * approché. Les déplacements du téléphone (translation) ne sont pas vus : la prédiction ne vaut que quelques
 * instants, le temps que l'analyse d'image reprenne la main.
 */
import type { Pt } from "./homography";

export type Quat = [number, number, number, number]; // x, y, z, w

const D = Math.PI / 180;

function mul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function axis(x: number, y: number, z: number, deg: number): Quat {
  const h = (deg * D) / 2;
  const s = Math.sin(h);
  return [x * s, y * s, z * s, Math.cos(h)];
}

function conj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

function rotate(q: Quat, v: [number, number, number]): [number, number, number] {
  const r = mul(mul(q, [v[0], v[1], v[2], 0]), conj(q));
  return [r[0], r[1], r[2]];
}

/**
 * Orientation de l'écran dans le monde (W3C DeviceOrientation : Z-X'-Y'' intrinsèques, alpha autour de Z,
 * beta autour de X, gamma autour de Y), puis tournée de l'angle de l'écran (paysage) pour que les axes x / y
 * suivent l'image affichée.
 */
export function orientationQuat(alpha: number, beta: number, gamma: number, screenAngle = 0): Quat {
  const q = mul(mul(axis(0, 0, 1, alpha), axis(1, 0, 0, beta)), axis(0, 1, 0, gamma));
  return mul(q, axis(0, 0, 1, -screenAngle));
}

/** Orientation lue dans l'état de `sonic-orientation` (`alpha`, `beta`, `gamma`, `angle`), `null` sans capteurs. */
export function quatFromOrientation(v: unknown): Quat | null {
  const o = v as { alpha?: unknown; beta?: unknown; gamma?: unknown; angle?: unknown } | null;
  const a = Number(o?.alpha);
  const b = Number(o?.beta);
  const g = Number(o?.gamma);
  if (!o || o.alpha === null || o.beta === null || o.gamma === null || !Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(g)) return null;
  // ordinateur sans capteurs : zéros exacts
  if (a === 0 && b === 0 && g === 0) return null;
  return orientationQuat(a, b, g, Number(o.angle) || 0);
}

/**
 * Coins (0..1 de l'image) vus à l'orientation `q0`, ramenés à l'orientation `q1` (caméra arrière, rotation pure).
 * `fovH` : champ de vision horizontal de la caméra en degrés ; `aspect` = largeur / hauteur de l'image.
 * `null` si un coin passe derrière la caméra.
 */
export function rotateCorners(corners: Pt[], q0: Quat, q1: Quat, fovH: number, aspect: number): Pt[] | null {
  const W = 1;
  const H = 1 / Math.max(1e-3, aspect);
  const f = W / 2 / Math.tan((Math.max(10, Math.min(150, fovH)) * D) / 2);
  const rel = mul(conj(q1), q0); // repère écran à q0 → repère écran à q1
  const out: Pt[] = [];
  for (const p of corners) {
    // image (x droite, y bas, regard vers l'avant) → écran (x droite, y haut, z vers l'utilisateur)
    const x = (p.x - 0.5) * W;
    const y = (p.y - 0.5) * H;
    const d = rotate(rel, [x, -y, -f]);
    if (d[2] >= -1e-6) return null;
    const s = f / -d[2];
    out.push({ x: d[0] * s / W + 0.5, y: -d[1] * s / H + 0.5 });
  }
  return out;
}
