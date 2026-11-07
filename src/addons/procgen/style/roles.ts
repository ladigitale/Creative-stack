/**
 * Rôles de couleur. La géométrie ne porte jamais une couleur : elle porte un rôle (entier), résolu par le style au rendu.
 * Changer de palette ou de nuit ne recompose rien.
 */
export const ROLES = [
  "ground", // 0 sol nu, terre
  "grass", // 1 herbe
  "path", // 2 chemin, terre battue, sable
  "road", // 3 chaussée
  "stone", // 4 pierre, rocher
  "wall", // 5 façades, enduit
  "trim", // 6 encadrements, corniches, bordures
  "roof", // 7 toitures
  "wood", // 8 bois
  "bark", // 9 écorce
  "leaf", // 10 feuillage
  "leaf2", // 11 feuillage secondaire (variation)
  "flower", // 12 fleurs
  "water", // 13 eau
  "metal", // 14 métal
  "glass", // 15 vitres (émissif la nuit)
  "lamp", // 16 lumière (émissif)
  "cloth1", // 17 tissu principal
  "cloth2", // 18 tissu secondaire
  "cloth3", // 19 tissu tertiaire
  "leather", // 20 cuir, chaussures
  "skin", // 21 peau (carnation propre au personnage)
  "hair", // 22 cheveux
  "eye", // 23 iris / pupille
  "eyeWhite", // 24 blanc de l'œil
  "mouth", // 25 bouche
  "accent", // 26 accent (drapeaux, enseignes, détails)
  "ink", // 27 encre (lettres, pictos)
  "paper", // 28 fond de panneau, papier
  "snow", // 29 neige
  "fire", // 30 flamme (émissif)
  "sky", // 31 (réservé au ciel)
] as const;

export type Role = (typeof ROLES)[number];
export const ROLE: Record<Role, number> = Object.fromEntries(ROLES.map((r, i) => [r, i])) as Record<Role, number>;

/** Rôles qui émettent (la nuit surtout). */
export const EMISSIVE_ROLES: Role[] = ["lamp", "fire", "glass"];

export function roleIndex(name: string, fallback: Role = "accent"): number {
  return name in ROLE ? ROLE[name as Role] : ROLE[fallback];
}
