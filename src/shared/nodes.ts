/**
 * Format de scène commun : des **nœuds nommés** décrits par un patch.
 *
 * Un producteur l'écrit dans un DataProvider (clé `nodes`), un rendu le lit, sans adaptateur :
 * - producteurs : `sonic-physics` (`nodes-plane`), `sonic-timeline` (`nodes-out`), un `sonic-store`, `sonic-p2p`…
 * - rendus : `sonic-3d` (nœuds glTF par nom), `sonic-stage` (éléments HTML / SVG par `id` ou `data-node-id`).
 *
 * Sémantique patch : champs absents inchangés, nœuds absents non réinitialisés ; `"$reset": true` remet
 * l'état d'origine. Chaque rendu ignore les champs qu'il ne sait pas appliquer (ex. `rx` en 2D).
 * Unités : positions dans l'unité du rendu (mètres 3D, unités de la scène 2D), rotations en **radians**.
 */

/** Courbes d'interpolation acceptées dans `ease.curve`. */
export type NodeCurve = "linear" | "in" | "out" | "inOut";

export type NodeEase = { ms?: number; curve?: NodeCurve };

/** Surcharge d'un nœud (clé DP `nodes.<nom>`). Champs absents = inchangés. */
export type NodePatch = {
  x?: number;
  y?: number;
  /** 3D : profondeur ; 2D : ordre d'empilement (z-index). */
  z?: number;
  rx?: number;
  ry?: number;
  /** Rotation dans le plan de l'écran en 2D (radians, sens horaire puisque y descend). */
  rz?: number;
  scale?: number | [number, number, number];
  visible?: boolean;
  color?: string | number;
  emissive?: number;
  emissiveColor?: string | number;
  opacity?: number;
  ease?: NodeEase;
  /** 3D : hauteur max en y au milieu d'une interpolation de position (requiert `ease.ms`). */
  lift?: number;
};

export type NodesSpec = { $reset?: boolean } & Record<string, NodePatch | boolean>;

/** Nombre max de nœuds traités par mutation. */
export const MAX_NODES_PER_MUTATION = 200;

/** Tap (vs glisser) : déplacement max en px et durée max en ms (communs aux rendus). */
export const TAP_MAX_MOVE_PX = 6;
export const TAP_MAX_MS = 400;

export function easeCurve(curve: NodeCurve, t: number): number {
  if (curve === "in") return t * t;
  if (curve === "out") return 1 - (1 - t) * (1 - t);
  if (curve === "inOut") return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
  return t;
}

export function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function patchOf(v: unknown): NodePatch | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as NodePatch) : null;
}

/** Échelle x / y d'un patch (nombre ou `[x, y, z]`), null si absente ou invalide. */
export function scaleXY(s: NodePatch["scale"]): [number, number] | null {
  if (isNum(s)) return [s, s];
  if (Array.isArray(s) && isNum(s[0]) && isNum(s[1])) return [s[0], s[1]];
  return null;
}

/** Regex `pick-names` (invalide ou vide : null = tout accepter). */
export function namesRegex(src: string): RegExp | null {
  const s = src.trim();
  if (!s) return null;
  try {
    return new RegExp(s);
  } catch {
    return null;
  }
}
