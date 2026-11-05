/**
 * Géométrie de main à partir des 21 points MediaPipe (indices : 0 poignet, 4 bout du pouce,
 * 5/9/13/17 base des doigts, 8/12/16/20 bout des doigts) et attribution des rôles gauche/droite.
 * Tout en coordonnées normalisées 0..1 (origine en haut à gauche) ; aucune dépendance au DOM.
 */

export type Point = { x: number; y: number; z: number };

export type RawHand = {
  landmarks: Point[];
  world?: Point[];
  /** Étiquette du modèle ("Left" | "Right"), indicative. */
  label?: string;
  score: number;
  gesture?: string;
  gestureScore?: number;
};

export type HandMetrics = {
  x: number;
  y: number;
  z: number;
  tipX: number;
  tipY: number;
  pinch: number;
  openness: number;
  roll: number;
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Miroir horizontal (x → 1 - x). */
export function mirrorPoints(points: Point[]): Point[] {
  return points.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z }));
}

export function palmCenter(lm: Point[]): Point {
  const ids = [0, 5, 9, 13, 17];
  let x = 0;
  let y = 0;
  let z = 0;
  for (const i of ids) {
    x += lm[i].x;
    y += lm[i].y;
    z += lm[i].z;
  }
  return { x: x / ids.length, y: y / ids.length, z: z / ids.length };
}

/** Taille de référence de la paume (poignet → base du majeur), pour normaliser pince et ouverture. */
export function palmSize(lm: Point[]): number {
  return Math.max(dist(lm[0], lm[9]), 1e-4);
}

/** 0 = pouce et index écartés, 1 = bouts qui se touchent. */
export function pinch(lm: Point[]): number {
  return clamp01(1 - dist(lm[4], lm[8]) / (0.8 * palmSize(lm)));
}

/**
 * 0 = poing, 1 = doigts tendus. Rapport (bout du doigt → poignet) / (base du doigt → poignet)
 * moyenné sur index, majeur, annulaire, auriculaire : ≈ 1 replié, ≈ 1,9 tendu (valeurs empiriques).
 */
export function openness(lm: Point[]): number {
  const pairs: Array<[number, number]> = [
    [8, 5],
    [12, 9],
    [16, 13],
    [20, 17],
  ];
  let r = 0;
  for (const [tip, base] of pairs) r += dist(lm[tip], lm[0]) / Math.max(dist(lm[base], lm[0]), 1e-4);
  r /= pairs.length;
  return clamp01((r - 1) / 0.9);
}

/** Rotation du poignet dans le plan : 0,5 = main verticale, 0 / 1 = penchée de 90° à gauche / à droite. */
export function roll(lm: Point[]): number {
  const dx = lm[9].x - lm[0].x;
  const dy = lm[9].y - lm[0].y;
  const angle = Math.atan2(dx, -dy);
  return clamp01(0.5 + angle / Math.PI);
}

export function metricsOf(lm: Point[]): HandMetrics {
  const c = palmCenter(lm);
  return {
    x: c.x,
    y: c.y,
    z: c.z,
    tipX: lm[8].x,
    tipY: lm[8].y,
    pinch: pinch(lm),
    openness: openness(lm),
    roll: roll(lm),
  };
}

/* ---------------- mesures fines : doigts ---------------- */

export const FINGER_NAMES = ["thumb", "index", "middle", "ring", "pinky"] as const;
export type FingerName = (typeof FINGER_NAMES)[number];

export type FineMetrics = Record<FingerName, number> & {
  /** Comme `pinch`, entre le bout du pouce et le bout du majeur / de l'annulaire / de l'auriculaire. */
  pinchMiddle: number;
  pinchRing: number;
  pinchPinky: number;
  /** 0 = doigts serrés, 1 = écartés. */
  spread: number;
};

export const FINE_KEYS = ["thumb", "index", "middle", "ring", "pinky", "pinchMiddle", "pinchRing", "pinchPinky", "spread"] as const;

/** Indices des 4 points de chaque doigt : base, 1re articulation, 2e articulation, bout. */
const FINGER_CHAINS: Record<FingerName, [number, number, number, number]> = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

/** Angle (degrés) au point `b` entre les segments b→a et b→c, en 3D ; 180 = aligné. */
function angleAt(a: Point, b: Point, c: Point): number {
  const ux = a.x - b.x, uy = a.y - b.y, uz = a.z - b.z;
  const vx = c.x - b.x, vy = c.y - b.y, vz = c.z - b.z;
  const n = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz);
  if (n < 1e-12) return 180;
  const cos = (ux * vx + uy * vy + uz * vz) / n;
  return (Math.acos(cos < -1 ? -1 : cos > 1 ? 1 : cos) * 180) / Math.PI;
}

/**
 * Extension d'un doigt : 0 = replié, 1 = tendu. Moyenne des angles des deux articulations (180° = droit) ramenée
 * entre une borne « replié » et une borne « tendu » (valeurs empiriques : doigts ≈ 95°→165°, pouce ≈ 130°→165°).
 * Indépendante de la position et de la rotation de la main ; mesurée en 3D (utiliser `world` quand il existe).
 */
export function fingerExtension(pts: Point[], finger: FingerName): number {
  const [a, b, c, d] = FINGER_CHAINS[finger];
  const mean = (angleAt(pts[a], pts[b], pts[c]) + angleAt(pts[b], pts[c], pts[d])) / 2;
  const [lo, hi] = finger === "thumb" ? [130, 165] : [95, 165];
  return clamp01((mean - lo) / (hi - lo));
}

/**
 * Doigts, pinces supplémentaires et écartement. `lm` : points image (pour les distances normalisées par la paume) ;
 * `world` : mêmes points en mètres si disponibles (angles plus fidèles : pas de déformation par le format d'image).
 */
export function fineMetrics(lm: Point[], world?: Point[]): FineMetrics {
  const pts = world && world.length >= 21 ? world : lm;
  const palm = palmSize(lm);
  const pinchTo = (tip: number) => clamp01(1 - dist(lm[4], lm[tip]) / (0.8 * palm));
  const gaps = (dist(lm[8], lm[12]) + dist(lm[12], lm[16]) + dist(lm[16], lm[20])) / 3 / palm;
  return {
    thumb: fingerExtension(pts, "thumb"),
    index: fingerExtension(pts, "index"),
    middle: fingerExtension(pts, "middle"),
    ring: fingerExtension(pts, "ring"),
    pinky: fingerExtension(pts, "pinky"),
    pinchMiddle: pinchTo(12),
    pinchRing: pinchTo(16),
    pinchPinky: pinchTo(20),
    spread: clamp01((gaps - 0.2) / 0.45),
  };
}

/** Nombre de doigts tendus (0..5) : extension > 0,55. */
export function countFingers(f: Record<FingerName, number>): number {
  return FINGER_NAMES.reduce((n, k) => n + (f[k] > 0.55 ? 1 : 0), 0);
}

/* ---------------- rôles ---------------- */

export type Role = "left" | "right";

export type RoleMemory = Partial<Record<Role, { x: number; y: number }>>;

/**
 * Attribue `left` / `right` aux mains visibles (x déjà en repère écran, miroir appliqué).
 *  - deux mains : la plus à gauche est `left` ;
 *  - une main : on garde le rôle de la main la plus proche vue précédemment (si assez proche),
 *    sinon l'étiquette du modèle, sinon la moitié d'écran.
 * Retourne, pour chaque main (même ordre), son rôle.
 */
export function assignRoles(
  hands: Array<{ x: number; y: number; label?: string }>,
  memory: RoleMemory,
  maxJump = 0.35,
): Role[] {
  if (hands.length === 0) return [];
  if (hands.length >= 2) {
    const order = hands.map((h, i) => ({ i, x: h.x })).sort((a, b) => a.x - b.x);
    const roles: Role[] = new Array(hands.length).fill("right");
    roles[order[0].i] = "left";
    return roles;
  }
  const h = hands[0];
  let best: { role: Role; d: number } | null = null;
  for (const role of ["left", "right"] as Role[]) {
    const m = memory[role];
    if (!m) continue;
    const d = Math.hypot(m.x - h.x, m.y - h.y);
    if (d <= maxJump && (!best || d < best.d)) best = { role, d };
  }
  if (best) return [best.role];
  const label = h.label?.toLowerCase();
  if (label === "left" || label === "right") return [label];
  return [h.x < 0.5 ? "left" : "right"];
}
