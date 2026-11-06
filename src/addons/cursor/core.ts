/** Calcul pur du curseur : effet magnétique et cible survolée. */

export type Box = { left: number; top: number; width: number; height: number };

/**
 * Décalage d'un élément attiré par le pointeur : dans la zone de l'élément agrandie de `radius`, l'élément se déplace
 * vers le pointeur de `strength` × l'écart au centre, sans dépasser `max` px. Hors zone : 0.
 */
export function magneticOffset(box: Box, px: number, py: number, radius: number, strength: number, max: number): { dx: number; dy: number; active: boolean } {
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  const inside = px >= box.left - radius && px <= box.left + box.width + radius && py >= box.top - radius && py <= box.top + box.height + radius;
  if (!inside) return { dx: 0, dy: 0, active: false };
  let dx = (px - cx) * strength, dy = (py - cy) * strength;
  const len = Math.hypot(dx, dy);
  if (len > max && len > 0) { dx = (dx / len) * max; dy = (dy / len) * max; }
  return { dx, dy, active: true };
}

/** Premier élément du chemin d'événement qui porte `data-cursor` : son nom (valeur de l'attribut) et son id. */
export function hoverTarget(path: readonly unknown[]): { name: string; id: string } | null {
  for (const n of path) {
    if (n && typeof n === "object" && typeof (n as Element).hasAttribute === "function" && (n as Element).hasAttribute("data-cursor")) {
      const el = n as Element;
      return { name: el.getAttribute("data-cursor") ?? "", id: el.id ?? "" };
    }
  }
  return null;
}
