/** Contrat des dessinateurs vectoriels. */
import type { V3 } from "../../core/math";
import type { Rng } from "../../core/rng";
import type { ObjectInfo } from "../../scene/compose";
import type { Projector } from "../project";
import type { Shape } from "../shape";
import type { Kit } from "./kit";

export type Project = Projector;

export type DrawEnv = {
  pr: Projector;
  L: V3;
  out: Shape[];
  /** Ombres portées au sol (dessinées juste après le sol). */
  shadows: Shape[];
  ground: (x: number, z: number) => number;
  time: number;
  night: number;
  waterLevel: number | null;
};

export type DrawCtx = { obj: ObjectInfo; env: DrawEnv; rng: Rng; /** Dessin en miroir (variété), stable par objet. */ mirror: boolean; /** Plan d'un bâtiment (tirages du générateur), si connu. */ plan?: import("../buildplan").Plan };

/** Un dessinateur reçoit les paramètres **résolus** (schéma du générateur, valeurs par défaut comprises). */
export type ObjectDrawer = (kit: Kit, p: Record<string, unknown>, ctx: DrawCtx) => void;
