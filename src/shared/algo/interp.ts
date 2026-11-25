/**
 * Interpolation et « sensation de jeu » : lerp, remap, courbes d'accélération (famille de Penner), amortissement
 * critique (smooth damp), avancer vers une valeur, angles en degrés par le plus court chemin.
 */
const c1 = 1.70158, c2 = c1 * 1.525, c3 = c1 + 1, c4 = (2 * Math.PI) / 3, c5 = (2 * Math.PI) / 4.5;

function bounceOut(x: number): number {
  const n1 = 7.5625, d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

export const EASINGS: Record<string, (x: number) => number> = {
  linear: (x) => x,
  inQuad: (x) => x * x,
  outQuad: (x) => 1 - (1 - x) * (1 - x),
  inOutQuad: (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2),
  inCubic: (x) => x ** 3,
  outCubic: (x) => 1 - (1 - x) ** 3,
  inOutCubic: (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
  inQuart: (x) => x ** 4,
  outQuart: (x) => 1 - (1 - x) ** 4,
  inOutQuart: (x) => (x < 0.5 ? 8 * x ** 4 : 1 - (-2 * x + 2) ** 4 / 2),
  inQuint: (x) => x ** 5,
  outQuint: (x) => 1 - (1 - x) ** 5,
  inOutQuint: (x) => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2),
  inSine: (x) => 1 - Math.cos((x * Math.PI) / 2),
  outSine: (x) => Math.sin((x * Math.PI) / 2),
  inOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  inExpo: (x) => (x === 0 ? 0 : 2 ** (10 * x - 10)),
  outExpo: (x) => (x === 1 ? 1 : 1 - 2 ** (-10 * x)),
  inOutExpo: (x) => (x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? 2 ** (20 * x - 10) / 2 : (2 - 2 ** (-20 * x + 10)) / 2),
  inCirc: (x) => 1 - Math.sqrt(1 - x * x),
  outCirc: (x) => Math.sqrt(1 - (x - 1) ** 2),
  inOutCirc: (x) => (x < 0.5 ? (1 - Math.sqrt(1 - (2 * x) ** 2)) / 2 : (Math.sqrt(1 - (-2 * x + 2) ** 2) + 1) / 2),
  inBack: (x) => c3 * x ** 3 - c1 * x * x,
  outBack: (x) => 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2,
  inOutBack: (x) => (x < 0.5 ? ((2 * x) ** 2 * ((c2 + 1) * 2 * x - c2)) / 2 : ((2 * x - 2) ** 2 * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2),
  inElastic: (x) => (x === 0 ? 0 : x === 1 ? 1 : -(2 ** (10 * x - 10)) * Math.sin((x * 10 - 10.75) * c4)),
  outElastic: (x) => (x === 0 ? 0 : x === 1 ? 1 : 2 ** (-10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1),
  inOutElastic: (x) =>
    x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? -(2 ** (20 * x - 10) * Math.sin((20 * x - 11.125) * c5)) / 2 : (2 ** (-20 * x + 10) * Math.sin((20 * x - 11.125) * c5)) / 2 + 1,
  inBounce: (x) => 1 - bounceOut(1 - x),
  outBounce: bounceOut,
  inOutBounce: (x) => (x < 0.5 ? (1 - bounceOut(1 - 2 * x)) / 2 : (1 + bounceOut(2 * x - 1)) / 2),
  smoothstep: (x) => x * x * (3 - 2 * x),
  smootherstep: (x) => x * x * x * (x * (x * 6 - 15) + 10),
};

export function ease(name: string, t: number): number {
  const f = EASINGS[name];
  if (!f) throw new Error(`courbe inconnue : ${name} (${Object.keys(EASINGS).join(", ")})`);
  return f(Math.min(1, Math.max(0, t)));
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function remap(v: number, a0: number, a1: number, b0: number, b1: number, clamp = false): number {
  let t = a1 === a0 ? 0 : (v - a0) / (a1 - a0);
  if (clamp) t = Math.min(1, Math.max(0, t));
  return b0 + (b1 - b0) * t;
}

/** Avance `v` vers `target` d'au plus `step`. */
export function approach(v: number, target: number, step: number): number {
  const s = Math.abs(step);
  return v < target ? Math.min(target, v + s) : Math.max(target, v - s);
}

/** Écart d'angle en degrés ramené dans ]-180, 180]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export const angleLerp = (a: number, b: number, t: number) => a + angleDelta(a, b) * t;

/**
 * Amortissement critique (Game Programming Gems 4) : suit une cible sans dépasser, quelle que soit la cadence.
 * Rend la nouvelle valeur et la vitesse à garder dans l'état.
 */
export function smoothDamp(current: number, target: number, velocity: number, smoothTime: number, dt: number, maxSpeed = Infinity): { value: number; velocity: number } {
  const st = Math.max(1e-4, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let change = current - target;
  const maxChange = maxSpeed * st;
  change = Math.min(maxChange, Math.max(-maxChange, change));
  const tgt = current - change;
  const temp = (velocity + omega * change) * dt;
  let v = (velocity - omega * temp) * exp;
  let out = tgt + (change + temp) * exp;
  if (target - current > 0 === out > target) {
    out = target;
    v = (out - target) / Math.max(dt, 1e-6);
  }
  return { value: out, velocity: v };
}
