/**
 * Pixels accrochés au monde (caméras orthographiques : iso, dessus, côté, face, cavalière).
 *
 * Rendu basse résolution (jeton `pixel`) : la translation de la caméra est arrondie à la grille des texels de la cible,
 * dans le repère de la vue (axes droite / haut ; taille d'un texel en unités monde = étendue visible / texels). La
 * cible est agrandie d'une marge de `SNAP_MARGIN` texels de chaque côté ; à l'affichage (plus proche voisin), l'image
 * est décalée du reste sous-texel (position réelle − position arrondie) : les texels restent fixes par rapport au
 * monde (pas de « nage » ni de scintillement pendant un déplacement) et la vue suit la position réelle au pixel écran.
 *
 * Effets de grille de la pile `post` (pixel, 1 bit, palette tramée, demi-teintes, hachures…) : l'image est en pleine
 * définition, il suffit de décaler l'origine des grilles de la position de la caméra (`gridOffset`).
 *
 * Perspective : un déplacement change la projection de chaque point différemment (parallaxe) ; aucun accrochage.
 */
import type { CameraMode } from "./camera";

export const SNAP_MARGIN = 2;
/** Période de repli de l'origine des grilles (px CSS) : multiple commun des pas usuels, précision float conservée. */
export const GRID_WRAP = 10080;

/** Caméras où l'accrochage s'applique (projection orthographique, cisaillée ou non). */
export const snapApplicable = (camera: CameraMode, enabled: boolean) => enabled && camera !== "perspective" && camera !== "follow";

/** Arrondi d'une coordonnée (unités monde, le long d'un axe de la vue) à la grille `texel` ; reste en texels. */
export function snapAxis(a: number, texel: number): { snapped: number; rem: number } {
  const snapped = Math.round(a / texel) * texel;
  return { snapped, rem: (a - snapped) / texel };
}

/**
 * Passage des coordonnées écran (0..1) aux coordonnées de la cible agrandie : `uvCible = uv · (sx, sy) + (ox, oy)`.
 * Un point écran à `s` texels du bord se lit à `s + marge + reste` dans la cible rendue depuis la position arrondie.
 */
export function marginTransform(rw: number, rh: number, m: number, rx: number, ry: number): [number, number, number, number] {
  const W = rw + 2 * m, H = rh + 2 * m;
  return [rw / W, rh / H, (m + rx) / W, (m + ry) / H];
}

/** Origine des grilles des effets (px CSS) : position de la caméra dans le plan de la vue, `cssPerUnit` px par unité monde. */
export function gridOffset(a: number, b: number, cssPerUnit: number): [number, number] {
  const w = (x: number) => ((x % GRID_WRAP) + GRID_WRAP) % GRID_WRAP;
  return [w(a * cssPerUnit), w(b * cssPerUnit)];
}
