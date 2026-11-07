/**
 * Contrat commun des générateurs : un générateur reçoit des paramètres résolus et un contexte (aléa, problèmes),
 * et rend un `Asset` en coordonnées locales (mètres, y vers le haut, base au sol en y = 0, avant = +z).
 */
import type { Q, V3 } from "../core/math";
import type { Rng } from "../core/rng";
import type { Issues, Resolved, Schema } from "../core/schema";
import type { Mesh } from "../geom/mesh";
import type { Skeleton } from "../rig/skeleton";
import type { Role } from "../style/roles";

export type Anchor = {
  /** Os porteur (personnages) ; absent : repère fixe de l'objet. */
  bone?: string;
  /** Position dans le repère de l'objet au repos. */
  pos: V3;
  rot: Q;
  /** Échelle caractéristique (largeur de tête, de main…) pour caler un accessoire. */
  scale: number;
};

export type Footprint = { hx: number; hz: number; r: number };

export type Asset = {
  generator: string;
  mesh: Mesh;
  skeleton?: Skeleton;
  anchors: Record<string, Anchor>;
  /** Emprise au sol (demi-côtés et rayon) pour le placement, la navigation et l'AO entre objets. */
  footprint: Footprint;
  height: number;
  /** Couleurs propres à l'objet (rôle → #rrggbb), appliquées par-dessus la palette du style. */
  colors?: Partial<Record<Role, string>>;
  /** Morph de clignement présent (personnages). */
  blink?: boolean;
  /** Données propres au générateur (ex. points de porte d'un bâtiment). */
  extra?: Record<string, unknown>;
};

export type GenContext = {
  rng: Rng;
  issues: Issues;
  /** Chemin dans la recette (pour les messages). */
  path: string;
};

export type Generator<S extends Schema = Schema> = {
  id: string;
  label: string;
  doc: string;
  tags: string[];
  schema: S;
  build(params: Resolved<S>, ctx: GenContext): Asset;
};

export function defineGenerator<S extends Schema>(g: Generator<S>): Generator<S> {
  return g;
}
