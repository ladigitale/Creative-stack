/**
 * Vecteurs de caractéristiques à partir de la sortie d'un tracker, invariants à la position et à l'échelle :
 * c'est ce qui permet de reconnaître une pose de main ou de corps où qu'elle soit dans l'image.
 * Pur : aucun accès au DOM.
 */

type P = { x: number; y: number };

const isPts = (v: unknown, n: number): v is P[] =>
  Array.isArray(v) && v.length >= n && v.every((p) => !!p && typeof (p as P).x === "number" && typeof (p as P).y === "number");

/** Main : 21 points relatifs au poignet, divisés par la taille de la paume (poignet → base du majeur). 42 valeurs. */
export function handFeatures(landmarks: unknown): number[] | null {
  if (!isPts(landmarks, 21)) return null;
  const w = landmarks[0];
  const size = Math.hypot(landmarks[9].x - w.x, landmarks[9].y - w.y);
  if (!(size > 1e-4)) return null;
  const out: number[] = [];
  for (let i = 0; i < 21; i++) out.push((landmarks[i].x - w.x) / size, (landmarks[i].y - w.y) / size);
  return out;
}

/** Corps : 33 points relatifs au centre des hanches, divisés par la longueur du buste. 66 valeurs. */
export function poseFeatures(landmarks: unknown): number[] | null {
  if (!isPts(landmarks, 33)) return null;
  const hip = { x: (landmarks[23].x + landmarks[24].x) / 2, y: (landmarks[23].y + landmarks[24].y) / 2 };
  const sh = { x: (landmarks[11].x + landmarks[12].x) / 2, y: (landmarks[11].y + landmarks[12].y) / 2 };
  const size = Math.hypot(sh.x - hip.x, sh.y - hip.y);
  if (!(size > 1e-4)) return null;
  const out: number[] = [];
  for (let i = 0; i < 33; i++) out.push((landmarks[i].x - hip.x) / size, (landmarks[i].y - hip.y) / size);
  return out;
}

/** Visage : blendshapes triés par nom (ordre stable), 0..1. */
export function blendFeatures(blend: unknown): number[] | null {
  if (!blend || typeof blend !== "object") return null;
  const keys = Object.keys(blend as Record<string, unknown>).sort();
  if (keys.length < 5) return null;
  const out: number[] = [];
  for (const k of keys) {
    const v = (blend as Record<string, unknown>)[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

export type FeatureSource = "auto" | "hand" | "pose" | "face";

export type HandPick = "any" | "left" | "right";

/**
 * Extrait un vecteur de la sortie d'un tracker. `auto` : d'après les clés (`hands`, `poses`, `blend`).
 * `hand` : la main demandée (`any` : la première vue). Retourne `null` quand rien n'est visible.
 */
export function extractFeatures(data: unknown, source: FeatureSource = "auto", hand: HandPick = "any"): number[] | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const kind = source !== "auto" ? source : Array.isArray(d.poses) ? "pose" : Array.isArray(d.hands) ? "hand" : d.blend ? "face" : null;
  if (kind === "hand") {
    const hands = Array.isArray(d.hands) ? (d.hands as Array<{ role?: string; landmarks?: unknown }>) : [];
    const pick = hand === "any" ? hands[0] : hands.find((h) => h?.role === hand);
    return pick ? handFeatures(pick.landmarks) : null;
  }
  if (kind === "pose") {
    const poses = Array.isArray(d.poses) ? (d.poses as Array<{ landmarks?: unknown }>) : [];
    return poses[0] ? poseFeatures(poses[0].landmarks) : null;
  }
  if (kind === "face") return d.present === 0 ? null : blendFeatures(d.blend);
  return null;
}
