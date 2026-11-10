/**
 * Où l'image d'une source (`getFrameCanvas()`) apparaît à l'écran : matrice affine [a, b, c, d, e, f] des
 * pixels de cette image vers le viewport (x' = a·x + c·y + e, y' = b·x + d·y + f).
 *
 * Une source dont l'image n'est pas le canvas affiché (toile `sonic-paint navigable` : l'image entière vue
 * à travers une fenêtre zoomée) fournit sa propre matrice par `frameToClient()`. Sinon : le cadre du canvas
 * s'il est dans la page, puis celui de l'élément. `null` : source non affichée (masquée, hors page).
 */
export type FrameToClient = { frameToClient(): number[] | null };

const hasOwn = (el: unknown): el is FrameToClient => !!el && typeof (el as FrameToClient).frameToClient === "function";

export function frameToClient(el: Element, canvas: { width: number; height: number; isConnected?: boolean; getBoundingClientRect?: () => DOMRect }): number[] | null {
  if (hasOwn(el)) return el.frameToClient();
  if (!(canvas.width > 0 && canvas.height > 0)) return null;
  const r = canvas.isConnected && canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return null;
  return [r.width / canvas.width, 0, 0, r.height / canvas.height, r.left, r.top];
}

/** Applique une matrice affine [a, b, c, d, e, f]. */
export const applyAffine = (m: number[], x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
