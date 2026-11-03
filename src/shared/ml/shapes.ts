/**
 * Formes à dessiner à partir de la sortie d'un tracker (mains, visage, corps) : points et segments en
 * coordonnées normalisées 0..1 (écran, miroir déjà appliqué). Pur : aucun accès au DOM ni au canvas.
 */

export type Pt = { x: number; y: number };

export type Shape =
  | { type: "line"; pts: Pt[]; role?: string; closed?: boolean }
  | { type: "dots"; pts: Pt[]; role?: string; small?: boolean }
  | { type: "rect"; x: number; y: number; w: number; h: number; role?: string; label?: string };

export type OverlayKind = "hands" | "face" | "pose" | "objects";

export const HAND_BONES: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export const POSE_BONES: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];

/** Contours du maillage du visage (indices MediaPipe Face Landmarker, côtés « image »). */
export const FACE_CONTOURS: Record<string, number[]> = {
  oval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
  lips: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],
  eyeA: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  eyeB: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  browA: [336, 296, 334, 293, 300],
  browB: [107, 66, 105, 63, 70],
};

type Lm = { x?: unknown; y?: unknown };

const isPt = (p: unknown): p is Pt => !!p && typeof (p as Lm).x === "number" && typeof (p as Lm).y === "number" && Number.isFinite((p as Pt).x) && Number.isFinite((p as Pt).y);

/** Liste de points valides ; `null` si l'entrée n'est pas une liste de points. */
function points(value: unknown): Pt[] | null {
  if (!Array.isArray(value)) return null;
  const out: Pt[] = [];
  for (const p of value) {
    if (!isPt(p)) return null;
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/** Deviner le type de sortie d'après ses clés (`hands`, `faces`, `poses`). */
export function detectKind(data: unknown): OverlayKind | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (Array.isArray(d.poses)) return "pose";
  if (Array.isArray(d.faces)) return "face";
  if (Array.isArray(d.hands)) return "hands";
  if (Array.isArray(d.objects)) return "objects";
  return null;
}

function bones(pts: Pt[], pairs: Array<[number, number]>, role?: string): Shape[] {
  const out: Shape[] = [];
  for (const [a, b] of pairs) if (pts[a] && pts[b]) out.push({ type: "line", pts: [pts[a], pts[b]], role });
  return out;
}

export type ShapeOptions = { points: boolean; bones: boolean };

/** Formes d'une sortie de tracker. Données absentes ou mal formées : liste vide. */
export function buildShapes(data: unknown, kind: OverlayKind | "auto", opts: ShapeOptions = { points: true, bones: true }): Shape[] {
  const k = kind === "auto" ? detectKind(data) : kind;
  if (!k || !data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  const out: Shape[] = [];

  if (k === "hands") {
    const hands = Array.isArray(d.hands) ? d.hands : [];
    for (const h of hands as Array<{ role?: string; landmarks?: unknown }>) {
      const pts = points(h?.landmarks);
      if (!pts || pts.length < 21) continue;
      if (opts.bones) out.push(...bones(pts, HAND_BONES, h.role));
      if (opts.points) out.push({ type: "dots", pts, role: h.role });
    }
  } else if (k === "pose") {
    const poses = Array.isArray(d.poses) ? d.poses : [];
    poses.forEach((p, i) => {
      const pts = points((p as { landmarks?: unknown })?.landmarks);
      if (!pts || pts.length < 33) return;
      const role = `p${i}`;
      if (opts.bones) out.push(...bones(pts, POSE_BONES, role));
      if (opts.points) out.push({ type: "dots", pts, role });
    });
  } else if (k === "objects") {
    const objects = Array.isArray(d.objects) ? d.objects : [];
    objects.forEach((o, i) => {
      const b = o as { x?: unknown; y?: unknown; w?: unknown; h?: unknown; label?: unknown; score?: unknown };
      if (![b?.x, b?.y, b?.w, b?.h].every((v) => typeof v === "number" && Number.isFinite(v))) return;
      const pct = typeof b.score === "number" ? ` ${Math.round(b.score * 100)}%` : "";
      out.push({ type: "rect", x: b.x as number, y: b.y as number, w: b.w as number, h: b.h as number, role: `o${i}`, label: `${typeof b.label === "string" ? b.label : ""}${pct}`.trim() });
    });
  } else if (k === "face") {
    const faces = Array.isArray(d.faces) ? d.faces : [];
    faces.forEach((f, i) => {
      const pts = points((f as { landmarks?: unknown })?.landmarks);
      if (!pts || pts.length < 468) return; // sans `landmarks="true"` côté tracker : rien à dessiner
      const role = `f${i}`;
      if (opts.bones) {
        for (const [name, idx] of Object.entries(FACE_CONTOURS)) {
          const line = idx.map((j) => pts[j]).filter(Boolean);
          out.push({ type: "line", pts: line, role, closed: name === "oval" || name === "lips" || name.startsWith("eye") });
        }
      }
      if (opts.points) out.push({ type: "dots", pts, role, small: true });
    });
  }
  return out;
}
