/**
 * Physique du football : vol du ballon (un seul intégrateur pour le jeu et pour les prédictions), colliders invisibles
 * des joueurs (jambes, tronc, tête, mains du gardien) et des buts (poteaux et transversale en vraies capsules 3D), et
 * contact balle – collider : séparation, rebond selon la restitution, frottement tangentiel, vitesse du membre comprise.
 * Aucun tirage au sort : un arrêt, un poteau ou un contre a lieu parce que le ballon touche réellement quelque chose.
 */

export type V3 = [number, number, number];

/** Rayon du ballon (m), gravité. */
export const BALL_R = 0.11;
export const GRAVITY = 9.81;
/** Traînée de l'air (1/m) : ralentissement proportionnel au carré de la vitesse. */
export const DRAG = 0.011;
/** Freinage au roulement (m/s²). */
export const ROLL = 1.7;

/** Ballon en vol : position, vitesse, effet latéral (m/s²). */
export type Flight = { p: V3; v: V3; curl: number };

/**
 * Un pas d'intégration du vol (traînée, effet tant que le ballon est en l'air, gravité, rebond au sol, roulement
 * freiné). Renvoie la vitesse verticale à l'impact au sol (> 0) s'il y a eu rebond, sinon 0. Partagé par le jeu et
 * les prédictions : le gardien lit la vraie trajectoire.
 */
export function flightStep(f: Flight, h: number): number {
  const { p, v } = f;
  const sp = Math.hypot(v[0], v[1], v[2]);
  const drag = DRAG * sp;
  for (let k = 0; k < 3; k++) v[k] -= v[k] * drag * h;
  if (f.curl && p[1] > BALL_R + 0.02) {
    const hs = Math.hypot(v[0], v[2]) || 1;
    const vx = v[0];
    v[0] += (v[2] / hs) * f.curl * h;
    v[2] += (-vx / hs) * f.curl * h;
  }
  v[1] -= GRAVITY * h;
  p[0] += v[0] * h;
  p[1] += v[1] * h;
  p[2] += v[2] * h;
  let impact = 0;
  if (p[1] <= BALL_R) {
    p[1] = BALL_R;
    if (v[1] < -1.2) {
      impact = -v[1];
      v[1] = -v[1] * 0.55;
      v[0] *= 0.86;
      v[2] *= 0.86;
      f.curl *= 0.5;
    } else v[1] = 0;
  }
  if (p[1] <= BALL_R + 0.01) {
    const hs = Math.hypot(v[0], v[2]);
    const k = hs > 0 ? Math.max(0, hs - ROLL * h) / hs : 0;
    v[0] *= k;
    v[2] *= k;
    f.curl = 0;
  }
  return impact;
}

/** Trajectoire sans obstacle : `n` points espacés de `dt`, sous-pas de 0,025 s. */
export function flightPath(f0: Flight, dt: number, n: number): V3[] {
  const f: Flight = { p: [...f0.p] as V3, v: [...f0.v] as V3, curl: f0.curl };
  const out: V3[] = [[...f.p] as V3];
  const sub = Math.max(1, Math.round(dt / 0.025));
  for (let i = 1; i < n; i++) {
    for (let s = 0; s < sub; s++) flightStep(f, dt / sub);
    out.push([...f.p] as V3);
  }
  return out;
}

/** Collider : capsule (segment a–b de rayon r ; sphère si a = b), avec sa vitesse (m/s) et sa nature. */
export type Collider = { a: V3; b: V3; r: number; v: V3; part: "leg" | "body" | "head" | "hand" | "post" | "bar"; e: number; mu: number };

/** Point du segment a–b le plus proche de p. */
function closest(a: V3, b: V3, p: V3): V3 {
  const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2)) : 0;
  return [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
}

export type Contact = { part: Collider["part"]; n: V3; vn: number; rel: number };

/**
 * Ballon contre un collider : s'ils se recouvrent et se rapprochent, le ballon est replacé au contact et sa vitesse
 * relative au collider est réfléchie (restitution `e` sur la normale, frottement `mu` sur la tangente). Renvoie le
 * contact (normale, vitesse normale d'approche) ou null.
 */
export function collide(f: Flight, c: Collider): Contact | null {
  const q = closest(c.a, c.b, f.p);
  const d: V3 = [f.p[0] - q[0], f.p[1] - q[1], f.p[2] - q[2]];
  const dist = Math.hypot(d[0], d[1], d[2]);
  const min = c.r + BALL_R;
  if (dist >= min) return null;
  const n: V3 = dist > 1e-6 ? [d[0] / dist, d[1] / dist, d[2] / dist] : [0, 1, 0];
  const rv: V3 = [f.v[0] - c.v[0], f.v[1] - c.v[1], f.v[2] - c.v[2]];
  const vn = rv[0] * n[0] + rv[1] * n[1] + rv[2] * n[2];
  for (let k = 0; k < 3; k++) f.p[k] = q[k] + n[k] * (min + 0.002);
  if (vn >= 0) return null;
  const rel = Math.hypot(rv[0], rv[1], rv[2]);
  const vt: V3 = [rv[0] - vn * n[0], rv[1] - vn * n[1], rv[2] - vn * n[2]];
  for (let k = 0; k < 3; k++) f.v[k] = c.v[k] + vt[k] * (1 - c.mu) - vn * c.e * n[k];
  // un choc franc casse l'effet
  f.curl *= 0.3;
  return { part: c.part, n, vn: -vn, rel };
}

/** Poteaux et transversale d'un but en x = gx (capsules de 6 cm de rayon, face intérieure alignée sur la ligne). */
export function goalColliders(gx: number, gw: number, gh: number): Collider[] {
  const r = 0.06, z = gw / 2 + r, top = gh + r;
  const still: V3 = [0, 0, 0];
  return [
    { a: [gx, 0, z], b: [gx, top, z], r, v: still, part: "post", e: 0.62, mu: 0.08 },
    { a: [gx, 0, -z], b: [gx, top, -z], r, v: still, part: "post", e: 0.62, mu: 0.08 },
    { a: [gx, top, -z], b: [gx, top, z], r, v: still, part: "bar", e: 0.62, mu: 0.08 },
  ];
}

/** Joueur vu par la physique : position au sol, vitesse, cap, hauteur et état de plongeon (gardien). */
export type BodyState = {
  pos: [number, number]; vel: [number, number]; yaw: number; lift: number; dive: number; diveDir: number; reach: number; keeper: boolean; down: number;
  /** Gardien debout : mains portées vers le ballon, [écart latéral (m, + = côté gauche du gardien), hauteur (m)]. */
  handAim?: [number, number];
};

/**
 * Colliders invisibles d'un joueur. Debout : jambes (0,1 → 0,85 m), tronc (0,9 → 1,45 m), tête. Gardien : mains au
 * bout des bras (levés devant lui quand il est prêt). En plongeon (`dive` > 0) : le corps s'allonge à l'horizontale
 * vers `diveDir` (côté du plongeon, ±1 sur l'axe latéral), à la hauteur `lift`, mains tendues au bout de `reach`.
 * Les colliders bougent avec le joueur : leur vitesse entre dans le rebond (une main qui plonge chasse le ballon).
 */
export function bodyColliders(s: BodyState): Collider[] {
  const [x, z] = s.pos;
  const v: V3 = [s.vel[0], 0, s.vel[1]];
  const out: Collider[] = [];
  if (s.down > 0 && s.dive <= 0) {
    // au sol : un seul cylindre couché
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    out.push({ a: [x - fx * 0.8, 0.15, z - fz * 0.8], b: [x + fx * 0.8, 0.15, z + fz * 0.8], r: 0.18, v, part: "body", e: 0.3, mu: 0.4 });
    return out;
  }
  if (s.keeper && s.dive > 0) {
    // latéral du gardien : perpendiculaire à son cap (il fait face au jeu)
    const lx = Math.cos(s.yaw) * s.diveDir, lz = -Math.sin(s.yaw) * s.diveDir;
    const y = Math.max(0.25, s.lift);
    const hip: V3 = [x - lx * 0.35, y, z - lz * 0.35];
    const sh: V3 = [x + lx * 0.25, y + 0.1, z + lz * 0.25];
    const hand: V3 = [x + lx * (0.25 + s.reach), y + 0.18, z + lz * (0.25 + s.reach)];
    out.push({ a: [x - lx * 1.15, y - 0.12, z - lz * 1.15], b: hip, r: 0.13, v, part: "leg", e: 0.35, mu: 0.3 });
    out.push({ a: hip, b: sh, r: 0.18, v, part: "body", e: 0.3, mu: 0.35 });
    out.push({ a: sh, b: hand, r: 0.07, v, part: "hand", e: 0.45, mu: 0.25 });
    out.push({ a: hand, b: hand, r: 0.13, v, part: "hand", e: 0.45, mu: 0.25 });
    return out;
  }
  const lift = s.lift;
  out.push({ a: [x, 0.12 + lift, z], b: [x, 0.85 + lift, z], r: 0.14, v, part: "leg", e: 0.35, mu: 0.3 });
  out.push({ a: [x, 0.95 + lift, z], b: [x, 1.42 + lift, z], r: 0.19, v, part: "body", e: 0.3, mu: 0.35 });
  out.push({ a: [x, 1.66 + lift, z], b: [x, 1.66 + lift, z], r: 0.12, v, part: "head", e: 0.5, mu: 0.2 });
  if (s.keeper) {
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw), lx = Math.cos(s.yaw), lz = -Math.sin(s.yaw);
    if (s.handAim) {
      // mains portées vers le point de passage du ballon, au bout des bras (0,75 m depuis les épaules à 1,45 m),
      // l'une contre l'autre ; bras compris (capsule épaule → mains)
      const [al, ay] = s.handAim;
      const sh: V3 = [x + fx * 0.05, 1.45 + lift, z + fz * 0.05];
      let dl = al, dy = ay - sh[1], df = 0.3;
      const n = Math.hypot(dl, dy, df), k = n > 0.75 ? 0.75 / n : 1;
      [dl, dy, df] = [dl * k, dy * k, df * k];
      const hc: V3 = [sh[0] + lx * dl + fx * df, sh[1] + dy, sh[2] + lz * dl + fz * df];
      out.push({ a: sh, b: hc, r: 0.07, v, part: "hand", e: 0.45, mu: 0.25 });
      for (const sg of [-1, 1]) {
        const hp: V3 = [hc[0] + lx * sg * 0.1, hc[1], hc[2] + lz * sg * 0.1];
        out.push({ a: hp, b: hp, r: 0.12, v, part: "hand", e: 0.45, mu: 0.25 });
      }
    } else {
      // mains prêtes devant le corps, à hauteur de poitrine, écartées
      for (const sg of [-1, 1]) {
        const hp: V3 = [x + fx * 0.32 + lx * sg * 0.28, 1.25 + lift, z + fz * 0.32 + lz * sg * 0.28];
        out.push({ a: hp, b: hp, r: 0.12, v, part: "hand", e: 0.45, mu: 0.25 });
      }
    }
  }
  return out;
}

/**
 * Vitesse initiale pour que le ballon, avec traînée et effet, passe par `target` (x, y, z) en partant de `from`
 * à la vitesse horizontale voulue `speed` : visée corrigée par simulation (3 retouches de la direction et de la
 * vitesse verticale), au lieu d'une parabole sans air.
 */
export function aimShot(from: V3, target: V3, speed: number, curl: number): V3 {
  const dx = target[0] - from[0], dz = target[2] - from[2];
  const dl = Math.hypot(dx, dz) || 1;
  let ax = target[0], az = target[2], ay = target[1];
  let v: V3 = [0, 0, 0];
  for (let it = 0; it < 4; it++) {
    const ex = ax - from[0], ez = az - from[2], el = Math.hypot(ex, ez) || 1;
    const t = el / speed;
    v = [(ex / el) * speed, (ay - from[1] + 0.5 * GRAVITY * t * t) / t, (ez / el) * speed];
    // simulation jusqu'au plan de la cible (perpendiculaire au tir), puis correction de l'écart
    const f: Flight = { p: [...from] as V3, v: [...v] as V3, curl };
    const ux = dx / dl, uz = dz / dl;
    let s = 0;
    const h = 0.01;
    while ((f.p[0] - from[0]) * ux + (f.p[2] - from[2]) * uz < dl && s++ < 600) flightStep(f, h);
    const lat = (f.p[0] - target[0]) * -uz + (f.p[2] - target[2]) * ux;
    ax -= -uz * lat;
    az -= ux * lat;
    ay -= f.p[1] - target[1];
  }
  return v;
}
