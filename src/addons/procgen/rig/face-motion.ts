/** Ouverture de bouche (0 … ~1) selon l'action : parole en syllabes irrégulières, mâche, cri de joie. Commun 3D / vectoriel. */
export function mouthOpen(action: string, t: number): number {
  if (action === "talk") return Math.max(0, 0.55 * Math.sin(t * 11.3) + 0.35 * Math.sin(t * 7.1 + 1.3) + 0.1 * Math.sin(t * 17.9)) * 1.3;
  if (action === "eat") return 0.35 * (0.5 + 0.5 * Math.sin(t * 9));
  if (action === "cheer") return 0.9;
  return 0;
}
