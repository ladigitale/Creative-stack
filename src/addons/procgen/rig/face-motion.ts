/** Ouverture de bouche (0 … ~1) selon l'action : parole en syllabes irrégulières, mâche, cri de joie. Commun 3D / vectoriel. */
export function mouthOpen(action: string, t: number): number {
  if (action === "talk") return Math.max(0, 0.55 * Math.sin(t * 11.3) + 0.35 * Math.sin(t * 7.1 + 1.3) + 0.1 * Math.sin(t * 17.9)) * 1.3;
  if (action === "eat") return 0.35 * (0.5 + 0.5 * Math.sin(t * 9));
  if (action === "cheer") return 0.9;
  return 0;
}

/** Pose des mains selon l'action : poids visés des morphs `fist`, `open`, `point` par côté (`l`, `r`). */
export function handPose(action: string, t: number): Record<string, number> {
  switch (action) {
    case "wave":
      return { "open.r": 1 };
    case "point":
      return { "point.r": 1 };
    case "cheer":
      return { "fist.l": 1, "fist.r": 1 };
    case "talk":
      return { "open.r": 0.55 + 0.3 * Math.sin(t * 3.1), "open.l": 0.35 };
    case "run":
      return { "fist.l": 0.65, "fist.r": 0.65 };
    case "jump":
      return { "open.l": 0.8, "open.r": 0.8 };
    case "think":
      return { "fist.r": 0.55 };
    case "carry":
      return { "open.l": 0.45, "open.r": 0.45 };
    case "kick":
      return { "fist.l": 0.5, "fist.r": 0.5 };
    default:
      return {};
  }
}
